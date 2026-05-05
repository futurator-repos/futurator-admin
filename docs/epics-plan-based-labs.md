# Futurator-Admin — Epic 17: Plan-Based Labs

**Date:** 2026-04-21
**Project Level:** 2 (8 stories, ~22 story points — meaningful UX restructure spanning data model, API, cron, and UI)
**Epic Number:** 17 (follows Epic 16 — Orchestration Recovery)

---

## Epic 17: Labs as a Plan-Based Workspace

**Slug:** `plan-based-labs`

### Goal

Restructure the Labs module around a first-class **Plan** object — the atomic unit of product intent the operator cares about. A Plan owns its name (= folder = deploy URL), its intent text, a persistent `plan.md` on disk, and one-or-more Epics with inter-epic dependencies. This replaces today's confusing identity chain (`activeAppName` → folder → untitled epic) with a single coherent domain object, and makes rapid prototype-and-delete workflows safe and intentional.

### Why now

The Pong-inside-solitaire incident on 2026-04-21 — where the operator deleted a folder named `solitaire` via the file-explorer trash icon without realizing it held a Pong epic — exposed the core flaw in today's identity model. The folder name (`activeAppName`) is the deploy URL, but the epic title (`Pong`) is what the operator thinks about. When they diverge, destructive mistakes become easy.

Beyond the incident, day-to-day Labs usage is shifting toward rapid iteration: generate a plan → run it → delete it → try again. Today's flow is built around a single persistent project per workspace and hides the "New Project" CTA in a dropdown. Every throwaway prototype requires navigating three menus.

### Scope

**In Scope:**

- New `Plan` domain object with its own DDB table, CRUD API, and status lifecycle (Concept → Developing → Review → Delivered → Archived).
- Plan name = project folder name = deploy slug, validated + locked on creation.
- `plan.md` authored by the PM agent, persisted to the project folder, and editable in-UI.
- Epics gain `planId` + `dependsOnEpics` fields enabling an epic-level DAG. The existing wave-completion cron extends to resolve plan-level epic waves in addition to story waves.
- PM agent prompt change: outputs a **Plan JSON** with 1..N epics instead of a single Epic XML. Zod schema, parser, serializer, and round-trip plan.md ↔ Plan object.
- Labs UI redesign: Plans list view as the home, New Plan form replacing the intent-generator-in-dropdown flow, Plan detail page with Plan / Workflow / Deploy tabs.
- Archive (soft-delete) by default, with restore within 14 days. Hard-delete gated by a confirmation modal showing cost spent + cascade impact + name-match typing.
- File-explorer trash demoted to an Admin section (kept functional, removed from the main path).
- Legacy "Generate Epic" / "Start Epic" / `useEpicOrchestrator` / `activeAppName` concepts renamed/retired.

**Out of Scope (not this epic):**

- Existing epics/projects: **not migrated**. Full wipe before Epic 17 ships (per operator direction 2026-04-21). Fresh-start philosophy — DDB tables + EC2 `/home/ubuntu/projects/*` + S3 artifacts all cleared as a one-shot.
- Plan branching / forking / parameterized plans. V1 ships linear plans only.
- Per-epic execution-mode override. Execution mode (Pipeline vs Orchestrator) is a Plan-level setting; all epics inside a plan use the same mode.
- Live multi-user collaboration on plan editing. Assumes single-operator use.
- Retirement of the orchestrator code path (still deferred to Story 16.4).

### Success Criteria

1. Operator lands on `/labs` with zero plans; an empty state invites them to create one with the intent textbox + plan-name field as the primary UI (no dropdown hunt).
2. Typing an intent and clicking **Generate Plan** produces a Plan in `concept` status, creates `/home/ubuntu/projects/<name>/` via SSM, writes `plan.md`, and navigates to the Plan detail page.
3. The Plan detail page's Plan tab shows a tree of Epics → Waves → Stories, all editable. Clicking **Start Plan Development** transitions the Plan to `developing` and kicks off the first epic's wave-0 jobs.
4. Multiple epics with inter-epic dependencies run in correct order: the wave-completion cron holds Epic N+1 until all Epic-N stories complete + their per-wave build-checks pass. A plan-level build-check runs after the final epic before marking the Plan `review`.
5. Archiving a Plan via the row overflow menu marks it `archived`, moves its folder to `/home/ubuntu/.trash/plans/<name>-<ts>/`, and cancels any running jobs. Restore returns the folder and status within 14 days; a nightly cron hard-deletes older archived plans.
6. Hard-delete from the Plan card overflow menu requires typing the plan name; the modal shows rows-to-delete, running-jobs-to-cancel, agent-cost-spent, and deploy-URL-to-tear-down before executing.
7. The file-explorer trash icon no longer appears on the main projects grid; same endpoint is reachable via an explicit Admin Tools panel.
8. The PM agent output is valid Plan JSON parseable by Zod and round-trippable to/from `plan.md` without data loss.
9. `npm run ci` passes; no regression in Epic 16's wave-completion + step-based pipeline behavior.

