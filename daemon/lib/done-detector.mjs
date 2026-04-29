// Pipeline v2.0 efficiency fixes T0.1 + PR-6 (B).
//
// Detects whether an agent emitted a "complete output" signal in its
// streamed prose. Used by `runAgent`'s close handler to convert a forced
// termination (COST_HARD, OAuth expiry, OOM-kill, SIGTERM) into a success
// when the agent has already finished — the work is captured; retrying
// would just re-discover the same conclusion at the same cost.
//
// Per-step completion contracts:
//
//   DEV / TEST / retry:     `---DONE---`        + `---WORK_SUMMARY---`
//   REVIEWER:               `---REVIEW_CRITERIA---` + `---END_REVIEW_CRITERIA---`
//   COMPILER / generic:     `---DONE---`        (no WORK_SUMMARY required)
//
// All markers must appear on their own line (line-anchored regex) — defends
// against false-positives from tool inputs that happen to embed the literal
// (e.g., an Edit call modifying a file containing `---DONE---` as text).
//
// Pure functions; no side effects, no I/O.
//
// dino1 forensic (2026-04-28): COST_HARD-after-DONE wasted ~$35 per no-op
// story before T0.1 shipped.
// dino-N forensic (2026-04-29): OAuth expired AFTER reviewer emitted complete
// `---REVIEW_CRITERIA---` block. Without B, the verdict was thrown away.

/** DEV/retry/TEST contract: DONE + WORK_SUMMARY both on own lines. */
function hasDevCompletion(text) {
  if (!/^---DONE---\s*$/m.test(text)) return false;
  if (!/^---WORK_SUMMARY---\s*$/m.test(text)) return false;
  return true;
}

/** REVIEWER contract: REVIEW_CRITERIA bracket pair on own lines. */
function hasReviewerCompletion(text) {
  if (!/^---REVIEW_CRITERIA---\s*$/m.test(text)) return false;
  if (!/^---END_REVIEW_CRITERIA---\s*$/m.test(text)) return false;
  return true;
}

/** Generic / COMPILER contract: DONE on own line, regardless of WORK_SUMMARY. */
function hasGenericCompletion(text) {
  return /^---DONE---\s*$/m.test(text);
}

/**
 * Returns true iff the agent emitted any recognized completion signal. The
 * close handler doesn't need to know the agent's role — if any contract
 * matches, the work is captured.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isStepOutputComplete(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return hasReviewerCompletion(text) || hasDevCompletion(text) || hasGenericCompletion(text);
}

/**
 * Diagnostic helper — returns which contract matched (or 'none'). Useful for
 * observability events so the daemon can record WHY it accepted a forced
 * termination as success.
 *
 * @param {string} text
 * @returns {'dev'|'reviewer'|'generic'|'none'}
 */
export function classifyCompletion(text) {
  if (typeof text !== 'string' || text.length === 0) return 'none';
  if (hasDevCompletion(text)) return 'dev';
  if (hasReviewerCompletion(text)) return 'reviewer';
  if (hasGenericCompletion(text)) return 'generic';
  return 'none';
}

/**
 * Backwards-compat alias for the T0.1 callers that pre-date PR-6's renaming.
 * Same semantics as `hasDevCompletion` (DEV+WORK_SUMMARY both required).
 *
 * Prefer `isStepOutputComplete` in new code.
 *
 * @deprecated use isStepOutputComplete
 */
export function hasDoneAndWorkSummary(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return hasDevCompletion(text);
}
