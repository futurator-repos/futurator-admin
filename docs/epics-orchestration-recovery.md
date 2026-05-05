# Futurator-Admin — Epic 16: Orchestration Recovery (Step-Based Pipeline)

**Date:** 2026-04-20
**Project Level:** 1 (3 stories, ~7 story points — smaller than original estimate because `generateStoryPipeline()` is still intact in the codebase)
**Tech-Spec:** [recovery-orchestration-plan.md](./recovery-orchestration-plan.md) — authoritative investigation + option analysis
**Epic Number:** 16 (follows Epic 15 — Party Module)

---

## Epic 16: Step-Based Epic Pipeline Recovery

**Slug:** `orchestration-recovery`

### Goal

Restore per-step execution control over epic-workflow runs so the operator has discrete observability, retryability, and cost attribution per agent per story — reversing the single-outer-Claude-orchestrator model shipped in `73ac1ae`. Orchestrator path remains available via the existing `EpicWorkflow.useEpicOrchestrator` flag, and default flips to step-based once tested.

### Scope

**In Scope:**

- `POST /api/epic-workflows/:id/start` gains mode dispatch: when `useEpicOrchestrator === false`, create one per-story `PipelineDefinition` job per wave instead of a single `phase='epic-dev'` job. When `useEpicOrchestrator === true`, unchanged.
- Restore `POST /api/epic-workflows/:id/stories/:storyId/run` (currently 410). This lets the operator re-run a single failed story without respawning the whole epic.
- Wave-level gating: wave N+1's jobs enqueue only after wave N's are all `COMPLETED`. Uses the existing `waveBuildJobs` field on `EpicWorkflow`.
- Restore `POST /api/epic-workflows/:id/visual-qa` (currently 410) — QA pipeline as a discrete, re-runnable job per epic.
- Restore `POST /api/epic-workflows/:id/dev-server` (currently 410).
- Default for new epics: flip `useEpicOrchestrator: true` → `false`. Existing epics retain their current value.

**Out of Scope (deferred):**

- Retirement of the orchestrator code path (Story 16.4 in the original plan — kept as an explicit deferred item until step-based has run ≥ 5 epics successfully in production).
- Rebuilding the resolve-blocker UI for step-based failures (the drawer still works, but blocker mapping needs re-wire).
- 3D agentic-office scene changes (keep rendering orchestrator-mode events; step-based uses the existing per-step events which `story-live-output.tsx` already renders).
- Reports page + flat-log renderer — work unchanged for both modes.
- Mycelium compile-* pipeline (reused as-is — step-based already invokes those steps in every story).

### Success Criteria

1. Operator can click **Start Epic** on a new epic and see one job per story per wave in `futurator-agent-jobs`, each executing the 6-step pipeline from `docs/concepts/agentic-pipeline-forensic-report.md` §2.
2. Each story's events stream (`futurator-agent-events`) shows discrete `step_start`, `tool_use`, `step_complete` events per agent per step — the Labs UI's `story-live-output.tsx` renders this without code changes.
3. Operator can re-run a single failed story via **Retry** on the story card (API: `POST /stories/:storyId/run`) without touching the rest of the epic.
4. `POST /visual-qa` and `POST /dev-server` return 201 + a `jobId` (not 410) and their jobs execute the existing `buildVisualQaPipeline()` / dev-server shell pipeline.
5. Wave N+1 does not start before wave N is complete — verified by ordering of `createdAt` timestamps on jobs.
6. Legacy orchestrator path still works end-to-end for any epic with `useEpicOrchestrator: true` — no regression.
7. `npm run ci` passes end-to-end.

### Dependencies

**External / operational:** none new. Daemon + DDB + Claude auth + EC2 filesystem all already in place.

**Internal code that must stay intact:**

- `functions/api/index.ts:693` — `generateStoryPipeline(story, epicTitle, workingDir, opts)` — builds the 6-step per-story pipeline. **Do not rewrite; just call.**
- `functions/api/index.ts:~2098` — `buildVisualQaPipeline(epic)` — still exists. Restore its 410-stub endpoint.
- `functions/shared/types/agent-orchestrator.ts` — `PipelineDefinition`/`PipelineStep` types unchanged.
- `daemon/agent-daemon.mjs:939` — `executePipeline(job)` — the step executor. Unchanged.
- `daemon/pipelines/job-router.mjs` — dispatches step-based jobs when no `phase='epic-dev'` or `jobType='party-*'`. Unchanged.
- `src/components/labs/agentic-workflow/story-live-output.tsx` — already renders per-step events. Unchanged.