### Dependencies

**External / operational:** none new. The EC2 daemon, DDB, SST infra, and Claude Code auth already exist.

**Upstream features that must stay intact:**

- `functions/shared/services/wave-reducer.ts` (Epic 16) — extended by Story 17.4 to reason about epic-level deps; existing story-wave behavior unchanged.
- `functions/shared/services/pipeline-launcher.ts` (Epic 16) — reused by Plan launch; no signature changes required.
- `functions/shared/pipelines/story-pipeline.ts` + `wave-build-pipeline.ts` (Epic 16) — per-story and per-wave-build pipelines unchanged; a new plan-build pipeline is added alongside.
- Identity Broker auth — unchanged.

---

## Story Map — Epic 17

```
Epic 17: Plan-Based Labs

  Backend foundation (ship first)
  ├── 17.1  Plan data model + repo + CRUD API                (3 pts)
  ├── 17.2  Plan folder bootstrap + plan.md read/write       (2 pts)
  ├── 17.3  PM agent — generate Plan JSON, Zod, parser       (3 pts)
  └── 17.4  Epic-level deps, plan waves, cron extension      (3 pts)

  UI (ships on top of backend)
  ├── 17.5  Plans list + New Plan form                       (3 pts)
  └── 17.6  Plan detail page (Plan / Workflow / Deploy tabs) (5 pts)

  Safety net + cleanup (ships last)
  ├── 17.7  Archive + hard-delete with confirmation modal    (2 pts)
  └── 17.8  Retire legacy concepts (rename/remove)           (1 pt)
```

**Total active points:** 22
**Estimated timeline:** 1.5–2 sprints (7–10 working days).

**Sequencing rationale:**

1. **Stories 17.1–17.4 ship the backend** in order: data model → folder + markdown persistence → PM agent output format → multi-epic orchestration. Each can be tested via curl/integration tests before any UI lands, de-risking the UI work.
2. **Stories 17.5–17.6 ship the UI** on the stable backend. 17.5 (list + new) is the entry surface; 17.6 (detail) is where the operator spends most of their time.
3. **Story 17.7** adds the archive + safe-delete net after the main flow works so operators don't have to wait for safety to start using plans. Delete is always `DELETE /api/plans/:id` gated by modal — even in 17.1, the primitive exists; 17.7 builds the UX around it.
4. **Story 17.8** retires legacy concepts once everything else is green. No partial renames — big bang once the new system is production-proven for a week.

### Pre-epic cleanup

Before Story 17.1 lands, all existing DDB rows (epics, jobs, events, project-registry, party-*), EC2 project folders, and S3 artifacts are wiped in a single pre-flight pass (executed 2026-04-21). Fresh-start philosophy per operator direction. No migration code is written.

---

## Stories — Epic 17

### Story 17.1: Plan data model + repository + CRUD API

As **Richie (operator)**, I want **Plan as a first-class DDB object with basic CRUD**, so that **Plans can be listed, fetched, updated, and deleted via the API — the foundation the UI will build on**.

**Acceptance Criteria:**

