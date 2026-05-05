# Futurator-Admin — App / Plan Brownfield Model (Pipeline v1)

**Author:** Richie
**Date:** 2026-04-27
**Project Level:** 2 (cross-cutting feature: data model, API, daemon, prompt, frontend)
**Source Tech Spec:** [`docs/tech-spec-app-plan-v1.md`](./tech-spec-app-plan-v1.md)
**Supersedes:** `docs/concepts/published-feedback-loop-mvp.md` (bug-fix-only design)

---

## Overview

This document decomposes the App/Plan v1 tech spec into seven epics totaling **27 stories**. Each story is sized for single-session completion by a 200k-context dev agent, sequenced with no forward dependencies, and carries `touchPoints` (per pipeline-v1 dev-correction Story D.2) so the wave-conflict resolver can serialize correctly.

The seven epics map 1:1 to the Implementation Sequence in §"Implementation Sequence" of the tech spec:

```
App/Plan v1 — 27 stories across 7 epics

  Backend foundation (ship first)
  ├── Epic 1   App/Plan Data Foundation             5 stories
  ├── Epic 2   App Lifecycle API                    6 stories
  ├── Epic 3   Pipeline Integrity Guards            4 stories
  └── Epic 4   PM Brownfield Planning               4 stories

  UI (ships on top of backend)
  ├── Epic 5   Apps Workspace Home                  4 stories
  └── Epic 6   App Workshop View                    7 stories

  Migration + cleanup (ships last)
  └── Epic 7   Plan Detail Re-shell + URL Migration 4 stories  (overlap with Epic 6 — see deps)
```

**Sequencing rationale:**

1. **Epics 1–4 ship the backend** in order: data model → API → daemon guards → PM-augmentation prompt. Each can be exercised via curl/integration tests before any UI lands.
2. **Epics 5–6 ship the UI** on top of the stable backend. Epic 5 is the entry surface (Apps grid); Epic 6 is the workshop where operators spend most of their time.
3. **Epic 7 finishes the URL migration**, re-shelling the existing pipeline UI under the new nested route. Sweep + replace is the final mechanical step.

**Pre-epic cleanup:** the user has confirmed existing Plans are throwaway prototypes; a one-shot manual wipe of `futurator-plans` rows + `/home/ubuntu/projects/*` precedes Epic 1. **No data migration; no compat layer.**

---

## Epic 1: App/Plan Data Foundation

**Slug:** `app-plan-foundation`
**Goal:** Establish the new App entity and modify the Plan entity so all downstream work has a stable schema, repository, and validation surface to build against. Ship the SST infra changes (new table, new GSI) so the runtime is ready for traffic.

### Story 1.1: Define `App` and `Plan` types + Zod schemas

As Richie,
I want strongly-typed, Zod-validated `App` and updated `Plan` schemas at `functions/shared/`,
So that the rest of the project has a single source of truth for what's stored and what's accepted at API boundaries.

**Acceptance Criteria:**

**Given** the tech spec's data-model section,
**When** the schema files are created/modified,
**Then** `functions/shared/types/app.ts` exports an `App` interface matching the tech spec exactly (10 fields, `icon` optional).

**And** `functions/shared/types/plan.ts` adds `appId`, `kind`, `intent`, `iterationLabel`, `noTouchPaths`; removes `name`, `workingDir`, `deployJobIds`, `useEpicOrchestrator`; replaces statuses (`fixing`/`archived` removed; `abandoned` added).

**And** `functions/shared/schemas/app-schema.ts` exports `appSchema`, `createAppInputSchema`, `updateAppInputSchema`, `slugRegex`, `RESERVED_APP_IDS`.

**And** `functions/shared/schemas/plan-schema.ts` exports `planKindSchema`, `planStatusSchema`, `LEGAL_TRANSITIONS` table, updated `planSchema` and `createPlanInputSchema`.

**And** unit tests in `__tests__/app-schema.test.ts` and `__tests__/plan-schema.test.ts` pass for: slug regex (positive + negative cases), reserved-list rejection, intent length bounds, kind enum, status enum, legal transitions table.

**And** `npm run typecheck` passes with no errors.

**Prerequisites:** none (foundation story).

**Touch Points:**

- `functions/shared/types/app.ts`
- `functions/shared/types/plan.ts`
- `functions/shared/schemas/app-schema.ts`
- `functions/shared/schemas/plan-schema.ts`
- `functions/shared/schemas/__tests__/app-schema.test.ts`
- `functions/shared/schemas/__tests__/plan-schema.test.ts`

**Forbidden Areas:** No changes to repositories or API routes in this story; those are 1.2/1.3 and Epic 2.

**Technical Notes:** All Zod usage must be `safeParse` (per CLAUDE.md). `slugRegex` is `/^[a-z0-9]+(-[a-z0-9]+)*$/`. `RESERVED_APP_IDS = new Set(['data', 'media', 'apps', 'knowledge-live', 'admin', 'api'])`. Use existing patterns from `functions/shared/schemas/plan-schema.ts` (already a modified file in git status) as exemplars.

### Story 1.2: Create `app-repository.ts`

As Richie,
I want a repository module at `functions/shared/repositories/app-repository.ts`,
So that the API layer has pure, testable functions for App CRUD without inlining DDB calls.

**Acceptance Criteria:**

**Given** the App schema from Story 1.1,
**When** the repository is implemented,
**Then** the module exports six functions: `getApp`, `listApps`, `createApp`, `updateApp`, `appendDeployJobId`, `deleteApp`.

**And** `createApp` validates input via `createAppInputSchema`, sets `workingDir = /home/ubuntu/projects/<appId>`, `workingTreeStatus = 'clean'`, `currentlyDeployedPlanId = null`, and rejects on duplicate `appId`.

**And** `appendDeployJobId` uses DDB `list_append` atomically (no read-modify-write race).

**And** `deleteApp` is hard-delete; documentation in the function comment makes clear callers must cascade-delete Plans separately.

**And** unit tests in `__tests__/app-repository.test.ts` cover: happy path for each function, duplicate-create rejection, missing-app reads, atomic append behavior.

**Prerequisites:** Story 1.1.

**Touch Points:**

- `functions/shared/repositories/app-repository.ts`
- `functions/shared/repositories/__tests__/app-repository.test.ts`

**Technical Notes:** Mirror the style of `functions/shared/repositories/plan-repository.ts` and `agent-jobs-repository.ts` — pure functions, no classes. DDB client comes from existing `functions/shared/dynamo-client.ts`. Table name from `process.env.APPS_TABLE_NAME` (set in Story 1.4).

### Story 1.3: Modify `plan-repository.ts` for new fields + App-aware queries

As Richie,
I want the existing `plan-repository.ts` updated to handle `appId`, `kind`, `intent`, and the new lifecycle states,
So that Plan CRUD and lifecycle transitions enforce the new invariants.

**Acceptance Criteria:**

**Given** the Plan schema from Story 1.1,
**When** the repository is modified,
**Then** `createPlan` accepts the new input shape (`{appId, kind, intent, executionMode?, displayName?}`), inherits `executionMode` and `rigor` from App's last delivered Plan (or App default / `mvp` if none), sets `status='concept'` and `epicIds=[]`.

**And** `listPlansByApp(appId)` queries the `appId-createdAt-index` GSI and returns Plans sorted by `createdAt` ascending.

**And** `getActivePlanForApp(appId)` calls `listPlansByApp` and returns the first Plan with `status ∈ {concept, developing, review}`, or `null`.

**And** `transitionPlanStatus(planId, toStatus)` validates against `LEGAL_TRANSITIONS` and throws `IllegalTransitionError` on invalid moves.

