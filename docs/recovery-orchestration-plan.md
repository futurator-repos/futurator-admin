# Orchestration Recovery Plan

**Status:** Draft — investigation only; no code changes yet
**Author:** Ricardo Araya (Richie)
**Date:** 2026-04-20
**Context:** We shipped the Epic Orchestrator (commit `73ac1ae`, 103 files, +17,906 LOC) as the single execution model for epic workflows. It traded the explicit per-step daemon pipeline for a single outer Claude process that uses the Task tool to spawn its own subagents. We lost observability and control over individual dev/reviewer/tester actions. This plan describes how to re-establish the per-step model without losing the ~90% of `73ac1ae` that is infrastructure (UI, events, repos, receiver, stale-heartbeat, etc.) unrelated to the execution model.

---

## 1. What "full control" means (the target state)

From `docs/concepts/agentic-pipeline-forensic-report.md` (the definitive record of the working pre-orchestrator system, based on a real Chrome Dinosaur Game run: 10 stories, 3 waves, $4.69, 70 min):

| Tier | Step | Kind | Model | Notes |
|---|---|---|---|---|
| **STORY** | 1. `dev` | agent | haiku | implements story (Bash/Read/Edit/Write/Glob/Grep). Emits `---WORK_SUMMARY---`. |
| **STORY** | 2. `review` | agent | haiku | checks AC. Emits `VERDICT: PASS/FAIL`. |
| **STORY** | 3. `retry` | agent (loop) | haiku | resumes dev session via `--resume`, applies feedback. Max 3 iterations. |
| **STORY** | 4. `compile-diff` | shell | — | `git diff --name-status` → list of touched files. |
| **STORY** | 5. `compile-knowledge` | agent | sonnet (wrong — should be haiku) | writes wiki articles in `knowledge/code/`. |
| **STORY** | 6. `compile-sync` | shell | — | `graph-sync.mjs` + `aws s3 sync knowledge-live/...`. |
| **WAVE** | A. `build-check` | shell | — | `npm run build`. |
| **WAVE** | B. `server-check` | shell | — | 15-second `curl` health check. |
| **EPIC** | I. `qa-start-server` | shell | — | launch dev server. |
| **EPIC** | II. `qa-evaluate` | agent | sonnet | visual tests. |
| **EPIC** | III. `qa-stop-server` | shell | — | kill dev server. |
| **EPIC (optional)** | PO review | agent | sonnet | — |
| **EPIC (optional)** | Deploy | agent | haiku | build + S3 sync + CloudFront invalidation. |

Every step is observable as a discrete job with its own events stream. You can retry, resume, re-run, or kill a single step. Cost and duration are attributable per agent per story.

## 2. Current state (what broke, what survived)

### What broke (user-facing)

- `POST /api/epic-workflows/:id/start` (`functions/api/index.ts:1817`) creates a job with `phase: 'epic-dev'` and `epicDevPayload: {stories, contextDigest, rubric, ...}`. The daemon routes this to `runEpicDevPipeline()` which spawns **one** `claude -p --model opus` process that decides internally (via the Task tool) when and how many dev/reviewer subagents to spawn.
- Two endpoints were outright removed and now return `410 Gone`:
  - `POST /api/epic-workflows/:id/visual-qa` — "Orchestrator handles QA inline."
  - `POST /api/epic-workflows/:id/dev-server` — "Orchestrator manages its own dev environment."

### What survived (this is the entire point of Option C)

The step-based execution model is **still alive in the code** and **still the default path for any non-orchestrator job**. Concretely:

1. **`daemon/agent-daemon.mjs:939` `executePipeline(job)`** — fully-functional step-based executor. Every job that does not have `phase === 'epic-dev'` (and is not a Party job) already runs through it today. It supports:
   - `stepType: 'agent' | 'shell'`
   - `extractors` (regex / between delimiters)
   - `validations` (equals / contains / not_contains)
   - `loopTo` for retry loops (with `maxIterations` cap)
   - `resumeFromStep` for `claude --resume <session>` semantics
   - `compile-*` step IDs integrated with the Mycelium compile pipeline
   - Proper per-step event emission (which the UI already renders)

