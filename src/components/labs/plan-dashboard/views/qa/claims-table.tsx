'use client';

/**
 * Claims table — QA-C (pong1), reshaped per operator UX review (pacman1,
 * 2026-06-12): rows expand IN PLACE (accordion) instead of opening a side
 * drawer. Each expanded claim shows its full evidence — clickable
 * screenshot, judge rationale, what the L0/L1/L2 level means, the wave-gate
 * history — plus the Send-back / Accept actions, all inline.
 *
 * Audience: semi-technical (PMs / scrum masters). Everything is labeled in
 * plain language; a claim = one acceptance criterion the product must show.
 */

import { Fragment, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ImageOff,
  Loader2,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useAcceptQaTest, useSendStoryBack } from '@/hooks/use-qa-report';
import type {
  GateVqaClaim,
  QaReport,
  VqaTestLevel,
  VqaTestResult,
  VqaTestStatus,
} from '@/types/qa-report';

export interface ClaimRow {
  test: VqaTestResult;
  claim?: GateVqaClaim;
}

interface Props {
  report: QaReport;
  planId: string;
}

const LEVEL_MEANING: Record<VqaTestLevel, string> = {
  L0: 'console scan — the page is loaded and its browser console is checked for errors. Deterministic, no AI judge.',
  L1: 'screenshot judge — a screenshot of the running app is compared by an AI panel against the expected description.',
  L2: 'interaction flow — scripted clicks/keys are performed, then the resulting screens are judged.',
};

