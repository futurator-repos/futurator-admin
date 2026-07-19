'use client';

/**
 * AgenticJourneysSection — Q2 (BrowserAgent integration), QA-Review W2.
 *
 * Renders `P3QaReport.agentic` when present: the automated operator-play-test
 * lane, where an agentic loop (headless Playwright, or the operator's live
 * Chrome via the extension lane) actually attempts each delivery journey
 * end-to-end rather than replaying a scripted probe. Mounted between
 * JourneyVerdicts (Lane 1) and BeforeAfterGallery (Lane 2) in
 * qa-review-view.tsx's DeployedAppQaReview.
 *
 * The client mirror (src/types/qa-review-p3.ts) does not yet carry
 * `AgenticFinding`/`AgenticRun`/`P3QaReport.agentic` (backend:
 * functions/shared/types/qa-review-p3.ts:108-160). Shadowed locally rather
 * than editing the foreign mirror file — see build slice deviations. Drop
 * this once the mirror syncs; the shapes are byte-identical to the backend.
 *
 * `verdict:'skipped'` (no-api-key / flag-off fail-soft) and `skippedReason`
 * are NEVER a QA failure — the lane just didn't run. Frame filmstrip follows
 * the before-after-gallery.tsx thumb-row pattern: lazy-loaded, click-to-open
 * in a new tab, broken-evidence guard via EvidenceImage.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Play } from 'lucide-react';
import { Field } from './qa-primitives';
import { useRunAgenticQa } from '@/hooks/use-p3-qa-report';

// ── Local shadow types (see file header) ─────────────────────────────

export interface AgenticFinding {
  severity: 'blocking' | 'attention';
  note: string;
}

export type AgenticVerdict = 'pass' | 'fail' | 'uncertain' | 'skipped';

export interface AgenticRun {
  journeyId: string;
  instruction: string;
  verdict: AgenticVerdict;
  findings: AgenticFinding[];
  frameUrls: string[];
  steps: number;
  durationMs: number;
  error?: string;
}

export interface AgenticReport {
  mode: 'headless' | 'extension';
  model: string;
  skippedReason?: string;
  runs: AgenticRun[];
}

// ── Pure helpers (exported + unit-tested) ────────────────────────────

const VERDICT_META: Record<AgenticVerdict, { label: string; color: string }> = {
  pass: { label: 'pass', color: 'var(--success)' },
  fail: { label: 'fail', color: 'var(--destructive)' },
  uncertain: { label: 'uncertain', color: 'var(--warning)' },
  skipped: { label: 'skipped', color: 'var(--text-mute)' },
};

/** Pure — the card accent color for a run, keyed by its verdict. */
export function agenticVerdictColor(verdict: AgenticVerdict): string {
  return VERDICT_META[verdict]?.color ?? 'var(--text-mute)';
}

/** Pure — finding severity → color. */
export function findingSeverityColor(severity: AgenticFinding['severity']): string {
  return severity === 'blocking' ? 'var(--destructive)' : 'var(--warning)';
}

