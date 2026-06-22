// D4(a) (2026-06-22) — PROACTIVE plan-gen budget guard.
//
// The pm-plan generation emits the WHOLE epic/story tree in one shot. A large
// grounded spec (big approved PRD + UX + Architecture, inlined into the prompt
// at dispatch by loadAllConceptArtifacts) renders a huge prompt and tends to
// produce a huge plan — which can overflow the CLI output cap
// (CLAUDE_CODE_MAX_OUTPUT_TOKENS) mid-JSON, so the closing fence is never
// written and NOTHING is captured (the pacmanv3 32K truncation).
//
// D4(b) cures this REACTIVELY: the concept-driver re-fires an empty pm-plan in
// compact mode. This module adds the PROACTIVE half — estimate the rendered
// prompt size at dispatch and, when it is large, inject a compact directive so
// the FIRST attempt already aims small, saving a wasted ~30-minute generation.
//
// Conservative by design: a false negative just falls back to D4(b); a false
// positive only makes a borderline plan terser. The true cure for specs too
// large for even a compact single generation is per-epic decomposition (dynamic
// step fan-out), which requires daemon orchestration support and is tracked
// separately.

// Rendered-prompt char count beyond which a single-shot plan risks the cap.
// ~24k chars of grounded spec empirically correlates with plans large enough to
// truncate. production plans skew larger, so their bar is lower.
export const COMPACT_PROMPT_CHAR_THRESHOLD = 24000;

// Each plan story renders to ~1.2k–1.6k output chars (id/title/description +
// ACs + userStory/technicalNotes/tasks at mvp+). The CLI output cap is
// CLAUDE_CODE_MAX_OUTPUT_TOKENS tokens ≈ 4 chars/token. We budget story COUNT
// against the OUTPUT cap, not the input prompt size — but the prompt size is
// the proxy we have at dispatch for "how much the model will want to emit".
const CHARS_PER_OUTPUT_TOKEN = 4;
const CHARS_PER_STORY = 1500;
// Headroom: never let the planned stories' rendered size exceed this fraction
// of the output cap (leaves room for the epic envelope + the closing fence).
const OUTPUT_BUDGET_FRACTION = 0.6;

/**
 * Decide whether the pm-plan prompt is large enough to warrant proactive
 * compaction.
 *
 * @param {object} input
 * @param {number} input.renderedChars - length of the fully-substituted prompt
 * @param {string} [input.rigor] - 'prototype' | 'mvp' | 'production'
 * @returns {boolean}
 */
export function shouldCompactPlanGen({ renderedChars, rigor } = {}) {
  if (typeof renderedChars !== 'number' || !Number.isFinite(renderedChars) || renderedChars <= 0) {
    return false;
  }
  const threshold =
    rigor === 'production' ? Math.round(COMPACT_PROMPT_CHAR_THRESHOLD * 0.8) : COMPACT_PROMPT_CHAR_THRESHOLD;
  return renderedChars >= threshold;
}

/**
 * D4(a) (2026-06-22) — derive a CONCRETE story ceiling that fits the OUTPUT
 * cap, so the proactive directive gives the planner a hard number that scales
 * with the actual cap instead of a vague "be compact". A bigger cap → more
 * stories allowed; a tighter cap → fewer. The ceiling is clamped to a sane
 * floor (a complex app still needs a handful of stories) and to the rigor's
 * own soft ceiling (production may go a bit higher than mvp).
 *
 * @param {object} input
 * @param {number} [input.maxOutputTokens] - CLAUDE_CODE_MAX_OUTPUT_TOKENS (default 32000, the CLI default)
 * @param {string} [input.rigor]
 * @returns {number} recommended max story count
 */
export function estimateStoryBudget({ maxOutputTokens, rigor } = {}) {
  const cap =
    typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? maxOutputTokens
      : 32000;
  const budgetChars = cap * CHARS_PER_OUTPUT_TOKEN * OUTPUT_BUDGET_FRACTION;
  const raw = Math.floor(budgetChars / CHARS_PER_STORY);
  // Clamp: floor 4 (even a tight cap must allow a minimal vertical-slice plan),
  // rigor-aware soft ceiling so we never *raise* the in-prompt budget contract.
  const ceiling = rigor === 'production' ? 18 : 12;
  return Math.max(4, Math.min(ceiling, raw));
}

/**
 * Build the proactive directive with a CONCRETE story ceiling baked in.
 *
 * @param {number} storyBudget
 * @returns {string}
 */
export function renderPlanCompactDirective(storyBudget) {
  const n = typeof storyBudget === 'number' && storyBudget > 0 ? storyBudget : 8;
  return `> ⚠️ PROACTIVE BUDGET GUARD — this is a LARGE grounded spec and the output cap
> is tight. Emit a COMPACT plan of AT MOST ${n} stories TOTAL across all epics:
> group related requirements into the fewest vertical slices that still cover
> them (coverage is proven by requirementRefs, NOT story count), keep every
> \`description\` to ONE sentence, omit \`technicalNotes\`/\`tasks\` unless essential,
> and you MUST close the \`---END_PLAN_JSON---\` fence. A complete, closed plan of
> ≤ ${n} stories is REQUIRED; an exhaustive plan that truncates mid-JSON is
> REJECTED and costs a full retry.

`;
}

/**
 * Back-compat: the static directive (no concrete number). Retained so existing
 * imports keep working; new call sites get the numbered version via
 * `applyProactivePlanBudget`.
 */
export const PLAN_COMPACT_DIRECTIVE = renderPlanCompactDirective(8);

/**
 * If the prompt is large, prepend a compact directive carrying a concrete story
 * ceiling sized to the output cap. Returns the (possibly unchanged) prompt plus
 * whether it was injected and the computed budget, for logging.
 *
 * @param {string} prompt
 * @param {object} [opts] - { rigor, maxOutputTokens }
 * @returns {{ prompt: string, injected: boolean, storyBudget: number }}
 */
export function applyProactivePlanBudget(prompt, opts = {}) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { prompt, injected: false, storyBudget: 0 };
  }
  if (!shouldCompactPlanGen({ renderedChars: prompt.length, rigor: opts.rigor })) {
    return { prompt, injected: false, storyBudget: 0 };
  }
  const storyBudget = estimateStoryBudget({
    maxOutputTokens: opts.maxOutputTokens,
    rigor: opts.rigor,
  });
  return {
    prompt: `${renderPlanCompactDirective(storyBudget)}${prompt}`,
    injected: true,
    storyBudget,
  };
}