- **AC #1** — New DDB table `futurator-plans` (partition key: `planId`, PAY_PER_REQUEST, PITR enabled). Schema and table creation in `sst.config.ts`.
- **AC #2** — `functions/shared/types/plan.ts` defines `Plan` interface: `planId`, `name`, `intent`, `description`, `status` (`'concept' | 'developing' | 'review' | 'delivered' | 'archived'`), `epicIds[]`, `workingDir`, `deployUrl?`, execution settings (`devModel`, `reviewerModel`, `yoloMode`, `executionMode`), cost rollup (`totalCostUsd`, `totalStories`, `doneStories`), timestamps, `archivedAt?`, `archivePath?`.
- **AC #3** — `functions/shared/repositories/plan-repository.ts` exports `createPlan`, `getAllPlans`, `getPlanById`, `updatePlanFields`, `deletePlan` — same pattern as `epic-workflow-repository.ts`.
- **AC #4** — Zod schema in `functions/shared/schemas/plan-schema.ts` validates Plan name: kebab-case `[a-z][a-z0-9-]{2,40}`, unique across non-archived plans (409 Conflict on collision).
- **AC #5** — Hono endpoints in `functions/api/index.ts`:
  - `POST /api/plans` — create; returns 201 + `{plan}`
  - `GET /api/plans` — list summaries (id, name, status, counts, cost, createdAt)
  - `GET /api/plans/:id` — full plan with populated `epics[]`
  - `PATCH /api/plans/:id` — partial update (intent, description, settings)
  - `DELETE /api/plans/:id` — hard delete (cascade to epics/jobs/events/folder/S3)
- **AC #6** — Epic type gains `planId: string` (required going forward). New `dependsOnEpics?: string[]` field (empty = no deps).
- **AC #7** — Unit tests: plan-repository CRUD, name validation (valid/invalid/duplicate), epic-plan association, cascade delete test.
- **AC #8** — `npm run ci` passes.

**Prerequisites:** Pre-epic cleanup (all legacy rows wiped) completed.

**Files to create:**
- `functions/shared/types/plan.ts`
- `functions/shared/repositories/plan-repository.ts`
- `functions/shared/schemas/plan-schema.ts`
- `functions/shared/repositories/__tests__/plan-repository.test.ts`

**Files to modify:**
- `sst.config.ts` — add PlansTable
- `functions/shared/dynamo-client.ts` — add `plans` to `TABLE_NAMES`
- `functions/shared/types/epic-workflow.ts` — add `planId`, `dependsOnEpics?`
- `functions/api/index.ts` — 5 new endpoints

**Effort:** 3 points.

---

### Story 17.2: Plan folder bootstrap + plan.md read/write

As **Richie**, I want **the project folder and `plan.md` to materialize when a Plan is created**, so that **the Plan exists on disk from Concept state onward and survives editing round-trips**.

**Acceptance Criteria:**

- **AC #1** — `functions/shared/services/plan-folder-service.ts` exports:
  - `bootstrapPlanFolder(plan, deps)` — SSM-executes `mkdir -p /home/ubuntu/projects/<name> && echo ... > plan.md` using the safe-path regex established by DELETE `/ec2/files`.
  - `writePlanMarkdown(plan)` — renders the Plan object to Markdown + writes via SSM.
  - `readPlanMarkdown(planName)` — reads the file, parses back to Plan structure.
  - `movePlanFolderToTrash(plan, timestamp)` — used by Story 17.7 archive.
- **AC #2** — `plan.md` format: YAML frontmatter (`planId`, `name`, `status`, `createdAt`) followed by sections: `# Plan: <name>`, `## Intent`, `## Description`, `## Epics` (each with `### Epic N: <title>`, deps line, goal, AC list, `#### Stories` with story bullets).
- **AC #3** — `POST /api/plans` (Story 17.1) calls `bootstrapPlanFolder` after the DDB write. Failure to create the folder marks the Plan `status: 'archived'` with error message (so the system never leaves an orphan DDB row pointing at a nonexistent folder).
- **AC #4** — `PATCH /api/plans/:id` triggers `writePlanMarkdown` to keep the file in sync with DDB edits.
- **AC #5** — `DELETE /api/plans/:id` hard-delete cascades to SSM `rm -rf /home/ubuntu/projects/<name>` using the same regex-guarded pattern from existing `DELETE /ec2/files` to prevent path escape.
- **AC #6** — Unit tests: markdown serializer round-trip (Plan → MD → Plan equality), frontmatter parsing, error path when SSM is unreachable.
- **AC #7** — `npm run ci` passes.

**Prerequisites:** Story 17.1 complete.

**Files to create:**
- `functions/shared/services/plan-folder-service.ts`
- `functions/shared/services/__tests__/plan-folder-service.test.ts`
- `functions/shared/services/plan-markdown.ts` (serializer/parser)

**Files to modify:**
- `functions/api/index.ts` — wire folder bootstrap into POST/PATCH/DELETE plans

**Effort:** 2 points.

---

### Story 17.3: PM agent — generate Plan JSON

As **Richie**, I want **the PM agent to produce a structured Plan with 1..N epics and inter-epic dependencies**, so that **intents bigger than one epic (auth + dashboard + billing) are organized correctly rather than crammed into a single epic**.