---

## Story Map — Epic 16

```
Epic 16: Orchestration Recovery
├── Story 16.1: Wire step-based path in /start (2 pts)
│   Dependencies: None (foundational)
│   Delivers: useEpicOrchestrator=false epics use generateStoryPipeline; single-wave only
│
├── Story 16.2: Multi-wave gating + wave build-check (3 pts)
│   Dependencies: 16.1
│   Delivers: Wave N+1 waits for wave N COMPLETED; wave-build-check job on wave close
│
└── Story 16.3: Restore /visual-qa + /dev-server + /stories/:id/run (2 pts)
    Dependencies: 16.1 (uses same dispatch model for side-endpoints)
    Delivers: Three endpoints un-410'd; re-run UI affordances work again
```

**Deferred (not in this epic):**

```
└── Story 16.4: Retire orchestrator code (3 pts, deferred)
    Trigger: Step-based has run ≥ 5 production epics with no regressions.
    Scope: delete epic-dev-pipeline.mjs, remove JOB_HANDLER_EPIC_DEV branch, drop `phase: 'epic-dev'`
           from AgentJob type, clean up orchestrator templates.
```

**Total active points:** 7
**Estimated timeline:** ~1 sprint (1 week of focused work)

---

## Stories — Epic 16

### Story 16.1: Wire step-based path in `/start`

As **Richie (operator)**,
I want **the Start Epic button to create per-story pipelines when `useEpicOrchestrator` is false**,
so that **each story runs as a discrete job I can monitor, retry, and cost-attribute individually**.

**Acceptance Criteria:**

- **AC #1** — Given `EpicWorkflow.useEpicOrchestrator === false`, when `POST /api/epic-workflows/:id/start` is called, the endpoint creates **one PENDING job per story in wave 1** (the lowest `wave` number among stories). Each job has `pipeline = generateStoryPipeline(story, epic.title, epic.workingDir, opts)`, no `phase` field, no `epicDevPayload`. The response returns `{jobIds: string[], waveNumber: 1}`.
- **AC #2** — Given `EpicWorkflow.useEpicOrchestrator === true`, when `POST /api/epic-workflows/:id/start` is called, existing orchestrator behavior is unchanged — single job with `phase: 'epic-dev'` and `epicDevPayload`. Response is unchanged: `{jobId}`.
- **AC #3** — New epics created via `POST /api/epic-workflows` default to `useEpicOrchestrator: false`. Existing epics retain their current flag value (no migration). Default in `functions/shared/repositories/epic-workflow-repository.ts:createEpic` flips.
- **AC #4** — The API updates `epic.status = 'in_progress'` and persists the created `jobIds[]` into a new or existing `epic.storyJobs` map shape `{[storyId: string]: string}` so the UI knows which job runs which story.
- **AC #5** — If wave 1 contains > 1 story, all jobs are created in parallel (no inter-dependency). If wave 1 is empty (edge case — first wave is `wave === 0` or all stories are in higher waves), the endpoint returns 400 `no-wave-1-stories`.
- **AC #6** — Wave N+1 is **not yet handled** in this story — that's 16.2. For now, only wave 1 is enqueued. A comment in the code marks the extension point.
- **AC #7** — Unit tests for the new dispatch logic: one test that `useEpicOrchestrator=true` path creates a single `phase='epic-dev'` job (regression); one test that `useEpicOrchestrator=false` path creates N jobs with `generateStoryPipeline` output. Mock `agentJobsRepo.createJob` and `generateStoryPipeline`.
- **AC #8** — `npm run ci` passes.

**Prerequisites:** None. `generateStoryPipeline` is intact at `functions/api/index.ts:693`.

**Technical Notes:**

