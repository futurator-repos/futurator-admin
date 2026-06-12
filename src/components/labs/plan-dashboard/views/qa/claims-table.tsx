'use client';

/**
 * Claims table — QA-C (pong1 2026-06-12), the claim-centric heart of the
 * QA Review redesign.
 *
 * The unit of QA is a CLAIM about the product (a browser AC / visual test),
 * not a job. One row per claim, grouped Epic → Story, showing the claim's
 * FULL verification lifecycle:
 *
 *   AC text · level chip (L0/L1/L2) · gate verdict (v2.6 wave-gate VQA,
 *   incl. the fix-forward arc `W2 ✗ → W3 ✓`) · final QA verdict · thumbnail
 *
 * Every row — pass or fail — opens the evidence drawer. Nothing is
 * double-counted; tests without a gate history simply show `—` there.
 */

import { Fragment, useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
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
  onSelect: (row: ClaimRow) => void;
}

const LEVEL_HELP: Record<VqaTestLevel, string> = {
  L0: 'L0 — deterministic console-error scan (no AI judge, free)',
  L1: 'L1 — static screenshot judged by an AI panel against the expected text',
  L2: 'L2 — interaction flow: scripted actions, then judged screenshots',
};

export function ClaimsTable({ report, onSelect }: Props) {
  const results = useMemo(() => report.vqa.results ?? [], [report.vqa.results]);
  const claimsByAcId = useMemo(() => {
    const m = new Map<string, GateVqaClaim>();
    for (const c of report.gateVqa?.claims ?? []) m.set(c.acId, c);
    return m;
  }, [report.gateVqa]);

  // Group: epicLabel → storyTitle → rows. Stable insertion order (the
  // aggregator emits results in epic/story order already).
  const groups = useMemo(() => {
    const byEpic = new Map<string, Map<string, ClaimRow[]>>();
    for (const test of results) {
      const epicKey = test.epicLabel ?? test.epicId ?? '—';
      const storyKey = test.storyTitle ?? test.storyId ?? '—';
      const claim = test.criteriaRef ? claimsByAcId.get(test.criteriaRef) : undefined;
      const epicMap = byEpic.get(epicKey) ?? new Map<string, ClaimRow[]>();
      const rows = epicMap.get(storyKey) ?? [];
      rows.push({ test, claim });
      epicMap.set(storyKey, rows);
      byEpic.set(epicKey, epicMap);
    }
    return byEpic;
  }, [results, claimsByAcId]);

  if (results.length === 0) return null;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Claims · epic → story → criterion
        </span>
        <LevelLegend />
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
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-dim)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              textDecoration: 'none',
            }}
          >
            Overview shot
            <ExternalLink size={10} />
          </a>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 720 }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--border)',
                background: 'color-mix(in srgb, var(--foreground) 1.5%, transparent)',
              }}
            >
              <Th style={{ width: 90 }}>Claim</Th>
              <Th>Expected</Th>
              <Th style={{ width: 46, textAlign: 'center' }}>Level</Th>
              <Th style={{ width: 150 }}>Gate (merged candidate)</Th>
              <Th style={{ width: 110 }}>Final QA</Th>
              <Th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([epicLabel, storyMap]) => (
              <Fragment key={epicLabel}>
                {[...storyMap.entries()].map(([storyTitle, rows], storyIdx) => (
                  <Fragment key={`${epicLabel}:${storyTitle}`}>
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          padding: '8px 16px 4px',
                          borderTop: storyIdx === 0 ? '1px solid var(--border)' : 'none',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 9,
                            color: 'var(--text-faint)',
                            letterSpacing: '0.14em',
                            textTransform: 'uppercase',
                          }}
                        >
                          {epicLabel}
                        </span>
                        <span style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 10 }}>
                          {storyTitle}
                        </span>
                      </td>
                    </tr>
                    {rows.map((row) => (
                      <ClaimRowTr key={row.test.testId} row={row} onSelect={onSelect} />
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '10px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 8,
        color: 'var(--text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        fontWeight: 500,
        ...style,
      }}
    >
      {children}
    </th>
  );
}

// ── Row ─────────────────────────────────────────────────────────────

function ClaimRowTr({ row, onSelect }: { row: ClaimRow; onSelect: (row: ClaimRow) => void }) {
  const { test, claim } = row;
  return (
    <tr
      onClick={() => onSelect(row)}
      style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = 'color-mix(in srgb, var(--foreground) 3%, transparent)')
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>
        <code style={{ fontSize: 10, color: 'var(--accent-blue)', letterSpacing: '0.04em' }}>
          {test.criteriaRef ?? test.testId}
        </code>
      </td>
      <td style={{ padding: '8px 10px', color: 'var(--text-dim)', lineHeight: 1.4 }}>
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
      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
        <LevelChip level={test.level} />
      </td>
      <td style={{ padding: '8px 10px' }}>
        <GateArc claim={claim} />
      </td>
      <td style={{ padding: '8px 10px' }}>
        <StatusChip status={test.status} accepted={test.accepted} />
      </td>
      <td style={{ padding: '6px 12px', textAlign: 'right' }}>
        {test.screenshotUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={test.screenshotUrl}
            alt={test.testId}
            style={{
              width: 54,
              height: 34,
              objectFit: 'cover',
              borderRadius: 3,
              border: '1px solid var(--border-2)',
              display: 'inline-block',
              verticalAlign: 'middle',
            }}
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
          />
        ) : (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>
            —
          </span>
        )}
      </td>
    </tr>
  );
}

// ── Chips ───────────────────────────────────────────────────────────

export function LevelChip({ level }: { level?: VqaTestLevel }) {
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
      title={LEVEL_HELP[level]}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.08em',
        color,
        border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`,
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
        borderRadius: 2,
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
      return { label: 'skipped·budget', color: 'var(--text-faint)' };
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
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: meta.color,
        border: `1px solid color-mix(in srgb, ${meta.color} 50%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
        borderRadius: 2,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
}

/**
 * The wave-gate VQA history rendered as a compact arc:
 *   `W0 ✓`                       — verified at its first gate
 *   `W2 ✗ → W3 ✓ · fixed`        — fix-forward closed by the fix story
 *   `W1 ⚒ fixed in gate`          — in-candidate fixer cleared it
 *   `W2 ✗ → open`                 — still un-reverified
 *   `W0 ? unverifiable`           — no idle frame can show it
 */
function GateArc({ claim }: { claim?: GateVqaClaim }) {
  if (!claim || claim.attempts.length === 0) {
    return (
      <span
        title="No wave-gate VQA history for this claim (no browser AC at a gated wave, or pre-v2.6 run)"
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
      title={`Gate VQA: ${claim.final}${claim.fixStoryId ? ` · fix story ${claim.fixStoryId.slice(0, 8)}` : ''}`}
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
      {claim.final === 'fixed-in-gate' && (
        <span style={{ color: 'var(--text-mute)' }}> fixed in gate</span>
      )}
      {claim.final === 'unverifiable' && (
        <span style={{ color: 'var(--text-mute)' }}> unverifiable</span>
      )}
    </span>
  );
}

function LevelLegend() {
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 10,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: 'var(--text-mute)',
        letterSpacing: '0.04em',
      }}
    >
      <span title={LEVEL_HELP.L0}>L0 console scan</span>
      <span title={LEVEL_HELP.L1}>L1 screenshot judge</span>
      <span title={LEVEL_HELP.L2}>L2 interaction</span>
    </span>
  );
}
