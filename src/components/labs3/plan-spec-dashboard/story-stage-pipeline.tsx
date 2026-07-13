'use client';

/**
 * StoryStagePipeline — the per-story multi-agent sub-pipeline, made visible
 * AND auditable.
 *
 * Derives the TDD stage timeline from the story's agent-event stream (grouped
 * by stepId) and renders it as a horizontal strip:
 *
 *   🧪 Test-Author → ⚙ Implementer → 👁 Reviewer → 📚 Compile
 *
 * Stage events are emitted by the daemon: 'test-author' (P3_TEST_AUTHOR_SPLIT),
 * 'story-dev' (the implementer spawn), 'reviewer' (P3_QUALITY_GATE=on,
 * risk-tiered), 'compile' (fire-and-forget knowledge-graph growth). A stage with
 * no events renders dimmed ("not run") — e.g. single-spawn runs have no
 * Test-Author, low-risk stories no Reviewer — so the pipeline SHAPE is always
 * legible, including what was skipped.
 *
 * B2 (audit): each pill is a TAB. Clicking one opens a per-stage detail panel
 * under the strip — the operator's test-quality audit surface (authored test
 * files + previews, AC→test bindings, invariant manifest, per-attempt commits,
 * reviewer verdicts). The artifacts come from the persisted `stageSummaries`
 * (see the S1 CROSS-SLICE CONTRACT); rows predating stage capture say so
 * plainly rather than fabricate data.
 *
 * A4 (chip semantics): a step whose *outcome* failed reads destructive even
 * though the step process exited — the caller passes `verdictFailed` (final
 * verdict failed ⇒ the Implementer produced a failing story) and
 * `blockingReview` (an advisory-security reviewer fail ⇒ Reviewer blocked). A
 * step is DONE-green only when it genuinely succeeded.
 */

import { useState } from 'react';
import type { AgentEvent } from '@/types/agent-orchestrator';
import type { BoundAcceptanceCriterion } from '@/types/plan-spec';
import type {
  StageSummaries,
  TestAuthorStageSummary,
  ImplementerStageSummary,
  ReviewerStageSummary,
  CompileStageSummary,
} from './adapter';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'not-run';

export interface StageInfo {
  id: string;
  label: string;
  icon: string;
  status: StageStatus;
  durationMs: number | null;
  detail: string | null;
  attempts: number;
}

const STAGE_DEFS = [
  { id: 'test-author', label: 'Test-Author', icon: '🧪' },
  { id: 'story-dev', label: 'Implementer', icon: '⚙️' },
  { id: 'reviewer', label: 'Reviewer', icon: '👁️' },
  { id: 'compile', label: 'Compile', icon: '📚' },
] as const;

/** Verdict-derived hints that re-tone a step whose OUTCOME failed (A4). */
export interface StageSemanticsOpts {
  /** Final story verdict failed ⇒ the Implementer produced a failing story. */
  verdictFailed?: boolean;
  /** Advisory-security reviewer fail ⇒ the Reviewer blocked completion. */
  blockingReview?: boolean;
}

/** Pure: fold the event stream into one StageInfo per pipeline stage. */
export function deriveStages(events: AgentEvent[], opts: StageSemanticsOpts = {}): StageInfo[] {
  return STAGE_DEFS.map((def) => {
    const evs = events.filter((e) => e.stepId === def.id);
    if (evs.length === 0) {
      return {
        ...def,
        status: 'not-run' as StageStatus,
        durationMs: null,
        detail: null,
        attempts: 0,
      };
    }
    const starts = evs.filter((e) => e.eventType === 'step_start');
    const completes = evs.filter((e) => e.eventType === 'step_complete');
    const errors = evs.filter((e) => e.eventType === 'step_error');
    let status: StageStatus =
      errors.length > 0 && completes.length === 0
        ? 'failed'
        : completes.length > 0
          ? 'done'
          : starts.length > 0
            ? 'running'
            : 'pending';
    // A4 — a step that exited (done) but whose OUTCOME failed reads destructive.
    // The step process finishing ≠ the story passing; only re-tone a completed
    // step so we never mask a genuinely-running stage.
    if (status === 'done') {
      if (def.id === 'story-dev' && opts.verdictFailed) status = 'failed';
      if (def.id === 'reviewer' && opts.blockingReview) status = 'failed';
    }
    const first = starts[0] ?? evs[0];
    const lastTerminal = completes[completes.length - 1] ?? errors[errors.length - 1];
    const durationMs =
      first && lastTerminal
        ? Math.max(
            0,
            new Date(lastTerminal.timestamp).getTime() - new Date(first.timestamp).getTime(),
          )
        : null;
    const lastText =
      [...completes, ...errors].pop()?.text ?? starts[starts.length - 1]?.text ?? null;
    return { ...def, status, durationMs, detail: lastText, attempts: starts.length };
  });
}

