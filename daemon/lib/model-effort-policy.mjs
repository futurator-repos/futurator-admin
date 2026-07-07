// model-effort-policy — WHO thinks HOW HARD, per pipeline agent. PURE.
//
// Grounded in Anthropic's adaptive-thinking model (docs/build-with-claude/
// adaptive-thinking): on modern models (Sonnet 5 default-on, Opus 4.8/Fable 5
// adaptive-only) the model decides WHEN to think; the `effort` level
// (low|medium|high|xhigh|max) is soft guidance the Claude Code CLI accepts via
// `--effort`. Haiku does NOT support adaptive thinking — it stays the cheap
// no-thinking tier for mechanical roles.
//
// The policy (operator intuition, 2026-07-04): the PLANNER deserves the most
// thinking (a bad plan poisons every downstream story), implementers scale
// with story complexity, and reviewers/judges are cheap unless risk demands
// otherwise:
//
//   role          default model        effort           escalation
//   ─────────────────────────────────────────────────────────────────────────
//   planner       claude-opus-4-8      high             (quick-planspec: the plan IS the leverage)
//   test-author   claude-sonnet-5      high             tests carry the spec
//   dev           by story complexity:
//                   trivial   → haiku                  (no adaptive; speed)
//                   standard  → claude-sonnet-5 medium
//                   complex   → claude-sonnet-5 high
//                   architectural → claude-opus-4-8 high
//   reviewer      claude-sonnet-5      low              P0/security ACs → high
//   judge (VQA)   haiku                —                cheap frame verdicts
//   reflector     claude-sonnet-5      medium
//
// Every cell is env-overridable (P3_<ROLE>_MODEL / P3_<ROLE>_EFFORT) and
// plan-level overrides (plan.devModel/devEffort/testModel/reviewerModel/
// reviewerEffort — fields that already exist on the Plan row) win over both.
//
// HAIKU RULE: never emit an effort for a haiku model (the flag is meaningless
// there and older CLI builds reject unknown combinations) — cliModelArgs()
// drops it automatically.

const DEFAULTS = Object.freeze({
  // 2026-07-07 — planner upgraded to Opus 4.8. The plan is the single highest-
  // leverage artifact in the pipeline (a shallow plan caps every downstream
  // story's quality — the "lame app" root cause), so it gets the strongest
  // model + high adaptive effort. Env-overridable via P3_PLANNER_MODEL.
  planner: { model: 'claude-opus-4-8', effort: 'high' },
  'test-author': { model: 'claude-sonnet-5', effort: 'high' },
  reviewer: { model: 'claude-sonnet-5', effort: 'low' },
  reflector: { model: 'claude-sonnet-5', effort: 'medium' },
  judge: { model: 'haiku', effort: null },
});

const DEV_BY_COMPLEXITY = Object.freeze({
  trivial: { model: 'haiku', effort: null },
  standard: { model: 'claude-sonnet-5', effort: 'medium' },
  complex: { model: 'claude-sonnet-5', effort: 'high' },
  architectural: { model: 'claude-opus-4-8', effort: 'high' },
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
 *   role: 'planner'|'test-author'|'dev'|'reviewer'|'reflector'|'judge',
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