**And** `addEpicToPlan(planId, epicId)` uses atomic `list_append` on `epicIds`.

**And** removed methods that referenced `name`, `workingDir`, `deployJobIds`, or the `fixing`/`archived` statuses are gone or stubbed to throw.

**And** the existing `plan-repository.test.ts` is updated to cover the new behaviors and removes tests for removed behaviors.

**Prerequisites:** Story 1.1, Story 1.2 (uses `getApp` for inheritance).

**Touch Points:**

- `functions/shared/repositories/plan-repository.ts`
- `functions/shared/repositories/__tests__/plan-repository.test.ts`

**Forbidden Areas:** Do not modify `functions/api/index.ts` in this story — wiring happens in Epic 2.

**Technical Notes:** This file is already modified (per git status) — likely from prior work. Reconcile carefully with existing pending changes. The `IllegalTransitionError` class belongs in `functions/shared/errors.ts` if not already present.

### Story 1.4: SST infrastructure — Apps table + Plans GSI + env vars

As Richie,
I want `sst.config.ts` to provision the new Apps DynamoDB table and add the `appId-createdAt-index` GSI to the Plans table,
So that `sst deploy` brings the runtime in line with the new schema.

**Acceptance Criteria:**

**Given** the existing SST configuration,
**When** the config is updated,
**Then** a new `Apps` Dynamo resource is declared with `fields: { appId: "string" }`, `primaryIndex: { hashKey: "appId" }`, no GSIs, PAY_PER_REQUEST, no PITR.

**And** the existing Plans table gains `globalIndexes: { "appId-createdAt-index": { hashKey: "appId", rangeKey: "createdAt" } }`, requiring `appId` and `createdAt` in `fields`.

**And** the API Lambda's environment is extended with `APPS_TABLE_NAME` linking the new table.

**And** `npm run build` succeeds (SST build path).

**And** running `sst deploy --stage dev` (or equivalent local check) produces a clean diff showing the new resources without disrupting existing tables.

**Prerequisites:** none (independent infra story; can run in parallel with 1.1–1.3 but Epic 2 depends on this for the env var).

**Touch Points:**

- `sst.config.ts`

**Technical Notes:** Existing PITR settings on other tables remain unchanged — Apps table is regenerable from Plans + deploys, so PITR is omitted. Mirror the resource-naming convention used by `Plans` and `Projects`.

### Story 1.5: Pre-epic data wipe script

As Richie,
I want a one-shot script that wipes existing Plans, Projects, and EC2 working folders,
So that the new schema launches against a clean slate per the user's confirmed throwaway-prototype direction.

**Acceptance Criteria:**

**Given** the existing DynamoDB Plans/Projects rows and EC2 `/home/ubuntu/projects/*` folders,
**When** the script is run with explicit confirmation flags,
**Then** all rows in the Plans table are deleted via batched `BatchWriteItem` calls.

**And** all rows in the Projects table are deleted (legacy table — confirm with user before deleting if this conflicts with current usage).

**And** the script logs counts of items deleted per table.

**And** the script does NOT run automatically — it must be invoked manually with `--yes-really-wipe-everything` or equivalent.

**And** the EC2 folder cleanup is documented (manual SSH command) but NOT executed by the script (operator runs it via daemon SSM or hands-on).

**Prerequisites:** Story 1.4 (env vars must be in place to run the script).

**Touch Points:**

- `scripts/wipe-pre-epic.mjs` (new)

**Forbidden Areas:** Must not touch Apps table (it's empty). Must not delete S3 deploy bundles (they're regeneration sources for v1 rollback).

**Technical Notes:** This story exists for traceability and reproducibility — even though the action is one-shot, having it as a checked-in script makes it auditable. The script should print exactly what it will delete and require interactive confirmation.

---

## Epic 2: App Lifecycle API

**Slug:** `app-lifecycle-api`
**Goal:** Expose all seven new App-centric REST endpoints via the existing Hono app, with full validation, error taxonomy, atomic abandon transitions, and the server-side enrichment that powers the Apps grid efficiently.

### Story 2.1: Add `/api/apps` route group with auth + GET + POST

As Richie,
I want `GET /api/apps` and `POST /api/apps` working under a Hono `basePath('/apps')` group with auth middleware applied,
So that the Apps grid has data to render and operators can create new Apps.

**Acceptance Criteria:**

**Given** the App repository from Story 1.2 and existing `authRequired` middleware,
**When** the new routes are added to `functions/api/index.ts`,
**Then** `GET /api/apps` returns `{ apps: AppCardData[] }` — enriched with `planCount`, `currentlyLiveLabel`, and `derivedStatus` per App (computed via `listPlansByApp` per App).

**And** `POST /api/apps` validates input via `createAppInputSchema`, rejects reserved slugs with `400 app_id_reserved`, rejects duplicates with `409 app_id_taken`, and returns `201 { app }` on success.

**And** integration tests verify: 401 without auth header, 200 with empty list, 200 with populated list, 201 happy path, 400 invalid slug, 400 reserved slug, 409 duplicate.

**And** `npm run lint` and `npm run typecheck` pass.

**Prerequisites:** Story 1.2, Story 1.4.

**Touch Points:**

- `functions/api/index.ts`
- `functions/api/__tests__/apps-api.test.ts` (new)
- `functions/shared/types/app-card-data.ts` (new — small file)

**Forbidden Areas:** Do not implement other `/apps/*` endpoints in this story (split per following stories). Do not add Hono CORS middleware (per CLAUDE.md — CORS is at Function URL level).

**Technical Notes:** The enrichment loop on `GET /apps` should batch-read Plans per App; for v1 with small N, a sequential loop is acceptable. Optimize only if measurable.

### Story 2.2: Add `GET /api/apps/:appId` with detail response shape

As Richie,
I want `GET /api/apps/:appId` returning `{ app, plans, activePlan, recentDeploys }` in one round-trip,
So that the App detail page renders without N+1 fetches.

**Acceptance Criteria:**

**Given** an existing App with Plans and deploys,
**When** the operator hits `GET /api/apps/:appId`,
**Then** the response includes `app` (full App record), `plans` (sorted ascending by `createdAt`), `activePlan` (first non-terminal Plan or null), and `recentDeploys` (last 5 from `App.deployJobIds`).

**And** missing App returns `404 app_not_found`.

**And** unauthorized returns `401`.

**And** integration tests cover: empty Plans list, multiple Plans with one active, multiple Plans all delivered (activePlan null), 404 for missing App.

**Prerequisites:** Story 2.1.

**Touch Points:**

- `functions/api/index.ts`
- `functions/api/__tests__/apps-api.test.ts`

**Technical Notes:** Recent deploys lookup uses the existing `agent-jobs-repository` to fetch the last 5 deploy jobs by ID. If a deployJobId is not found in jobs table (legacy data), skip silently.

### Story 2.3: Add `PATCH /api/apps/:appId` and `DELETE /api/apps/:appId` with cascade

As Richie,
I want to update App fields and delete an App with all its Plans/Epics cascading,
So that the settings dialog and danger-zone delete dialog have working backends.

**Acceptance Criteria:**

**Given** an existing App,
**When** `PATCH /api/apps/:appId` is called with a partial body,
**Then** only `displayName`, `icon`, `executionMode`, and `workingTreeStatus` are accepted; other fields return `400`.

**And** `DELETE /api/apps/:appId` lists all Plans for the App, cascade-deletes each Plan's Epics + the Plan itself, then deletes the App, returning `204`.

**And** integration tests cover: partial PATCH (single field), invalid PATCH field rejection, DELETE with no Plans, DELETE with multiple Plans + Epics (verify cascade).

