// gate-memo-sweep — periodic TTL sweep of fact-force memos (development-plan §9).
//
// The live gate blocks a confirm-tier action ONCE per (session,tool,target) then
// clears on retry, persisted as `.seen` files. Over a long-lived daemon those
// memos must not accumulate: a stale memo would silently let a re-attempted
// risky action through. This is the daemon-side scheduler shim around the gate's
// own `sweepStaleMemos`, mandatory before enforce-at-scale (open-question 7).

import { sweepStaleMemos } from './pretool-gate.mjs';

export const GATE_MEMO_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** Run one sweep tick. Pure pass-through to the gate's sweeper; never throws. */
export function runGateMemoSweepTick({ stateDir, ttlMs, now } = {}) {
  try {
    return sweepStaleMemos({ stateDir, ttlMs, now });
  } catch {
    return { swept: 0, kept: 0 };
  }
}

/**
 * Start an unref'd interval that sweeps stale memos. Returns a stop fn. Safe to
 * call once at daemon boot; unref so it never holds the process open.
 */
export function startGateMemoSweep({ stateDir, intervalMs = GATE_MEMO_SWEEP_INTERVAL_MS, ttlMs } = {}) {
  const timer = setInterval(() => runGateMemoSweepTick({ stateDir, ttlMs }), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
