'use client';

/**
 * Quality gates panel — pacman1 UX pass (2026-06-12).
 *
 * Replaces the flat "GATE MATRIX · WAVE × STAGE" table the operator called
 * unreadable. Rows group by EPIC with an aggregate summary; epics expand to
 * their per-wave stage outcomes. All-green epics start collapsed (signal
 * over noise); anything failed / agent-fixed / pending starts expanded.
 *
 * Cells are real outcomes recorded by the wave-merge gate (QA-D): a stage
 * that didn't run renders as such — never an inferred green. Plain-language
 * legend on top for semi-technical readers.
 */

import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type {
  GateCellStatus,
  GateRollup,
  GateStageResult,
  GateWaveRow,
  GateWaveVqaCell,
} from '@/types/qa-report';

interface Props {
  rollup: GateRollup;
}

const STAGE_HELP: Record<string, string> = {
  build: 'compiles the merged code (npm run build)',
  test: 'runs the unit/integration test suite',
  eslint: 'static code-quality rules',
  knip: 'detects dead/unused code',
  'format:check': 'verifies code formatting',
};

export function WaveMatrix({ rollup }: Props) {
  if (rollup.verdict === 'skipped') {
    return <EmptyShell text="Automated gates are off for this rigor level (prototype)." dashed />;
  }
  if (rollup.waveRows.length === 0) {
    return <EmptyShell text="No merged waves yet — gate results appear as each wave completes." />;
  }
  return <EpicGroupedMatrix rollup={rollup} />;
}

// ── Grouped matrix ──────────────────────────────────────────────────

interface EpicGroup {
  epicId: string;
  epicLabel: string;
  rows: GateWaveRow[];
  totals: { pass: number; fail: number; pending: number; skipped: number; fixed: number };
  vqaSummary: string | null;
  allGreen: boolean;
}

function rowOutcomes(row: GateWaveRow): GateStageResult[] {
  if (row.stages && row.stages.length > 0) return row.stages;
  // Legacy rows (one job-status bit) — present honestly as a single cell.
  const any = Object.values(row.cells);
  const status: GateCellStatus = any.includes('fail')
    ? 'fail'
    : any.includes('pending')
      ? 'pending'
      : 'pass';
  return [{ key: 'gate (inferred)', cmd: 'job status — predates per-stage recording', status }];
}

function buildGroups(rollup: GateRollup): EpicGroup[] {
  const byEpic = new Map<string, GateWaveRow[]>();
  for (const row of rollup.waveRows) {
    const arr = byEpic.get(row.epicId) ?? [];
    arr.push(row);
    byEpic.set(row.epicId, arr);
  }
  return [...byEpic.values()].map((rows) => {
    const totals = { pass: 0, fail: 0, pending: 0, skipped: 0, fixed: 0 };
    let vqaPass = 0;
    let vqaOther: string | null = null;
    for (const row of rows) {
      for (const s of rowOutcomes(row)) {
        if (s.status === 'pass') totals.pass += 1;
        else if (s.status === 'fail') totals.fail += 1;
        else if (s.status === 'pending') totals.pending += 1;
        else totals.skipped += 1;
        if (s.fixedByAgent) totals.fixed += 1;
      }
      if (row.vqa) {
        if (row.vqa.outcome === 'pass' || row.vqa.outcome === 'fixed') vqaPass += 1;
        else if (row.vqa.outcome !== 'skipped') vqaOther = row.vqa.outcome;
      }
    }
    const vqaSummary = vqaOther !== null ? vqaOther : vqaPass > 0 ? `visual ✓ ×${vqaPass}` : null;
    return {
      epicId: rows[0].epicId,
      epicLabel: rows[0].epicLabel,
      rows,
      totals,
      vqaSummary,
      allGreen: totals.fail === 0 && totals.pending === 0 && vqaOther === null,
    };
  });
}