**Acceptance Criteria:**

- **AC #1** — New PM prompt template at `functions/shared/prompts/pm-plan-prompt.ts`. Instructs the agent to output **JSON** matching the schema in AC #2. Replaces the existing XML-epic prompt.
- **AC #2** — Zod schema `planOutputSchema` in `functions/shared/schemas/plan-output-schema.ts`:
  ```ts
  { plan: { name, description, epics: [{ id, title, goal, acceptanceCriteria, dependsOn: string[], stories: [{ id, title, description, dependsOn: string[], criteria: [...] }] }] } }
  ```
- **AC #3** — `POST /api/plans/from-intent` endpoint:
  - Takes `{ intent, name, workingDir?, devModel?, reviewerModel?, executionMode? }`
  - Creates a PENDING agent job with a `pm-plan` pipeline (runs the new prompt, captures JSON output)
  - Daemon pipeline step parses + validates the JSON against `planOutputSchema`
  - On success: creates the Plan (status=`concept`) + bootstrap folder + `plan.md` + creates 1..N Epic rows with `planId` set + `dependsOnEpics` populated
  - Returns `{ planId, planJobId }`
- **AC #4** — PM agent runs **1 attempt by default** (cheap regeneration). Optional `?attempts=3` query param for high-quality mode (used by `Start Plan Development` if the operator never edited the plan).
- **AC #5** — `PATCH /api/plans/:id/regenerate` — triggers a fresh PM agent run using the current intent (new job, 1 attempt by default), overwrites epic tree, re-writes `plan.md`.
- **AC #6** — JSON parse failures return 400 with the agent's raw output for debugging.
- **AC #7** — Unit tests: schema validates a known-good plan JSON, rejects malformed (missing fields, invalid dep references, kebab-case violations).
- **AC #8** — `npm run ci` passes.

**Prerequisites:** Story 17.1 + 17.2 complete.

**Files to create:**
- `functions/shared/prompts/pm-plan-prompt.ts`
- `functions/shared/schemas/plan-output-schema.ts`
- `functions/shared/services/plan-generation-service.ts` (wraps the agent invocation)
- `functions/shared/services/__tests__/plan-generation-service.test.ts`

**Files to modify:**
- `functions/api/index.ts` — 2 new endpoints (`from-intent`, `regenerate`)
- `daemon/pipelines/job-router.mjs` — register `pm-plan` pipeline type

**Effort:** 3 points.

---

### Story 17.4: Epic-level dependencies + plan waves

As **Richie**, I want **multi-epic plans to execute in the correct order based on their dependency graph**, so that **Epic 2 doesn't start until Epic 1 (whose types Epic 2 imports) has completed**.

**Acceptance Criteria:**

- **AC #1** — `functions/shared/services/plan-waves.ts` exports `computePlanWaves(epics)`: topological sort over `epic.dependsOnEpics` producing a `Record<epicId, planWaveNumber>` map. Same algorithm as the existing story-wave computation, one level up.
- **AC #2** — `POST /api/plans/:id/start` endpoint:
  - Validates Plan is in `concept` status
  - Computes plan waves via `computePlanWaves`
  - Launches all epic-wave-0 epics in parallel (one story-wave-0 per epic via `launchPipelineWave`)
  - Flips Plan status to `developing`
  - Returns `{ jobIds: { [epicId]: string[] } }`
- **AC #3** — Wave-completion cron (Story 16.2's `wave-completion-check`) is extended to:
  - Inner pass (existing): advance story waves within each epic.
  - **Outer pass (new)**: when all epics in plan-wave N reach `status === 'completed'`, launch plan-wave N+1 epics.
  - Plan-level final build-check: after the last plan-wave completes, run one `plan-build-check` job (`npm run build && dev server up`) against the full merged codebase. On success → Plan status `review`. On failure → Plan status `fixing`.
- **AC #4** — Plan `status` transitions mirror the cron's decisions: `developing` → `fixing` (any wave/epic failed) → operator intervenes → `developing` → `review` (all epics done + final build-check passed).
- **AC #5** — Unit tests for `computePlanWaves`: linear deps (0→1→2), parallel epics (two at wave 0), diamond (3 at wave 0 + 1 at wave 1 depending on all three), cycle detection (throws).
- **AC #6** — Integration test: reducer ticks through a 3-epic plan (E1 → E2 & E3 parallel → E4 joins) to completion with mocked job-status timeline.
- **AC #7** — `npm run ci` passes.