const STATUS_COLOR: Record<StageStatus, string> = {
  'not-run': 'var(--text-faint)',
  pending: 'var(--text-faint)',
  running: 'var(--accent-blue)',
  done: 'var(--success)',
  failed: 'var(--destructive)',
};

function fmtMs(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Stage id → the stageSummaries key that carries its persisted artifacts. */
const STAGE_SUMMARY_KEY: Record<string, keyof StageSummaries> = {
  'test-author': 'testAuthor',
  'story-dev': 'implementer',
  reviewer: 'reviewer',
  compile: 'compile',
};

export interface StoryStagePipelineProps {
  events: AgentEvent[];
  /** Persisted per-stage audit artifacts (S1 contract). Optional on legacy rows. */
  stageSummaries?: StageSummaries;
  /** The story's ACs — maps binding/verdict AC ids back to their text. */
  acceptanceCriteria?: BoundAcceptanceCriterion[];
  verdictFailed?: boolean;
  blockingReview?: boolean;
}

export function StoryStagePipeline({
  events,
  stageSummaries,
  acceptanceCriteria,
  verdictFailed,
  blockingReview,
}: StoryStagePipelineProps) {
  const stages = deriveStages(events, { verdictFailed, blockingReview });
  // Selected pill = the open audit tab. null = Overview (default, strip only).
  const [selected, setSelected] = useState<string | null>(null);

  // Nothing streamed at all yet (story not started) — don't render an empty strip.
  if (stages.every((s) => s.status === 'not-run')) return null;

  const selectedStage = selected ? stages.find((s) => s.id === selected) : null;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 8,
          margin: '2px 0 18px',
          flexWrap: 'wrap',
        }}
      >
        {stages.map((s, i) => {
          const isOpen = s.id === selected;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                aria-pressed={isOpen}
                title={
                  s.detail ??
                  (s.status === 'not-run' ? 'stage did not run for this story' : s.label)
                }
                onClick={() => setSelected((cur) => (cur === s.id ? null : s.id))}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  padding: '7px 12px',
                  borderRadius: 6,
                  minWidth: 128,
                  textAlign: 'left',
                  cursor: 'pointer',
                  border: `1px solid color-mix(in srgb, ${STATUS_COLOR[s.status]} ${
                    isOpen ? 90 : 45
                  }%, transparent)`,
                  background: `color-mix(in srgb, ${STATUS_COLOR[s.status]} ${
                    isOpen ? 16 : 6
                  }%, transparent)`,
                  boxShadow: isOpen ? `inset 0 -2px 0 0 ${STATUS_COLOR[s.status]}` : 'none',
                  opacity: s.status === 'not-run' ? 0.55 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12 }}>{s.icon}</span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: 'var(--foreground)',
                    }}
                  >
                    {s.label}
                  </span>
                  {s.attempts > 1 && (
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 8,
                        color: 'var(--warning)',
                      }}
                    >
                      ×{s.attempts}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: STATUS_COLOR[s.status],
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: STATUS_COLOR[s.status],
                      ...(s.status === 'running' ? { animation: 'pulse 1.2s infinite' } : {}),
                    }}
                  />
                  {s.status === 'not-run' ? 'not run' : s.status}
                  {s.durationMs != null && s.status !== 'not-run' && (
                    <span style={{ color: 'var(--text-faint)', textTransform: 'none' }}>
                      {fmtMs(s.durationMs)}
                    </span>
                  )}
                </div>
              </button>
              {i < stages.length - 1 && (
                <span style={{ color: 'var(--text-faint)', fontSize: 11, flexShrink: 0 }}>→</span>
              )}
            </div>
          );
        })}
      </div>

      {selectedStage && (
        <StageDetailPanel
          stage={selectedStage}
          summary={stageSummaries?.[STAGE_SUMMARY_KEY[selectedStage.id]]}
          hasSummaries={!!stageSummaries}
          acceptanceCriteria={acceptanceCriteria}
        />
      )}
    </div>
  );
}

// ── Per-stage detail panels ──────────────────────────────────────────────