**Prerequisites:** Story 2.2.

**Touch Points:**

- `functions/api/index.ts`
- `functions/api/__tests__/apps-api.test.ts`

**Forbidden Areas:** Do not implement soft-delete in v1 — hard-delete only.

**Technical Notes:** Cascade is sequential, not transactional (DDB transactWrite caps at 100 items; an App with 50 Plans and 200 Epics would exceed it). Document the non-atomicity in a code comment — partial failures need operator follow-up via the wipe script (Story 1.5).

### Story 2.4: Add `POST /api/apps/:appId/plans` with concurrency + initial-uniqueness + PM-augmentation enqueue

As Richie,
I want creating a Plan via the App-nested endpoint to enforce one-active-Plan-per-App, validate `kind=initial` only as the first Plan, and kick off the PM-augmentation job,
So that the new Plan modal can submit safely and PM-augmentation runs without operator intervention.

**Acceptance Criteria:**

**Given** an existing App with no active Plans,
**When** `POST /api/apps/:appId/plans` is called with valid input,
**Then** `getActivePlanForApp(appId)` is called first; if it returns non-null, respond `409 plan_already_active` with `details: { activePlanId, activePlanStatus }`.

**And** if `kind === 'initial'` and any Plans exist for this App, respond `409 initial_plan_already_exists`.

**And** if `kind !== 'initial'` and no Plans exist, respond `409 first_plan_must_be_initial`.

**And** on success, the Plan is created via `createPlan` with `status='concept'`, a PM-augmentation job is enqueued in `futurator-agent-jobs` (only for `kind ≠ initial`), and the response is `201 { plan }`.

**And** for `kind=initial`, the existing greenfield PM job kind is enqueued instead (no new behavior — defer to existing pipeline).

**And** integration tests cover: each rejection path, happy path for `kind=initial` (no existing Plans), happy path for `kind=change` (with existing delivered Plan), verify a `pm-augmentation` job row appears in the jobs table.

**Prerequisites:** Story 2.2, Story 1.3.

**Touch Points:**

- `functions/api/index.ts`
- `functions/api/__tests__/apps-api.test.ts`

**Technical Notes:** PM-augmentation job enqueue uses the existing `agent-jobs-repository`. Job kind is `'pm-augmentation'`. The handler is wired in Epic 4 — for now the job will sit PENDING (acceptable; the daemon poller is not yet aware of this kind).

### Story 2.5: Add `POST /api/apps/:appId/redeploy` for v1 rollback

As Richie,
I want a re-deploy endpoint that flips the bundle pointer to a prior deploy without rebuilding code,
So that operators can roll back live Apps without git branches.

**Acceptance Criteria:**

**Given** an App with `App.deployJobIds = ['d1', 'd2', 'd3']` and `currentlyDeployedPlanId` pointing at the Plan that produced `d3`,
**When** `POST /api/apps/:appId/redeploy` is called with `{ deployJobId: 'd1' }`,
**Then** the deployJobId is validated against `App.deployJobIds[]`; if not present, respond `400 deploy_job_not_in_app_history`.

**And** on success, a re-deploy job is enqueued in the agent-jobs table that, when run, S3-syncs the prior deploy's bundle from `apps/<appId>/deploys/<jobId>/` to `apps/<appId>/`.

**And** on re-deploy job completion, `App.currentlyDeployedPlanId` updates to the Plan that originally produced `d1`.

**And** integration tests cover: invalid deployJobId rejection, happy-path enqueue, daemon-side re-deploy execution (mocked S3).

**Prerequisites:** Story 2.2.

**Touch Points:**

- `functions/api/index.ts`
- `functions/api/__tests__/apps-api.test.ts`
- `daemon/pipelines/redeploy-pipeline.mjs` (new — minimal handler that calls existing S3 sync helper)
- `daemon/pipelines/job-router.mjs` (modify — add `redeploy` job kind)

**Forbidden Areas:** Do not modify any existing deploy-pipeline file in this story; the new handler is a thin S3-sync wrapper that does not invoke a build.

**Technical Notes:** Requires that deploy bundles be retained at versioned S3 paths — confirm with infra that this is true. If not, this story expands to also amend the deploy-pipeline to write versioned copies, which is a larger lift.

### Story 2.6: Update `transitionPlanStatus` API + atomic abandon

As Richie,
I want the existing Plan-transition endpoints to use the new `LEGAL_TRANSITIONS` table and the `abandoned` transition to atomically update Plan + App + pending jobs,
So that abandonment is a clean one-shot operation with no partial-state windows.

**Acceptance Criteria:**

**Given** an active Plan in `developing` status with PENDING jobs,
**When** the operator calls the abandon transition (`POST /api/plans/:planId/transitions/abandon` or equivalent),
**Then** a single DDB `transactWrite` updates Plan to `abandoned`, App to `workingTreeStatus='dirty-from-abandoned-plan'`, and all that Plan's PENDING jobs to `status='ORPHANED', orphanReason='plan_abandoned'`.

**And** illegal transitions (e.g., `delivered → developing`) return `409 illegal_plan_transition`.

**And** integration tests cover: happy abandon path verifying all three writes, illegal-transition rejection, transition table coverage (every legal pair tested).

**And** the API surfaces partial-failure 500 with retry guidance if the transactWrite fails.

**Prerequisites:** Story 1.3, Story 2.2.

**Touch Points:**

- `functions/api/index.ts`
- `functions/shared/services/plan-reducer.ts` (modify — already a modified file in git status)
- `functions/shared/repositories/agent-jobs-repository.ts` (modify — add `markJobOrphaned` if not present)
- `functions/api/__tests__/plan-transitions.test.ts`

**Forbidden Areas:** No changes to wave-reducer or pipeline-launcher; the orchestration code is unaffected by this story.

**Technical Notes:** transactWrite item cap is 100. For Plans with >98 PENDING jobs, the abandon must split into multiple transactWrites or fall back to non-atomic — document the limit in code, alert in monitoring if hit.

---

## Epic 3: Pipeline Integrity Guards

**Slug:** `pipeline-integrity-guards`
**Goal:** Make the daemon App-aware so it refuses to dispatch jobs when the Plan is terminal, the App's tree is dirty, or the active-Plan invariant is violated. Add the `ORPHANED` job status and observability for the abandon flow.

### Story 3.1: Add `ORPHANED` job status + UI render rules

As a daemon operator,
I want `ORPHANED` to be a first-class job status alongside `FAILED`, `COMPLETED`, etc.,
So that abandoned-Plan jobs are visually and semantically distinct from failed jobs.

**Acceptance Criteria:**

**Given** the existing job-status enum,
**When** `ORPHANED` is added,
**Then** `functions/shared/types/agent-job.ts` includes `'ORPHANED'` in the `JobStatus` union with `orphanReason` optional field.

**And** any existing job-status filtering in `functions/api/index.ts` and `daemon/agent-daemon.mjs` accommodates the new status without breaking.

**And** the admin UI's job list (wherever jobs are displayed) renders `ORPHANED` as a collapsed-footer "N jobs cancelled" rather than as an attention item.

**And** unit tests cover the type addition; integration tests verify the API doesn't choke when listing ORPHANED jobs.

**Prerequisites:** none (can run in parallel with Epic 2; Story 2.6 will need this for the abandon transactWrite).

**Touch Points:**

- `functions/shared/types/agent-job.ts`
- `functions/shared/repositories/agent-jobs-repository.ts`
- `src/components/development/` (whatever component displays the job list — locate via grep)

**Technical Notes:** Locate the existing job-list rendering by grepping for the job-status badge component. Likely lives near `src/app/development/monitor/page.tsx` (already a modified file).