2. **Types intact** in `functions/shared/types/agent-orchestrator.ts`:
   - `PipelineDefinition { agents, steps, maxIterations, initialVariables }`
   - `PipelineStep { id, stepType, agentId, prompt, resumeFromStep, extractors, validations, loopTo, command, timeout, captureAs, captureStderrAs, onFail }`
   - `AgentConfig { name, allowedTools, disallowedTools, model }`
   - `ExtractorConfig`, `ValidationConfig`

3. **Eleven live call sites** in `functions/api/index.ts` still build `PipelineDefinition` objects:
   | Endpoint | Purpose | Lines |
   |---|---|---|
   | `POST /api/epic-workflows/generate` | one-shot PM agent that emits epic XML | `1165` |
   | `POST /api/epic-workflows/from-xml` | creates epic from already-parsed XML | (no pipeline — just DDB write) |
   | `POST /api/epic-workflows/:id/deploy` | 1-step DEPLOY agent pipeline | `2693` |
   | `POST /api/projects/:projectId/bug-report` | **7-step pipeline** (dev → build-check → dev-build-fix loop → server-check → dev-server-fix loop → review → retry loop) | `2822` |
   | `POST /api/projects/:projectId/feature-request` | 1-step PM "delta epic" pipeline | `3018` |
   | Static builders | `buildStoryPipeline()`, `buildBugPipeline()`, `buildVisualQaPipeline()` (returned 410 now) | `689`, `930`, `2098` |

   **The bug-report pipeline is the closest living example of the full pattern we need** — loops, shells, extractors, validations — and it works today.

4. **Observability spine intact:** `daemon/forwarder/ndjson-forwarder.mjs`, `daemon/receiver/http-receiver.mjs` (`/wave-complete`, `/heartbeat`), `functions/shared/rendering/flat-log.ts`, and `futurator-agent-events` DDB table all work for both models.

5. **UI renders per-step events natively:**
   - `src/components/labs/agentic-workflow/story-live-output.tsx` already renders tool_use, tool_result, text_delta, step_start, step_complete, extraction, validation events — all of which `executePipeline` emits.
   - `src/components/labs/agentic-workflow/story-card.tsx` — shows per-story jobId, sessions, retry count.
   - The 3D orchestrator office (`src/components/agentic-office/scene/*`) was built to render orchestrator-emitted events specifically; it can coexist with per-step events or be scoped to orchestrator jobs only.

### What's specifically dead weight (only used by the orchestrator path)

- `daemon/pipelines/epic-dev-pipeline.mjs` — orchestrator spawner (the wrong execution model).
- `daemon/pipelines/templates/epic-orchestrator-prompt.md.tpl` — the big prompt that tells one Claude to be an orchestrator.
- `daemon/pipelines/templates/dev-subagent-prompt.md.tpl` — subagent template consumed by the above.
- `daemon/pipelines/templates/reviewer-subagent-prompt.md.tpl` — same.
- `daemon/pipelines/templates/remediation-prompt.md.tpl` — same.
- `functions/shared/services/epic-dev-launcher.ts` — validates the epic-dev payload shape.
- `scripts/migrate-to-epic-orchestrator.ts` — one-shot migration of pre-existing epics to the orchestrator model (now reversing direction).
- The `phase: 'epic-dev'` + `epicDevPayload` branch of `AgentJob`, `JOB_HANDLER_EPIC_DEV`, `validateEpicDevJob`.

### What's valuable and stays regardless of path

- `daemon/pipelines/touch-point-inference.mjs` — 766 lines of still-useful classification (complexity, review rigor, touch points). The step-based epic should still run this once per story before building the pipeline.
- `daemon/receiver/http-receiver.mjs` — `/wave-complete` + `/heartbeat`. Wave-complete is actually useful for the step-based model too (daemon can checkpoint per wave).
- `daemon/pipelines/stale-heartbeat.mjs` — orphan-job recovery on daemon restart.
- `daemon/pipelines/lib/rubric-merge.mjs`, `codebase-index.mjs`, `glob-intersect.mjs` — prompt-building helpers, reusable.
- `daemon/pipelines/lib/epic-repo.mjs` — per-job epic context cache, reusable.
- `docs/concepts/observability-spine-contract.md` — authoritative event-shape spec.
- `functions/shared/rendering/flat-log.ts` — paste-friendly trace renderer.
- `functions/shared/repositories/*` — unchanged.
- `src/app/reports/page.tsx` — reports page.
- `src/components/labs/agentic-workflow/resolve-blocker-drawer.tsx` — blocker resolution UI (arguably MORE useful in step-based where "blocker" means "story N failed review 3 times" and needs human unblock).
- `src/components/agentic-office/scene/orchestrator-*.ts` — the 3D office. Opt-in: can render for orchestrator jobs only, or be retired.
- `src/types/agent-orchestrator.ts`, `src/hooks/use-orchestrator-metrics.ts`, `src/hooks/use-resolve-blocker.ts` — reusable.