export function ClaimsTable({ report, planId }: Props) {
  const results = useMemo(() => report.vqa.results ?? [], [report.vqa.results]);
  const [openId, setOpenId] = useState<string | null>(null);

  // (storyId, acId) join — the PM numbers criteria per story, so the same
  // acId exists in many epics.
  const claimsByStoryAc = useMemo(() => {
    const m = new Map<string, GateVqaClaim>();
    for (const c of report.gateVqa?.claims ?? []) m.set(`${c.storyId}:${c.acId}`, c);
    return m;
  }, [report.gateVqa]);

  const groups = useMemo(() => {
    const byEpic = new Map<string, Map<string, ClaimRow[]>>();
    for (const test of results) {
      const epicKey = test.epicLabel ?? test.epicId ?? '—';
      const storyKey = test.storyTitle ?? test.storyId ?? '—';
      const claim = test.criteriaRef
        ? claimsByStoryAc.get(`${test.storyId}:${test.criteriaRef}`)
        : undefined;
      const epicMap = byEpic.get(epicKey) ?? new Map<string, ClaimRow[]>();
      const rows = epicMap.get(storyKey) ?? [];
      rows.push({ test, claim });
      epicMap.set(storyKey, rows);
      byEpic.set(epicKey, epicMap);
    }
    return byEpic;
  }, [results, claimsByStoryAc]);

  if (results.length === 0) return null;

  return (
    <section
      aria-label="Visual claims"
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 220 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
            What the app must show — every visual claim, verified
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 2 }}>
            One row per acceptance criterion. Click a row for the screenshot, the judge&apos;s
            reasoning, and its history. <strong>Gate</strong> = verified on the merged code at each
            wave · <strong>Final QA</strong> = verified on the assembled app.
          </div>
        </div>
        {report.vqa.overviewUrl && (
          <a
            href={report.vqa.overviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: 'var(--text-dim)',
              letterSpacing: '0.06em',
              textDecoration: 'none',
              border: '1px solid var(--border-2)',
              borderRadius: 5,
              padding: '4px 10px',
            }}
          >
            Full app screenshot
            <ExternalLink size={11} />
          </a>
        )}
      </header>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 680 }}>
          <tbody>
            {[...groups.entries()].map(([epicLabel, storyMap]) => (
              <Fragment key={epicLabel}>
                {[...storyMap.entries()].map(([storyTitle, rows]) => (
                  <Fragment key={`${epicLabel}:${storyTitle}`}>
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          padding: '12px 18px 5px',
                          borderTop: '1px solid var(--border)',
                          background: 'color-mix(in srgb, var(--foreground) 2%, transparent)',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--accent-blue)',
                            letterSpacing: '0.1em',
                          }}
                        >
                          {epicLabel}
                        </span>
                        <span style={{ color: 'var(--text-dim)', fontSize: 12.5, marginLeft: 10 }}>
                          {storyTitle}
                        </span>
                      </td>
                    </tr>
                    {rows.map((row) => (
                      <ClaimAccordionRow
                        key={row.test.testId}
                        row={row}
                        planId={planId}
                        open={openId === row.test.testId}
                        onToggle={() =>
                          setOpenId((cur) => (cur === row.test.testId ? null : row.test.testId))
                        }
                      />
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <footer
        style={{
          padding: '9px 18px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          fontSize: 10.5,
          color: 'var(--text-mute)',
        }}
      >
        <span>
          <LevelChip level="L0" /> console scan
        </span>
        <span>
          <LevelChip level="L1" /> screenshot judge
        </span>
        <span>
          <LevelChip level="L2" /> interaction flow
        </span>
        <span style={{ marginLeft: 'auto' }}>
          {report.vqa.pass}/{report.vqa.total} passing
          {report.vqa.accepted ? ` · ${report.vqa.accepted} accepted as known limitation` : ''}
        </span>
      </footer>
    </section>
  );
}

// ── Row + expander ──────────────────────────────────────────────────

function ClaimAccordionRow({
  row,
  planId,
  open,
  onToggle,
}: {
  row: ClaimRow;
  planId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { test, claim } = row;
  // F12 (d) — a thumbnail that 404s/fails to decode is broken EVIDENCE (an
  // infra capture/upload failure), not "no screenshot". Surface it instead of
  // silently hiding it, so the operator sees the integrity gap.
  const [brokenImg, setBrokenImg] = useState(false);
  return (
    <>
      <tr
        onClick={onToggle}
        aria-expanded={open}
        style={{
          cursor: 'pointer',
          borderTop: '1px solid var(--border)',
          background: open ? 'color-mix(in srgb, var(--accent-blue) 4%, transparent)' : undefined,
        }}
        onMouseEnter={(e) => {
          if (!open)
            e.currentTarget.style.background =
              'color-mix(in srgb, var(--foreground) 3%, transparent)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        <td style={{ padding: '10px 8px 10px 18px', whiteSpace: 'nowrap', width: 110 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {open ? (
              <ChevronDown size={13} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
            ) : (
              <ChevronRight size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
            )}
            <code style={{ fontSize: 10, color: 'var(--accent-blue)', letterSpacing: '0.04em' }}>
              {test.criteriaRef ?? test.testId.slice(0, 10)}
            </code>
          </span>
        </td>
        <td style={{ padding: '10px 10px', color: 'var(--text-dim)', lineHeight: 1.45 }}>
          <span
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {test.expected ?? test.description ?? test.testId}
          </span>
        </td>
        <td style={{ padding: '10px 8px', textAlign: 'center', width: 48 }}>
          <LevelChip level={test.level} />
        </td>
        <td style={{ padding: '10px 10px', width: 150, whiteSpace: 'nowrap' }}>
          <GateArc claim={claim} />
        </td>
        <td style={{ padding: '10px 10px', width: 100 }}>
          <StatusChip status={test.status} accepted={test.accepted} />
        </td>
        <td style={{ padding: '8px 18px 8px 8px', textAlign: 'right', width: 76 }}>
          {test.screenshotUrl && !brokenImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={test.screenshotUrl}
              alt={test.testId}
              style={{
                width: 56,
                height: 36,
                objectFit: 'cover',
                borderRadius: 4,
                border: '1px solid var(--border-2)',
                display: 'inline-block',
                verticalAlign: 'middle',
              }}
              onError={() => setBrokenImg(true)}
            />
          ) : test.screenshotUrl && brokenImg ? (
            // Evidence was supposed to exist but the thumbnail failed to load
            // (404 / broken upload) — flag the infra failure, don't hide it.
            <span
              title="Screenshot evidence missing or broken (capture/upload failure)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: 'var(--warning, #b45309)',
                border: '1px dashed var(--warning, #b45309)',
                borderRadius: 4,
                padding: '4px 6px',
                whiteSpace: 'nowrap',
              }}
            >
              <ImageOff size={11} aria-hidden />
              evidence broken
            </span>
          ) : (
            <span
              style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}
            >
              —
            </span>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td
            colSpan={6}
            style={{
              padding: 0,
              borderTop: '1px dashed var(--border)',
              background: 'color-mix(in srgb, var(--accent-blue) 2.5%, transparent)',
            }}
          >
            <ClaimDetail row={row} planId={planId} />
          </td>
        </tr>
      )}
    </>
  );
}

function ClaimDetail({ row, planId }: { row: ClaimRow; planId: string }) {
  const { test, claim } = row;
  const sendBack = useSendStoryBack(planId);
  const acceptTest = useAcceptQaTest(planId);
  const [sentMsg, setSentMsg] = useState<string | null>(null);
  const [note, setNote] = useState(() => buildDefaultNote(test));

  const isFail = test.status === 'fail' || test.status === 'errored';
  const isAccepted = !!test.accepted;
  const gated = test.failureClass === 'interaction-gated';
  const passedAtGate =
    claim &&
    (claim.final === 'verified' ||
      claim.final === 'fixed-in-gate' ||
      claim.final === 'fixed-by-story');

  async function handleSendBack() {
    if (!test.epicId || !test.storyId) return;
    try {
      const res = await sendBack.mutateAsync({
        epicId: test.epicId,
        storyId: test.storyId,
        note: note.trim() || buildDefaultNote(test),
      });
      setSentMsg(res.jobId ? `Sent back · job ${res.jobId.slice(0, 8)}` : 'Sent back');
    } catch (err) {
      setSentMsg(err instanceof Error ? `Error: ${err.message}` : 'Error');
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 20,
        padding: '16px 18px 18px',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
      }}
    >
      {/* Screenshot — click opens the full-size capture. */}
      {test.screenshotUrl && (
        <a
          href={test.screenshotUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the full-size screenshot in a new tab"
          style={{ flex: '0 1 380px', minWidth: 240, textDecoration: 'none' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={test.screenshotUrl}
            alt={`Screenshot for ${test.testId}`}
            style={{
              width: '100%',
              borderRadius: 6,
              border: `1px solid ${test.passed ? 'var(--success)' : 'var(--destructive)'}`,
              display: 'block',
            }}
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
          />
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginTop: 5,
              fontSize: 10.5,
              color: 'var(--text-mute)',
            }}
          >
            <ExternalLink size={10} />
            Open full size
          </span>
        </a>
      )}

      <div
        style={{
          flex: '1 1 320px',
          minWidth: 260,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {/* Honesty banners */}
        {isFail && passedAtGate && (
          <Banner color="var(--accent-purple)">
            <strong>Passed at the wave gate</strong> — this claim was verified on its isolated
            preview when the code merged. If final assembly retired that preview, the wording
            (background, layout) may describe the old surface rather than a real defect — consider
            Accept or rewording before sending back.
          </Banner>
        )}
        {isFail && test.failureClass && (
          <Banner color={gated ? 'var(--accent-blue)' : 'var(--warning)'}>
            <strong>{gated ? 'Needs interaction' : 'Visible defect'}</strong>
            {gated
              ? ' — this expectation depends on motion, time, or input, which a static screenshot cannot show. If the app behaves correctly, Accept it as a known limitation.'
              : ' — the judge could see this state in the screenshot and it did not match, so this is likely a genuine defect → Send back to dev.'}
          </Banner>
        )}
        {isAccepted && (
          <Banner color="var(--success)">
            <CheckCircle2 size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
            Accepted as a known limitation — this claim no longer blocks publishing.
          </Banner>
        )}

        {/* Expected + judge rationale */}
        <Field label="Expected (the acceptance criterion)">
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--foreground)' }}>
            {test.expected ?? test.description ?? '—'}
          </p>
        </Field>
        {test.rationale && (
          <Field label="What the judge saw">
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: 'var(--text-dim)',
                padding: '9px 12px',
                borderLeft: `3px solid ${test.passed ? 'var(--success)' : 'var(--warning)'}`,
                background: 'var(--surface)',
                borderRadius: 4,
              }}
            >
              {test.rationale}
            </p>
          </Field>
        )}

        {/* How it was checked */}
        {test.level && (
          <Field label="How it was checked">
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 12,
                color: 'var(--text-mute)',
                lineHeight: 1.45,
              }}
            >
              <LevelChip level={test.level} />
              <span>{LEVEL_MEANING[test.level]}</span>
            </span>
          </Field>
        )}

        {/* Stage A.3 — human-tier banner */}
        {test.humanVerify && (
          <Field label="Human-verified">
            <span style={{ fontSize: 12, color: 'var(--warning, #f59e0b)', lineHeight: 1.45 }}>
              ⓘ This claim is not machine-judgeable
              {test.humanVerifyReason ? ` (${test.humanVerifyReason})` : ''} — reach the state by
              playing, then Accept it if correct.
            </span>
          </Field>
        )}

        {/* Stage A.4 — the actual Playwright script QA ran (visible scripts) */}
        {test.generatedScript && (
          <Field label="Playwright script QA ran">
            <pre
              style={{
                margin: 0,
                padding: '8px 10px',
                fontSize: 11,
                lineHeight: 1.5,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                overflowX: 'auto',
                whiteSpace: 'pre',
              }}
            >
              {test.generatedScript}
            </pre>
          </Field>
        )}

        {/* Gate history */}
        {claim && claim.attempts.length > 0 && (
          <Field label="History at the wave gates (merged code)">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {claim.attempts.map((a, i) => (
                <div
                  key={`${a.waveNumber}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    fontSize: 12,
                    padding: '6px 10px',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    background: 'var(--surface)',
                  }}
                >
                  <code style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}>
                    wave {a.waveNumber}
                  </code>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      fontWeight: 700,
                      flexShrink: 0,
                      color:
                        a.result === 'PASS' || a.result === 'FIXED_IN_GATE'
                          ? 'var(--success)'
                          : a.result === 'FAIL'
                            ? 'var(--destructive)'
                            : 'var(--text-mute)',
                    }}
                  >
                    {a.result === 'FIXED_IN_GATE' ? 'FIXED IN GATE' : a.result}
                  </span>
                  <span style={{ color: 'var(--text-dim)', flex: 1, lineHeight: 1.4 }}>
                    {a.observation || ''}
                  </span>
                  {a.screenshotUrl && (
                    <a
                      href={a.screenshotUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ fontSize: 10, color: 'var(--accent-blue)', flexShrink: 0 }}
                    >
                      screenshot ↗
                    </a>
                  )}
                </div>
              ))}
              {claim.fixStoryId && (
                <span style={{ fontSize: 10.5, color: 'var(--text-mute)' }}>
                  An automatic fix story ({claim.fixStoryId.slice(0, 8)}) re-verified this claim.
                </span>
              )}
            </div>
          </Field>
        )}

        {/* Meta */}
        <div
          style={{
            display: 'flex',
            gap: 14,
            flexWrap: 'wrap',
            fontSize: 10.5,
            color: 'var(--text-mute)',
          }}
        >
          <span>
            test <code style={{ color: 'var(--text-dim)' }}>{test.testId.slice(0, 18)}</code>
          </span>
          {test.costUsd != null && <span>cost ${test.costUsd.toFixed(3)}</span>}
          {test.durationMs != null && <span>{(test.durationMs / 1000).toFixed(1)}s</span>}
        </div>

        {/* Actions — failures only */}
        {isFail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Field label="Send back to dev — note (editable)">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: '100%',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  padding: '8px 10px',
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: 'var(--foreground)',
                  resize: 'vertical',
                  outline: 'none',
                }}
              />
            </Field>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                onClick={handleSendBack}
                disabled={sendBack.isPending || !!sentMsg}
                style={actionBtn('var(--destructive)', sendBack.isPending || !!sentMsg)}
              >
                {sendBack.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )}
                {sendBack.isPending ? 'Sending…' : 'Send back to dev'}
              </button>
              <button
                type="button"
                onClick={() => acceptTest.mutate({ testId: test.testId, accept: !isAccepted })}
                disabled={acceptTest.isPending}
                title={
                  isAccepted
                    ? 'Un-accept — this claim will block again'
                    : 'Accept as a known limitation — stops blocking publish'
                }
                style={actionBtn(
                  isAccepted ? 'var(--success)' : 'var(--accent-blue)',
                  acceptTest.isPending,
                )}
              >
                {acceptTest.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ShieldCheck size={12} />
                )}
                {isAccepted ? 'Accepted — un-accept' : 'Accept (known limitation)'}
              </button>
              {sentMsg && (
                <span
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--success)' }}
                >
                  ✓ {sentMsg}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bits ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8.5,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Banner({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '8px 11px',
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.45,
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 50%, transparent)`,
        color: 'var(--text-dim)',
      }}
    >
      {children}
    </div>
  );
}

function actionBtn(color: string, disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    padding: '7px 13px',
    borderRadius: 5,
    background: `color-mix(in srgb, ${color} 11%, transparent)`,
    border: `1px solid ${color}`,
    color,
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    letterSpacing: '0.04em',
    opacity: disabled ? 0.6 : 1,
  };
}

function buildDefaultNote(t: VqaTestResult): string {
  const lines = [`Visual QA failed: ${t.testId}`];
  if (t.expected) lines.push(`Expected (the AC): ${t.expected}`);
  if (t.rationale) lines.push(`What the screenshot showed: ${t.rationale}`);
  if (t.screenshotUrl) lines.push(`Screenshot the judge inspected: ${t.screenshotUrl}`);
  lines.push('Fix the code so the rendered output matches the expectation above.');
  return lines.join('\n');
}

function LevelChip({ level }: { level?: VqaTestLevel }) {
  if (!level) {
    return (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>
        —
      </span>
    );
  }
  const color =
    level === 'L0'
      ? 'var(--text-dim)'
      : level === 'L1'
        ? 'var(--accent-blue)'
        : 'var(--accent-purple)';
  return (
    <span
      title={LEVEL_MEANING[level]}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.08em',
        color,
        border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`,
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
        borderRadius: 3,
        padding: '2px 6px',
      }}
    >
      {level}
    </span>
  );
}

function statusMeta(status: VqaTestStatus, accepted?: boolean) {
  if (accepted) return { label: 'accepted', color: 'var(--success)' };
  switch (status) {
    case 'pass':
      return { label: 'pass', color: 'var(--success)' };
    case 'fail':
      return { label: 'fail', color: 'var(--destructive)' };
    case 'uncertain':
      return { label: 'uncertain', color: 'var(--warning)' };
    case 'skipped-budget':
      return { label: 'skipped', color: 'var(--text-faint)' };
    case 'errored':
      return { label: 'errored', color: 'var(--destructive)' };
    case 'pending':
    default:
      return { label: 'pending', color: 'var(--text-mute)' };
  }
}

function StatusChip({ status, accepted }: { status: VqaTestStatus; accepted?: boolean }) {
  const meta = statusMeta(status, accepted);
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

/**
 * The wave-gate history rendered as a compact arc: `W2 ✗ → W3 ✓`.
 */
function GateArc({ claim }: { claim?: GateVqaClaim }) {
  if (!claim || claim.attempts.length === 0) {
    return (
      <span
        title="No wave-gate verification history for this claim"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}
      >
        —
      </span>
    );
  }
  const finalColor =
    claim.final === 'verified' ||
    claim.final === 'fixed-by-story' ||
    claim.final === 'fixed-in-gate'
      ? 'var(--success)'
      : claim.final === 'unverifiable'
        ? 'var(--text-mute)'
        : 'var(--warning)';
  const glyph = (r: string) =>
    r === 'PASS' ? '✓' : r === 'FAIL' ? '✗' : r === 'FIXED_IN_GATE' ? '⚒' : '?';
  return (
    <span
      title={`Gate verification: ${claim.final}${claim.fixStoryId ? ` · fix story ${claim.fixStoryId.slice(0, 8)}` : ''}`}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: finalColor,
        letterSpacing: '0.05em',
        whiteSpace: 'nowrap',
      }}
    >
      {claim.attempts.map((a, i) => (
        <Fragment key={`${a.waveNumber}-${i}`}>
          {i > 0 && <span style={{ color: 'var(--text-faint)' }}> → </span>}W{a.waveNumber}{' '}
          {glyph(a.result)}
        </Fragment>
      ))}
      {claim.final === 'fix-forwarded' && <span style={{ color: 'var(--warning)' }}> → open</span>}
      {claim.final === 'unverifiable' && (
        <span style={{ color: 'var(--text-mute)' }}> unverifiable</span>
      )}
    </span>
  );
}