**Prerequisites:** Stories 17.1–17.3 complete.

**Files to create:**
- `functions/shared/services/plan-waves.ts`
- `functions/shared/services/__tests__/plan-waves.test.ts`
- `functions/shared/pipelines/plan-build-pipeline.ts` (final integration check)

**Files to modify:**
- `functions/shared/services/wave-reducer.ts` — add outer plan-wave reduction pass
- `functions/cron/wave-completion-check.ts` — fetch plans, run outer reduction
- `functions/api/index.ts` — new `POST /api/plans/:id/start` endpoint

**Effort:** 3 points.

---

### Story 17.5: Plans list view + New Plan form

As **Richie**, I want **the Labs home to be a list of all my plans with a prominent New Plan affordance**, so that **creating, finding, and opening prototypes takes one click, not three menu navigations**.

**Acceptance Criteria:**

- **AC #1** — `/labs` lands on a `<PlansList>` component. No dropdown. No `activeAppName`. Empty state (0 plans) shows the `<NewPlanForm>` taking over the page.
- **AC #2** — `<PlansList>`:
  - Header: `Labs` + sticky `[+ New Plan]` button (top-right).
  - Filter bar: All / Concept / Developing / Review / Delivered / Archived (multi-select chips).
  - Rows: plan name + status badge + progress summary (epics done / waves running) + cost + last updated. Overflow menu `⋮` = Open · Duplicate · Archive · Delete.
  - Collapsed "Archived" section at the bottom (separately expandable).
- **AC #3** — `<NewPlanForm>`:
  - Plan name input (kebab-case validated live, inline "already taken" check against `GET /api/plans`).
  - Intent textarea.
  - Advanced collapsible: Execution mode (Pipeline default / Orchestrator), Dev model, Reviewer model, Dev effort, Reviewer effort, YOLO toggle.
  - Submit = `POST /api/plans/from-intent`. Shows PM-agent progress bar (polls `plan.planJobId`). On success, routes to `/labs/plans/<planId>`.
- **AC #4** — New hook `use-plans.ts` exposing `usePlansList()`, `usePlan(planId)`, `useCreatePlan()`, `useArchivePlan()`, `useDeletePlan()`, `useStartPlanDevelopment()`. All invalidate `['plans']` query key on mutation success.
- **AC #5** — Duplicate: opens New Plan form pre-filled with the source plan's intent + `-copy` suffix on the name.
- **AC #6** — Cmd+K palette: opens a quick switcher showing existing plans filtered by fuzzy search + "+ New Plan" action at the top.
- **AC #7** — Component tests: empty state renders NewPlanForm, name validation, duplicate-then-navigate, filter chip behavior.
- **AC #8** — `npm run ci` passes.

**Prerequisites:** Stories 17.1–17.3 complete (17.4 not required for the list itself but recommended to land first so operators can actually use the plans they create).

**Files to create:**
- `src/app/labs/plans/page.tsx`
- `src/components/labs/plans/plans-list.tsx`
- `src/components/labs/plans/plan-row.tsx`
- `src/components/labs/plans/new-plan-form.tsx`
- `src/components/labs/plans/plan-cmdk.tsx`
- `src/hooks/use-plans.ts`

**Files to modify:**
- `src/app/labs/page.tsx` — redirect to `/labs/plans` (or render PlansList directly)
- `src/stores/labs-store.ts` — drop `activeAppName`, add `activePlanId` (set by route)

**Effort:** 3 points.

---

### Story 17.6: Plan detail page

As **Richie**, I want **a Plan detail page where I can edit the intent, edit the epic tree, and start development — plus watch progress and manage deploy**, so that **everything I do with a plan lives in one coherent surface**.

**Acceptance Criteria:**

- **AC #1** — Route `/labs/plans/:planId` renders `<PlanDetail>` with three tabs: **Plan** · **Workflow** · **Deploy**.
- **AC #2** — **Plan tab (Concept state)**:
  - Intent editor (single textarea + `Regenerate Plan` button wired to `PATCH /api/plans/:id/regenerate`).
  - Epic tree editor: add/remove epics, reorder via drag handle, edit epic title inline, set `dependsOn` via multi-select of other epics, add/remove/rename stories inline, set story `dependsOn` within-epic.
  - Auto-save edits: 500ms debounce → `PATCH /api/plans/:id` with the updated epics array. Plan-md file rewritten server-side.
  - Footer: `Start Plan Development` button (enabled when `status === 'concept'`, plan is syntactically valid, and at least one story exists).