## 3. Recommended approach — **Option C (forward)**

Keep the orchestrator code in place. Add the step-based epic pipeline as the default. Wire a single `PIPELINE_MODE` flag per epic so you can A/B both models while you rebuild confidence. Once you're confident, delete the orchestrator code in a separate commit.

This avoids:
- Destructive `git revert` on 103 files
- Conflicts with Party, Mycelium, Identity Broker, and Reports
- Loss of the 3D office / reports / resolve-blocker drawer

This requires writing ~400-700 lines of new code (the epic-to-step-list builder) plus small wiring changes.

### Alternatives considered (and rejected)

- **Option A — surgical in-place**: same end state but without the mode flag. Faster to ship but no easy rollback if the step-based model has its own issues.
- **Option B — full `git revert 73ac1ae`**: loses Reports, resolve-blocker, 3D office, concept docs, all orchestrator tests. Conflicts with Party. Not recommended.

## 4. Proposed epic + story breakdown (Epic 16)

**Epic 16: Step-Based Epic Pipeline Recovery**

**Goal:** Restore per-step execution (dev → review → retry → compile-*) for user-created epics so the operator has discrete observability, retryability, and cost attribution per agent per story. Orchestrator path remains available via opt-in flag until deprecated.

**Scope:** `POST /api/epic-workflows/:id/start` default execution mode, the per-story pipeline builder, the wave-level build check job, and the epic-level visual-QA job. Does NOT modify Mycelium, Party, bug-report, feature-request, or deploy pipelines (all already step-based and working).

**Stories:**

### Story 16.1 — Epic-to-step pipeline builder + mode dispatch

**As** the operator starting an epic,
**I want** the "Start" button to create explicit per-story step-based jobs,
**So that** I see discrete dev/review/retry/compile events per story and can retry individual steps.

**Acceptance criteria:**

1. Add `executionMode: 'orchestrator' | 'step-based'` to the `EpicWorkflow` type, default `'step-based'` for new epics.
2. When `executionMode === 'step-based'`, `POST /api/epic-workflows/:id/start` creates **one `PipelineDefinition` job per story per wave**, not a single `phase='epic-dev'` job. Jobs for a wave are enqueued in parallel; wave N+1 only enqueues after wave N's jobs are all `COMPLETED`.
3. Each per-story pipeline contains exactly the 6 steps from `docs/concepts/agentic-pipeline-forensic-report.md` §2 (dev → review → retry(loop) → compile-diff → compile-knowledge → compile-sync).
4. `compile-knowledge` uses `haiku` (not `sonnet`) — the forensic report identified model selection as one of the top issues.
5. Move selection of model per step out of hard-coded strings into a `modelMatrix` table keyed on `{complexity, reviewRigor}` (from touch-point inference) so the operator can tune per run.
6. When `executionMode === 'orchestrator'`, existing behavior unchanged (epic-dev payload path). This is the mode-flag safety net.
7. New environment variable `DEFAULT_EPIC_EXECUTION_MODE` defaults to `step-based`. Setting it to `orchestrator` flips the default for new epics.
8. Tests: Vitest unit tests for the pipeline builder with 3 shapes — single-wave/single-story, single-wave/multi-story, multi-wave. Plus one round-trip test confirming the daemon's `executePipeline` consumes the output correctly (mocked `spawn`).

**Out of scope:** frontend UI changes to choose execution mode (defaults work).

**Estimated effort:** 5 points (~5 days).

