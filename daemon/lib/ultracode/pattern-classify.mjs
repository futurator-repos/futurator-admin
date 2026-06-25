// pattern-classify.mjs — shared deterministic classifier (design doc §5).
// Maps a phase-name sequence (+ light structural features) → Pattern, so BOTH projectors
// classify consistently. Order matters: more specific skeletons are tested first.

const norm = (s) => String(s || '').toLowerCase();

/**
 * @param {string[]} phaseNames  ordered phase titles (from meta.phases or wave layering)
 * @param {{hasBuild?:boolean, hasMerge?:boolean, groundingFirst?:boolean, allFanOutNoBuild?:boolean}} [features]
 * @returns {import('./decision-schema.mjs').Pattern}
 */
export function classifyPattern(phaseNames, features = {}) {
  const names = (phaseNames || []).map(norm);
  const has = (re) => names.some((n) => re.test(n));
  const idx = (re) => names.findIndex((n) => re.test(n));

  // brownfield-harden: a grounding/scout/map phase appears at position 0.
  const groundIdx = idx(/scout|map|cartograph|ground|recon|inventory/);
  if (features.groundingFirst || groundIdx === 0) return 'brownfield-harden';

  // build-verify-fix: Build/Implement → Review/Verify → Fix
  if (has(/build|implement/) && has(/review|verif|critique|refut/) && has(/fix|repair|resolve/)) {
    return 'build-verify-fix';
  }

  // plan-synthesis-critique: Design/Architecture/Domain decomposition → Synthesize → Critique.
  // (Broadened so real ultracode plans like Foundation→Domain Plans→Critique→Synthesis are
  // recognized instead of falling through to 'other' — 2026-06-25.)
  const planDecomp = /dimension|expert|breakdown|elicit|design|architect|foundation|domain|subsystem|component|aspect/;
  if (
    has(planDecomp) &&
    has(/synth|assemble|merge|combine|decompose|consolidat|final plan|plan doc/) &&
    has(/critique|review|refine|assess|evaluat/)
  ) {
    return 'plan-synthesis-critique';
  }
  // looser plan-synthesis: a breakdown/decompose/domain-expert phase with no build phase
  if (
    has(/breakdown|elicit|dimension|decompose|domain|subsystem|architect|foundation/) &&
    !has(/build|implement|scaffold/)
  ) {
    return 'plan-synthesis-critique';
  }

  // greenfield-build: Design → Scaffold → Implement → Integrate (the heavy build skeleton)
  if (has(/design/) && has(/scaffold/) && has(/implement/)) {
    return 'greenfield-build';
  }

  // research: parallel finders → synthesize, no build/merge-to-trunk.
  if (features.allFanOutNoBuild || (has(/research|find|gather|explore/) && has(/synth|report|summar/) && !has(/build|implement|merge/))) {
    return 'research';
  }

  return 'other';
}
