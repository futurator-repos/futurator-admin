# Story 17.4: Epic-level dependencies + plan waves

**Status:** Backlog

---

## User Story

As **Richie (operator) running a multi-epic plan**,
I want **epics to execute in order defined by their `dependsOnEpics` graph, with parallel execution where possible**,
So that **Epic 2 doesn't start until Epic 1 completes (because Epic 2 imports types Epic 1 defined), and independent Epics 2 + 3 run in parallel to save time**.

---

## Acceptance Criteria

**AC #1** — `functions/shared/services/plan-waves.ts` exports `computePlanWaves(epics): Record<epicId, number>`. Algorithm: topological sort; each epic's wave number = `1 + max(wave of each dependency)`, or `0` if no deps. Throws on cycles. Mirrors the existing story-wave algorithm one level up.

**AC #2** — `POST /api/plans/:id/start`:
- Plan must be `status === 'concept'`, else 409.
- Computes `planWaves` via `computePlanWaves(epics)`.
- For each epic in plan-wave 0: calls existing `launchPipelineWave(epic, findFirstWave(epic), userId, now, deps)` to kick off its story-wave 0.
- Flips Plan `status = 'developing'`, persists `startedAt`.
- Returns 201 `{ jobsByEpic: { [epicId]: jobIds[] } }`.

**AC #3** — Wave-completion cron (Story 16.2) extended:
- **Existing behavior (inner pass)**: iterate epics, advance story waves via `reduceEpicWaves`. Unchanged.
- **New outer pass**: for each plan in `status === 'developing'`:
  - Inspect each epic's status (via `reduceEpicWaves` or direct epic.status).
  - If all epics in plan-wave N have `status === 'completed'` AND no plan-wave N epics are in `status === 'fixing'`:
    - Launch all plan-wave N+1 epics (one `launchPipelineWave` per epic, wave 0).
  - If all plan-waves have completed epics:
    - Create a PENDING `plan-build-check` job using the new `generatePlanBuildPipeline(workingDir, planName, allEpicTitles)` helper.
    - Set `plan.planBuildJobId = newJobId`.
  - If `plan.planBuildJobId` is set and the job is COMPLETED → `plan.status = 'review'`.
  - If `plan.planBuildJobId` is set and the job is FAILED → `plan.status = 'fixing'`.

**AC #4** — Plan status transitions (managed by reducer):
- `concept` → (user clicks Start) → `developing`
- `developing` → (any epic in fixing) → `fixing` (sticky until operator recovers)
- `developing` → (all epics done + plan-build-check COMPLETED) → `review`
- `developing` → (any epic `completed` but plan-build-check FAILED) → `fixing`
- `review` → (operator ships) → `delivered`

**AC #5** — `functions/shared/pipelines/plan-build-pipeline.ts` — a 2-step shell pipeline: `npm run build` + dev-server `curl localhost:5173` smoke. Same pattern as `wave-build-pipeline.ts` but at the plan-root working dir.

**AC #6** — Unit tests:
- `computePlanWaves`: linear deps (E1→E2→E3 = [0,1,2]), parallel (E1 E2 E3 no deps = [0,0,0]), diamond (E1→E2, E1→E3, (E2,E3)→E4 = [0,1,1,2]), cycle detection (throws).
- Plan reducer: 3-epic plan (E1 then E2+E3 parallel then E4) drives through completion with mocked job timeline.
- Plan reducer: plan-build-check FAILED → `plan.status = 'fixing'`, no deliver transition.

**AC #7** — Integration test: cron ticks through a 2-epic plan end-to-end (existing `wave-completion-check.test.ts` extended).

**AC #8** — `npm run ci` passes.

---

## Implementation Details

### Tasks / Subtasks

- [ ] Create `plan-waves.ts` + its tests.
- [ ] Create `plan-build-pipeline.ts` helper.
- [ ] Extend `wave-reducer.ts` with an outer `reducePlan(plan, epics, deps)` function that calls `reduceEpicWaves` for each epic and then reconciles plan state.
- [ ] Update `functions/cron/wave-completion-check.ts` to:
  - Scan `futurator-plans` table (status in `['developing', 'fixing']`).
  - For each plan: fetch its epics, call `reducePlan`.
  - Log per-plan result.
- [ ] Add `POST /api/plans/:id/start` endpoint in `functions/api/index.ts`.
- [ ] Unit + integration tests.
- [ ] `npm run ci` passes.

### Key Code References

- `functions/shared/services/wave-reducer.ts` — inner reducer (Epic 16 Story 16.2); extend.
- `functions/shared/services/pipeline-launcher.ts` — `launchPipelineWave` + `findFirstWave`.
- `functions/shared/pipelines/wave-build-pipeline.ts` — reference shape for the plan build pipeline.
- `functions/cron/wave-completion-check.ts` — extend.

---

## Context References

**Epic:** [../epics-plan-based-labs.md](../epics-plan-based-labs.md).
**Depends on:** 17.1 (Plan repo), 17.2 (folder), 17.3 (epic rows with `planId` + `dependsOnEpics` populated).

---

## Dev Agent Record

<!-- -->