function EpicGroupedMatrix({ rollup }: { rollup: GateRollup }) {
  const groups = useMemo(() => buildGroups(rollup), [rollup]);
  // Anything not fully green starts expanded; clean epics start collapsed.
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(groups.filter((g) => !g.allGreen || g.totals.fixed > 0).map((g) => g.epicId)),
  );
  const toggle = (id: string) =>
    setOpenIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOpen = openIds.size === groups.length;

  // Stage column set = union across rows, first-seen order.
  const stageKeys = useMemo(() => {
    const keys: string[] = [];
    for (const row of rollup.waveRows) {
      for (const s of rowOutcomes(row)) if (!keys.includes(s.key)) keys.push(s.key);
    }
    return keys;
  }, [rollup.waveRows]);
  const anyVqa = rollup.waveRows.some((r) => r.vqa);

  return (
    <section
      aria-label="Quality gates"
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
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 220, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
            Quality gates — every merged wave, real outcomes
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 2 }}>
            Each time stories merge, the combined code must pass these checks before it advances.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpenIds(allOpen ? new Set() : new Set(groups.map((g) => g.epicId)))}
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            border: '1px solid var(--border-2)',
            background: 'transparent',
            borderRadius: 5,
            padding: '4px 10px',
            cursor: 'pointer',
          }}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </header>

      {/* Legend — plain language */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          padding: '9px 18px',
          borderBottom: '1px solid var(--border)',
          fontSize: 10.5,
          color: 'var(--text-mute)',
          alignItems: 'center',
        }}
      >
        <LegendItem cell={<Cell status="pass" />} label="passed" />
        <LegendItem cell={<Cell status="fail" />} label="failed" />
        <LegendItem
          cell={<Cell status="pass" fixed />}
          label="fixed by the repair agent, then passed"
        />
        <LegendItem cell={<Cell status="pending" />} label="pending" />
        <LegendItem cell={<Cell status="skipped" />} label="didn't run" />
        {anyVqa && (
          <LegendItem
            cell={<VqaCellChip vqa={{ outcome: 'pass' }} />}
            label="visual check on the merged app"
          />
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 560 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={headStyle({ textAlign: 'left', paddingLeft: 18, minWidth: 170 })}>
                epic / wave
              </th>
              {stageKeys.map((k) => (
                <th key={k} style={headStyle({ textAlign: 'center' })} title={STAGE_HELP[k] ?? ''}>
                  {k}
                </th>
              ))}
              {anyVqa && (
                <th
                  style={headStyle({ textAlign: 'center' })}
                  title="AI judges verify the acceptance criteria visually on the merged app"
                >
                  visual
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const open = openIds.has(g.epicId);
              return (
                <Fragment key={g.epicId}>
                  {/* Epic summary row */}
                  <tr
                    onClick={() => toggle(g.epicId)}
                    style={{
                      cursor: 'pointer',
                      borderTop: '1px solid var(--border)',
                      background: 'color-mix(in srgb, var(--foreground) 2%, transparent)',
                    }}
                  >
                    <td style={{ padding: '9px 10px 9px 18px', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        {open ? (
                          <ChevronDown size={13} style={{ color: 'var(--text-mute)' }} />
                        ) : (
                          <ChevronRight size={13} style={{ color: 'var(--text-faint)' }} />
                        )}
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            fontWeight: 600,
                            color: 'var(--accent-blue)',
                          }}
                        >
                          {g.epicLabel}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-mute)' }}>
                          {g.rows.length} wave{g.rows.length === 1 ? '' : 's'}
                        </span>
                      </span>
                    </td>
                    <td
                      colSpan={stageKeys.length + (anyVqa ? 1 : 0)}
                      style={{ padding: '9px 18px 9px 10px' }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          gap: 12,
                          alignItems: 'center',
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        <span
                          style={{
                            color: g.totals.fail > 0 ? 'var(--destructive)' : 'var(--success)',
                          }}
                        >
                          {g.totals.fail > 0
                            ? `✗ ${g.totals.fail} failing`
                            : `✓ all ${g.totals.pass} checks passed`}
                        </span>
                        {g.totals.fixed > 0 && (
                          <span
                            style={{
                              color: 'var(--warning)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <Wrench size={10} />
                            {g.totals.fixed} agent-fixed
                          </span>
                        )}
                        {g.totals.pending > 0 && (
                          <span style={{ color: 'var(--text-mute)' }}>
                            {g.totals.pending} pending
                          </span>
                        )}
                        {g.vqaSummary && (
                          <span style={{ color: 'var(--success)' }}>{g.vqaSummary}</span>
                        )}
                      </span>
                    </td>
                  </tr>
                  {/* Wave rows */}
                  {open &&
                    g.rows.map((row) => {
                      const byKey = new Map(rowOutcomes(row).map((s) => [s.key, s]));
                      return (
                        <tr
                          key={`${row.epicId}-${row.waveIndex}`}
                          style={{ borderTop: '1px solid var(--border)' }}
                        >
                          <td
                            style={{
                              padding: '7px 10px 7px 40px',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                              color: 'var(--text-dim)',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {row.waveLabel}
                            {row.inferred && (
                              <span
                                title="This wave predates per-stage recording — only its overall pass/fail is known."
                                style={{ marginLeft: 8, fontSize: 9, color: 'var(--warning)' }}
                              >
                                inferred
                              </span>
                            )}
                          </td>
                          {stageKeys.map((k) => {
                            const s = byKey.get(k);
                            return (
                              <td key={k} style={{ padding: '6px 10px', textAlign: 'center' }}>
                                {s ? (
                                  <Cell
                                    status={s.status}
                                    fixed={s.fixedByAgent}
                                    title={`${s.cmd}${s.durationMs != null ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ''}${s.fixedByAgent ? ' · failed first, repaired by the build-fix agent, then passed' : ''}`}
                                  />
                                ) : (
                                  <span
                                    title="This check is not part of this wave's gate"
                                    style={{
                                      fontFamily: 'var(--font-mono)',
                                      fontSize: 10,
                                      color: 'var(--text-faint)',
                                    }}
                                  >
                                    –
                                  </span>
                                )}
                              </td>
                            );
                          })}
                          {anyVqa && (
                            <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                              <VqaCellChip vqa={row.vqa} />
                            </td>
                          )}
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Cells ───────────────────────────────────────────────────────────

function Cell({
  status,
  fixed,
  title,
}: {
  status: GateCellStatus;
  fixed?: boolean;
  title?: string;
}) {
  const meta =
    status === 'pass'
      ? { glyph: '✓', color: 'var(--success)' }
      : status === 'fail'
        ? { glyph: '✗', color: 'var(--destructive)' }
        : status === 'pending'
          ? { glyph: '·', color: 'var(--text-mute)' }
          : { glyph: '—', color: 'var(--text-faint)' };
  const ring = fixed ? 'var(--warning)' : `color-mix(in srgb, ${meta.color} 40%, transparent)`;
  return (
    <span
      title={title ?? status}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: 6,
        background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
        border: `1px solid ${ring}`,
        color: meta.color,
        fontSize: 12,
        fontWeight: 700,
        position: 'relative',
      }}
    >
      {meta.glyph}
      {fixed && (
        <Wrench
          size={9}
          style={{
            position: 'absolute',
            right: -4,
            bottom: -4,
            color: 'var(--warning)',
            background: 'var(--bg-elev)',
            borderRadius: 3,
          }}
        />
      )}
    </span>
  );
}

function VqaCellChip({ vqa }: { vqa?: GateWaveVqaCell }) {
  if (!vqa) {
    return (
      <span
        title="No visual check ran at this gate (no screen-visible criteria in this wave)"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}
      >
        –
      </span>
    );
  }
  const meta =
    vqa.outcome === 'pass'
      ? {
          glyph: '✓',
          color: 'var(--success)',
          label: `visual check passed (${vqa.pass ?? 0} criteria)`,
        }
      : vqa.outcome === 'fixed'
        ? {
            glyph: '⚒',
            color: 'var(--success)',
            label: `visual issues repaired in the gate (${vqa.fixed ?? 0})`,
          }
        : vqa.outcome === 'fix-forward'
          ? {
              glyph: '→',
              color: 'var(--warning)',
              label: `${vqa.fixForward ?? 0} visual issue(s) handed to an automatic fix story`,
            }
          : vqa.outcome === 'env-blocked'
            ? {
                glyph: '✗',
                color: 'var(--destructive)',
                label: 'the app would not start for the visual check',
              }
            : vqa.outcome === 'unverifiable'
              ? {
                  glyph: '?',
                  color: 'var(--text-mute)',
                  label: 'criteria not visible in a static screenshot',
                }
              : { glyph: '—', color: 'var(--text-faint)', label: 'skipped' };
  return (
    <span
      title={meta.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: 6,
        background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
        color: meta.color,
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {meta.glyph}
    </span>
  );
}

function LegendItem({ cell, label }: { cell: React.ReactNode; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{ transform: 'scale(0.78)', transformOrigin: 'left center', display: 'inline-flex' }}
      >
        {cell}
      </span>
      {label}
    </span>
  );
}

function headStyle(extra: React.CSSProperties): React.CSSProperties {
  return {
    padding: '9px 10px',
    fontFamily: 'var(--font-mono)',
    fontSize: 8.5,
    color: 'var(--text-faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
    fontWeight: 600,
    ...extra,
  };
}

function EmptyShell({ text, dashed }: { text: string; dashed?: boolean }) {
  return (
    <div
      style={{
        padding: '24px 20px',
        border: dashed ? '1px dashed var(--border-2)' : '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
        color: 'var(--text-mute)',
        fontSize: 12,
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  );
}