- `/api/epic-workflows/:id/start` is at `functions/api/index.ts:1832`. Add a branch BEFORE the existing `validateEpicForOrchestratorStart` call.
- `generateStoryPipeline` signature: `(story, epicTitle, workingDir, {devModel?, devEffort?, reviewerModel?, reviewerEffort?, epicId?})`. Pull models/efforts from `epic.devModel` etc.
- Use the existing `computeWave()` logic in `POST /api/epic-workflows` to re-derive wave numbers if stories don't already have them. In practice wave numbers should already be on story rows.
- The existing UI (`src/components/labs/agentic-workflow/index.tsx`) polls `GET /api/epic-workflows/:id` and looks at each story's `jobId`. If we write `storyJobs[storyId]` on the epic row, the existing UI logic already picks up per-story jobs from the legacy code path — confirm behavior before considering this story done.

**Estimated Effort:** 2 points (~1-2 days).

**Files expected to change:**
- `functions/api/index.ts` — the `/start` endpoint branch (~50 LOC)
- `functions/shared/repositories/epic-workflow-repository.ts` — `createEpic` default flip + schema change for `storyJobs` field
- `functions/shared/types/epic-workflow.ts` — add `storyJobs?: Record<string, string>` field
- `functions/api/__tests__/` (new or existing file) — 2 unit tests

---

### Story 16.2: Multi-wave gating + wave build-check

As **Richie (operator) running a multi-wave epic**,
I want **wave N+1 to start automatically only after wave N's stories are all COMPLETED and a wave build-check passes**,
so that **a story that broke the build is surfaced before downstream waves compound the damage**.

**Acceptance Criteria:**

- **AC #1** — A new cron Lambda or API endpoint runs wave-completion checks: for each epic with `useEpicOrchestrator === false` and `status === 'in_progress'`, check if the current wave's stories all have jobs with `status === 'COMPLETED'`. If yes, enqueue a `wave-build-check` shell job (2 steps: `npm run build` + server curl).
- **AC #2** — When the `wave-build-check` job COMPLETES, enqueue all wave-N+1 stories as per-story PENDING jobs (mirroring Story 16.1 logic). Persist the wave-build-check's `jobId` into `epic.waveBuildJobs[waveNumber]`.
- **AC #3** — If `wave-build-check` fails, the epic transitions to `status: 'fixing'` and the UI surfaces the shell-step output via the existing flat-log renderer (`functions/shared/rendering/flat-log.ts`).
- **AC #4** — After the last wave's stories all COMPLETE and the last wave-build-check passes, epic transitions to `status: 'completed'`.
- **AC #5** — The wave-completion check mechanism is resilient to daemon restarts. If the daemon is restarted mid-wave-transition, the check rediscovers in-progress epics on next run and resumes waves appropriately.
- **AC #6** — Unit tests: a 3-wave epic with 2 stories per wave drives through completion via a mocked job-status timeline; a 3-wave epic with wave 2 failing its build stops at `status: 'fixing'`.
- **AC #7** — `npm run ci` passes.

**Prerequisites:** Story 16.1 complete.

**Technical Notes:**

- The cron approach: add a new entry in `functions/cron/` — e.g., `wave-completion-check.ts` — running every 60 seconds via EventBridge Scheduler. Pattern matches existing crons in `sst.config.ts`.
- Alternative — a daemon-polled approach (daemon itself checks waves after each job completion). Cleaner but couples logic to daemon. Cron is simpler and decoupled.
- Use existing `buildVisualQaPipeline()`-style shell pipeline shape for the wave-build-check: two steps, `build-check` + `server-check`, both `stepType: 'shell'` with `captureAs` / `captureStderrAs`.
- `waveBuildJobs` map shape already exists on `EpicWorkflow` (line 156 of `epic-workflow.ts`). Reuse it.

**Estimated Effort:** 3 points (~2-3 days).

---

### Story 16.3: Restore `/visual-qa` + `/dev-server` + `/stories/:id/run`

As **Richie (operator)**,
I want **per-story re-run, visual QA, and dev-server endpoints available as discrete operations**,
so that **I can isolate failures, re-validate specific parts of an epic, and launch dev environments without respawning the whole epic**.

**Acceptance Criteria:**

