# Story 19.6: PAT-loader refresh awareness (60s cache + retry-on-auth-fail)

Status: DONE (2026-05-21) — Tasks 1–6 ✅; Task 3 deferred (see notes); Task 7 (manual smoke) deferred to post-rsync

## Story

As a daemon operator,
I want the brownfield PAT loader to detect PAT rotation and re-read on auth failure rather than caching a stale token until the daemon restarts,
so that pipeline-v2's `compile-push` and party-push's eventual push don't both break when the operator rotates a PAT in `/migrate`.

## Acceptance Criteria

1. Extend `ctx.loadBrownfieldPat(secretName: string)` (currently in `daemon/agent-daemon.mjs`) with:
   - In-process cache TTL of 60 seconds (down from current 1 hour TTL, per §12.4 risk 27)
   - A new option flag `{ forceRefresh: boolean }` defaulting to false
   - On `forceRefresh: true`: skip cache, re-read from Secrets Manager, update cache with new value
2. New helper `withPatRetry(secretName, operation)` (or equivalent inline pattern) — wraps a PAT-using operation; on AWS / GitHub auth error (HTTP 401, "Bad credentials", "Personal access token has expired"), force-refreshes the PAT and retries the operation **once**. Second auth failure propagates.
3. Pipeline-v2's `compile-push` and party-push's checkpoint script both use `withPatRetry` for the actual git push invocation. (Party's push is disabled until Epic 21; wire the helper but the call site is dormant.)
4. Audit logging on every PAT cache miss + force-refresh: `[brownfield-pat] refreshed <secretName>` at INFO level. Cache hits stay at DEBG to avoid log spam.
5. **Regression**: pipeline-v2's existing tests stay green. The TTL drop from 1h → 60s is a tightening; no existing test should rely on stale cache.
6. Manual smoke test: rotate the brownfield PAT for one project in `/migrate`, run a pipeline-v2 story that does `compile-push` immediately after — the push should succeed without daemon restart. (Pre-fix would fail until 1h cache expired.)

## Tasks / Subtasks

- [x] Task 1: Modify `loadBrownfieldPat` to accept `{ forceRefresh }` + drop TTL to 60s (AC: 1)
- [x] Task 2: Add `withPatRetry(secretName, operation)` helper (AC: 2) — extracted to `daemon/lib/pat-retry.mjs` for unit-testability; daemon binds via `createPatRetry({ loadPat: loadBrownfieldPat, logger })`
- [ ] Task 3: ~~Wire pipeline-v2's `compile-push` callsite through `withPatRetry`~~ — **deferred to Story 20.2's JS push-wrapper.** Rationale: today's `compile-push` is a raw shell `git push origin HEAD` step inside `compile-pipeline.mjs` (no inline PAT, relies on git's credential helper). Inserting `withPatRetry` requires the same JS-wrapper push pattern that Story 20.2 needs anyway; landing both together avoids a wasted intermediate refactor. The primitive + `ctx.withPatRetry` export ship now (AC 1–2); the call-site wire-up lands in PR 1.
- [ ] Task 4: Wire (dormant) party-push checkpoint through `withPatRetry` — **deferred to Story 20.2** (same JS-wrapper, same scope)
- [x] Task 5: Audit logging (AC: 4) — `loadBrownfieldPat` logs `loaded` on cache miss and `refreshed` on force-refresh at INFO level
- [x] Task 6: Run pipeline-v2 regression suite (AC: 5) — `daemon/lib/__tests__/pat-retry.test.mjs` (14 tests passed); existing daemon suite stays green at 1380/1384 (4 unrelated `epic-dev-pipeline` failures pre-existed before this story, verified via `git stash` + re-run)
- [ ] Task 7: Document manual smoke test in `status.md` (AC: 6 — operator runs once PR 0 ships)

## Implementation notes (2026-05-21)

- Dropped `PAT_CACHE_TTL_MS` from `60 * 60 * 1000` → `60 * 1000` (1h → 60s).
- `loadBrownfieldPat(secretName, opts)` now accepts `opts.forceRefresh: boolean`. When true: skip cache, re-read from Secrets Manager, update cache. INFO log distinguishes `loaded` vs `refreshed`.
- New file `daemon/lib/pat-retry.mjs` exports:
  - `isPatAuthError(err)` — heuristic matching HTTP 401/403, `Bad credentials`, `Personal access token has expired`, `Authentication failed`, `Permission to … denied`, `Invalid username or token`.
  - `createPatRetry({ loadPat, logger })` — factory producing `withPatRetry(secretName, operation)`. Calls operation with cached PAT; on `isPatAuthError`, force-refreshes and retries exactly once. If refresh returns the same token (no rotation actually happened) or null, original error propagates — avoids infinite retry-on-same-bad-token loop.
- `agent-daemon.mjs` binds the factory once: `const withPatRetry = createPatRetry({ loadPat: loadBrownfieldPat, logger: { info: (msg) => log('info', msg) } })`. Exported on `ctx.withPatRetry` so future Story 20.2's JS push-wrapper picks it up without further wiring.
- 14/14 unit tests pass (`daemon/lib/__tests__/pat-retry.test.mjs`):
  - 6 `isPatAuthError` tests (falsy input, 401/403 status, GitHub message bodies, HTTP-status-in-text, non-auth errors, string-only input)
  - 1 factory validation test
  - 1 happy-path test
  - 4 auth-failure tests (refresh-and-retry success, retry-once-then-throw, same-token-no-retry, refresh-returns-null-no-retry)
  - 2 non-auth error tests (network blip propagates, "no token available" on initial null load)
- Typecheck baseline: 79 errors total, all pre-existing in `agent-job-state-machine.ts`, `timer-colors.ts`, `functions/api/index.ts`, and various test files. None from this story.

## Dev Notes

- The 1h TTL was set when PAT rotation was rare; with party-push enabling more frequent rotation it's the wrong default.
- Force-refresh on auth-fail is the binding semantic; the TTL drop is just defense-in-depth.
- Per Free Explorer §13.6 + §13.1, log to DDB events (NOT CloudWatch metrics) for now; CloudWatch tier added later.
