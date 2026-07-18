'use client';

/**
 * SubtabRow — the stage-scoped surface switcher. Generalized from the old
 * DevelopingSubtabs: it now takes an explicit `{tabs, active, onChange}` and
 * holds NO stage knowledge of its own — the shell (PlanSpecDashboard) passes
 * the selected stage's ordered subtab set. A stage with a single subtab renders
 * no row at all (the shell omits it).
 *
 * Visuals are intentionally identical to legacy so the two modules read as one
 * design system.
 *
 * Bug fix (2026-07-13, operator screenshot — ambiguous active tab), two
 * compounding causes traced and fixed at the source (verified against jsdom's
 * CSSStyleDeclaration, which implements the same shorthand-reset semantics as
 * real browsers):
 *
 * 1. REAL root cause — inline-style key ORDER. React applies a `style` object
 *    as sequential CSSOM property assignments in object-key order. The old
 *    per-button style set `borderBottom: '1px solid <color-or-transparent>'`
 *    and THEN `border: 'none'` afterward. Setting the `border` shorthand resets
 *    every longhand it covers — including the width/color just set by
 *    `borderBottom` — so the final computed border-bottom had NO explicit color
 *    or width, only `style: solid`, resolving to `currentColor` at the default
 *    `medium` width. Net: EVERY tab rendered a colored underline. Fix: reset
 *    (`background`/`border: 'none'`) BEFORE setting the real `borderBottom`.
 * 2. Compounding — `flexWrap: 'wrap'` on the row floated first-row underlines
 *    above the single container track. Fix: never wrap; scroll horizontally.
 */

import type { Labs3Subtab } from './constants';

export interface SubtabRowTab {
  id: Labs3Subtab;
  label: string;
}

export function SubtabRow({
  tabs,
  active,
  onChange,
}: {
  /** The ordered subtab set to render (already scoped to the selected stage). */
  tabs: SubtabRowTab[];
  active: Labs3Subtab;
  onChange: (t: Labs3Subtab) => void;
}) {
  return (
    <div style={{ padding: '28px 0 0' }}>
      <div
        role="tablist"
        aria-label="Stage surfaces"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          borderBottom: '1px solid var(--border)',
          flexWrap: 'nowrap',
          overflowX: 'auto',
        }}
      >
        {tabs.map((t) => {
          const on = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              onClick={() => onChange(t.id)}
              aria-selected={on}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] focus-visible:ring-inset"
              onMouseEnter={(e) => {
                if (!on) e.currentTarget.style.color = 'var(--text-dim)';
              }}
              onMouseLeave={(e) => {
                if (!on) e.currentTarget.style.color = 'var(--text-mute)';
              }}
              style={{
                flex: '0 0 auto',
                whiteSpace: 'nowrap',
                padding: '14px 24px',
                fontSize: 12,
                color: on ? 'var(--foreground)' : 'var(--text-mute)',
                fontWeight: 400,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                // Reset FIRST — the `border` shorthand resets every longhand it
                // covers, so it must run before the real borderBottom value is
                // set, or the color/width below get wiped (see file-header note).
                background: 'transparent',
                border: 'none',
                borderBottom: `1px solid ${on ? 'var(--foreground)' : 'transparent'}`,
                marginBottom: -1,
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