**Files expected to change:**
- `functions/shared/types/epic-workflow.ts` (add `executionMode` field)
- `functions/shared/services/epic-step-pipeline-builder.ts` (NEW — the builder)
- `functions/shared/services/__tests__/epic-step-pipeline-builder.test.ts` (NEW)
- `functions/api/index.ts` — `POST /api/epic-workflows/:id/start` mode dispatch
- `functions/shared/repositories/epic-workflow-repository.ts` — persist `executionMode`

---

### Story 16.2 — Wave-level gating + wave build-check restoration

**As** the operator running a multi-wave epic,
**I want** wave N+1 to only start after wave N's stories are all COMPLETED and the wave build-check passes,
**So that** a story that broke the build is surfaced before downstream waves compound the damage.

**Acceptance criteria:**

1. After the last job in wave N reaches COMPLETED, the API (or a new cron-light reducer) enqueues a `wave-build-check` job (existing `buildVisualQaPipeline`-like shape but narrowed to `build-check` + `server-check`).
2. If `wave-build-check` passes, wave N+1's jobs are enqueued. If it fails, the epic transitions to `fixing` status and exposes the failing shell output via the existing flat-log renderer.
3. Per-wave progress visible in `/api/epic-workflows/:id` — wave status: `pending | running | build-checking | passed | failed`.
4. The existing `/wave-complete` HTTP receiver endpoint (`daemon/receiver/http-receiver.mjs`) is kept; it already writes `waveResults[N]` on the job row. For step-based this means the final story-job in each wave writes its checkpoint there.
5. Tests: daemon/API integration test driving a 3-wave epic through to completion with a deliberate build break in wave 2.

**Out of scope:** rollback of wave-N changes on failure (manual recovery for now, as today).

**Estimated effort:** 3 points (~3 days).

---

### Story 16.3 — Restore `/visual-qa` (and `/dev-server`) endpoints

**As** the operator finishing an epic,
**I want** to trigger visual QA as a discrete job I can re-run,
**So that** QA failures don't force me to re-run the entire epic.

**Acceptance criteria:**

1. `POST /api/epic-workflows/:id/visual-qa` rebuilt using the step-based `buildVisualQaPipeline()` that is already in the codebase (`functions/api/index.ts:2098`) — remove the 410 Gone stub.
2. `POST /api/epic-workflows/:id/dev-server` rebuilt as a 2-step pipeline (start + keepalive) — remove the 410 Gone stub.
3. UI buttons for both endpoints already exist in earlier git history — confirm they're still in `src/components/labs/agentic-workflow/epic-info-panel.tsx` or restore them from the UI render layer.
4. Visual QA still runs once per epic (not per story — forensic report §VISUAL QA argues against per-story).
5. Tests: one Vitest mocking the shell `npm run build` and `npx playwright screenshot` pipeline.

**Estimated effort:** 2 points (~2 days).

---

### Story 16.4 — Retire orchestrator execution path (optional, later)

**Status:** deferred. Only open this after 16.1–16.3 have been in production for ≥ 2 weeks and the step-based model has successfully run ≥ 5 epics end-to-end.

**Scope:**
- Delete `daemon/pipelines/epic-dev-pipeline.mjs` and 4 template `.tpl` files.
- Delete `functions/shared/services/epic-dev-launcher.ts` and `scripts/migrate-to-epic-orchestrator.ts`.
- Delete `JOB_HANDLER_EPIC_DEV`, `validateEpicDevJob`, and dispatch branch in `daemon/agent-daemon.mjs`.
- Delete `phase: 'epic-dev'` and `epicDevPayload` from `AgentJob` type.
- Decide fate of `src/components/agentic-office/scene/orchestrator-*.ts` — keep as general event visualization, or retire.
- Decide fate of `src/components/labs/agentic-workflow/resolve-blocker-drawer.tsx` — keep (still useful for step-based blocker surfacing) or retire.

**Estimated effort:** 3 points (~3 days) once activated.

---

## 5. Total effort & sequencing

| Story | Points | Dependencies |
|---|---|---|
| 16.1 | 5 | None (foundational) |
| 16.2 | 3 | 16.1 |
| 16.3 | 2 | 16.1 (ideally) |
| 16.4 | 3 | Deferred — after 16.1–16.3 proven |