- **AC #1** — `POST /api/epic-workflows/:id/stories/:storyId/run` (currently 410) creates a fresh PENDING job with `pipeline = generateStoryPipeline(story, epic.title, epic.workingDir, opts)` and updates `epic.storyJobs[storyId]` to point at the new jobId. Returns `{jobId}` 201.
- **AC #2** — `POST /api/epic-workflows/:id/visual-qa` (currently 410) calls existing `buildVisualQaPipeline(epic)` and creates a single PENDING job. Stores `epic.qaJobId = jobId`. Returns `{jobId}` 201.
- **AC #3** — `POST /api/epic-workflows/:id/dev-server` (currently 410) creates a 2-step shell pipeline: `npm run dev` in background + `curl localhost:5173` health check. Returns `{jobId}` 201.
- **AC #4** — None of these endpoints check `useEpicOrchestrator` — they all use step-based pipelines unconditionally.
- **AC #5** — UI wiring check: the Labs UI's "Retry story" button (in `story-card.tsx`) already calls `/stories/:storyId/run`. Confirm the button re-renders properly on success (no new frontend code needed, just verify).
- **AC #6** — Unit tests: one test per restored endpoint asserting correct pipeline shape.
- **AC #7** — `npm run ci` passes.

**Prerequisites:** Story 16.1 complete (re-uses `generateStoryPipeline` from there; no new builder logic).

**Technical Notes:**

- The 410-stubs are at approximate line numbers:
  - `/stories/:storyId/run` — `functions/api/index.ts:1816`
  - `/visual-qa` — `functions/api/index.ts:~2190`
  - `/dev-server` — `functions/api/index.ts:~2210`
- Git history (commit `73ac1ae`) contains the original implementations if the current 410 stubs don't have the builder functions left behind. Worst case: `git show 73ac1ae:functions/api/index.ts | grep -A 30 "/stories/:storyId/run"` to recover the original handler shape.

**Estimated Effort:** 2 points (~1-2 days).

---

## Implementation Timeline — Epic 16

**Total Story Points:** 7

**Estimated Timeline:** ~1 sprint (4-6 working days).

**Sequencing rationale:**

1. **Story 16.1 first** — wires the one branch in `/start` that everything else depends on. End state: can curl a single-wave epic through full completion, one job per story, events flowing.
2. **Story 16.2 second** — adds wave sequencing on top. End state: multi-wave epics work autonomously.
3. **Story 16.3 third** — restores the side-endpoints that complete the developer experience. End state: operator has full CRUD over epic execution at story/wave/epic granularity.

**Dependency Validation:** ✅ Valid sequence — no forward dependencies. 16.1 delivers working single-wave epics. 16.2 extends. 16.3 is additive side-endpoints.

---

## Tech-Spec Reference

See [recovery-orchestration-plan.md](./recovery-orchestration-plan.md) for the full investigation + option analysis. That doc is the source of truth for why we chose Option C (forward), what's preserved from `73ac1ae`, and the forensic report's behavioral spec.

Additional canonical source: [docs/concepts/agentic-pipeline-forensic-report.md](./concepts/agentic-pipeline-forensic-report.md) — measured behavior of the 6-step per-story pipeline on the Chrome-Dino epic (10 stories, 3 waves, $4.69, 70 min).

---

## After Epic 16

Once 16.1-16.3 are `review` + operator has run ≥ 5 production epics without regressions, open **Story 16.4 (deferred)**:

- Delete `daemon/pipelines/epic-dev-pipeline.mjs` + the 4 orchestrator prompt templates.
- Delete `functions/shared/services/epic-dev-launcher.ts`.
- Delete `scripts/migrate-to-epic-orchestrator.ts`.
- Remove `JOB_HANDLER_EPIC_DEV` branch from `daemon/agent-daemon.mjs` + `job-router.mjs`.
- Remove `phase: 'epic-dev'` + `epicDevPayload` from `AgentJob` type.
- Decide fate of `src/components/agentic-office/scene/orchestrator-*.ts` (keep as generic event visualizer, or retire).
- Decide fate of `src/components/labs/agentic-workflow/resolve-blocker-drawer.tsx` (keep — useful for step-based blocker surfacing — or retire).

3 points when activated. Not now.
