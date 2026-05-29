/**
 * integration-lock.mjs — Story B (agentic-integration-branching, 2026-05-29).
 *
 * Per-app mutual exclusion for the wave-merge integration gate.
 *
 * THE PROBLEM (pacman-2, 2026-05-28): two epics in the same plan-wave run
 * two wave-merge jobs concurrently (MAX_CONCURRENT=2). Before this lock they
 * both mutated the same `_merge` worktree on the same `plan/<slug>` branch,
 * interleaving merges and leaving a conflict marker that a sibling job's
 * build gate then tripped over — wedging an epic in `fixing` with no
 * recovery. The fix has two halves: (1) merge in an ephemeral per-candidate
 * worktree and advance `plan/<slug>` atomically only on green (see
 * wave-merge-runner.mjs); (2) THIS lock — serialize the integration gate per
 * app so two candidates never race to advance the same green ref.
 *
 * Because one-plan-per-app is hard-enforced today (`PLAN_ALREADY_ACTIVE`,
 * plan-repository.ts), per-app == per-plan, so a per-`appId` lock is
 * sufficient and simplest.
 *
 * ── DISTRIBUTED SEAM ───────────────────────────────────────────────────────
 * This is an IN-PROCESS mutex. It is correct ONLY while every wave-merge for a
 * given app runs inside a single daemon process (true today: one EC2 daemon,
 * MAX_CONCURRENT=2). The moment integration workers span machines, this must
 * become a distributed lock — a DDB conditional-write lease, or git's own
 * atomic ref update (`update-ref <new> <old>` / `push --force-with-lease`) as
 * the compare-and-swap. The `advance-on-green` step in wave-merge-runner.mjs
 * already passes the expected-old-SHA to `git update-ref`, so the ref-CAS
 * backstop is in place even now; this mutex is the cheap first layer.
 * See docs/concepts/pipeline-v2/integration-followups-bcd.md (Story B).
 */

/**
 * appId → a promise that settles when that app's current lock holder (and
 * everything queued behind it) has finished. New callers chain onto it.
 * @type {Map<string, Promise<void>>}
 */
const _chains = new Map();

/**
 * Run `fn` while holding the integration lock for `appId`. Calls for the
 * same appId run strictly one-at-a-time in arrival order (FIFO); calls for
 * different appIds run concurrently. The lock is released even if `fn`
 * throws (a failing job must never wedge its app's lock forever), and the
 * rejection is propagated to the caller.
 *
 * @template T
 * @param {string} appId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withAppIntegrationLock(appId, fn) {
  if (!appId) throw new Error('withAppIntegrationLock: appId required');

  // Wait for the prior holder to finish, then run. A prior rejection must
  // not block us — swallow it for the purpose of sequencing only.
  const prior = _chains.get(appId) || Promise.resolve();
  const run = prior.then(
    () => fn(),
    () => fn(),
  );

  // The new tail: `run` settled, errors swallowed so the chain never wedges.
  const tail = run.then(
    () => {},
    () => {},
  );
  _chains.set(appId, tail);

  // Prune the map entry once this tail settles, but only if nobody chained
  // behind us in the meantime (i.e. we're still the current tail).
  tail.then(() => {
    if (_chains.get(appId) === tail) _chains.delete(appId);
  });

  return run;
}

/**
 * Diagnostic: number of apps with a live or queued lock chain. Not
 * load-bearing; handy for an operator health snapshot and tests.
 */
export function activeLockCount() {
  return _chains.size;
}

/** Test helper: drop all chains between unit-test cases. */
export function _resetLocks() {
  _chains.clear();
}
