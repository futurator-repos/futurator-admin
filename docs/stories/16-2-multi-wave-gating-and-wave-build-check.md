# Story 16.2: Multi-wave gating + wave build-check

**Status:** Review

---

## User Story

As **Richie (operator running a multi-wave Pipeline-mode epic)**,
I want **wave N+1 to start automatically only after wave N's stories all complete and a wave build-check passes**,
So that **a story that broke the build is surfaced before downstream waves compound the damage, and my multi-wave epics run to completion without manual intervention**.

---

## Acceptance Criteria

**AC #1 — Wave-completion cron Lambda.**
A new cron Lambda at `functions/cron/wave-completion-check.ts` runs every 60 seconds. On each run it scans `futurator-epic-workflows` for epics with `useEpicOrchestrator === false` AND `status === 'in_progress'`, and reduces each one by a waves-state-machine (detailed in AC #3-#7).

**AC #2 — Reducer is idempotent and restart-safe.**
If the daemon/cron Lambda is killed mid-reduction or fires twice for the same epic, no duplicate wave-build-check jobs are created, no duplicate next-wave stories are enqueued. Idempotency key: `waveBuildJobs[currentWave]` being present means the build-check for wave N has been created already.

**AC #3 — Current wave detection.**
Given an epic, the "current wave" is `max(stories.filter(s => s.jobId).map(s => s.wave ?? 0))` — the highest wave number that has any story with a `jobId` assigned (i.e. it was launched). Wave 1 is enqueued by Story 16.1; higher waves are enqueued by this reducer.

**AC #4 — Current-wave completion gate.**
Given a current wave, the reducer reads each wave-N story's `jobId → agentJobsRepo.getJobById → job.status`. If **any** wave-N story's job is still `PENDING` or `RUNNING`, the reducer waits (returns without action). If **all** wave-N stories' jobs are terminal (`COMPLETED` / `FAILED` / `STALE`), the reducer proceeds to AC #5.

**AC #5 — Per-story terminal status propagation.**
Given a wave-N story whose job terminates, the reducer updates `story.status` on the epic row from `running` to `done` (if job `COMPLETED`) or `failed` (if job `FAILED` or `STALE`). These statuses are the same the existing GET `/api/epic-workflows/:id` sync-on-read logic writes; the reducer does it proactively so downstream state machines can reason off the epic row alone.

**AC #6 — Wave build-check on wave completion.**
Given a wave N has all stories with **COMPLETED** job status and `epic.waveBuildJobs[N]` is undefined, the reducer creates a PENDING `wave-build-check` job using the existing `generateWaveBuildPipeline(workingDir, waveNumber, storyTitles)` helper, stores the new `jobId` as `epic.waveBuildJobs[N]`, and persists via `updateEpicFields`.

**AC #7 — Wave build-check resolution → next wave or complete.**
Given `epic.waveBuildJobs[N]` is set, the reducer reads its status:
- `PENDING` / `RUNNING` → wait (return).
- `FAILED` → update `epic.status = 'fixing'` and return. Operator must intervene.
- `COMPLETED` →
  - Identify `nextWave = N + 1`.
  - `nextWaveStories = stories.filter(s => (s.wave ?? 0) === nextWave)`.
  - If `nextWaveStories.length === 0`: update `epic.status = 'completed'`. Return.
  - Else: call `launchPipelineWave(epic, nextWave, ...)` and persist the updated stories via `updateEpicFields`.

**AC #8 — `launchPipelineWave1` renamed to `launchPipelineWave(epic, waveNumber, ...)`.**
The Story 16.1 launcher now takes an explicit `waveNumber` argument. Story 16.1's `/start` and `/from-xml` autoStart call-sites pass the result of a new helper `findFirstWave(epic)` (min wave number). This story calls `launchPipelineWave(epic, nextWave, ...)` directly.

**AC #9 — Any wave-N job FAILED → epic.status = 'fixing', no build-check.**
If any wave-N story job is `FAILED` (or `STALE`) when all wave-N jobs are terminal, the reducer sets `epic.status = 'fixing'` and does NOT create a wave-build-check for that wave. Operator must recover (retry failed story, clear status, or edit the epic) before the reducer re-engages.

**AC #10 — Unit tests.**
`functions/cron/__tests__/wave-completion-check.test.ts` with at least these cases:
1. Happy-path multi-wave: wave 1 COMPLETED → wave-build-check created
2. wave-build-check COMPLETED → wave 2 stories enqueued with new jobIds
3. wave-build-check FAILED → epic.status flips to 'fixing', no next-wave enqueue
4. Any wave-N story FAILED → epic.status='fixing' immediately, no wave-build-check
5. Wave N still has PENDING stories → reducer no-op
6. Last wave COMPLETED + build-check COMPLETED → epic.status='completed', no more enqueue
7. Idempotency: invoking the reducer twice on the same state produces the same single wave-build-check (no duplicates)

Additional test for the renamed `launchPipelineWave`: works for `waveNumber > 1` when wave 1 has already been launched (stories in other waves untouched across calls).

**AC #11 — `npm run ci` passes** (typecheck, tests, build).

---

## Implementation Details

### Tasks / Subtasks

**Launcher refactor (AC #8)**

- [x] Rename `launchPipelineWave1` → `launchPipelineWave` in `functions/shared/services/pipeline-launcher.ts`; add `waveNumber: number` as a required 4th argument (shift `deps` to 5th). Remove the `Math.min(...waveNumbers)` — the caller decides which wave to launch.
- [x] Add `findFirstWave(epic): number` exported helper — returns `Math.min(...stories.map(s => s.wave ?? 0))` (with safety for empty stories array).
- [x] Update `functions/api/index.ts` call-sites in `/start` and `/from-xml` autoStart: call `findFirstWave` then `launchPipelineWave(epic, firstWave, ...)`.
- [x] Update `functions/shared/services/__tests__/pipeline-launcher.test.ts` to match the new signature. Add one test: `launchPipelineWave(epic, 2, ...)` only mutates wave-2 stories (leaves wave-0 stories' jobId alone).

**Reducer module (new)**

- [x] Create `functions/shared/services/wave-reducer.ts` exporting `reduceEpicWaves(epic, deps): Promise<ReducerResult>`. Deps injected: `getJobById`, `createJob`, `updateEpicFields`, `generateWaveBuildPipeline`, `launchPipelineWave` (reusable from pipeline-launcher), `uuid`, `now`.
- [x] Reducer implements the state machine from AC #3-#9 with pure, testable logic. Returns a `ReducerResult` indicating what action was taken (for observability + tests):
  ```ts
  type ReducerResult =
    | { kind: 'no-op'; reason: 'wave-running' | 'all-waves-done' | 'epic-fixing' }
    | { kind: 'wave-build-check-created'; waveNumber: number; jobId: string }
    | { kind: 'wave-build-check-pending'; waveNumber: number }
    | { kind: 'next-wave-launched'; waveNumber: number; jobIds: string[] }
    | { kind: 'epic-completed' }
    | { kind: 'epic-failing'; reason: 'story-failed' | 'build-check-failed'; waveNumber: number };
  ```
- [x] Tests in `functions/shared/services/__tests__/wave-reducer.test.ts` cover 7 cases from AC #10.

**Cron handler**

- [x] Create `functions/cron/wave-completion-check.ts`:
  - Scan all epics (use `epicRepo.getAllEpics`), filter to `useEpicOrchestrator === false && status === 'in_progress'`.
  - For each, call `reduceEpicWaves(epic, deps)`. Catch + log per-epic errors so one malformed epic doesn't block the whole cron.
  - Emit per-epic result log line for observability.
- [x] Register cron in `sst.config.ts` next to the existing 5 crons. Schedule: `rate(1 minute)`. Handler: `functions/cron/wave-completion-check.handler`. Permissions: DDB read/write on `agent-jobs` + `epic-workflows`. Memory: 256 MB. Timeout: 120 seconds.

**Verify**

- [x] `npx tsc --noEmit` clean.
- [x] `npx vitest run functions/shared/services/__tests__/wave-reducer.test.ts` + `pipeline-launcher.test.ts` — all pass.
- [x] Full `npx vitest run` — no new failures.
- [x] `npx eslint` on modified files — zero new warnings.
- [x] `npm run build` clean.

### Technical Summary

The reducer lives as a pure module (`wave-reducer.ts`) with deps injected — same pattern as `pipeline-launcher.ts` from 16.1. This makes it testable without running the cron or touching DDB.

The cron handler is a thin adapter: iterate epics, call reducer per epic, log results, swallow per-epic errors. Scanning all epics every minute is fine at the current scale; at higher scale add a GSI on `status` or a TTL-based filter.

`launchPipelineWave1` → `launchPipelineWave(epic, waveNumber, ...)` is the only backwards-incompatible change. Story 16.1's call-sites and its tests are updated in the same PR.

### Project Structure Notes

- **Files to create:**
  - `functions/shared/services/wave-reducer.ts`
  - `functions/shared/services/__tests__/wave-reducer.test.ts`
  - `functions/cron/wave-completion-check.ts`
- **Files to modify:**
  - `functions/shared/services/pipeline-launcher.ts` (rename + signature change)
  - `functions/shared/services/__tests__/pipeline-launcher.test.ts` (update tests to new signature + add non-wave-1 test)
  - `functions/api/index.ts` (update 2 call-sites with findFirstWave)
  - `sst.config.ts` (register new cron)
- **Expected effort:** 3 story points (~2-3 days).

### Key Code References

- `functions/api/index.ts:941 generateWaveBuildPipeline` — the 4-step wave build-check pipeline (build → build-fix-loop → server-check → server-fix-loop). Reducer calls this for each wave completion.
- `functions/shared/services/pipeline-launcher.ts` — 16.1 launcher that becomes `launchPipelineWave`.
- `functions/api/index.ts:1630 sync-on-read` — existing story-status sync logic. Reducer duplicates this proactively so state is fresh on the epic row.
- `functions/cron/schedule-executor.ts` — reference shape for a minimal cron handler.
- `sst.config.ts:356 CostAggregator cron` — reference shape for registering a new cron.

---

## Context References

**Epic:** [../epics-orchestration-recovery.md](../epics-orchestration-recovery.md) — Epic 16 scope + story map.

**Previous story:** [16-1-wire-step-based-path-in-start.md](./16-1-wire-step-based-path-in-start.md) — Story 16.1 (wave-1 launch wiring).

**Behavioral spec:** [../concepts/agentic-pipeline-forensic-report.md](../concepts/agentic-pipeline-forensic-report.md) §WAVE BUILD CHECK.

---

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Opus 4.7, 1M context)

### Debug Log References

- `npx vitest run functions/` — 157 passed (15 files), including 9 wave-reducer tests + 10 pipeline-launcher tests.
- `npx tsc --noEmit` — clean.
- `npm run build` — clean (static export, all routes rendered).
- `npx eslint` on touched files — zero errors; 1 pre-existing warning (`buildQaPipeline` unused — will be revived by Story 16.3).

### Completion Notes

Built the state machine as a pure, deps-injected module (`wave-reducer.ts`) mirroring the pattern Story 16.1 set up for the per-story launcher. The cron handler is a thin adapter: iterate active Pipeline-mode epics, call `reduceEpicWaves` per epic, log results, swallow per-epic errors.

Two side refactors to enable the cron to share code without pulling in the Hono app:

1. Extracted `generateStoryPipeline` out of `functions/api/index.ts` into `functions/shared/pipelines/story-pipeline.ts`. Used by both `api/index.ts` call-sites and the cron's `launchPipelineWave` dep.
2. Extracted `generateWaveBuildPipeline` out of `functions/api/index.ts` into `functions/shared/pipelines/wave-build-pipeline.ts`. Used only by the cron now (api/index.ts no longer owns wave-build-check creation — the cron does).

Reducer covers all 11 ACs including:

- Idempotency via `epic.waveBuildJobs[currentWave]` lookup — re-running never creates duplicate build-checks.
- Proactive story-status propagation (`running → done/failed`) so the epic row is fresh without relying on sync-on-read.
- Terminal-status set includes `COMPLETED`, `FAILED`, `COMPLETE_WITH_BLOCKED_STORIES`, `STALE`. Success set is `COMPLETED + COMPLETE_WITH_BLOCKED_STORIES`.
- Epic flips to `status: 'fixing'` on any wave-N story FAILED/STALE OR on wave-build-check FAILED, halting reducer progress until operator intervention.

### Files Modified

**Created:**

- `functions/shared/services/wave-reducer.ts`
- `functions/shared/services/__tests__/wave-reducer.test.ts`
- `functions/shared/pipelines/story-pipeline.ts`
- `functions/shared/pipelines/wave-build-pipeline.ts`
- `functions/cron/wave-completion-check.ts`

**Modified:**

- `functions/shared/services/pipeline-launcher.ts` — `launchPipelineWave1` → `launchPipelineWave(epic, waveNumber, ...)` + new `findFirstWave(epic)` helper.
- `functions/shared/services/__tests__/pipeline-launcher.test.ts` — updated to new signature + added non-wave-1 launch test.
- `functions/api/index.ts` — `/start` and `/from-xml` autoStart now use `findFirstWave` + `launchPipelineWave`; inline `generateStoryPipeline` and `generateWaveBuildPipeline` removed in favor of shared-module imports.
- `sst.config.ts` — new `WaveCompletionCheck` cron at `rate(1 minute)`, 256 MB / 120s timeout, linked to agent-jobs + epic-workflows tables.

### Test Results

- 9 new wave-reducer tests (all 7 AC-10 cases + edge cases) — passing.
- 2 new pipeline-launcher tests (findFirstWave + non-wave-1 launch) — passing alongside existing 8.
- Full `functions/` suite: 157/157 passing.
- Pre-existing 5 failures in `daemon/pipelines/__tests__/epic-dev-pipeline.test.mjs` and `daemon/pipelines/lib/__tests__/codebase-index.test.mjs` originate in commit 73ac1ae — unrelated to 16.2.

---

## Review Notes

<!-- -->
