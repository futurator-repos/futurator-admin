'use client';

/**
 * Wave-level gate matrix — rows = epic·wave, columns:
 *
 *   QA-D (pong1 2026-06-12) — TRUTHFUL MODE. When the wave-merge runner
 *   persisted per-stage outcomes (`waveMergeResult.stages[]`), the columns
 *   are the rigor's ACTUAL blocking stages (build / test / eslint / knip…)
 *   plus a `gate VQA` column, and every cell is a real exit outcome.
 *   `skipped` cells mean the stage genuinely didn't run — never inferred
 *   green. Legacy rows (jobs predating stage persistence) render ONE
 *   honest "inferred from job status" cell instead of N fabricated checks
 *   (the pong1 "24 green cells from one COMPLETED bit" façade).
 *
 *   Fallback (no stage data anywhere): the legacy fixed-column matrix, with
 *   an honesty footnote.
 */

import { Fragment } from 'react';
import type {
  GateCellStatus,
  GateCheck,
  GateRollup,
  GateStageResult,
  GateWaveRow,
  GateWaveVqaCell,
} from '@/types/qa-report';

interface Props {
  rollup: GateRollup;
  onSelectCell?: (row: GateWaveRow, check: GateCheck, status: GateCellStatus) => void;
}

export function WaveMatrix({ rollup, onSelectCell }: Props) {
  const { activeChecks, waveRows } = rollup;

  if (rollup.verdict === 'skipped') {
    return (
      <div
        style={{
          padding: '28px 20px',
          border: '1px dashed var(--border-2)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          color: 'var(--text-mute)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        Automated gate is off for this rigor level (<code>prototype</code>).
      </div>
    );
  }
  if (waveRows.length === 0) {
    return (
      <div
        style={{
          padding: '28px 20px',
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          color: 'var(--text-mute)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        No waves have emitted build-check signals yet. The matrix populates as each wave completes.
      </div>
    );
  }

  // QA-D — truthful mode when ANY row carries real stage outcomes.
  if (rollup.hasStageData) {
    return <StageMatrix rollup={rollup} />;
  }

  const anyInferred = waveRows.some((r) => r.inferred);
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
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
        }}
      >
        Build matrix · wave × check
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
            minWidth: 560,
          }}
        >
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--border)',
                background: 'color-mix(in srgb, var(--foreground) 1.5%, transparent)',
              }}
            >
              <th
                style={{
                  textAlign: 'left',
                  padding: '10px 16px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 8,
                  color: 'var(--text-faint)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.18em',
                  fontWeight: 500,
                  position: 'sticky',
                  left: 0,
                  background: 'inherit',
                  minWidth: 160,
                }}
              >
                Wave
              </th>
              {activeChecks.map((c) => (
                <th
                  key={c}
                  style={{
                    padding: '10px 14px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    color: 'var(--text-faint)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.18em',
                    fontWeight: 500,
                    textAlign: 'center',
                  }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {waveRows.map((row, idx) => (
              <tr
                key={`${row.epicId}-${row.waveIndex}`}
                style={{
                  borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                <td
                  style={{
                    padding: '10px 16px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text-dim)',
                    letterSpacing: '0.04em',
                    position: 'sticky',
                    left: 0,
                    background: 'var(--bg-elev)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ color: 'var(--text-faint)' }}>{row.epicLabel}</span>
                  {' · '}
                  {row.waveLabel}
                </td>
                {activeChecks.map((check) => {
                  const status = row.cells[check] ?? 'pending';
                  return (
                    <td
                      key={check}
                      style={{
                        padding: '8px 10px',
                        textAlign: 'center',
                      }}
                    >
                      <Cell
                        status={status}
                        onClick={
                          onSelectCell && status === 'fail'
                            ? () => onSelectCell(row, check, status)
                            : undefined
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* QA-D honesty footnote — these cells are NOT independent checks. */}
      {anyInferred && (
        <div
          style={{
            padding: '8px 16px',
            borderTop: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            color: 'var(--warning)',
            letterSpacing: '0.04em',
            lineHeight: 1.5,
          }}
        >
          ⚠ inferred — these waves predate per-stage gate recording: every cell in a row reflects
          the wave-merge job&apos;s single pass/fail bit, not {activeChecks.length} independent
          checks. New waves record real per-stage outcomes.
        </div>
      )}
      <Legend />
    </div>
  );
}

// ── QA-D — truthful per-stage matrix ────────────────────────────────

function StageMatrix({ rollup }: { rollup: GateRollup }) {
  const { waveRows } = rollup;
  // Column set = union of stage keys across rows, in first-seen order. One
  // plan = one rigor, so rows agree; the union covers mixed legacy rows.
  const stageKeys: string[] = [];
  for (const row of waveRows) {
    for (const s of row.stages ?? []) {
      if (!stageKeys.includes(s.key)) stageKeys.push(s.key);
    }
  }
  const anyVqa = waveRows.some((r) => r.vqa);

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
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
        }}
      >
        Gate matrix · wave × stage (real outcomes)
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 560 }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid var(--border)',
                background: 'color-mix(in srgb, var(--foreground) 1.5%, transparent)',
              }}
            >
              <th style={stageHeadStyle({ textAlign: 'left', minWidth: 160 })}>Wave</th>
              {stageKeys.map((k) => (
                <th key={k} style={stageHeadStyle({ textAlign: 'center' })}>
                  {k}
                </th>
              ))}
              {anyVqa && <th style={stageHeadStyle({ textAlign: 'center' })}>gate VQA</th>}
            </tr>
          </thead>
          <tbody>
            {waveRows.map((row, idx) => {
              const byKey = new Map<string, GateStageResult>();
              for (const s of row.stages ?? []) byKey.set(s.key, s);
              return (
                <tr
                  key={`${row.epicId}-${row.waveIndex}`}
                  style={{ borderTop: idx === 0 ? 'none' : '1px solid var(--border)' }}
                >
                  <td
                    style={{
                      padding: '10px 16px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--text-dim)',
                      letterSpacing: '0.04em',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ color: 'var(--text-faint)' }}>{row.epicLabel}</span>
                    {' · '}
                    {row.waveLabel}
                  </td>
                  {row.stages && row.stages.length > 0 ? (
                    <Fragment>
                      {stageKeys.map((k) => {
                        const s = byKey.get(k);
                        return (
                          <td key={k} style={{ padding: '8px 10px', textAlign: 'center' }}>
                            {s ? (
                              <span
                                title={`${s.cmd}${s.durationMs != null ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ''}${s.fixedByAgent ? ' · fixed by build-fix agent' : ''}`}
                              >
                                <Cell status={s.status} />
                                {s.fixedByAgent && (
                                  <span
                                    style={{
                                      fontFamily: 'var(--font-mono)',
                                      fontSize: 8,
                                      color: 'var(--warning)',
                                      display: 'block',
                                      letterSpacing: '0.06em',
                                    }}
                                  >
                                    agent-fixed
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span
                                title="This stage is not part of this wave's gate"
                                style={{
                                  fontFamily: 'var(--font-mono)',
                                  fontSize: 10,
                                  color: 'var(--text-faint)',
                                }}
                              >
                                n/a
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </Fragment>
                  ) : (
                    <td
                      colSpan={stageKeys.length}
                      style={{
                        padding: '8px 10px',
                        textAlign: 'center',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9.5,
                        color: 'var(--text-mute)',
                        letterSpacing: '0.04em',
                      }}
                      title="This wave's gate job predates per-stage recording — only its single pass/fail bit is known."
                    >
                      {row.inferred ? 'inferred from job status (no per-stage data)' : 'pending'}
                    </td>
                  )}
                  {anyVqa && (
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <VqaOutcomeCell vqa={row.vqa} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Legend />
    </div>
  );
}

function stageHeadStyle(extra: React.CSSProperties): React.CSSProperties {
  return {
    padding: '10px 14px',
    fontFamily: 'var(--font-mono)',
    fontSize: 8,
    color: 'var(--text-faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
    fontWeight: 500,
    ...extra,
  };
}

/** v2.6 gate-VQA outcome cell: ✓ pass · ⚒ fixed · → fix-forward · — skipped. */
function VqaOutcomeCell({ vqa }: { vqa?: GateWaveVqaCell }) {
  if (!vqa) {
    return (
      <span
        title="No VQA stage ran at this gate"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}
      >
        —
      </span>
    );
  }
  const meta =
    vqa.outcome === 'pass'
      ? { glyph: '✓', color: 'var(--success)', label: `pass (${vqa.pass ?? 0} ACs)` }
      : vqa.outcome === 'fixed'
        ? { glyph: '⚒', color: 'var(--success)', label: `fixed in gate (${vqa.fixed ?? 0})` }
        : vqa.outcome === 'fix-forward'
          ? { glyph: '→', color: 'var(--warning)', label: `${vqa.fixForward ?? 0} fix-forwarded` }
          : vqa.outcome === 'env-blocked'
            ? { glyph: '✗', color: 'var(--destructive)', label: 'env-blocked (dev server no-boot)' }
            : vqa.outcome === 'unverifiable'
              ? { glyph: '?', color: 'var(--text-mute)', label: 'unverifiable' }
              : { glyph: '—', color: 'var(--text-faint)', label: 'skipped' };
  return (
    <span
      title={`gate VQA: ${meta.label}${vqa.unverifiable ? ` · ${vqa.unverifiable} unverifiable` : ''}`}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        fontWeight: 600,
        color: meta.color,
      }}
    >
      {meta.glyph}
    </span>
  );
}

// ── Cell ────────────────────────────────────────────────────────────

function Cell({ status, onClick }: { status: GateCellStatus; onClick?: () => void }) {
  const meta = cellMeta(status);
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      title={meta.title}
      style={{
        width: 28,
        height: 20,
        borderRadius: 3,
        background: meta.bg,
        border: `1px solid ${meta.border}`,
        cursor: clickable ? 'pointer' : 'default',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: meta.fg,
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        letterSpacing: '0.04em',
        padding: 0,
        transition: 'transform 100ms',
      }}
      onMouseEnter={(e) => {
        if (clickable) e.currentTarget.style.transform = 'scale(1.05)';
      }}
      onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
    >
      {meta.glyph}
    </button>
  );
}

function cellMeta(status: GateCellStatus) {
  switch (status) {
    case 'pass':
      return {
        bg: 'color-mix(in srgb, var(--success) 14%, transparent)',
        border: 'color-mix(in srgb, var(--success) 50%, transparent)',
        fg: 'var(--success)',
        glyph: '✓',
        title: 'pass',
      };
    case 'fail':
      return {
        bg: 'color-mix(in srgb, var(--destructive) 16%, transparent)',
        border: 'var(--destructive)',
        fg: 'var(--destructive)',
        glyph: '✗',
        title: 'fail · click for details',
      };
    case 'pending':
      return {
        bg: 'transparent',
        border: 'var(--border-2)',
        fg: 'var(--text-faint)',
        glyph: '·',
        title: 'pending',
      };
    case 'skipped':
      return {
        bg: 'transparent',
        border: 'var(--border)',
        fg: 'var(--text-faint)',
        glyph: '—',
        title: 'skipped by rigor',
      };
  }
}

function Legend() {
  const items: Array<{ label: string; status: GateCellStatus }> = [
    { label: 'pass', status: 'pass' },
    { label: 'fail', status: 'fail' },
    { label: 'pending', status: 'pending' },
    { label: 'skipped', status: 'skipped' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        padding: '10px 16px',
        borderTop: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: 'var(--text-faint)',
        letterSpacing: '0.06em',
        flexWrap: 'wrap',
      }}
    >
      {items.map((i) => {
        const meta = cellMeta(i.status);
        return (
          <span key={i.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: meta.bg,
                border: `1px solid ${meta.border}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: meta.fg,
                fontSize: 9,
              }}
            >
              {meta.glyph}
            </span>
            {i.label}
          </span>
        );
      })}
    </div>
  );
}