- **AC #3** — **Plan tab (Developing / later states)**: same tree but read-only, with live progress indicators: epic wave badge, story status dots, "currently running" pulse on the active story, cost-per-epic, time-elapsed-per-story. Clicking a story opens its live-output panel (reuses the existing `<StoryLiveOutput>` from Epic 16).
- **AC #4** — **Workflow tab**: flat list of all stories across all epics (with epic label), sortable by status / wave / cost / time. Useful for firefighting a specific failing story. Reuses today's `DevsWorkflowView` with minimal changes.
- **AC #5** — **Deploy tab**: dev-server URL button (uses Story 16.3's `/dev-server` endpoint), Publish button (deploys to S3 apps path), current deployed URL, latest QA snapshot summary.
- **AC #6** — Top-right overflow menu `⋮`: Edit Intent · Duplicate · Archive · Delete (the last two wired in Story 17.7).
- **AC #7** — Breadcrumb: `Labs / Plans / <name>`.
- **AC #8** — Component tests: tree-editor add/remove epic, dep multi-select, Start-Plan enablement, tab switching, read-only mode in Developing state.
- **AC #9** — `npm run ci` passes.

**Prerequisites:** Stories 17.1–17.5 complete.

**Files to create:**
- `src/app/labs/plans/[planId]/page.tsx`
- `src/components/labs/plans/plan-detail.tsx`
- `src/components/labs/plans/plan-tab.tsx`
- `src/components/labs/plans/epic-tree-editor.tsx`
- `src/components/labs/plans/plan-workflow-tab.tsx`
- `src/components/labs/plans/plan-deploy-tab.tsx`

**Files to modify:**
- `src/components/labs/agentic-workflow/story-live-output.tsx` — make story-id-agnostic so the Plan detail reuses it

**Effort:** 5 points.

---

### Story 17.7: Archive + hard-delete with confirmation modal

As **Richie**, I want **Archive as the default destructive path (with restore), and Hard-Delete behind a meaningful speed bump**, so that **I can rapid-prototype without fear of losing work to a misclick**.

**Acceptance Criteria:**

- **AC #1** — `POST /api/plans/:id/archive`:
  - Sets plan status to `archived`.
  - Cancels all running jobs under the plan (marks FAILED with `cancelled-by-archive`).
  - SSM-moves `/home/ubuntu/projects/<name>/` to `/home/ubuntu/.trash/plans/<name>-<ISO_TS>/`.
  - Stores `archivedAt` + `archivePath` on the plan row.
  - Returns 200 `{plan}`.
- **AC #2** — `POST /api/plans/:id/restore`:
  - Only valid when `status === 'archived'` and `.trash/` folder exists.
  - SSM-moves the folder back to `/home/ubuntu/projects/<name>/`.
  - Sets status back to the prior value (stored in a new `preArchiveStatus` field).
  - Clears `archivedAt` + `archivePath`.
- **AC #3** — `DELETE /api/plans/:id` (hard-delete):
  - Cascades: DDB plan row + DDB epic rows + DDB agent-jobs + DDB agent-events + SSM rm-rf folder (or `.trash/` folder if already archived) + S3 `apps/<name>/` cleanup + S3 `knowledge-live/<name>/` cleanup + CloudFront invalidation.
  - Returns 200 with a `results: [{step, status, detail}]` array (same pattern as existing cascade delete).
- **AC #4** — Delete confirmation modal `<DeletePlanModal>`:
  - Shows: "This will delete: X epics, Y jobs, Z events, working folder, deploy at futurator.ai/apps/<name>" + "Total agent cost: $N.NN over M minutes" + "Running jobs that will be cancelled: K".
  - Requires typing the plan name exactly to enable the red Delete button.
  - Two buttons: Cancel · Delete forever.
- **AC #5** — Nightly cron `purge-archived-plans` (`rate(1 day)`): hard-deletes plans with `archivedAt` > 14 days old. Logs `purged N plans`.
- **AC #6** — Unit tests: archive moves folder + cancels jobs, restore returns folder, hard-delete cascade touches all 5 tiers, name-match modal logic.
- **AC #7** — `npm run ci` passes.

**Prerequisites:** Stories 17.1–17.6 complete.