### Story 3.2: Implement `canDispatchJob` pre-dispatch guard in daemon

As a daemon operator,
I want `daemon/agent-daemon.mjs` to run three pre-dispatch checks (Plan terminal / App dirty-tree / concurrency) before spawning any subprocess,
So that orphaned and conflicting jobs are caught before they corrupt working trees or burn agent budget.

**Acceptance Criteria:**

**Given** the existing dispatch loop,
**When** the guard is inserted,
**Then** `canDispatchJob(job)` is called before every spawn, returning `{ ok, reason, hold? }`.

**And** if the Plan is in `delivered` or `abandoned`, the job is marked `ORPHANED` with the appropriate reason, and `canDispatchJob` returns `{ ok: false, reason: 'plan_<status>' }`.

**And** if the App's `workingTreeStatus === 'dirty-from-abandoned-plan'`, the job is held (NOT marked ORPHANED — it might dispatch later when resolved); `holdReason='app_dirty'` is set on the job row for UI visibility; the function returns `{ ok: false, reason: 'app_working_tree_dirty', hold: true }`.

**And** if `getActivePlanForApp(plan.appId).planId !== plan.planId`, the daemon logs an integrity violation, marks the job `FAILED` with reason `concurrency_violation`, and returns `{ ok: false, reason: 'concurrency_violation' }`.

**And** unit tests in `daemon/pipelines/__tests__/dispatch-guard.test.mjs` cover all three pre-dispatch checks plus the happy path.

**Prerequisites:** Story 1.2, Story 1.3, Story 3.1.

**Touch Points:**

- `daemon/agent-daemon.mjs` (already a modified file in git status — reconcile carefully)
- `daemon/pipelines/__tests__/dispatch-guard.test.mjs`
- `functions/shared/repositories/agent-jobs-repository.ts` (add `markJobOrphaned`, `setJobHoldReason` if not present)

**Forbidden Areas:** Do not refactor the surrounding dispatch loop logic — the guard is an inserted gate, not a rewrite.

**Technical Notes:** The hold path means the job stays PENDING and is re-evaluated next poll cycle. Held jobs accumulate `holdReason` in their row for UI surfacing. Clear `holdReason` on successful dispatch.

### Story 3.3: Implement atomic abandon transition logic

As Richie,
I want abandoning a Plan to perform a single `transactWrite` that updates Plan + App + all PENDING jobs,
So that abandonment can never produce a partial-state inconsistency.

**Acceptance Criteria:**

**Given** an active Plan with PENDING jobs and an App in `clean` state,
**When** `transitionPlanStatus(planId, 'abandoned')` runs,
**Then** a single DDB `transactWrite` performs:
- `Plan.status = 'abandoned'`
- `App.workingTreeStatus = 'dirty-from-abandoned-plan'`
- All PENDING jobs for the Plan: `status = 'ORPHANED'`, `orphanReason = 'plan_abandoned'`

**And** the transactWrite item count is calculated and the operation fails fast (with a clear error code) if >100 items are required.

**And** RUNNING jobs are NOT killed — they are allowed to finish; their output is discarded by the existing pipeline because the Plan is now terminal.

**And** unit tests verify all three writes occur, partial-failure surfaces, and the >100-item case rejects.

**Prerequisites:** Story 2.6, Story 3.1.

**Touch Points:**

- `functions/shared/services/plan-reducer.ts` (modify)
- `functions/shared/services/__tests__/plan-reducer.test.ts`

**Technical Notes:** Use the existing DDB client wrapper in `functions/shared/dynamo-client.ts`. Document the 100-item cap in a comment with a recommended escalation path (split into multiple transactWrites — this is v1.x work).

### Story 3.4: Add `OrphanedJobsPerHour` CloudWatch metric

As a daemon operator,
I want a per-App CloudWatch metric counting orphaned jobs per hour,
So that abnormal abandonment rates trigger alerts.

**Acceptance Criteria:**

**Given** the daemon is running,
**When** any job transitions to `ORPHANED`,
**Then** a CloudWatch metric `OrphanedJobsPerHour` is emitted with dimension `appId`.

**And** the metric is visible in CloudWatch within 5 minutes of emission.

**And** documentation in the tech spec / runbook describes the metric and a recommended alarm threshold (suggested: ≥3/hour for any single App).

**Prerequisites:** Story 3.3.

**Touch Points:**

- `daemon/agent-daemon.mjs`
- `daemon/pipelines/lib/cloudwatch-metrics.mjs` (new or extend if exists)
- `docs/concepts/orphaned-jobs-runbook.md` (new — short doc)

**Forbidden Areas:** No CloudWatch alarm creation in this story (alarms are infra-as-code, deferred).

**Technical Notes:** Use `@aws-sdk/client-cloudwatch` `PutMetricData`. Existing metric emission patterns (if any) should be matched — grep for `PutMetricData` first.

---

## Epic 4: PM Brownfield Planning

**Slug:** `pm-brownfield-planning`
**Goal:** Implement the new PM-augmentation prompt mode that classifies non-initial Plans, proposes minimal epic/story breakdowns, and produces the no-touch list. This is the load-bearing intelligence of the v1 design.

### Story 4.1: Create PM-augmentation prompt template

As Richie,
I want a prompt template at `daemon/pipelines/templates/pm-augmentation-prompt.md.tpl`,
So that the PM agent has a stable instruction set for brownfield planning.

**Acceptance Criteria:**

**Given** the prompt design in §"PM-Augmentation Prompt" of the tech spec,
**When** the template is created,
**Then** it includes: role declaration (PM in augmentation mode), tool grant constraint (Read/Grep/Glob/Bash only), input placeholders for `intent`, `app`, `priorPlans`, output contract (the YAML block format), AC quality rules, story sizing rule, voice-matching rule, and `clarification_needed` escape hatch.

**And** the template uses placeholder syntax compatible with the existing template engine (locate by inspecting `daemon/pipelines/templates/dev-subagent-prompt.md.tpl` or `epic-orchestrator-prompt.md.tpl` — already modified).

**And** a fixture-based test renders the template with mock inputs and verifies all sections are present.

**Prerequisites:** none (template design is independent of code wiring).

**Touch Points:**

- `daemon/pipelines/templates/pm-augmentation-prompt.md.tpl`
- `daemon/pipelines/__tests__/pm-augmentation-prompt.test.mjs` (rendering test)

**Technical Notes:** The template must explicitly state "you are read-only" in the prompt body even though the daemon enforces tool restrictions — belt and suspenders. Output format is YAML inside `---PM_AUGMENTATION_RESULT---` / `---END_PM_AUGMENTATION_RESULT---` tags (mirrors `<DEV_RESULT>` and `<REVIEW_CRITERIA>` conventions).

### Story 4.2: Implement `pm-augmentation-parser.mjs` with three failure modes

As Richie,
I want a parser at `daemon/pipelines/lib/pm-augmentation-parser.mjs` that validates the agent's tagged-YAML output,
So that malformed responses fail loud, not silent.

**Acceptance Criteria:**

**Given** sample agent outputs (valid and malformed),
**When** `parsePmAugmentationResult(rawOutput)` is called,
**Then** valid output returns the parsed object matching a Zod schema (`pmAugmentationResultSchema`).

**And** missing wrapper tags throws `ParseError('pm_augmentation_result_block_missing')`.

**And** invalid YAML inside the tags throws `ParseError('pm_augmentation_yaml_invalid')` with the YAML library's error attached as `cause`.

**And** YAML that parses but fails Zod validation throws `ParseError('pm_augmentation_schema_invalid')` with `details.issues` populated from `safeParse` errors.

