/**
 * Design tokens for the Party Mode V2 UI.
 * Mirrors `docs/concepts/party-mode/party-mode-ui2.md` §3 so we have one
 * source of truth and can reference these values from styles + JS alike.
 */

export const HEADER_H = 56;

export const COLORS = {
  bgDeepest: '#1e1f22',
  bgSurface: '#2b2d31',
  bgContent: '#313338',
  bgElevated: '#383a40',
  bgInput: '#1e1f22',

  textPrimary: '#f2f3f5',
  textBody: '#dbdee1',
  textMuted: '#949ba4',
  textFaint: '#80848e',

  accentBrand: '#5865f2',
  accentOrch: '#a78bfa',
  accentOrchSoft: '#c4b5fd',
  accentLive: '#4ade80',
  accentSuccess: '#23a55a',

  inlineCode: '#f9a8d4',
  inlineLink: '#00a8fc',
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
