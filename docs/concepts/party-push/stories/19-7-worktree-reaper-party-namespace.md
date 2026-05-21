# Story 19.7: Worktree-reaper `_party` namespace walker (no-op classifier)

Status: DONE (2026-05-21)

## Story

As a daemon operator,
I want the orphan reaper to recognize `/home/ubuntu/worktrees/<app>/_party/<sessionIdShort>/` as a distinct namespace it walks,
so that PR-0 ships a reaper that's structurally aware of party worktrees but doesn't yet reap any (the real classifier wires in Story 20.15 once `findBySessionIdShort` is in the daemon's deps).

## Acceptance Criteria

1. `daemon/lib/worktree-reaper.mjs` adds:
   - A new generator `walkPartyWorktrees(root)` mirroring `walkCoordinatorWorktrees` but yielding `{ appId, sessionIdShort, fullPath }`.
   - A new classifier `classifyPartyWorktree({ entry, deps })` that returns `{ shouldReap: false, reason: 'lookup-not-wired' }` UNCONDITIONALLY when `typeof deps.findPartySessionByShort !== 'function'` (Story 20.15 wires this; pre-Epic-20 the classifier returns no-op).
   - The walker is reachable from `runWorktreeReaper` and contributes to the structured summary log line (`per-story N/M, coordinator N/M, store N/M, party N/M`).
   - `walkPerStoryWorktrees` excludes any directory named `_party` to avoid double-walking (per `plan.md` §11.2.8 diff).
2. New constants exported:
   - `PARTY_TERMINAL_STATUSES = new Set(['ENDED', 'CANCELLED', 'EXPIRED'])`
   - `PARTY_STALE_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000` (7 days, longer than per-story's 24h — debate artifacts in `docs/` deserve a longer recoverable window)
3. **No party worktrees exist yet on the EC2 box**, so the reaper's behavior is unchanged: hourly ticker logs `party 0/0` and reaps nothing.
4. Test (`daemon/lib/__tests__/worktree-reaper-party.test.mjs`):
   - Creates a fake party worktree dir on the test filesystem, runs the reaper, verifies it's NOT reaped (because `deps.findPartySessionByShort` is undefined in the test fixture)
   - Verifies the summary log includes the `party N/M` segment
5. Existing reaper tests stay green.
6. Typecheck baseline maintained.

## Tasks / Subtasks

- [x] Task 1: Add `walkPartyWorktrees` generator (AC: 1a)
- [x] Task 2: Add `classifyPartyWorktree` with no-op default (AC: 1b)
- [x] Task 3: Modify `walkPerStoryWorktrees` to skip `_party` dirs (AC: 1d)
- [x] Task 4: Wire the party loop into `runWorktreeReaper` + summary line (AC: 1c)
- [x] Task 5: Constants (AC: 2) — `PARTY_TERMINAL_STATUSES`, `PARTY_STALE_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000`
- [x] Task 6: New test (AC: 4) — `daemon/lib/__tests__/worktree-reaper-party.test.mjs`, 4 tests
- [x] Task 7: Confirm existing tests stay green (AC: 5) — `daemon/lib/__tests__/worktree-reaper.test.mjs` 8/8 still pass; new + existing run together 12/12

## Implementation notes (2026-05-21)

- `walkPartyWorktrees(root)` descends `<root>/<appId>/_party/<sessionIdShort>/` two levels, yielding `{ appId, sessionIdShort, fullPath }`. Skips when `_party` dir doesn't exist or isn't a directory.
- `walkPerStoryWorktrees` now `continue`s on `plan.name === '_party'` so the per-story + party walkers never double-walk the same path. Verified by the test that creates BOTH a real per-story worktree AND a `_party` worktree on the same app, then asserts `summary.perStory.scanned === 1` and `summary.party.scanned === 1` (not 2 + 0).
- `classifyPartyWorktree({ entry, deps })` returns `{ shouldReap: false, reason: 'lookup-not-wired' }` when `typeof deps.findPartySessionByShort !== 'function'`. The full classifier body is written but lives behind the guard — Story 20.15 will land the `findPartySessionByShort` wiring on `ctx`, which lights up the real branches without further changes here.
- Reap teardown mirrors the coordinator (`_merge`) shape: `git --git-dir=<bare> worktree remove --force <path>` then `rm -rf`.
- Summary log line now ends with `…, party N/M` so operators can grep for `party 0/0` (= party worktree code is wired but nothing on disk yet) vs `party 0/3` (= party worktrees accumulating, classifier still no-op).

## Dev Notes

- "No-op classifier" is the load-bearing pattern: it means PR 0 can ship even though no party worktrees exist yet, and Story 20.15 lights up the real classifier when the daemon-side `findPartySessionByShort` lookup is wired. Reverse order (real classifier first, then no-op) risks the reaper deleting things it shouldn't during the rollout.
- The 7-day terminal-but-fresh window: debate artifacts in `docs/` are operator-recoverable. If the operator force-deletes the GitHub branch by mistake, the EC2 worktree's `.git` history still has it for 7 days.