**And** unit tests at `__tests__/pm-augmentation-parser.test.mjs` cover: happy path, missing tags, malformed YAML (unclosed quote), schema-invalid (missing required field, wrong type for `kind_confidence`).

**Prerequisites:** Story 4.1.

**Touch Points:**

- `daemon/pipelines/lib/pm-augmentation-parser.mjs`
- `daemon/pipelines/__tests__/pm-augmentation-parser.test.mjs`
- `functions/shared/schemas/pm-augmentation-schema.ts` (new — `pmAugmentationResultSchema` Zod)

**Technical Notes:** Use the `yaml` package (likely already a dep — check `package.json`). If not present, prefer `js-yaml`. Mirror the parser style of `daemon/pipelines/lib/review-criteria-parser.mjs` (Epic C).

### Story 4.3: Implement `render-pm-augmentation-prompt.mjs`

As Richie,
I want a rendering helper that assembles the full prompt from a Plan, its App, and prior Plans,
So that the daemon can render before each invocation without hand-stitching strings.

**Acceptance Criteria:**

**Given** a Plan, App, and an array of prior Plans,
**When** `renderPmAugmentationPrompt({ plan, app, priorPlans })` is called,
**Then** the function returns a single string suitable for direct submission to a Claude subprocess.

**And** prior Plans are rendered in chronological order with each Plan's full epic/story breakdown including AC.

**And** the App's `workingDir` is included so the agent knows where to read.

**And** if `priorPlans` is empty (impossible for `kind ≠ initial` but defensive), the function throws.

**And** unit tests cover: happy path with 1 prior Plan, happy path with 3 prior Plans (ordering), empty prior-Plans rejection, very-long prior Plan (truncation if needed — see notes).

**Prerequisites:** Story 4.1.

**Touch Points:**

- `daemon/pipelines/lib/render-pm-augmentation-prompt.mjs`
- `daemon/pipelines/__tests__/render-pm-augmentation-prompt.test.mjs`

**Technical Notes:** Long prior-Plan histories may exceed Claude's context window. v1 strategy: render full history; if it ever overflows, address as a v1.x story (truncation, summarization, or selective load). Add a warning log if the rendered prompt exceeds 50KB.

### Story 4.4: Wire `pm-augmentation` job kind into job-router with apply step

As Richie,
I want the daemon's `job-router.mjs` to recognize the `pm-augmentation` job kind, run the prompt, parse the output, and atomically apply the result to the Plan + Epic tables,
So that creating a Plan triggers automatic planning end-to-end.

**Acceptance Criteria:**

**Given** a `pm-augmentation` job in PENDING status,
**When** the daemon picks it up,
**Then** it loads the Plan, App, and prior Plans; renders the prompt; spawns a Claude subprocess with tools `Read, Grep, Glob, Bash`; captures the output.

**And** the parser is invoked. On success: a single DDB `transactWrite` updates the Plan with `kind`, `iterationLabel`, `noTouchPaths`, and creates one Epic record per `epics[]` entry (linked via `planId`).

**And** the Plan **stays in `concept`** after augmentation — operator must approve via the actions bar (Epic 7).

**And** on `clarification_needed`, the Plan stays in `concept` and an attention item is created with the agent's question.

**And** on parser failure, retry up to 2 times with the parser error echoed in a reminder; after 2 retries, salvage via the existing escalation pattern (`pipelinev1-self-corrections-escalation.md`).

**And** integration tests cover: happy path applying the result, clarification_needed path, retry path, salvage path.

**Prerequisites:** Stories 4.1, 4.2, 4.3.

**Touch Points:**

- `daemon/pipelines/job-router.mjs`
- `daemon/pipelines/pm-augmentation-pipeline.mjs` (new — handler module)
- `daemon/pipelines/__tests__/pm-augmentation-pipeline.test.mjs`

**Forbidden Areas:** Do not modify the existing greenfield PM pipeline — augmentation is a parallel path for `kind ≠ initial`.

**Technical Notes:** The transactWrite for apply may exceed 100 items if a Plan has very many proposed Epics — though that's unlikely (the prompt encourages minimal breakdowns). Document the cap; v1.x work if needed.

---

## Epic 5: Apps Workspace Home

**Slug:** `apps-workspace-home`
**Goal:** Replace `/labs` (currently the Plans list) with the new Apps grid, including the empty state, the App card component, and the New App modal. This is the operator's new home.

### Story 5.1: Create `links.ts`, `apps-api.ts` client, and `useApps` hook

As Richie,
I want centralized URL builders and API client wrappers + a TanStack Query hook for Apps,
So that subsequent UI stories can consume cleanly without re-implementing URLs or fetchers.

**Acceptance Criteria:**

**Given** the new API endpoints from Epic 2,
**When** the client modules are written,
**Then** `src/lib/links.ts` exports `links.apps()`, `links.app(id)`, `links.plan(appId, planId)`.

**And** `src/lib/api/apps-api.ts` exports `listApps`, `createApp`, `getApp`, `updateApp`, `deleteApp`, `redeployApp` — each a thin `apiClient`-based wrapper.

**And** `src/hooks/use-apps.ts` exports `useApps()` returning a TanStack Query result with 5-min staleTime per project convention.

**And** TypeScript types from `src/types/app.ts` are mirrored from backend types via type-only import.

**And** `npm run typecheck` and `npm run lint` pass.

**Prerequisites:** Epic 2 complete (Stories 2.1, 2.2 minimum).

**Touch Points:**

- `src/lib/links.ts`
- `src/lib/api/apps-api.ts`
- `src/hooks/use-apps.ts`
- `src/types/app.ts`

**Forbidden Areas:** No React components in this story — pure plumbing.

**Technical Notes:** Mirror existing patterns from `src/hooks/use-projects.ts` and `src/lib/api/projects-api.ts` (whatever the existing names are — locate first).

### Story 5.2: Rewrite `/labs` page as Apps grid with empty state

As Richie,
I want the `/labs` route to show an Apps grid (or an empty state if no Apps exist),
So that operators land on the new home and can navigate to App detail.

**Acceptance Criteria:**

**Given** `useApps` returns the App list,
**When** `/labs` renders,
**Then** with zero Apps the empty state shows ("No Apps yet" + CTA to create).

**And** with N Apps, a responsive grid renders (1 col mobile, 3 cols tablet, 4 cols desktop).

**And** loading state shows a skeleton.

**And** error state shows an `ApiErrorBanner` with retry.

**And** the `+ New App` button opens the modal (modal stub is fine for this story; full modal in 5.4).

**And** the existing query-param routing for `?planId=` is **removed** — no inline Plan-detail rendering on this page.

**And** Playwright smoke test verifies the route loads, the grid renders, and clicking a card navigates to `/labs/[appId]`.

**Prerequisites:** Story 5.1.

**Touch Points:**

- `src/app/labs/page.tsx` (REWRITE)
- `src/components/labs/apps-grid.tsx` (new)
- `src/components/labs/apps-grid-skeleton.tsx` (new)
- `src/components/labs/empty-apps-state.tsx` (new)
- `tests/e2e/apps-grid.spec.ts` (new)

**Forbidden Areas:** Do not implement the App detail page in this story (Epic 6). Do not implement the New App modal here (5.4).

**Technical Notes:** Existing `/labs/page.tsx` is heavily customized — read carefully before rewriting. Preserve any orchestrator-related links or auth integration.

### Story 5.3: Create `AppCard` component with status pill

As Richie,
I want each App in the grid rendered as a card showing icon, name, slug, status, and Plan count,
So that triage at-a-glance works.

