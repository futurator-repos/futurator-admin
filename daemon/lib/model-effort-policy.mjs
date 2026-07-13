// model-effort-policy — WHO thinks HOW HARD, per pipeline agent. PURE.
//
// Grounded in Anthropic's adaptive-thinking model (docs/build-with-claude/
// adaptive-thinking): on modern models (Sonnet 5 default-on, Opus 4.8/Fable 5
// adaptive-only) the model decides WHEN to think; the `effort` level
// (low|medium|high|xhigh|max) is soft guidance the Claude Code CLI accepts via
// `--effort`. Haiku does NOT support adaptive thinking — it stays the cheap
// no-thinking tier for mechanical roles (judge only, as of the 2026-07-11
// three-tier ladder below — haiku was retired from the dev ladder).
//
// The policy (operator directive, 2026-07-13): sonnet for easy work,
// opus-4-8 for everything load-bearing. Fable 5 was REMOVED from the ladder
// on 2026-07-13 — it is deactivated on the Claude Code Max subscription, so
// any seat defaulting to it would fail to spawn; opus-4-8 at high effort is
// the top tier. The PLANNER is the single highest-leverage artifact in the
// pipeline (a shallow plan poisons every downstream story), so it gets the
// strongest available model. Implementers scale with story complexity;
// reviewers/judges stay cheap unless risk demands otherwise; the
// plan-critique fresh-eyes pass gets a dedicated opus-4-8/medium seat (plan
// defects are the most expensive class to catch late):
//
//   role          default model        effort           escalation
//   ─────────────────────────────────────────────────────────────────────────
//   planner       claude-opus-4-8      high             (quick-planspec: the plan IS the leverage)
//   test-author   claude-sonnet-5      high             tests carry the spec
//   dev           by story complexity:
//                   trivial       → claude-sonnet-5 low   (haiku retired from dev ladder)
//                   standard      → claude-sonnet-5 medium
//                   complex       → claude-opus-4-8 medium
//                   architectural → claude-opus-4-8 medium
//   critic        claude-opus-4-8      medium           plan-critique fresh-eyes pass
//   reviewer      claude-sonnet-5      low              P0/security ACs → high
//   judge (VQA)   haiku                —                cheap frame verdicts
//   reflector     claude-sonnet-5      medium
//   integrator    claude-opus-4-8      high             (medium-difficult tier per the ladder)
//
// Every cell is env-overridable (P3_<ROLE>_MODEL / P3_<ROLE>_EFFORT) and
// plan-level overrides (plan.devModel/devEffort/testModel/reviewerModel/
// reviewerEffort — fields that already exist on the Plan row) win over both.
//
// HAIKU RULE: never emit an effort for a haiku model (the flag is meaningless
// there and older CLI builds reject unknown combinations) — cliModelArgs()
// drops it automatically.

const DEFAULTS = Object.freeze({
  // 2026-07-13 — planner on Opus 4.8 (Fable 5 is deactivated on the Max
  // subscription; a fable default would fail every planner spawn). The plan
  // is the single highest-leverage artifact in the pipeline (a shallow plan
  // caps every downstream story's quality — the "lame app" root cause), so it
  // gets the strongest available model at high adaptive effort.
  // Env-overridable via P3_PLANNER_MODEL.
  planner: { model: 'claude-opus-4-8', effort: 'high' },
  'test-author': { model: 'claude-sonnet-5', effort: 'high' },
  // Reality-Spine P3 (redesign Part 2, Part 5 #4) — the INTEGRATOR is the ONE
  // whole-tree actor: it holds the entire assembled artifact in one context and
  // fixes cross-cutting integration defects no scope-jailed slice can. It sits
  // at the same opus-4-8/high tier as the planner/architectural seats.
  // Env-overridable via P3_INTEGRATOR_MODEL / P3_INTEGRATOR_EFFORT;
  // plan.integratorModel wins.
  integrator: { model: 'claude-opus-4-8', effort: 'high' },
  // 2026-07-11 — dedicated critic seat. The plan-critique fresh-eyes pass
  // previously fell back to the reviewer's sonnet/low; plan defects are the
  // most expensive class to catch late, so it's worth a medium-tier read.
  // resolveAgentPolicy role 'critic' now resolves directly (no fallback).
  critic: { model: 'claude-opus-4-8', effort: 'medium' },
  reviewer: { model: 'claude-sonnet-5', effort: 'low' },
  reflector: { model: 'claude-sonnet-5', effort: 'medium' },
  judge: { model: 'haiku', effort: null },
});

