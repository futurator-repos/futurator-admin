/**
 * infra-retry.mjs — R3 infra-attempt protection (pipeline fix round, I15).
 *
 * PURE policy only — no I/O, no daemon/pipeline coupling. A story-level
 * browser-AC failure that's INFRA (dev server didn't boot, a squatter
 * answered, the page hung) must not burn the same fix-forward attempt
 * budget as a genuine APP defect: the implementer's diff may be perfectly
 * correct and the host just glitched (observed live: EADDRINUSE squatters,
 * dirty-basePath 404s, Rosetta-provider-class host flakes — see worklog
 * I9-I14). This module answers two pure questions —
 *   1. shouldConsumeAttempt(classification) — does THIS failure spend a
 *      fix-forward attempt?
 *   2. nextInfraRetry(count) — given how many infra retries a story has
 *      already burned, should it retry again, and after how long?
 * — plus annotate(job, …) to shape the bookkeeping fields onto a job/story
 * row without mutating it. `classification` is whatever
 * `classifyProbeFailure()` (daemon/lib/browser-probe-executor.mjs) returns:
 * `{ infra:boolean, reason:string }`.
 *
 * WIRING NOTE: story attempt accounting lives in story-dev-pipeline.mjs
 * (R2's file, not owned here) — this module does NOT call into it. See the
 * "deviations" note in this slice's report for the exact 2-line call-site
 * change R2's fix-forward loop needs to consult this policy.
 */

/** Bounded — never retry an infra failure more than this many times. */
export const MAX_INFRA_RETRIES = 3;

/** Backoff schedule, one entry per retry number (1st, 2nd, 3rd). */
const BACKOFF_MS = [30_000, 60_000, 120_000];

/**
 * Does this failure classification consume a fix-forward attempt?
 * Infra failures (classification.infra === true) do NOT — they're a host/
 * environment hiccup, not evidence the implementer's diff is wrong. Anything
 * else (including an absent/malformed classification) defaults to "yes,
 * consume it" — fail-closed on the attempt budget, never fail-open.
 */
export function shouldConsumeAttempt(classification) {
  return classification?.infra !== true;
}

/**
 * Given `count` infra retries already burned by this story (starts at 0),
 * decide whether to retry again and how long to wait first.
 * Returns `{ retry:boolean, delayMs:number, attempt:number }` — `attempt` is
 * the retry-number-about-to-run (1-indexed) when retry:true, else `count`
 * unchanged (retries are exhausted).
 */
export function nextInfraRetry(count = 0) {
  const used = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (used >= MAX_INFRA_RETRIES) {
    return { retry: false, delayMs: 0, attempt: used };
  }
  const delayMs = BACKOFF_MS[Math.min(used, BACKOFF_MS.length - 1)];
  return { retry: true, delayMs, attempt: used + 1 };
}

/**
 * Shape infra-retry bookkeeping onto a job/story-row-shaped object. Pure —
 * returns a NEW object, never mutates `job`. Call after classifying a
 * failure and computing its retry decision (see nextInfraRetry).
 *
 * Fields written:
 *   infraRetries        - count of infra retries consumed so far
 *   infraRetryReason    - the last classification.reason observed
 *   infraRetryExhausted - true once MAX_INFRA_RETRIES is hit on an infra
 *                         failure — signals the caller this one now DOES
 *                         have to consume a real attempt (can't stall
 *                         forever on a host that never recovers)
 */
export function annotate(job, { classification, decision } = {}) {
  const prevInfraRetries = job?.infraRetries ?? 0;
  return {
    ...job,
    infraRetries: decision?.retry ? decision.attempt : prevInfraRetries,
    infraRetryReason: classification?.reason ?? job?.infraRetryReason ?? null,
    infraRetryExhausted: classification?.infra === true && decision?.retry === false,
  };
}