**Files to create:**
- `src/components/labs/plans/delete-plan-modal.tsx`
- `src/components/labs/plans/archive-badge.tsx`
- `functions/cron/purge-archived-plans.ts`

**Files to modify:**
- `functions/api/index.ts` — add archive/restore endpoints, enhance DELETE with cascade
- `functions/shared/services/plan-folder-service.ts` — add `movePlanFolderToTrash` + `restorePlanFolder`
- `src/hooks/use-plans.ts` — add `useArchivePlan`, `useRestorePlan`, enhance `useDeletePlan`
- `sst.config.ts` — register the purge cron

**Effort:** 2 points.

---

### Story 17.8: Retire legacy concepts

As **Richie**, I want **the old "Generate Epic" / "Start Epic" / "activeAppName" concepts removed from the codebase and UI**, so that **the Plan-based model is the single source of truth and future contributors aren't confused by two parallel hierarchies**.

**Acceptance Criteria:**

- **AC #1** — Delete `EpicGenerator` component + its intent-capture logic (`src/components/labs/agentic-workflow/epic-generator.tsx`). The equivalent flow is now in `<NewPlanForm>` (Story 17.5).
- **AC #2** — Remove `activeAppName` from `labs-store.ts`. All plans-based routing uses `activePlanId` (route-based, not store-based).
- **AC #3** — Remove the `useEpicOrchestrator` toggle from any remaining UI. Execution mode lives on the Plan now.
- **AC #4** — Rename/remove legacy endpoints. The flow for launching per-story or per-wave work under a Plan goes through `POST /api/plans/:id/start` (Story 17.4). Legacy `POST /api/epic-workflows/:id/start` is left in place for one sprint as a redirect (`301` to the plan's start endpoint using `epic.planId`), then deleted.
- **AC #5** — Move the file-explorer trash button out of the main projects grid. It lives in a new `Admin Tools` collapsed section at the bottom of the File Explorer page with a "These are low-level operations — prefer Plan-level actions." helper text.
- **AC #6** — Update `docs/sprint-status.yaml` legacy terms; update `CLAUDE.md` to reference Plans instead of Epics as the top-level unit.
- **AC #7** — `npm run ci` passes; no references to `activeAppName`, `EpicGenerator`, `useEpicOrchestrator` remain in `src/` or `functions/`.

**Prerequisites:** Stories 17.1–17.7 complete + operator has used the new UI for at least one plan successfully.

**Files to delete:**
- `src/components/labs/agentic-workflow/epic-generator.tsx`

**Files to modify:**
- `src/stores/labs-store.ts`
- `src/components/labs/agentic-workflow/index.tsx`
- `src/components/development/file-explorer.tsx`
- `functions/api/index.ts` (remove or redirect legacy endpoints)
- `CLAUDE.md`

**Effort:** 1 point.

---

## Implementation Timeline — Epic 17

**Total Story Points:** 22
**Estimated Timeline:** 7–10 working days, shipped in three waves:

1. **Wave 1 — Backend foundation (stories 17.1 → 17.2 → 17.3 → 17.4).** All testable via curl/integration tests before any UI lands. ~3 days.
2. **Wave 2 — UI (stories 17.5 → 17.6).** Built against the stable backend. ~3–4 days.
3. **Wave 3 — Safety + cleanup (stories 17.7 → 17.8).** Ships the archive/delete modal + retires legacy concepts. ~1–2 days.

**Dependency graph:**
- 17.1 is foundation (no deps).
- 17.2 needs 17.1.
- 17.3 needs 17.1 + 17.2.
- 17.4 needs 17.3 (because cron needs Plan + epics to exist).
- 17.5 needs 17.1 + 17.3 (list needs GET /plans; form needs POST /from-intent).
- 17.6 needs 17.4 + 17.5.
- 17.7 needs 17.6 (archive UI lives on the plan detail overflow menu).
- 17.8 needs 17.7 (legacy removal only after new flow is user-proven).

---

## After Epic 17

Once the operator has shipped 3+ plans through the new flow without regressions, file follow-ups for items deferred from V1:

- **Story 18.1 (future)** — Full markdown editor for `plan.md` as an alternative to the tree editor.
- **Story 18.2 (future)** — Per-epic execution-mode override.
- **Story 18.3 (future)** — Plan forking / branching (try two variants of the same intent).
- **Story 16.4 (still deferred)** — Retire the orchestrator code path now that Pipeline is plan-default.
