# Story 20.14: ConcurrencyManager — unified queue with interactive-first priority

Status: TODO
Supersedes: an earlier draft of this story that proposed lane-partitioning (1 interactive + 1 batch slot).
Operator decision (2026-05-21): build the abstraction NOW, single queue, interactive jobs jump ahead.

## Story

As a daemon operator on a 1.8GB EC2 host,
I want a unified concurrency manager that keeps total claudes at 2 (any class), runs an interactive-first priority queue when more than 2 are pending, and is structured as a proper abstraction layer (not inline `activeJobs.size` counters),
so that a party debate doesn't queue behind a 5-minute pipeline-v2 test-author run, batch work still flows through during interactive idle time, and future agent classes plug into one place instead of growing more counters.

## Why this design (vs. the lane-partition draft)

The operator explicitly rejected the partition (1 interactive + 1 batch). Reasoning:

- Lane partitioning wastes capacity: if there's no active interactive work, the interactive slot sits idle while batch jobs queue. Operator wants ALL 2 slots usable by ALL classes.
- The real ergonomic concern is "don't make me wait behind batch." That's a scheduling problem, not a capacity-allocation problem. Solve it with priority, not lanes.
- The operator wants "one layer of concurrency management" as a proper abstraction so future agent classes (Multi-Agent Operator Workflow / Rung-1 free-agent / others) plug into it without growing per-class counters.

## Acceptance Criteria

1. New module `daemon/lib/concurrency-manager.mjs` exports a `ConcurrencyManager` class with:
   - `constructor({ maxConcurrent, classifier, logger })` — `maxConcurrent` integer (default 2), `classifier(job) → 'interactive' | 'batch'`, `logger` for audit lines.
   - `tryAcquire(job) → { acquired: boolean, reason?: string }` — synchronous slot acquisition. Returns `acquired: true` only if capacity allows AND the job is the highest-priority pending OR the queue is empty.
   - `release(jobId)` — called when a job terminates. Frees the slot.
   - `getSnapshot() → { active: { jobId, jobClass, startedAt }[], maxConcurrent }` — observability for the status endpoint + tests.
   - `selectNext(candidates) → job | null` — given a list of PENDING jobs from DDB, applies the priority rule and returns the next one to attempt. Pure function, no mutation.
2. **Job classification** is a pure function the daemon owns (not inside the manager). Classifier:
   - `jobType: 'free-agent-session' | 'party-turn' | 'party-bootstrap' | 'party-inspect' | 'party-docs-sync' | 'party-docs-unlink' | 'party-refresh'` → `'interactive'`
   - Anything else (pipeline-v2 step jobs, `wave-merge`, `app-bootstrap`, `skill-scout`, `skill-install`, `reflector`) → `'batch'`
3. **Priority rule**: when `selectNext(candidates)` runs:
   - Sort candidates: `(class === 'interactive' ? 0 : 1, createdAt asc)`.
   - Return the first one (highest priority = interactive + oldest within class).
   - **Never preempts**: a RUNNING batch job is NEVER killed to make room for a pending interactive job. Priority only affects QUEUE order, not active execution.
4. **No starvation guard for batch**: batch jobs are guaranteed to make progress because every interactive session terminates eventually (turns + sessions are bounded). If the operator has a continuous stream of interactive work that's their explicit choice; document this in the manager's JSDoc.
5. **Backward-compat env vars**:
   - `MAX_CONCURRENT` (existing) → maps to `maxConcurrent` in the manager. Default 2 on the existing small-host cap.
   - New `MAX_CONCURRENT_INTERACTIVE` (optional, future-only) — RESERVED. Not consumed in this story. Documented in the JSDoc so a future operator can opt into per-class soft-caps without rewriting.
6. **Daemon integration**:
   - Replace `MAX_CONCURRENT - activeJobs.size` polling math (currently `agent-daemon.mjs:4649`) with `manager.canAcquire()` checks.
   - Replace the implicit FIFO from `ScanIndexForward: true` + `Limit: availableSlots` with: query a larger window (e.g. `Limit: 20`) of PENDING jobs, then call `manager.selectNext(candidates)` to pick the next one.
   - `runJobAsync` start path calls `manager.tryAcquire(job)`; if `acquired: false`, the job stays PENDING (no DDB write) and we'll see it again next tick.
   - Job-close path (success or failure) calls `manager.release(jobId)`.
