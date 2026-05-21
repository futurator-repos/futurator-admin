/**
 * pat-retry.mjs — Story 19.6 (party-push Epic 19 shared substrate).
 *
 * Two small primitives extracted from `agent-daemon.mjs` so they're
 * unit-testable without spinning up the whole daemon:
 *
 *   - `isPatAuthError(err)` — heuristic for "is this a GitHub PAT auth
 *     failure that retrying with a refreshed PAT might fix?"
 *   - `createPatRetry({ loadPat })` — factory producing a `withPatRetry`
 *     helper bound to a specific PAT loader. The daemon binds the real
 *     `loadBrownfieldPat`; tests bind a `vi.fn()`.
 *
 * Why "retry once": rotating a PAT in `/migrate` produces exactly one
 * stale-cache event per cache TTL. A second auth failure after force-refresh
 * means the new PAT is also bad — retrying further would just hammer the
 * GitHub API with a known-failing token, and the right move is to fail
 * loudly so the operator sees the misconfiguration.
 */

/**
 * Conservative auth-failure heuristic. Returns true when the error looks
 * like a 401/403 from git or the GitHub API. When uncertain, returns false
 * (the caller's original error then propagates as-is — better than retrying
 * on, say, a network blip that didn't actually invalidate the PAT).
 *
 * @param {Error | { message?: string, status?: number } | string | null | undefined} err
 * @returns {boolean}
 */
export function isPatAuthError(err) {
  if (!err) return false;
  const msg = typeof err === 'string' ? err : err.message || '';
  const status = typeof err === 'object' && err ? err.status : undefined;
  if (status === 401 || status === 403) return true;
  return (
    /\b401\b/.test(msg) ||
    /\b403\b/.test(msg) ||
    /Bad credentials/i.test(msg) ||
    /personal access token has expired/i.test(msg) ||
    /Authentication failed/i.test(msg) ||
    /Permission to .* denied/i.test(msg) ||
    /Invalid username or token/i.test(msg)
  );
}

/**
 * Build a `withPatRetry(secretName, operation)` helper bound to `loadPat`.
 *
 * Semantics:
 *   1. Load the PAT via `loadPat(secretName)` (cached path).
 *   2. If load returns falsy: throw a clear "no token available" error.
 *   3. Run `operation(pat)`. On non-auth error: propagate.
 *   4. On `isPatAuthError` true: force-refresh via `loadPat(secretName, { forceRefresh: true })`.
 *   5. If refreshed value is missing OR identical to the original: propagate the original error
 *      (no point retrying with the same token; avoids an infinite-loop foot-gun).
 *   6. Otherwise re-run `operation(refreshed)` exactly once. Whatever it returns
 *      or throws propagates.
 *
 * @param {{ loadPat: (secretName: string | undefined, opts?: { forceRefresh?: boolean }) => Promise<string | null>, logger?: { info?: (msg: string) => void } }} deps
 * @returns {(secretName: string | undefined, operation: (pat: string) => Promise<unknown>) => Promise<unknown>}
 */
export function createPatRetry({ loadPat, logger }) {
  if (typeof loadPat !== 'function') {
    throw new Error('createPatRetry: loadPat is required');
  }
  return async function withPatRetry(secretName, operation) {
    const pat = await loadPat(secretName);
    if (!pat) {
      throw new Error(
        `[brownfield-pat] no token available for ${secretName || 'legacy shared secret'}`,
      );
    }
    try {
      return await operation(pat);
    } catch (err) {
      if (!isPatAuthError(err)) throw err;
      logger?.info?.(
        `[brownfield-pat] auth failure on ${secretName || 'legacy shared secret'} — force-refreshing PAT and retrying once`,
      );
      const refreshed = await loadPat(secretName, { forceRefresh: true });
      if (!refreshed || refreshed === pat) throw err;
      return await operation(refreshed);
    }
  };
}