**Acceptance Criteria:**

**Given** an `AppCardData` record,
**When** `<AppCard app={...} />` renders,
**Then** the card shows icon (default 📦), `displayName`, `appId` (smaller text), `derivedStatus` pill, and `currentlyLiveLabel` or "no deploy yet".

**And** the status pill renders four states: `live` (green dot), `building` (pulsing accent), `dirty-tree` (amber ⚠), `no-deploy` (gray) — distinct colors using semantic theme tokens.

**And** clicking the card calls `router.push(links.app(app.appId))`.

**And** hover applies `translateY(-2px)` + shadow elevation, 150ms ease-out.

**And** unit tests verify each status renders correctly; snapshot test guards against accidental visual regression.

**Prerequisites:** Story 5.2.

**Touch Points:**

- `src/components/labs/app-card.tsx` (new)
- `src/components/labs/app-status-pill.tsx` (new)
- `src/components/labs/__tests__/app-card.test.tsx` (new)

**Technical Notes:** Use `lucide-react` for any glyphs needed. `prefers-reduced-motion` should collapse pulse to solid (test-coverable via JSDOM media query mock).

### Story 5.4: Implement `NewAppModal` with slug validation

As Richie,
I want a modal with four fields (slug, displayName, icon, executionMode) that creates an App and navigates to its detail page,
So that creating a new App is one decisive action.

**Acceptance Criteria:**

**Given** the modal is open,
**When** the operator types in the slug field,
**Then** live validation runs (debounced 300ms): regex check, length check, reserved-list check, existing-Apps check via cached `useApps` data.

**And** invalid states show inline messages (not submit-time errors).

**And** the displayName field is required, max 80 chars.

**And** the icon field is an emoji picker (use any lightweight library — or a simple text input that accepts a single character).

**And** executionMode is a radio group with default `'orchestrator'`.

**And** Submit calls `useCreateApp` mutation; on success, closes modal, invalidates `['apps']`, and navigates to `links.app(newApp.appId)`.

**And** Submit is disabled while validation fails or while the mutation is pending.

**And** unit tests cover: valid submit, invalid-slug rejection, reserved-slug rejection, mutation-pending state, mutation-error state.

**Prerequisites:** Story 5.1, Story 5.3.

**Touch Points:**

- `src/components/labs/new-app-modal.tsx` (new)
- `src/hooks/use-create-app.ts` (new)
- `src/components/labs/__tests__/new-app-modal.test.tsx` (new)

**Forbidden Areas:** Do not auto-create an initial Plan from this modal — App creation is decoupled from first-Plan creation per spec (two-step on purpose).

**Technical Notes:** Use shadcn `Dialog` primitive. Slug-availability check is client-side first (cached `useApps`), then server-side enforcement on submit; the API will reject duplicates regardless.

---

## Epic 6: App Workshop View

**Slug:** `app-workshop-view`
**Goal:** Build the App detail page at `/labs/[appId]` with all five regions: header, banner row, Plan timeline, deploys panel, and the settings/delete dialogs. This is where operators spend the most time.

### Story 6.1: Create `/labs/[appId]` route shell + `useApp` hook

As Richie,
I want the App detail route loading App + Plans + activePlan + recentDeploys in one query, with conditional polling while a Plan is `developing`,
So that the page renders fast and stays fresh during builds.

**Acceptance Criteria:**

**Given** the `GET /api/apps/:appId` endpoint,
**When** `useApp(appId)` is invoked,
**Then** the hook returns `{ app, plans, activePlan, recentDeploys }`.

**And** if `activePlan?.status === 'developing'`, the hook polls every 5s; otherwise relies on 5-min staleTime.

**And** the page renders a skeleton while loading, an `ApiErrorBanner` on error, and a `NotFoundState` when `app === null`.

**And** the page composes child components from later stories as placeholders for now (header, banner, timeline, deploys all stubbed).

**Prerequisites:** Stories 5.1, 2.2.

**Touch Points:**

- `src/app/labs/[appId]/page.tsx` (new)
- `src/hooks/use-app.ts` (new)

**Technical Notes:** TanStack Query's `refetchInterval` accepts a function — use the conditional form to inspect data and decide cadence.

### Story 6.2: Create `AppDetailHeader`

As Richie,
I want the App detail header showing icon + displayName + slug + live URL + preview button + settings/delete entry points,
So that operators have the orientation info and admin actions in one row.

**Acceptance Criteria:**

**Given** an App,
**When** the header renders,
**Then** the icon (large, 48px), `displayName` (heading), `appId` (monospace small), live URL (with external `↗` glyph), and `Preview` button are visible.

**And** a gear icon opens `<AppSettingsDialog />` (stub from this story; full impl in 6.7).

**And** an overflow `⋯` menu has a `Delete App` entry that opens `<DeleteAppDialog />` (stub for now).

**And** unit tests verify the header renders all elements.

**Prerequisites:** Story 6.1.

**Touch Points:**

- `src/components/labs/app-detail-header.tsx` (new)
- `src/components/labs/__tests__/app-detail-header.test.tsx` (new)

**Technical Notes:** Live URL is `https://futurator.ai/apps/<appId>/`. Preview button can simply `window.open(url, '_blank')` in v1; iframe-embed is a v1.x nicety.

### Story 6.3: Create `PlanTimeline` + `PlanTimelineNode` (responsive)

As Richie,
I want a horizontal-on-desktop, vertical-on-mobile timeline of Plans with status-driven nodes,
So that the App's iteration history is scannable at a glance.

**Acceptance Criteria:**

**Given** the App's Plans array,
**When** the timeline renders,
**Then** on `md:` and up, Plans render as horizontal nodes connected by lines; on smaller screens, they render as a vertical list with connecting line.

**And** each node shows status glyph (filled / pulsing / X / ring), `Plan #N`, kind chip, `iterationLabel`, status, and date or wave progress.

**And** `delivered` nodes are filled green dots; active (`concept`/`developing`/`review`) are pulsing accent dots; `abandoned` are X-marked gray; the trailing `+ New Plan` slot is an empty ring.

**And** clicking a node navigates to `links.plan(appId, planId)`.

**And** the trailing `+ New Plan` slot opens the New Plan modal (Story 6.4) when enabled.

**And** Playwright smoke test verifies the timeline renders and a Plan node click navigates correctly.

**Prerequisites:** Story 6.1.

**Touch Points:**

- `src/components/labs/plan-timeline.tsx` (new)
- `src/components/labs/plan-timeline-node.tsx` (new)
- `src/components/labs/__tests__/plan-timeline.test.tsx` (new)

**Technical Notes:** Plan numbering (`#N`) is by `createdAt` order — index in the sorted Plans array + 1. Don't store an explicit number in DB.

### Story 6.4: Create `NewPlanCta` + `NewPlanModal` with conditional disabled state

As Richie,
I want the `+ New Plan` button conditional on (no active Plan AND tree is clean), and a modal with one textarea for intent,
So that creating an iteration is one decisive action with clear gating.

**Acceptance Criteria:**

**Given** the App's state (activePlan, workingTreeStatus),
**When** the CTA renders,
**Then** if no active Plan and tree is clean, the button is enabled and labeled "+ New Plan" (or "Start your first Plan" for empty timeline).

**And** if blocked, the button is disabled and a tooltip explains why ("Plan #N is currently active" or "Working tree needs cleanup").

**And** clicking opens `NewPlanModal` with one textarea (10–2000 chars), a character counter, a Submit button (disabled until valid), and a Cancel button.

**And** Submit calls `useCreatePlan(appId)` with `{ intent, kind: hasExistingPlans ? 'change' : 'initial' }`; on success, navigates to `links.plan(appId, newPlanId)`.

