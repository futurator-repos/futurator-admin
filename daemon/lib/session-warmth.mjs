// Pipeline v1 — Epic 5 (Cache & context optimization). Stories 5.1 + 5.2.
//
// Pure functions for warmth + cost-to-resume estimation. The daemon updates
// session-row token counts after each turn; this module exposes the policy
// that turns "minutes since last turn + token count" into a UI-friendly
// chip ("warm — $0.04 to resume").

const HOT_MS = 60 * 1000;
const WARM_MS = 5 * 60 * 1000;
const COLD_MS = 30 * 60 * 1000;

const STALE_AFTER_MS = (Number(process.env.SESSION_STALE_AFTER_MINUTES) || 30) * 60 * 1000;

export function getSessionWarmth(session, now = Date.now()) {
  if (!session?.lastTurnAt) return 'COLD';
  const age = now - new Date(session.lastTurnAt).getTime();
  if (age < HOT_MS) return 'HOT';
  if (age < WARM_MS) return 'WARM';
  if (age < COLD_MS) return 'COLD';
  return 'STALE';
}

export function isStaleSession(session, now = Date.now()) {
  if (!session?.lastTurnAt) return false;
  return now - new Date(session.lastTurnAt).getTime() >= STALE_AFTER_MS;
}

// Static price constants (USD per 1M input tokens). Kept conservative —
// real per-model rates can be plumbed later via an env-var override map.
const INPUT_TOKEN_USD_PER_M = 3.0;
const CACHE_READ_USD_PER_M = 0.3; // cache hits are ~10x cheaper

/**
 * Estimate the cost of the *first* turn of a resumed session, given the
 * accumulated token count and the warmth class. HOT/WARM benefit from
 * Anthropic's 5-minute prompt cache; COLD/STALE pay full input price.
 */
export function estimateResumeCostUsd(tokenCount, warmth) {
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) return 0;
  const perM = tokenCount / 1_000_000;
  if (warmth === 'HOT' || warmth === 'WARM') {
    return Number((perM * CACHE_READ_USD_PER_M).toFixed(4));
  }
  return Number((perM * INPUT_TOKEN_USD_PER_M).toFixed(4));
}

/**
 * Story 5.3 — should this session be auto-compacted? Threshold defaults
 * to 80k tokens (env-overridable), only IDLE sessions are candidates.
 */
const COMPACT_THRESHOLD = Number(process.env.SESSION_COMPACTION_TOKEN_THRESHOLD) || 80000;
export function shouldCompact(session) {
  if (!session) return false;
  if (session.status !== 'IDLE') return false;
  if ((session.tokenCount || 0) < COMPACT_THRESHOLD) return false;
  if (session.compactedFrom) return false; // already a compaction artifact
  return true;
}