function StageDetailPanel({
  stage,
  summary,
  hasSummaries,
  acceptanceCriteria,
}: {
  stage: StageInfo;
  summary: unknown;
  hasSummaries: boolean;
  acceptanceCriteria?: BoundAcceptanceCriterion[];
}) {
  return (
    <div
      data-testid={`stage-panel-${stage.id}`}
      style={{
        border: `1px solid color-mix(in srgb, ${STATUS_COLOR[stage.status]} 30%, var(--border))`,
        borderRadius: 6,
        background: 'color-mix(in srgb, var(--foreground) 2%, transparent)',
        padding: '16px 18px',
        marginBottom: 18,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12 }}>{stage.icon}</span>
        {stage.label} · stage detail
      </div>

      {!summary ? (
        <StageEmpty hasSummaries={hasSummaries} status={stage.status} />
      ) : stage.id === 'test-author' ? (
        <TestAuthorPanel
          summary={summary as TestAuthorStageSummary}
          acceptanceCriteria={acceptanceCriteria}
        />
      ) : stage.id === 'story-dev' ? (
        <ImplementerPanel summary={summary as ImplementerStageSummary} />
      ) : stage.id === 'reviewer' ? (
        <ReviewerPanel
          summary={summary as ReviewerStageSummary}
          acceptanceCriteria={acceptanceCriteria}
        />
      ) : (
        <CompilePanel summary={summary as CompileStageSummary} />
      )}
    </div>
  );
}

function StageEmpty({ hasSummaries, status }: { hasSummaries: boolean; status: StageStatus }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: 'var(--text-mute)',
        lineHeight: 1.6,
        fontFamily: 'var(--font-mono)',
      }}
    >
      {!hasSummaries
        ? 'This run predates stage capture — no per-stage artifacts were recorded for this story.'
        : status === 'not-run'
          ? 'This stage did not run for this story.'
          : 'No artifacts captured for this stage.'}
    </div>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 8,
        color: 'var(--text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.24em',
        margin: '14px 0 8px',
      }}
    >
      {children}
    </div>
  );
}

function KindChip({ kind }: { kind?: string }) {
  if (!kind) return null;
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 8,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        padding: '1px 6px',
        borderRadius: 3,
        border: '1px solid color-mix(in srgb, var(--accent-blue) 40%, transparent)',
        color: 'var(--accent-blue)',
      }}
    >
      {kind}
    </span>
  );
}

// ── Test-Author: RED sha, authored files (preview), bindings, invariants ──

function TestAuthorPanel({
  summary,
  acceptanceCriteria,
}: {
  summary: TestAuthorStageSummary;
  acceptanceCriteria?: BoundAcceptanceCriterion[];
}) {
  const acText = new Map((acceptanceCriteria ?? []).map((a) => [a.id, a.text]));
  const files = summary.files ?? [];
  const bindings = Object.entries(summary.bindings ?? {});
  const invariants = Object.entries(summary.invariantManifest ?? {});

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {summary.redSha && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-dim)',
              letterSpacing: '0.04em',
            }}
          >
            RED @ <span style={{ color: 'var(--destructive)' }}>{summary.redSha.slice(0, 7)}</span>
          </span>
        )}
        {summary.resumed && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              padding: '2px 7px',
              borderRadius: 3,
              border: '1px solid color-mix(in srgb, var(--warning) 45%, transparent)',
              background: 'color-mix(in srgb, var(--warning) 10%, transparent)',
              color: 'var(--warning)',
            }}
          >
            resumed
          </span>
        )}
      </div>

      {files.length > 0 && (
        <>
          <PanelLabel>Authored test files · {files.length}</PanelLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.map((f) => (
              <TestFileRow key={f.path} file={f} />
            ))}
          </div>
        </>
      )}

      {bindings.length > 0 && (
        <>
          <PanelLabel>AC → test bindings</PanelLabel>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            {bindings.map(([acId, b], i) => (
              <div
                key={acId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 12,
                  alignItems: 'center',
                  padding: '8px 12px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--foreground)', minWidth: 0 }}>
                  {acText.get(acId) ?? acId}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    justifySelf: 'end',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--text-dim)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {b.testRef}
                  </span>
                  <KindChip kind={b.testKind} />
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {invariants.length > 0 && (
        <>
          <PanelLabel>Invariant manifest</PanelLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {invariants.map(([id, v]) => (
              <div
                key={id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                }}
              >
                <span style={{ color: 'var(--accent-purple)' }}>{id}</span>
                <span style={{ color: 'var(--text-faint)' }}>→</span>
                <span style={{ color: 'var(--text-dim)', wordBreak: 'break-all' }}>{v.ref}</span>
                <KindChip kind={v.kind} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TestFileRow({ file }: { file: { path: string; lines?: number; preview?: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: 'grid',
          gridTemplateColumns: '14px 1fr auto',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          textAlign: 'left',
          padding: '8px 12px',
          background: 'transparent',
          border: 'none',
          cursor: file.preview ? 'pointer' : 'default',
        }}
        disabled={!file.preview}
      >
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-faint)',
            transition: 'transform 160ms',
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
            opacity: file.preview ? 1 : 0,
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--foreground)',
            wordBreak: 'break-all',
          }}
        >
          {file.path}
        </span>
        {file.lines != null && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-mute)',
              whiteSpace: 'nowrap',
            }}
          >
            {file.lines} {file.lines === 1 ? 'line' : 'lines'}
          </span>
        )}
      </button>
      {open && file.preview && (
        <pre
          style={{
            margin: 0,
            padding: '12px 14px',
            maxHeight: 320,
            overflow: 'auto',
            background: 'var(--background)',
            borderTop: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.55,
            color: 'var(--text-dim)',
            whiteSpace: 'pre',
            tabSize: 2,
          }}
        >
          {file.preview}
        </pre>
      )}
    </div>
  );
}

