# Story 19.3: Refactor free-agent-session to use the shared cancel-poller

Status: DONE (2026-05-21) — automated AC 1–6 ✅, manual smoke (AC 7) deferred to post-rsync

## Story

As a maintainer of the free-agent runtime,
I want `free-agent-session.mjs` to call the shared `cancel-poller.mjs` (story 19.2) instead of keeping its own inline poller,
so that the cancel-flag semantics for both agent classes are guaranteed identical and a fix landed for one is automatically picked up by the other.

## Acceptance Criteria

1. `daemon/pipelines/free-agent-session.mjs` imports `startCancelPoller` from `./lib/cancel-poller.mjs`.
2. The inline `setInterval` poller block at `free-agent-session.mjs:~250-277` is deleted.
3. Both pre-spawn and post-close `clearCancelFlag` calls in the original flow are deleted — they're now handled by `poller.stop()` (always-clear, per §13.2).
4. The close handler reads `poller.isCancelled()` instead of the local `cancelled` boolean. The handler still emits the cancelled-event vs completion-event split correctly.
5. `cancelPoller` references in the rest of the file are replaced with `poller.stop()`.
6. **Regression**: existing free-agent tests stay green (`npx vitest run functions/shared/services/__tests__/free-agent-*.test.ts daemon/pipelines/__tests__/free-agent-session*.test.mjs`).
7. **Smoke test on EC2** (post-rsync): open a free-agent session in the UI, send a turn that takes >5 seconds, click Stop. The session marks CANCELLED, the event is `free-agent.turn.cancelled` (not generic error), and a SECOND turn started immediately after does NOT pre-cancel (verifies §12.1.5 fix).

## Tasks / Subtasks

- [x] Task 1: Import `startCancelPoller` (AC: 1)
- [x] Task 2: Delete inline `setInterval` block + replace with `poller = startCancelPoller(...)` (AC: 2, 5)
- [x] Task 3: Delete pre-spawn + post-close `clearCancelFlag` calls (AC: 3)
- [x] Task 4: Swap close-handler `cancelled` reads with `poller.isCancelled()` (AC: 4)
- [x] Task 5: Run free-agent regression suite (AC: 6) — `npx vitest run daemon/pipelines/__tests__/free-agent-session.test.mjs daemon/pipelines/lib/__tests__/cancel-poller.test.mjs` → 28 passed
- [ ] Task 6: Manual smoke test post-rsync (AC: 7) — only after story 19.7 enables `findBySessionIdShort` in the daemon's reaper deps so a session reaped during the test still resolves cleanly

## Implementation notes (2026-05-21)

- Imported `startCancelPoller` from `./lib/cancel-poller.mjs` at the top of `free-agent-session.mjs`.
- Deleted the 24-line inline `setInterval` poller block at the original lines 254–277.
- Deleted the pre-spawn `clearCancelFlag` block at original lines 231–237; the poller now owns the flag's lifecycle for the turn (per §13.2 atomic-clear).
- Renamed the watchdog's own kill timer from `killTimer` → `watchdogKillTimer` to make the lifecycle obvious — the cancel-path SIGKILL timer is now owned by the poller, not the surrounding scope.
- Replaced `if (cancelled)` close-handler with `if (poller.isCancelled())`; the cancelled-vs-timed-out-vs-normal discrimination stays correct because `timedOut` is unchanged and the poller's `isCancelled()` only flips on operator cancel.
- Deleted the post-close `clearCancelFlag` block at original lines 409–415 — `poller.stop()` already cleared it.
- Regression suite (`free-agent-session.test.mjs` 19 tests + `cancel-poller.test.mjs` 9 tests) all passed in 2.91s. No behavioral change to the test surface.

## Dev Notes

- Per Free Explorer §13.2, the change is "safe — the in-memory `cancelled` boolean lifetime is what matters; DDB clear timing doesn't change semantics."
- The original file's `cancelPoller` variable + `let cancelled = false` + `let killTimer = null` go away; the poller's return object owns all that state.
- One subtle gotcha: the watchdog timer (timed-out path) sets `timedOut = true` and SIGTERMs the child. The poller's `isCancelled()` only flips on operator cancel, not on watchdog. Keep the close-handler's discrimination intact (cancelled vs timed-out vs normal).