**And** unit tests cover: enabled/disabled paths with each tooltip variant, modal validation, mutation-pending state.

**Prerequisites:** Story 6.3.

**Touch Points:**

- `src/components/labs/new-plan-cta.tsx` (new)
- `src/components/labs/new-plan-modal.tsx` (new)
- `src/hooks/use-create-plan.ts` (new)
- `src/components/labs/__tests__/new-plan-cta.test.tsx` (new)

**Technical Notes:** Submit feedback should show "Planning…" (per the discussion's UX spec) — references the PM-augmentation kickoff. Server enforces the kind invariant; client inference is just an ergonomic default.

### Story 6.5: Create `ConcurrencyBanner` and `DirtyTreeBanner`

As Richie,
I want banners that appear above the timeline based on App state, with the dirty-tree banner using growth-framing copy,
So that abnormal states are visible and operators feel guided, not lectured.

**Acceptance Criteria:**

**Given** the App's `workingTreeStatus` and `activePlan`,
**When** the banner row renders,
**Then** if `workingTreeStatus === 'dirty-from-abandoned-plan'`, the dirty-tree banner shows: amber, copy "*Plan #N didn't ship. Some files may still be in mid-edit state. [Mark resolved] when you're ready to start the next iteration.*", with `Mark resolved` button calling `useUpdateApp({ workingTreeStatus: 'clean' })` and `View affected files` opening a side drawer.

**And** if tree is clean and an active Plan exists, the concurrency banner shows: info-blue, copy "*Plan #N is in progress. [Go to plan]*" with a link to that Plan's detail page.

**And** if both conditions are false, no banner renders.

**And** dirty-tree banner takes priority — never both visible at once.

**And** unit tests cover all three states and the priority rule.

**Prerequisites:** Story 6.1.

**Touch Points:**

- `src/components/labs/concurrency-banner.tsx` (new)
- `src/components/labs/dirty-tree-banner.tsx` (new)
- `src/components/labs/__tests__/banners.test.tsx` (new)
- `src/hooks/use-update-app.ts` (new)

**Technical Notes:** "View affected files" is a v1 best-effort: if a `.git` directory exists in the App's workingDir, run `git status --porcelain` via daemon to get the list; else show "Check the working dir manually". This requires a tiny new daemon endpoint or repurpose existing — defer if non-trivial.

### Story 6.6: Create `DeploysPanel` with re-deploy action

As Richie,
I want a panel listing the last 5 deploys with re-deploy buttons,
So that v1 rollback is a one-click affordance.

**Acceptance Criteria:**

**Given** `recentDeploys` from the App detail response,
**When** the panel renders,
**Then** each deploy shows timestamp + originating Plan label + currently-live badge if it matches `currentlyDeployedPlanId`.

**And** each row has a `Re-deploy` button that opens a confirm dialog ("Re-deploy v1.0 over current v1.2? This rolls the live App back to the older bundle.").

**And** confirming calls `useRedeployApp({ deployJobId })` and shows a toast on success ("Re-deploying… check back in ~60s").

**And** unit tests cover: empty deploys (renders nothing or an empty state), multiple deploys with one currently live, re-deploy mutation flow.

**Prerequisites:** Story 6.1.

**Touch Points:**

- `src/components/labs/deploys-panel.tsx` (new)
- `src/hooks/use-redeploy-app.ts` (new)
- `src/components/labs/__tests__/deploys-panel.test.tsx` (new)

**Technical Notes:** v1 re-deploy doesn't update the UI immediately — operator must refresh or wait for polling. v1.x adds optimistic update.

### Story 6.7: Create `AppSettingsDialog` and `DeleteAppDialog`

As Richie,
I want full-functionality settings and delete dialogs replacing the stubs,
So that operators can edit and delete Apps from this page.

**Acceptance Criteria:**

**Given** the gear and `⋯` triggers from Story 6.2,
**When** the settings dialog opens,
**Then** the operator can edit `displayName`, `icon`, and `executionMode`; save calls `useUpdateApp`; cache invalidates correctly.

**And** the delete dialog requires the operator to type the slug to confirm; on success, calls `useDeleteApp` and navigates to `/labs`.

**And** unit tests cover happy paths + cancel paths for both.

**Prerequisites:** Story 6.2.

**Touch Points:**

- `src/components/labs/app-settings-dialog.tsx` (new)
- `src/components/labs/delete-app-dialog.tsx` (new)
- `src/hooks/use-delete-app.ts` (new)
- `src/components/labs/__tests__/app-dialogs.test.tsx` (new)

**Forbidden Areas:** Do not implement an "archive" action — v1 hard-delete only.

**Technical Notes:** The typed-slug-to-confirm pattern is a known good safeguard for destructive actions; reuse it from any existing delete dialog in the codebase if one exists.

---

## Epic 7: Plan Detail Re-shell + URL Migration

**Slug:** `plan-detail-reshell`
**Goal:** Mount the existing pipeline UI under the new nested route `/labs/[appId]/plans/[planId]`, add the breadcrumb + status-driven actions bar, sweep all old `/labs?planId=X` references via the centralized link builder, and add the navigation smoke test.

### Story 7.1: Create `/labs/[appId]/plans/[planId]` route with `PlanDetailShell`

As Richie,
I want the existing Plan detail UI mounted under the new nested route, wrapped in a shell that provides breadcrumb + Plan header,
So that the page survives the URL migration with minimal disruption.

**Acceptance Criteria:**

**Given** the new route shape,
**When** the route renders,
**Then** the page loads `useApp(appId)` and `usePlan(planId)` in parallel.

**And** if `plan.appId !== appId` (URL tampering or stale link), the page auto-redirects to the canonical URL via `router.replace`.

**And** the breadcrumb shows: `Apps  ›  <icon> <displayName>  ›  Plan #N · <iterationLabel>`, with all but the last segment clickable.

**And** the existing pipeline UI components (PipelineStageView, WaveRunnerPanel, AgentEventsStream, FileExplorer) mount as children of the shell, unchanged.

**And** loading and error states render.

**Prerequisites:** Stories 5.1, 6.1 (uses `useApp`).

**Touch Points:**

- `src/app/labs/[appId]/plans/[planId]/page.tsx` (new)
- `src/components/labs/plan-detail-shell.tsx` (new)
- `src/components/labs/plan-breadcrumb.tsx` (new)

**Forbidden Areas:** Do not modify any existing pipeline UI components in this story — they mount as-is.

**Technical Notes:** Plan numbering for breadcrumb: the index of this Plan in the App's chronologically-sorted Plans + 1. Compute on render.

### Story 7.2: Create `PlanActionsBar` with status-driven actions

As Richie,
I want a status-driven actions bar so the operator only sees buttons relevant to the Plan's current state,
So that approve/abandon/sign-off flows are obvious without UI clutter.

**Acceptance Criteria:**

**Given** a Plan,
**When** the actions bar renders,
**Then** for `concept`: `Approve & Start Building` (primary) · `Edit Proposal` (ghost) · `Abandon` (ghost-danger, right-aligned).

**And** for `developing`: status indicator with wave progress · `Abandon` (ghost-danger, right-aligned).

**And** for `review`: `Sign Off & Deploy` (primary) · `Send back to dev` (ghost) · `Abandon` (ghost-danger, right-aligned).

**And** for `delivered`: muted "Delivered" badge + "Start a new Plan from the App page to iterate."

**And** for `abandoned`: muted "Abandoned" badge + link back to App.

**And** the `Approve` action calls `transitionPlanStatus(planId, 'developing')` via existing API.

**And** the `Abandon` action opens a confirm dialog (copy framing per Maya's note: "Stop working on Plan #N? You can start a new iteration after.") and calls the abandon transition on confirm.

**And** primary action is left-aligned; danger action is right-aligned via `ml-auto` — never adjacent.

**And** unit tests cover all five status renderings and at least one happy-path mutation per action.

**Prerequisites:** Story 7.1.

**Touch Points:**

- `src/components/labs/plan-actions-bar.tsx` (new)
- `src/hooks/use-transition-plan.ts` (new — wraps the existing transition endpoints)
- `src/components/labs/__tests__/plan-actions-bar.test.tsx` (new)

**Technical Notes:** `Edit Proposal` (concept state) opens a separate dialog/page that allows editing the Plan's epics/stories before approval — v1 can stub this with a placeholder linking to the existing edit UI if one exists; full implementation is a v1.x story if not in scope.

### Story 7.3: Sweep + replace old `/labs?planId=X` references via `links.ts`

As Richie,
I want every reference to `/labs?planId=X` in the codebase replaced with `links.plan(appId, planId)`, and old query-param logic removed from `/labs/page.tsx`,
So that there is exactly one URL shape for Plan detail.

**Acceptance Criteria:**

**Given** the codebase contains references to the old URL pattern,
**When** the sweep runs,
**Then** `grep -r '/labs?planId=' src/ tests/` returns zero results after the change.

**And** every `Link` and `router.push` call previously using the old pattern now uses `links.plan(...)`.

**And** any caller that needs `appId` but didn't have it gets it via the existing data flow (typically by extending the hook or passing through props — make minimal-impact changes).

**And** the old `/labs/page.tsx` query-param branching is fully removed (Story 5.2 starts this; this story finishes the sweep across all callers).

**And** Playwright smoke tests are updated to use the new URL shape.

**And** `npm run ci` passes.

**Prerequisites:** Stories 5.1, 7.1.

**Touch Points:** `<EPIC_WIDE>` — this is a cross-cutting refactor and gets its own wave.

**Forbidden Areas:** Do not introduce new components or new behaviors — pure mechanical migration.

**Technical Notes:** The `<EPIC_WIDE>` sentinel (per pipeline-v1 dev-correction Story D.2) tells the wave-conflict resolver to give this story its own wave with no siblings — appropriate because the sweep can touch any file under `src/components/labs/**` and `src/app/labs/**` and we want it serialized.

### Story 7.4: Add Playwright smoke for App → Plan navigation flow

As Richie,
I want one Playwright smoke that exercises the entire App → Plan → action flow,
So that we have continuous regression protection on the critical path.

**Acceptance Criteria:**

**Given** the new routes are wired,
**When** the smoke runs,
**Then** the test: navigates to `/labs`, clicks a seeded App card, asserts `/labs/[appId]` loads with timeline, clicks a Plan node, asserts `/labs/[appId]/plans/[planId]` loads with breadcrumb + actions bar, clicks the breadcrumb's App segment, asserts back at `/labs/[appId]`, clicks the breadcrumb's Apps segment, asserts back at `/labs`.

**And** auth is pre-seeded in sessionStorage per existing pattern.

**And** API routes are mocked via `page.route()` per existing pattern.

**And** the smoke runs in CI (`npm run test:e2e`).

**And** the smoke completes in <30s.

**Prerequisites:** Stories 5.2, 6.1, 7.1, 7.3.

**Touch Points:**

- `tests/e2e/app-navigation.spec.ts` (new — may have been stubbed by Story 5.2)

**Technical Notes:** Mock fixtures should match the `AppCardData` and detail response shapes from Stories 2.1 and 2.2. Re-use existing Playwright helpers from `tests/e2e/`.

---

## Sequencing Across Epics

```
Epic 1  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        (5 stories, all internal deps)
                │
                ▼
Epic 2  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        (6 stories — 2.1, 2.2 unblock 5.1)
                │
                ▼            ┌────────────────────┐
Epic 3  ━━━━━━━━━━━━━━━━━━━━━┤                    │
        (4 stories)          │ Epic 5             │
                │            │ (4 stories,         │
                ▼            │  needs 2.1, 2.2)    │
Epic 4  ━━━━━━━━━━━━━━━━━━━━━┤                    │
        (4 stories)          │ Epic 6             │
                             │ (7 stories,         │
                             │  needs 2.2)         │
                             │                    │
                             │ Epic 7             │
                             │ (4 stories,         │
                             │  needs 5.1, 6.1)    │
                             └────────────────────┘
```

**Parallelism opportunities:**

- Epic 5 can begin once Stories 2.1, 2.2 land — even before Epics 3 and 4 complete.
- Epic 6 can begin once Story 2.2 lands; Story 6.1 in particular only needs `GET /api/apps/:appId`.
- Epic 7 needs the link builder (Story 5.1) and the App detail route shell (Story 6.1).
- Within Epic 1, Stories 1.1 and 1.4 can run in parallel; 1.2 and 1.3 depend on 1.1; 1.5 is tail.

A two-developer / two-agent split could ship backend (Epics 1–4) and UI (Epics 5–7) in parallel after Story 2.2 lands.

---

## Total Story Count and Sizing

| Epic | Stories | Approximate sizing |
|---|---|---|
| 1. Data Foundation | 5 | 2 small + 3 medium |
| 2. Lifecycle API | 6 | 1 small + 5 medium |
| 3. Integrity Guards | 4 | 2 small + 2 medium |
| 4. PM Brownfield Planning | 4 | 1 small + 3 medium |
| 5. Apps Workspace Home | 4 | 1 small + 3 medium |
| 6. App Workshop View | 7 | 3 small + 4 medium |
| 7. Plan Detail Re-shell | 4 | 1 small + 1 medium + 1 EPIC_WIDE + 1 small |
| **Total** | **34** | — |

(Earlier overview said 27; the detailed breakdown surfaced more discrete stories, which is normal during decomposition.)

**Estimated timeline:** 2–3 sprints (10–15 working days) for a single agent; 1.5–2 sprints with backend/UI parallelism.

---

## Validation Against Tech Spec

Each Acceptance Criterion in the tech spec's §"Acceptance Criteria" section is covered:

| Spec AC | Covered by |
|---|---|
| 1. Schema provisioned via SST | Stories 1.1, 1.4 |
| 2. Seven new `/apps/*` endpoints | Stories 2.1, 2.2, 2.3, 2.4, 2.5 |
| 3. `canDispatchJob` guard + `ORPHANED` + metric | Stories 3.1, 3.2, 3.4 |
| 4. PM-augmentation prompt + parser + clarification | Stories 4.1, 4.2, 4.3, 4.4 |
| 5. Apps grid + App detail + Plan re-shell | Epics 5, 6, 7 |
| 6. Conditional `+ New Plan` + dirty-tree banner | Stories 6.4, 6.5 |
| 7. Tests pass | All stories include test ACs |
| 8. `npm run ci` passes | All stories require it |
| 9. Manual smoke (App → Plan ship) | Story 7.4 + manual exercise |
| 10. Predecessor doc marked Superseded | (Add to Epic 1.5 wipe story or as a one-line cleanup) |

Spec AC #10 needs a small docs touch — adding a "Superseded by `docs/tech-spec-app-plan-v1.md`" note at the top of `docs/concepts/published-feedback-loop-mvp.md`. This is a 5-minute task that can fold into Story 1.5 or stand alone.

---

_For implementation: use the `bmad:bmm:workflows:create-story` workflow against this document to generate individual story implementation plans, or hand stories directly to the dev agent (story files at `docs/stories/ap-N-M-*.md`)._