// 2026-07-11 ladder, amended 2026-07-13: haiku retired from the dev ladder
// entirely; trivial gets sonnet at low effort (still cheap and fast, but
// keeps adaptive-thinking support instead of haiku's no-thinking floor).
// complex AND architectural both resolve to opus-4-8/high — Fable 5 was
// removed on 2026-07-13 (deactivated on the Max subscription; a fable
// default would fail the spawn). architectural stays a distinct complexity
// tier so a future stronger model can slot in via one line here.
// 2026-07-13 (pacman1 forensics): complex/architectural implementers dropped
// high→medium effort. At effort:high the foundation implementer spent a
// 3.7-minute silent thinking block on a fully test-specified contract story —
// the authored tests carry the spec and the deterministic gates carry the
// safety, so implementer-tier deep thinking buys latency, not correctness.
// Planner/integrator (the genuinely open-ended seats) stay high.
const DEV_BY_COMPLEXITY = Object.freeze({
  trivial: { model: 'claude-sonnet-5', effort: 'low' },
  standard: { model: 'claude-sonnet-5', effort: 'medium' },
  complex: { model: 'claude-opus-4-8', effort: 'medium' },
  architectural: { model: 'claude-opus-4-8', effort: 'medium' },
});

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function envKey(role, kind) {
  return `P3_${role.toUpperCase().replace(/-/g, '_')}_${kind}`;
}

function isHaiku(model) {
  return /haiku/i.test(String(model || ''));
}

/**
 * Resolve { model, effort } for one pipeline agent. PURE (env injected).
 *
 * @param {{
 *   role: 'planner'|'test-author'|'dev'|'critic'|'reviewer'|'reflector'|'judge'|'integrator',
 *   complexity?: 'trivial'|'standard'|'complex'|'architectural',
 *   riskTags?: string[],            // AC riskTags — P0 present escalates the reviewer
 *   overrides?: { model?: string, effort?: string },  // plan-level (devModel/devEffort…)
 *   env?: Record<string, string|undefined>,
 * }} args
 * @returns {{ model: string, effort: string|null }}
 */
export function resolveAgentPolicy({ role, complexity, riskTags = [], overrides = {}, env = process.env } = {}) {
  let base;
  if (role === 'dev') {
    base = DEV_BY_COMPLEXITY[complexity] || DEV_BY_COMPLEXITY.standard;
  } else {
    base = DEFAULTS[role] || DEFAULTS.reviewer;
  }

  let model = overrides.model || env[envKey(role, 'MODEL')] || base.model;
  let effort = overrides.effort || env[envKey(role, 'EFFORT')] || base.effort;

  // Risk escalation: a reviewer facing P0 (security-critical) ACs thinks hard.
  if (role === 'reviewer' && riskTags.includes('P0') && !overrides.effort && !env[envKey(role, 'EFFORT')]) {
    effort = 'high';
  }

  if (!EFFORTS.has(String(effort))) effort = null;
  if (isHaiku(model)) effort = null; // adaptive thinking/effort unsupported on haiku
  return { model, effort };
}

/** CLI arg fragment for a resolved policy: ['--model', m, '--effort', e?]. */
export function cliModelArgs(policy) {
  if (!policy?.model) return [];
  const args = ['--model', policy.model];
  if (policy.effort) args.push('--effort', policy.effort);
  return args;
}