7. **Audit logging** on every acquire + release with class label: `[concurrency] acquire <jobId> class=interactive active=1/2` / `[concurrency] release <jobId> active=0/2`.
8. **Daemon status endpoint** (`/api/daemon/status` or its successor) returns the manager's `getSnapshot()` for UI display.
9. **Feature flag for safety rollback**: if `process.env.PARTY_PUSH_CONCURRENCY_MANAGER === '0'`, the daemon falls back to the legacy `activeJobs.size` counter (today's behavior). Default enabled (`'1'`) after PR 0 ships and operator confirms in `status.md`.
10. **Tests** (`daemon/lib/__tests__/concurrency-manager.test.mjs`):
    - **Capacity**: 2 jobs acquire → 3rd `tryAcquire` returns `acquired: false`. Release one → 3rd acquires.
    - **Priority — interactive jumps batch**: 1 batch job RUNNING + 1 batch PENDING (older) + 1 interactive PENDING (newer) → on next slot free, interactive wins despite being newer.
    - **Priority — interactive among interactives FIFO**: 2 interactive PENDING with different `createdAt` → older wins.
    - **Priority — batch among batches FIFO**: all-batch queue behaves identical to today.
    - **Never preempts**: a long-running batch + a fresh interactive → batch keeps running, interactive waits until batch completes OR the other slot frees.
    - **Snapshot accuracy**: after acquire + release, snapshot reflects state.
    - **Classifier coverage**: every known `jobType` maps to a class with no `'unknown'` returned. (Failsafe: unknown jobTypes default to `'batch'` with a logger.warn.)
11. **No behavioral change to free-agent + pipeline-v2 runs in isolation** — both classes still complete normally; what changes is only the scheduling order when they compete.
12. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: Write `daemon/lib/concurrency-manager.mjs` per AC 1–7 (Tasks 4 wiring is separate)
- [ ] Task 2: Job classifier in daemon (AC: 2)
- [ ] Task 3: Manager unit tests (AC: 10)
- [ ] Task 4: Wire into `agent-daemon.mjs` poll loop (AC: 6, 7) — feature-flagged per AC 9
- [ ] Task 5: Daemon status endpoint integration (AC: 8)
- [ ] Task 6: Document the no-starvation-guard tradeoff in JSDoc (AC: 4)
- [ ] Task 7: Reserve `MAX_CONCURRENT_INTERACTIVE` env var slot in docs (AC: 5)
- [ ] Task 8: Confirm tests + typecheck (AC: 10, 12)

## Dev Notes

- The original Story 20.14 proposed a lane partition. Operator (2026-05-21) rejected: "I don't want to separate like 1 batch dev work, and 1 for interactive… 2 max agents no matter where they are coming, perhaps we need to abstract one layer of concurrency."
- "Never preempts" is the safest semantics. Preempting a RUNNING claude subprocess SIGTERM-style mid-turn is a footgun: the existing cancel-poller path is operator-driven, not scheduler-driven. Adding scheduler-driven preemption widens the failure surface (lost work mid-call, ambiguity about whether a kill was operator-cancel or scheduler-kill, OAuth state cleanup, etc.). Defer preemption to a future story if and only if real friction surfaces.
- **Why a class (not a plain function)**: the manager owns mutable state (slot map). Free-agent's existing inline counter is acceptable today because there's one place to update; with party-push + future classes, an object-with-methods is clearer + easier to test.
- The DDB query that backs `manager.selectNext` should fetch a window (Limit: 20) of PENDING jobs, not just `Limit: availableSlots`. Otherwise the priority rule can't see a higher-priority job further back in createdAt order. This is the only meaningful API change at the poll-loop layer.
- 2GB swap on EC2 remains a separate operator action (Free Explorer §13.3 follow-up). Independent of this story.

## Future-friendly extension points

These are explicitly NOT in this story but the abstraction should support them:

- **Per-class soft-caps**: `MAX_CONCURRENT_INTERACTIVE=1` could reserve 1 slot exclusively for interactive even if both are free. Reserve the env var name now.
- **Time-of-day priority**: "during operator's awake hours, interactive priority; overnight, batch priority." Pure-function policy in `selectNext`; class doesn't need to change.
- **Job-level priority hints**: `job.priority: 'high'|'normal'|'low'` as a third tiebreaker. Already compatible with the class signature.

## Out of scope

- Preemption of RUNNING jobs (deferred unless real friction surfaces)
- Per-class hard caps (deferred; reserve env var)
- Priority across machines (multi-machine dispatch is out of v1; the manager runs per-daemon)

## Cross-refs

- `plan.md` §13.3 (Free Explorer's lane-partition recommendation, NOW SUPERSEDED — operator chose unified queue)
- `plan.md` §12.3.1 (ship-blocker, now resolved by this story)
- `status.md` §12.3.1 row (updated post-2026-05-21)
- Existing daemon poll loop at `daemon/agent-daemon.mjs:4627-4674`