// ── Implementer: one row per attempt ──────────────────────────────────────

function ImplementerPanel({ summary }: { summary: ImplementerStageSummary }) {
  const attempts = summary.attempts ?? [];
  if (attempts.length === 0) {
    return <StageEmpty hasSummaries status="done" />;
  }
  return (
    <div>
      <PanelLabel>Attempts · {attempts.length}</PanelLabel>
      <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        {attempts.map((a, i) => (
          <div
            key={a.attempt}
            style={{
              display: 'grid',
              gridTemplateColumns: '48px 1fr auto auto',
              gap: 12,
              alignItems: 'center',
              padding: '9px 12px',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
            }}
          >
            <span
              style={{
                color: 'var(--text-mute)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              #{a.attempt}
            </span>
            <span style={{ color: 'var(--text-dim)', minWidth: 0 }}>
              {a.commitSha ? (
                <>
                  commit{' '}
                  <span style={{ color: 'var(--foreground)' }}>{a.commitSha.slice(0, 7)}</span>
                  {a.filesChanged && a.filesChanged.length > 0 && (
                    <span style={{ color: 'var(--text-mute)' }}>
                      {' '}
                      · {a.filesChanged.length} file{a.filesChanged.length === 1 ? '' : 's'}
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: 'var(--text-faint)' }}>no commit</span>
              )}
            </span>
            <span style={{ color: 'var(--text-mute)', whiteSpace: 'nowrap' }}>
              {a.durationMs != null ? fmtMs(a.durationMs) : '—'}
            </span>
            <span style={{ color: 'var(--cyan)', whiteSpace: 'nowrap' }}>
              {a.tokens != null ? `${a.tokens.toLocaleString()} tok` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Reviewer: per-AC verdict chips + needsHuman + ranAt ───────────────────

function ReviewerPanel({
  summary,
  acceptanceCriteria,
}: {
  summary: ReviewerStageSummary;
  acceptanceCriteria?: BoundAcceptanceCriterion[];
}) {
  const acText = new Map((acceptanceCriteria ?? []).map((a) => [a.id, a.text]));
  const verdicts = Object.entries(summary.verdicts ?? {});
  const needsHuman = summary.needsHuman ?? [];

  return (
    <div>
      {summary.ranAt && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
          }}
        >
          ran {summary.ranAt}
        </div>
      )}

      {verdicts.length > 0 && (
        <>
          <PanelLabel>Per-AC verdicts</PanelLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {verdicts.map(([acId, v]) => {
              const pass = v === 'pass';
              const color = pass ? 'var(--success)' : 'var(--destructive)';
              return (
                <div
                  key={acId}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 8,
                      textTransform: 'uppercase',
                      letterSpacing: '0.12em',
                      padding: '1px 6px',
                      borderRadius: 3,
                      border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
                      background: `color-mix(in srgb, ${color} 10%, transparent)`,
                      color,
                      flexShrink: 0,
                    }}
                  >
                    {v}
                  </span>
                  <span style={{ color: 'var(--text-dim)', minWidth: 0 }}>
                    {acText.get(acId) ?? acId}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {needsHuman.length > 0 && (
        <>
          <PanelLabel>Needs human</PanelLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {needsHuman.map((id) => (
              <div key={id} style={{ fontSize: 12, color: 'var(--warning)' }}>
                {acText.get(id) ?? id}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Compile: status / detail or honest "not run" ──────────────────────────

function CompilePanel({ summary }: { summary: CompileStageSummary }) {
  if (!summary.status && !summary.detail) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>
        Compile did not run for this story.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {summary.status && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
          status: <span style={{ color: 'var(--foreground)' }}>{summary.status}</span>
        </div>
      )}
      {summary.detail && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          {summary.detail}
        </div>
      )}
    </div>
  );
}
