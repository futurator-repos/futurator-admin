'use client';

/**
 * Labs3 sub-tabs — the SDD surface switcher (Graph / Git Graph / Stories / QA /
 * Skills & Learnings / Stream). Forked from legacy DevelopingSubtabs but driven
 * by the Labs3Subtab union + LABS3_SUBTABS from constants so the tab list has a
 * single source of truth shared with the shell's URL validation.
 *
 * Visuals are intentionally identical to legacy so the two modules read as one
 * design system.
 */

import { LABS3_SUBTABS, type Labs3Subtab } from './constants';

export function DevelopingSubtabs({
  active,
  onChange,
}: {
  active: Labs3Subtab;
  onChange: (t: Labs3Subtab) => void;
}) {
  return (
    <div style={{ padding: '28px 0 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        {LABS3_SUBTABS.map((t) => {
          const on = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              aria-pressed={on}
              onMouseEnter={(e) => {
                if (!on) e.currentTarget.style.color = 'var(--text-dim)';
              }}
              onMouseLeave={(e) => {
                if (!on) e.currentTarget.style.color = 'var(--text-mute)';
              }}
              style={{
                padding: '14px 24px',
                fontSize: 12,
                color: on ? 'var(--foreground)' : 'var(--text-mute)',
                fontWeight: 400,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                borderBottom: `1px solid ${on ? 'var(--foreground)' : 'transparent'}`,
                marginBottom: -1,
                background: 'transparent',
                border: 'none',
                borderBottomStyle: 'solid',
                cursor: 'pointer',
                transition: 'color 150ms, border-color 150ms',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
