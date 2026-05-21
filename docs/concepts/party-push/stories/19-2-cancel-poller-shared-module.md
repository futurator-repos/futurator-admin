# Story 19.2: Shared cancel-poller module + atomic-clear API

Status: DONE (2026-05-21)

## Story

As an agent-runtime engineer,
I want the cancel-flag polling pattern extracted into one reusable module that both free-agent-session and party-turn can call,
so that the operator's Stop button works identically across agent classes and the stale-cancel-flag bug from 2026-05-19 cannot regress in either class.

## Acceptance Criteria

1. New file `daemon/pipelines/lib/cancel-poller.mjs` exports `startCancelPoller({ sessionsRepo, sessionId, child, logger, pollMs, killGraceMs }) → { isCancelled(), stop() }`.
2. `stop()` is async and always clears the cancel flag via `sessionsRepo.clearCancelFlag(sessionId)` before returning, per Free Explorer §13.2 (no opt-out; simpler API).
3. `isCancelled()` continues to return the in-memory `cancelled` value AFTER `stop()` returns — close handlers depend on it to choose between cancelled-event vs normal-completion-event emission (per §13.2 invariant).
4. Default `pollMs = 2_500`, default `killGraceMs = 5_000`, both overridable.
5. On `cancelRequested === true`: SIGTERM the child immediately; `setTimeout` to SIGKILL after `killGraceMs`. Log via `logger.info`.
6. DDB read failures inside the poll loop log via `logger.warn` but do NOT crash the poller (network blip resilience).
7. Unit tests at `daemon/pipelines/lib/__tests__/cancel-poller.test.mjs` cover:
   - Happy path: child exits cleanly, `stop()` clears flag, `isCancelled()` returns false
   - Cancel path: `cancelRequested` flips true, SIGTERM fires, `isCancelled()` returns true after `stop()`
   - DDB read failure: poller continues, doesn't throw, doesn't SIGTERM erroneously
   - `clearCancelFlag` failure on stop: stop returns cleanly (warn-only), `isCancelled()` state intact

## Tasks / Subtasks

- [x] Task 1: Write `daemon/pipelines/lib/cancel-poller.mjs` per `plan.md` §11.2.1 + §12.1.5 atomic-clear API (AC: 1–6)
- [x] Task 2: Write unit tests (AC: 7)
- [x] Task 3: `npx vitest run daemon/pipelines/lib/__tests__/cancel-poller.test.mjs` passes — 9 tests passed in 32ms

## Implementation notes (2026-05-21)

- Module at `daemon/pipelines/lib/cancel-poller.mjs` (128 lines, JSDoc-typed).
- `stop()` is async and always calls `sessionsRepo.clearCancelFlag` when the repo implements it (skips silently when missing — keeps the contract optional for future callers).
- `clearCancelFlag` rejection inside `stop()` is caught and logged via `logger.warn`; never thrown (per AC 4 + §13.2 best-effort semantics).
- Tick guard: both `stopped` and `cancelled` short-circuit the next tick body so a SIGTERM never fires twice and reads cease after stop.
- Tests at `daemon/pipelines/lib/__tests__/cancel-poller.test.mjs` (9 tests):
  - Happy path (AC 1) — 1 test
  - Cancel path (AC 2) — 2 tests (SIGTERM-then-SIGKILL grace; no double-SIGTERM on repeat ticks)
  - DDB read failure (AC 3) — 1 test
  - `clearCancelFlag` failure (AC 4) — 2 tests (rejection swallowed; missing fn skipped)
  - Input validation — 3 tests (missing `sessionsRepo.getSession`, `sessionId`, `child`)
- Used `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` to drive the poll loop deterministically.
- Story 19.3 consumes this. Story 20.7 wires it into party-turn (different `sessionsRepo`, same call shape).

## Dev Notes

- Per §13.2, do NOT expose `{ clearFlag: false }` — make `stop()` always clear. Simpler API.
- The child process is passed in (not spawned by the poller). Lifecycle separation makes the test mockable via a fake `{ kill: vi.fn() }` shape.
- Story 19.3 is the refactor of free-agent-session to use this. Story 20.7 is the party-turn wire-up.
