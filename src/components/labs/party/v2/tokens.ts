/**
 * Design tokens for the Party Mode V2 UI.
 *
 * These constants are deliberately CSS-variable references (not hex values).
 * That way every `style={{ background: COLORS.bgSurface }}` inline style
 * gets resolved by the theme system — dark mode uses the Discord palette,
 * light mode uses the brighter palette. Hex literals are defined once in
 * `src/app/globals.css` under `--party-*` (see :root + .dark blocks).
 *
 * Mirrors the spec at `docs/concepts/party-mode/party-mode-ui2.md` §3 —
 * with the brightness inversion for light mode added as part of the
 * holistic theme pass.
 */

// Slimmed from 56 → 48 in the 2026-06 "full vertical space" pass — every
// pane header row shares this so the top edge stays aligned across columns.
export const HEADER_H = 48;

/** Width of the far-right icon strip (Rounds / Docs / Questions / Audit). */
export const RAIL_STRIP_W = 44;

/** localStorage key for the active right-rail tab ('rounds' | 'uploads' | …). */
export const RAIL_TAB_KEY = 'partyMode.railTab';

export const COLORS = {
  bgDeepest: 'var(--party-bg-deepest)',
  bgSurface: 'var(--party-bg-surface)',
  bgContent: 'var(--party-bg-content)',
  bgElevated: 'var(--party-bg-elevated)',
  bgInput: 'var(--party-bg-input)',

  textPrimary: 'var(--party-text-primary)',
  textBody: 'var(--party-text-body)',
  textMuted: 'var(--party-text-muted)',
  textFaint: 'var(--party-text-faint)',

  accentBrand: 'var(--party-accent-brand)',
  accentOrch: 'var(--accent-purple)',
  accentOrchSoft: 'var(--party-accent-orch-soft)',
  accentLive: 'var(--success)',
  accentSuccess: 'var(--success)',

  inlineCode: 'var(--party-inline-code)',
  inlineLink: 'var(--accent-blue)',
} as const;

export const PANE_DEFAULTS = {
  left: 340,
  right: 280,
  leftMin: 240,
  leftMax: 600,
  rightMin: 200,
  rightMax: 480,
} as const;

export const PANE_SIZES_KEY = 'partyMode.paneSizes';

export const DRAWER_DEFAULTS = {
  width: 680,
  min: 360,
  max: 1200,
} as const;

export const DRAWER_WIDTH_KEY = 'partyMode.drawerWidth';
