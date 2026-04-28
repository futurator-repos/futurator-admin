// Pipeline v2.0 efficiency fix T0.1.
//
// Detect whether an agent emitted both `---DONE---` and `---WORK_SUMMARY---`
// envelope markers in its streamed output. Used by `runAgent`'s close handler
// to convert COST_HARD-after-DONE forced terminations into successes.
//
// dino1 forensic (2026-04-28): 5+ DEV re-spawns on the dino-physics story,
// each terminating with `[COST HARD] $7.X hit ceiling` AFTER the agent had
// already emitted `---DONE---` + `---WORK_SUMMARY---: No changes needed.`
// Treating those as failures wasted ~$35 on a single no-op story before the
// operator manually abandoned the Plan.
//
// Pure function; no side effects, no I/O.

/**
 * Returns true iff the supplied agent text contains both protocol markers
 * on their own line. Strict line-anchored matching avoids false-positives
 * from `---DONE---` literals that might appear inside Edit/Write tool inputs
 * (e.g. an agent editing a file whose content contains the marker as text).
 *
 * @param {string} text — the agent's accumulated prose output (stream text
 *   deltas + assistant text blocks). Tool inputs are excluded by design;
 *   the caller of `hasDoneAndWorkSummary` only feeds it text-content events.
 * @returns {boolean}
 */
export function hasDoneAndWorkSummary(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (!/^---DONE---\s*$/m.test(text)) return false;
  if (!/^---WORK_SUMMARY---\s*$/m.test(text)) return false;
  return true;
}
