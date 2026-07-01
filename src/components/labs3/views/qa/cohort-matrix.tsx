'use client';

/**
 * Cohort-batch matrix — optional per-cohortBatch pass/fail grid.
 *
 * Only rendered when ≥ 2 distinct cohortBatch levels exist across the
 * story set (a single-batch plan's gauges in the verdict strip are
 * already sufficient).
 *
 * For each cohortBatch level (L0, L1, L2, …):
 *   batch  |  stories  |  done  |  passing ACs  |  failing ACs  |  bound  |  unbound  |  total
 *
 * Rows are sorted ascending by cohortBatch. The table is read-only;
 * the pipeline executor is the authority on these values.
 *
 * Visual contract:
 *   - Green counts (passing/done) use var(--success)
 *   - Red counts (failing) use var(--destructive)
 *   - Blue counts (bound) use var(--accent-blue)
 *   - Dim counts (unbound/total) use var(--text-dim)/var(--text-mute)
 *   - A batch row's left badge flips red on any failure, green when complete
 */

import { useMemo } from 'react';
import type { StoryNodeRow } from '@/types/plan-spec';

// ── Batch row model ──────────────────────────────────────────────────

interface BatchRow {
  cohortBatch: number;
  storyCount: number;
  doneCount: number;
  failedCount: number;
  passingAcs: number;
  failingAcs: number;
  boundAcs: number;
  unboundAcs: number;
  totalAcs: number;
}

function buildBatchRows(stories: StoryNodeRow[]): BatchRow[] {
  const byBatch = new Map<number, BatchRow>();
  for (const story of stories) {
    const b = story.cohortBatch;
    if (!byBatch.has(b)) {
      byBatch.set(b, {
        cohortBatch: b,
        storyCount: 0,
        doneCount: 0,
        failedCount: 0,
        passingAcs: 0,
        failingAcs: 0,
        boundAcs: 0,
        unboundAcs: 0,
        totalAcs: 0,
      });
    }
    const row = byBatch.get(b)!;
    row.storyCount += 1;
    if (story.state === 'done') row.doneCount += 1;
    if (story.state === 'failed') row.failedCount += 1;
    for (const ac of story.acceptanceCriteria) {
      row.totalAcs += 1;
      if (ac.testBinding.status === 'passing') row.passingAcs += 1;
      else if (ac.testBinding.status === 'failing') row.failingAcs += 1;
      else if (ac.testBinding.status === 'bound') row.boundAcs += 1;
      else row.unboundAcs += 1;
    }
  }
  return [...byBatch.values()].sort((a, b) => a.cohortBatch - b.cohortBatch);
}

// ── Cell components ──────────────────────────────────────────────────

function CountCell({ value, color }: { value: number; color: string }) {
  return (
    <td style={{ padding: '7px 12px', textAlign: 'center' }}>
      {value > 0 ? (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            fontWeight: 600,
            color,
          }}
        >
          {value}
        </span>
      ) : (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          —
        </span>
      )}
    </td>
  );
}

// ── Column head style ────────────────────────────────────────────────

function headTh(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    padding: '8px 12px',
    fontFamily: 'var(--font-mono)',
    fontSize: 8.5,
    color: 'var(--text-faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
    fontWeight: 600,
    textAlign: 'center',
    ...extra,
  };
}

// ── Main export ──────────────────────────────────────────────────────

/**
 * CohortMatrix renders when ≥ 2 batch levels exist; returns null otherwise.
 * The shell (QaReviewView) passes `stories` and this component self-selects.
 */
export function CohortMatrix({ stories }: { stories: StoryNodeRow[] }) {
  const rows = useMemo(() => buildBatchRows(stories), [stories]);

  if (rows.length < 2) return null;

  return (
    <section
      aria-label="Cohort-batch AC matrix"
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
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
            Cohort-batch rollup
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 2 }}>
            AC status counts per topological level. Each batch runs after all{' '}
            <code style={{ fontSize: 11 }}>depends_on</code> in earlier batches complete.
          </div>
        </div>
      </header>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={headTh({ textAlign: 'left', paddingLeft: 18, minWidth: 90 })}>batch</th>
              <th style={headTh()}>stories</th>
              <th style={headTh({ color: 'var(--success)' })}>done</th>
              <th style={headTh({ color: 'var(--success)' })}>passing</th>
              <th style={headTh({ color: 'var(--destructive)' })}>failing</th>
              <th style={headTh({ color: 'var(--accent-blue)' })}>bound</th>
              <th style={headTh()}>unbound</th>
              <th style={headTh()}>total ACs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const batchDone = row.doneCount === row.storyCount && row.storyCount > 0;
              const batchFailed = row.failedCount > 0;
              const batchColor = batchFailed
                ? 'var(--destructive)'
                : batchDone
                  ? 'var(--success)'
                  : 'var(--text-dim)';

              return (
                <tr key={row.cohortBatch} style={{ borderTop: '1px solid var(--border)' }}>
                  {/* Batch label */}
                  <td style={{ padding: '8px 12px 8px 18px', whiteSpace: 'nowrap' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        fontWeight: 600,
                        color: batchColor,
                        letterSpacing: '0.04em',
                      }}
                    >
                      L{row.cohortBatch}
                    </span>
                    {batchFailed && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 9,
                          color: 'var(--destructive)',
                          fontFamily: 'var(--font-mono)',
                          letterSpacing: '0.06em',
                        }}
                      >
                        ✗ failed
                      </span>
                    )}
                    {!batchFailed && batchDone && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 9,
                          color: 'var(--success)',
                          fontFamily: 'var(--font-mono)',
                          letterSpacing: '0.06em',
                        }}
                      >
                        ✓ done
                      </span>
                    )}
                  </td>

                  <CountCell value={row.storyCount} color="var(--text-dim)" />
                  <CountCell value={row.doneCount} color="var(--success)" />
                  <CountCell value={row.passingAcs} color="var(--success)" />
                  <CountCell value={row.failingAcs} color="var(--destructive)" />
                  <CountCell value={row.boundAcs} color="var(--accent-blue)" />
                  <CountCell value={row.unboundAcs} color="var(--text-mute)" />

                  {/* Total ACs */}
                  <td style={{ padding: '7px 12px', textAlign: 'center' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--text-dim)',
                      }}
                    >
                      {row.totalAcs}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
