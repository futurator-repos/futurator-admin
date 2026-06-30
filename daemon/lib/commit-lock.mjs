// commit-lock — serialize ONLY the git-commit step, per repo (development-plan §4.1).
//
// In the shared-tree SDD model, parallel stories write disjoint files (the gate
// guarantees disjoint `touches`), so they never conflict on content. The only
// shared resource is `.git/index` at commit time — the legacy "index.md write
// race". Rather than give each story its own worktree, we serialize just the
// commit: an in-process async mutex keyed by repo path. Dev runs fully parallel;
// commits to the SAME repo queue (a few ms each); commits to DIFFERENT repos
// (different plans) run concurrently.
//
// Single-daemon scope. A multi-host future would swap this for a DynamoDB lease
// (the same atomic-claim pattern), but one daemon owns one plan's tree today.

const chains = new Map(); // repoKey → tail Promise

/**
 * Run `fn` while holding the commit lock for `repoKey`. Serialized per key;
 * the returned promise resolves/rejects with fn's result. fn errors do not
 * poison the chain (the lock always releases).
 *
 * @template T
 * @param {string} repoKey  usually the repo's absolute path
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withCommitLock(repoKey, fn) {
  const prev = chains.get(repoKey) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  // The next caller waits on `gate`; we chain it after the previous tail.
  chains.set(repoKey, prev.then(() => gate));

  return prev.then(
    () => Promise.resolve().then(fn).finally(release),
    // Even if a prior holder rejected, we still take our turn.
    () => Promise.resolve().then(fn).finally(release),
  );
}

/** Test/inspection helper: is anything queued for this repo? */
export function isLocked(repoKey) {
  return chains.has(repoKey);
}

/** Test helper: clear all chains. */
export function _reset() {
  chains.clear();
}
