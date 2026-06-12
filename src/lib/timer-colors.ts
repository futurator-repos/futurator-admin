/**
 * Timer Intelligence — colorblind-friendly palette for the 15 TimerCategory values.
 *
 * Palette derived from Wong (2011) "Points of view: Color blindness" (Nature Methods 8, 441)
 * and Okabe & Ito (2002). Hand-picked for deuteranopia safety.
 *
 * Wong 2011 base 8: #000000, #E69F00, #56B4E9, #009E73, #F0E442, #0072B2, #D55E00, #CC79A7
 * Additional 7 derived from contrast-safe extensions of the same palette.
 *
 * Semantic groupings:
 *   Primary work   → vivid hues (blue, teal, orange family)
 *   Waiting        → muted (gray-blue, slate)
 *   Operational    → mid-range (purple, olive)
 *   Rework (fix)   → red-tinted (#D55E00 — safe for deuteranopia, reads as warning)
 *   Idle           → very light gray
 *   Unattributed   → bright magenta (should never appear; glaring if it does)
 */

import type { TimerCategory } from '../../functions/shared/timer/types';

export const TIMER_COLORS: Record<TimerCategory, string> = {
  // Primary dev work — vivid blue (Wong #0072B2)
  dev: '#0072B2',

  // Test authoring — teal (Wong #009E73)
  'test-author': '#009E73',

  // Test execution — darker teal variant
  'test-execute': '#00705A',

  // Code review — warm amber (Wong #E69F00)
  review: '#E69F00',

  // QA phase — sky blue (Wong #56B4E9)
  qa: '#56B4E9',

  // Product-owner / spec — gold-yellow (Wong #F0E442, darkened for contrast)
  po: '#C8BC00',

  // Architect pass — deep blue-purple (Okabe & Ito extension)
  architect: '#4B0082',

  // Baseline regression gate — muted teal-gray
  'baseline-check': '#5E8076',

  // Tamper check — muted plum
  'tamper-check': '#8E6B8E',

  // Compile / orchestrator machinery — medium olive-gray
  compile: '#6B7A5E',

  // Wave merge gate (merge + rigor-composed quality stages) — deep slate-blue
  'merge-gate': '#3E5C76',

  // Wave VQA gate (evidence/judges/triage/fixer on the merged candidate) —
  // vivid purple: judged verification is primary signal, not machinery.
  'vqa-gate': '#7D3FBF',

  // Human-wait — muted slate (neutral, not alarming)
  'human-wait': '#7B8FA8',

  // Machine-wait — cool gray-blue
  'machine-wait': '#9BAEC0',

  // Git operations — indigo (distinct from blue)
  git: '#5050C8',

  // Bootstrap — warm gray
  bootstrap: '#A89060',

  // Fix / rework — red-tinted orange (Wong #D55E00 — safe for deuteranopia)
  fix: '#D55E00',

  // Idle — very light gray (structural near-zero slices)
  idle: '#C8C8C8',

  // Unattributed — bright magenta (MUST NOT appear in practice; glaring if it does)
  unattributed: '#FF00FF',
};

/** Human-readable display label for each category */
export const TIMER_CATEGORY_LABELS: Record<TimerCategory, string> = {
  dev: 'Dev',
  'test-author': 'Test Author',
  'test-execute': 'Test Execute',
  review: 'Review',
  qa: 'QA',
  po: 'PO',
  architect: 'Architect',
  'baseline-check': 'Baseline Check',
  'tamper-check': 'Tamper Check',
  compile: 'Compile',
  'merge-gate': 'Merge Gate',
  'vqa-gate': 'VQA Gate',
  'human-wait': 'Human Wait',
  'machine-wait': 'Machine Wait',
  git: 'Git',
  bootstrap: 'Bootstrap',
  fix: 'Fix',
  idle: 'Idle',
  unattributed: 'Unattributed',
};

/** Ordered list of all 15 categories for stable rendering order */
export const TIMER_CATEGORY_ORDER: TimerCategory[] = [
  'dev',
  'test-author',
  'test-execute',
  'review',
  'qa',
  'po',
  'architect',
  'baseline-check',
  'tamper-check',
  'compile',
  'merge-gate',
  'vqa-gate',
  'human-wait',
  'machine-wait',
  'git',
  'bootstrap',
  'fix',
  'idle',
  'unattributed',
];
