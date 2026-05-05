'use client';

/**
 * Wave-level build matrix — rows = waves, cols = active checks for the
 * plan's rigor (`compile / typecheck / lint / unit / browser / tamper`).
 *
 * Each cell renders as a colored square:
 *   pass     → green
 *   fail     → red    (clickable → drawer)
 *   pending  → muted
 *   skipped  → blank
 *
 * This is Wave 3 of the QA page. Matrix is per-wave (not per-story) because
 * the daemon emits build-check signals at wave granularity. Per-story is
 * Phase 2 (deferred).
 */

import type { GateCellStatus, GateCheck, GateRollup, GateWaveRow } from '@/types/qa-report';

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
        No waves have emitted build-check signals yet. The matrix populates as
        each wave completes.
      </div>
    );
  }

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
                background:
                  'color-mix(in srgb, var(--foreground) 1.5%, transparent)',
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

      <Legend />
    </div>
  );
}

// ── Cell ────────────────────────────────────────────────────────────

function Cell({
  status,
  onClick,
}: {
  status: GateCellStatus;
  onClick?: () => void;
}) {
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