/** Pure — compact "Ns" / "N.Ns" duration formatter. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function VerdictPill({ verdict }: { verdict: AgenticVerdict }) {
  const meta = VERDICT_META[verdict] ?? { label: verdict, color: 'var(--text-mute)' };
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: meta.color,
        border: `1px solid color-mix(in srgb, ${meta.color} 50%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
        borderRadius: 3,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
}

// ── Mode badge — which backend actually drove the browser ────────────

function ModeBadge({ mode, model }: { mode: AgenticReport['mode']; model: string }) {
  const live = mode === 'extension';
  return (
    <span
      title={
        live
          ? "Driven via the operator's live Chrome (BrowserAgent extension lane)."
          : 'Driven via an embedded headless Playwright browser.'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: live ? 'var(--accent-purple)' : 'var(--accent-blue)',
        border: `1px solid color-mix(in srgb, ${live ? 'var(--accent-purple)' : 'var(--accent-blue)'} 45%, transparent)`,
        background: `color-mix(in srgb, ${live ? 'var(--accent-purple)' : 'var(--accent-blue)'} 8%, transparent)`,
        borderRadius: 3,
        padding: '3px 9px',
      }}
    >
      {live ? '● live extension' : '○ headless'}
      <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>· {model}</span>
    </span>
  );
}

// ── Filmstrip — lazy-loaded, click-to-open thumb row ─────────────────

function Filmstrip({ frameUrls }: { frameUrls: string[] }) {
  if (frameUrls.length === 0) {
    return <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>No step screenshots.</span>;
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {frameUrls.map((url, i) => (
        <a
          key={`${url}-${i}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open step ${i + 1} screenshot in a new tab`}
          style={{ display: 'block', textDecoration: 'none' }}
        >
          <span style={{ display: 'inline-block' }}>
            {/* Intentional raw <img> (not next/image): a broken agentic frame
                should quietly drop from the strip; see file-footer note. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`Agentic run step ${i + 1}`}
              loading="lazy"
              style={{
                width: 72,
                height: 46,
                objectFit: 'cover',
                borderRadius: 4,
                border: '1px solid var(--border-2)',
                display: 'block',
              }}
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          </span>
        </a>
      ))}
    </div>
  );
}

// ── Findings list ──────────────────────────────────────────────────────

function FindingsList({ findings }: { findings: AgenticFinding[] }) {
  if (findings.length === 0) {
    return (
      <span style={{ fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic' }}>
        No findings.
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {findings.map((f, i) => {
        const color = findingSeverityColor(f.severity);
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              fontSize: 12,
              lineHeight: 1.45,
              padding: '6px 9px',
              borderLeft: `3px solid ${color}`,
              background: 'var(--surface)',
              borderRadius: 4,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color,
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              [{f.severity}]
            </span>
            <span style={{ color: 'var(--text-dim)' }}>{f.note}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Per-run card ────────────────────────────────────────────────────────

function AgenticRunCard({
  run,
  open,
  onToggle,
}: {
  run: AgenticRun;
  open: boolean;
  onToggle: () => void;
}) {
  const color = agenticVerdictColor(run.verdict);
  return (
    <div
      style={{
        border: `1px solid ${run.verdict === 'fail' ? color : 'var(--border)'}`,
        borderRadius: 8,
        background: 'var(--bg-elev)',
        overflow: 'hidden',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '11px 14px',
          cursor: 'pointer',
          background: open ? 'color-mix(in srgb, var(--accent-blue) 4%, transparent)' : undefined,
        }}
      >
        {open ? (
          <ChevronDown size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
        ) : (
          <ChevronRight size={14} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--foreground)',
              lineHeight: 1.4,
              ...(open
                ? {}
                : {
                    display: '-webkit-box',
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: 'vertical' as const,
                    overflow: 'hidden',
                  }),
            }}
          >
            {run.instruction}
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--text-mute)',
              fontFamily: 'var(--font-mono)',
              marginTop: 2,
            }}
          >
            {run.journeyId} · {run.steps} step{run.steps === 1 ? '' : 's'} ·{' '}
            {formatDurationMs(run.durationMs)}
          </div>
        </div>

        <VerdictPill verdict={run.verdict} />
      </div>

      {open && (
        <div
          style={{
            padding: '2px 16px 14px 40px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {run.error && (
            <Field label="Error">
              <pre
                style={{
                  margin: 0,
                  padding: '7px 10px',
                  fontSize: 11,
                  lineHeight: 1.45,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--destructive)',
                  background: 'var(--surface)',
                  border: '1px solid color-mix(in srgb, var(--destructive) 40%, transparent)',
                  borderRadius: 4,
                  whiteSpace: 'pre-wrap',
                  overflowX: 'auto',
                }}
              >
                {run.error}
              </pre>
            </Field>
          )}
          <Field label="Findings">
            <FindingsList findings={run.findings} />
          </Field>
          <Field label="Steps">
            <Filmstrip frameUrls={run.frameUrls} />
          </Field>
        </div>
      )}
    </div>
  );
}

// ── Run visual QA — Slice B operator trigger ──────────────────────────

/**
 * True once the mutation error looks like a 409 (a run is already in
 * flight / conflicting). `api-client.ts` stamps `err.status` on every
 * non-ok response.
 */
export function isAgenticRunConflict(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status?: number }).status === 409
  );
}

