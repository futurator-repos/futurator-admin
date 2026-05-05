/**
 * Multi-plan color system (Epic C).
 *
 * One plan ↔ one palette slot. Deterministic hashing of planId → index so
 * the same plan always gets the same color across remounts and clients.
 *
 * The palette is a curated 8-color ramp drawn from Tailwind's accent hues —
 * high-contrast against the office's warm wall tone (`#e9dfc7`) and
 * distinguishable under colorblind simulation (deuter/protanopia safe).
 * We deliberately avoid red (reserved for failure states) and grey
 * (reserved for "unassigned" / legacy plans with no planId).
 *
 * Palette is used in three surfaces:
 *   1. 3D scene desk-tag mesh color per occupying assignment
 *   2. Chat bubble border tint (Epic E)
 *   3. Kanban filter chip background (Epic C.3)
 */

export interface PlanPaletteEntry {
  /** Hex for Three.js materials / inline style backgrounds. */
  hex: string;
  /** Tailwind text class for chip labels. */
  textClass: string;
  /** Tailwind bg class for chip backgrounds (at 20% alpha for legibility). */
  bgClass: string;
  /** Tailwind border class for chip borders (at 40% alpha). */
  borderClass: string;
  /** Display name, used in tooltips. */
  name: string;
}

export const PLAN_PALETTE: readonly PlanPaletteEntry[] = [
  {
    hex: '#22d3ee',
    textClass: 'text-cyan-200',
    bgClass: 'bg-cyan-500/20',
    borderClass: 'border-cyan-400/40',
    name: 'cyan',
  },
  {
    hex: '#a78bfa',
    textClass: 'text-violet-200',
    bgClass: 'bg-violet-500/20',
    borderClass: 'border-violet-400/40',
    name: 'violet',
  },
  {
    hex: '#34d399',
    textClass: 'text-emerald-200',
    bgClass: 'bg-emerald-500/20',
    borderClass: 'border-emerald-400/40',
    name: 'emerald',
  },
  {
    hex: '#fbbf24',
    textClass: 'text-amber-200',
    bgClass: 'bg-amber-500/20',
    borderClass: 'border-amber-400/40',
    name: 'amber',
  },
  {
    hex: '#f472b6',
    textClass: 'text-pink-200',
    bgClass: 'bg-pink-500/20',
    borderClass: 'border-pink-400/40',
    name: 'pink',
  },
  {
    hex: '#60a5fa',
    textClass: 'text-blue-200',
    bgClass: 'bg-blue-500/20',
    borderClass: 'border-blue-400/40',
    name: 'blue',
  },
  {
    hex: '#fb923c',
    textClass: 'text-orange-200',
    bgClass: 'bg-orange-500/20',
    borderClass: 'border-orange-400/40',
    name: 'orange',
  },
  {
    hex: '#5eead4',
    textClass: 'text-teal-200',
    bgClass: 'bg-teal-500/20',
    borderClass: 'border-teal-400/40',
    name: 'teal',
  },
] as const;

/** Fallback entry for legacy plans (planId === null). Neutral grey. */
export const UNASSIGNED_PLAN_PALETTE: PlanPaletteEntry = {
  hex: '#94a3b8',
  textClass: 'text-slate-300',
  bgClass: 'bg-slate-500/20',
  borderClass: 'border-slate-400/40',
  name: 'slate',
};

/**
 * Deterministic hash: planId → index ∈ [0, PLAN_PALETTE.length). Uses FNV-1a
 * 32-bit for good distribution over short string IDs. Stable across
 * JavaScript engines — no dependency on `crypto` / `subtle` / salt.
 */
export function hashPlanIdToPaletteIndex(planId: string): number {
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < planId.length; i++) {
    h ^= planId.charCodeAt(i);
    // 32-bit FNV prime multiply via Math.imul for correct overflow.
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned then modulo into palette range.
  return (h >>> 0) % PLAN_PALETTE.length;
}

/** Convenience: resolve planId → palette entry (or UNASSIGNED for null). */
export function paletteForPlanId(planId: string | null | undefined): PlanPaletteEntry {
  if (!planId) return UNASSIGNED_PLAN_PALETTE;
  return PLAN_PALETTE[hashPlanIdToPaletteIndex(planId)];
}