**Total active work:** ~10 points / ~10 days.
**Total including deprecation cleanup:** ~13 points / ~13 days.

## 6. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Step-based model rediscovers the forensic-report bugs (compile overhead, OOM on parallel waves, inconsistent reviewer verdicts) | High | Medium | Forensic report (§"What Needs to be Fixed") lists fixes: switch compile to haiku, serialize compile-knowledge within a wave, cache knowledge/index.md per wave. Bake these in as part of 16.1 pipeline builder. |
| Orchestrator-era UI (3D office, resolve-blocker, reports) renders stale / broken for step-based jobs | Medium | Low | The 3D office is optional; hide it unless the epic's `executionMode === 'orchestrator'`. Reports page uses generic event-query — works for both. Resolve-blocker drawer is orthogonal. |
| Party module affected | Very low | — | Party uses its own `jobType: 'party-*'` dispatch and does not touch `phase` or `epicDevPayload`. Stays fully untouched. |
| Mycelium Devs (knowledge compilation) affected | Medium | Low | Mycelium's compile-* steps ARE the legacy per-story compile steps. They're still wired via `compile-pipeline.mjs`. Step-based epic pipeline re-uses them cleanly — this is a net positive for Mycelium too. |
| Identity Broker auth change (`2b28de6`) affected | No | — | Auth is a middleware; orchestration mode is orthogonal. |
| Cost regression — running many more Claude sessions per epic (vs one orchestrator) | Medium | Medium | Forensic report shows $4.69 for 10 stories on step-based vs no equivalent orchestrator run cost on record. Acknowledge we're trading cost for control. Add per-epic cost tracking in `EpicWorkflow` row. |
| Daemon concurrency ceiling (currently `MAX_CONCURRENT=2` jobs) bottlenecks parallel wave stories | Medium | Medium | Bump to 4-5 for typical EC2 t3.small/medium; monitor memory. Wave-level gating in 16.2 already limits peak concurrency to one wave's stories. |

## 7. What NOT to do

- **No full `git revert 73ac1ae`**. Too destructive.
- **No `git reset --hard`** of any kind.
- **No changes to Party module** (`src/components/labs/party/*`, `daemon/pipelines/party-*.mjs`, `functions/shared/repositories/party-*.ts`, etc.). Party is correct as-is and is the per-turn control pattern the user wanted.
- **No changes to Mycelium compile pipeline** beyond incidental re-use. Mycelium works; it's already step-based.
- **No changes to deploy / bug-report / feature-request pipelines**. All three are already step-based and working.
- **No rename or renumbering of existing stories** (15-1 through 15-3 for Party; 9-x through 14-x for Project Hub Enhancement etc.).
- **No deployment of this plan's implementation** until the user explicitly approves Epic 16 and its stories.

## 8. Artefacts available for reference

Already in the repo:

- `docs/concepts/agentic-pipeline-forensic-report.md` — the definitive behavioral spec (real measured runs).
- `docs/concepts/futurator-agent-orchestrator-architecture.md` — the original step-based architecture doc (1,066 lines).
- `docs/concepts/labs-testing-pipeline-plan.md` — 2026-04-13 plan that introduced `stepType: 'agent'|'shell'`, still the type contract in use.
- `docs/concepts/orchestrator-pipeline-brainstorm.md` — the brainstorm that (regrettably) led to shipping the orchestrator. Useful as "what not to do again" and for context on what we tried to solve.
- `docs/concepts/observability-spine-contract.md` — event-shape spec. Kept as-is.
- `docs/concepts/resolve-blocker-contract.md` — blocker taxonomy. Reusable for step-based.
- `functions/api/index.ts:2822` (`bugPipeline`) — live, working 7-step pipeline template to copy from.
- `daemon/agent-daemon.mjs:939` (`executePipeline`) — the unchanged step executor.

## 9. Immediate next step (approval gate)

**Approve Epic 16 + Story 16.1 first**, then I can drive Story 16.1 through `dev-story` workflow. No code changes before that approval.

If this plan is off-target in any way (scope, sequencing, risks), call that out so we refine it before committing.

---

_Generated 2026-04-20 during an investigation session. No code was modified._