function RunVisualQaButton({
  planId,
  devUrl,
  agentic,
}: {
  planId?: string;
  devUrl?: string;
  agentic?: AgenticReport;
}) {
  const runAgenticQa = useRunAgenticQa(planId ?? null);
  // Set once the enqueue POST resolves, together with a snapshot of the run
  // count at click-time; combined with the current run count below this
  // DERIVES the optimistic 'Queued…' state during render — no effect
  // needed, it just falls back to null/false once report.agentic.runs
  // grows past the snapshot (the existing report hook keeps polling; we
  // just watch what it hands us on the next render).
  const [queuedBaseline, setQueuedBaseline] = useState<number | null>(null);

  const runCount = agentic?.runs.length ?? 0;
  const queued = queuedBaseline !== null && runCount <= queuedBaseline;

  const disabledReason = !planId
    ? 'No plan selected.'
    : !devUrl
      ? 'Deploy a dev build first — no devUrl to visually QA yet.'
      : null;
  const disabled = !!disabledReason || runAgenticQa.isPending || queued;

  const conflict = runAgenticQa.isError && isAgenticRunConflict(runAgenticQa.error);
  const errorMessage = runAgenticQa.isError
    ? conflict
      ? 'A visual QA run is already in progress for this plan.'
      : runAgenticQa.error instanceof Error
        ? runAgenticQa.error.message
        : 'Failed to queue the visual QA run.'
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          runAgenticQa.mutate(
            { mode: 'auto' },
            {
              onSuccess: () => setQueuedBaseline(runCount),
            },
          );
        }}
        disabled={disabled}
        title={disabledReason ?? 'Enqueue an agentic-only visual QA run against the dev deploy.'}
        aria-label={disabledReason ? `Run visual QA disabled: ${disabledReason}` : 'Run visual QA'}
        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          padding: '6px 12px',
          borderRadius: 5,
          border: `1px solid ${disabled ? 'var(--border-2)' : 'var(--accent-blue)'}`,
          background: disabled
            ? 'transparent'
            : 'color-mix(in srgb, var(--accent-blue) 10%, transparent)',
          color: disabled ? 'var(--text-faint)' : 'var(--accent-blue)',
          fontWeight: 500,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        {runAgenticQa.isPending || queued ? (
          <Loader2 size={11} className="animate-spin" aria-hidden />
        ) : (
          <Play size={11} aria-hidden />
        )}
        {queued ? 'Queued…' : 'Run visual QA'}
      </button>
      {errorMessage && (
        <span
          role="alert"
          aria-live="polite"
          style={{ fontSize: 10.5, color: 'var(--destructive)' }}
        >
          {errorMessage}
        </span>
      )}
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────

export interface AgenticJourneysSectionProps {
  /** report.agentic — ABSENT when the lane hasn't run yet (empty-state, not a skip). */
  agentic?: AgenticReport;
  /** plan.id — required to enqueue a Run-visual-QA request; absent ⇒ button disabled. */
  planId?: string;
  /** plan.devUrl (report.devUrl) — the Run-visual-QA button is disabled without it. */
  devUrl?: string;
}

export function AgenticJourneysSection({ agentic, planId, devUrl }: AgenticJourneysSectionProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section
      aria-label="Agentic play-test journeys"
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
          Agentic play-test
        </span>
        {agentic && <ModeBadge mode={agentic.mode} model={agentic.model} />}
        {agentic && agentic.runs.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-mute)' }}>
            {agentic.runs.length} journey{agentic.runs.length === 1 ? '' : 's'} attempted
          </span>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <RunVisualQaButton planId={planId} devUrl={devUrl} agentic={agentic} />
        </div>
      </header>

      <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.4 }}>
        auto: uses your Chrome via the BrowserAgent extension when its local server is connected;
        otherwise headless on the fleet.
      </span>

      {!agentic && (
        <div
          style={{
            padding: '28px 20px',
            textAlign: 'center',
            color: 'var(--text-mute)',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            border: '1px dashed var(--border-2)',
            borderRadius: 8,
          }}
        >
          No visual QA runs yet.
        </div>
      )}

      {agentic?.skippedReason && (
        <div
          style={{
            padding: '8px 11px',
            borderRadius: 5,
            fontSize: 12,
            lineHeight: 1.45,
            background: 'color-mix(in srgb, var(--text-mute) 9%, transparent)',
            border: '1px solid color-mix(in srgb, var(--text-mute) 40%, transparent)',
            color: 'var(--text-dim)',
          }}
        >
          Skipped — {agentic.skippedReason}
        </div>
      )}

      {agentic &&
        (agentic.runs.length === 0
          ? !agentic.skippedReason && (
              <div
                style={{
                  padding: '28px 20px',
                  textAlign: 'center',
                  color: 'var(--text-mute)',
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  border: '1px dashed var(--border-2)',
                  borderRadius: 8,
                }}
              >
                No agentic runs recorded for this QA pass.
              </div>
            )
          : agentic.runs.map((run) => (
              <AgenticRunCard
                key={run.journeyId}
                run={run}
                open={openId === run.journeyId}
                onToggle={() => setOpenId((cur) => (cur === run.journeyId ? null : run.journeyId))}
              />
            )))}
    </section>
  );
}

// Re-export EvidenceImage-free thumb helper isn't needed elsewhere; the
// Filmstrip above intentionally uses a raw <img> (not EvidenceImage) since a
// broken agentic frame should just quietly drop from the strip rather than
// render a "broken evidence" placeholder tile per thumb — kept lightweight
// for a row that may contain 25 frames (AGENTIC_VQA_MAX_STEPS).
