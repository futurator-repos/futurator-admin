'use client';

/**
 * Labs3 sub-tabs — the SDD surface switcher (Graph / Git Graph / Stories / QA /
 * Skills & Learnings / Stream). Forked from legacy DevelopingSubtabs but driven
 * by the Labs3Subtab union + LABS3_SUBTABS from constants so the tab list has a
 * single source of truth shared with the shell's URL validation.
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
 *    and THEN `border: 'none'` afterward (plus a trailing
 *    `borderBottomStyle: 'solid'` bandage). Setting the `border` shorthand
 *    resets every longhand it covers — including the width/color just set by
 *    `borderBottom` — so the final computed border-bottom had NO explicit
 *    color or width, only `style: solid`, which resolves to `currentColor`
 *    (the button's own text color) at the browser-default `medium` width.
 *    Net effect: EVERY tab — active AND inactive — rendered a colored
 *    underline (dim for inactive, bright for active), not just the active
 *    one. That is exactly "underlines span across groups of tabs, active tab
 *    unclear." Fix: reset (`background`/`border: 'none'`) BEFORE setting the
 *    real `borderBottom`, and drop the now-redundant `borderBottomStyle`.
 * 2. Compounding — this fork added `flexWrap: 'wrap'` on the row (legacy
 *    sibling has none) to fit 7 labels instead of legacy's 6. The single
 *    `borderBottom` track lives on the CONTAINER and each button overlays its
 *    own underline onto that exact line via `marginBottom: -1` — correct only
 *    when every tab shares one row. If the row ever wraps, the track sits
 *    under the LAST row only, so a first-row tab's underline floats above
 *    whatever is in row two. Fix: never wrap; scroll horizontally instead, so
 *    the track and every tab's overlaid underline are always on one line.
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
        role="tablist"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          borderBottom: '1px solid var(--border)',
          flexWrap: 'nowrap',
          overflowX: 'auto',
        }}
      >
        {LABS3_SUBTABS.map((t) => {
          const on = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              onClick={() => onChange(t.id)}
              aria-pressed={on}
              aria-selected={on}
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
                // Reset FIRST — the `border` shorthand resets every longhand
                // it covers, so it must run before the real borderBottom
                // value is set, or the color/width below get wiped (see the
                // file-header note: this ordering bug used to underline
                // every tab, not just the active one).
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
