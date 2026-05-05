# Futurator-Admin — Technical Specification: App / Plan Brownfield Model (Pipeline v1)

**Author:** Ricardo
**Date:** 2026-04-27
**Project Level:** 2 (Cross-cutting feature touching data model, API, daemon, frontend, prompts)
**Change Type:** Architectural rename + brownfield iteration model on Labs Plans
**Development Context:** Brownfield — existing Futurator-Admin codebase with established conventions
**Scope Note:** This tech spec defines pipeline v1 only. GitHub integration (branches/commits/PRs) is deferred to v2; Mycelium knowledge-graph integration is deferred to v3.

---

## Context

### Source Discussion

This tech spec was produced from a multi-agent Party Mode discussion on 2026-04-27 covering:

- The unmet need to enhance, fix, or refine **already-published plans** (the dino3-on-mobile motivating example).
- A predecessor design at `docs/concepts/published-feedback-loop-mvp.md` (2026-04-25) which scoped a *bug-fix-only* feedback loop with a Triage agent. This tech spec **supersedes that design** by generalizing to all post-publish work and by introducing the App/Plan rename.

### Available Documents

- **`docs/concepts/published-feedback-loop-mvp.md`** — predecessor; bug-fix-only loop with triage. Superseded.
- **`docs/concepts/github-integration.md`** — design doc for v2 GitHub integration; informs v1 boundaries.
- **`docs/concepts/mycelium-labs-architecture.md`** — knowledge-graph design; informs v3 boundaries.
- **`docs/tech-spec-party-module.md`** — exemplar for tech-spec format and brownfield conventions.
- **`docs/concepts/pipelinev1-deferrals.md`** — backlog from the v1 pipeline build; some items intersect (PM-prompt cache layout, etc.).
- **`CLAUDE.md`** — project conventions (one-table-per-concern DynamoDB, static export, Bearer JWT, no cookies, SST-managed deploy, dual-bucket S3).

### Project Stack

Inherits the existing Futurator-Admin stack — no new dependencies introduced in v1.

- **Frontend:** Next.js 16 App Router, static export (`output: 'export'`, `trailingSlash: true`), React 19, TypeScript 5 strict, Tailwind 4 + shadcn/ui, Zustand 5, TanStack Query 5 (5-min staleTime), Zod 3, lucide-react, date-fns 4, next-themes.
- **Backend:** Hono 4 on Lambda (single app at `functions/api/index.ts`), JWT validation via `jose` against Identity Broker JWKS, AWS SDK v3 for DynamoDB / S3.
- **Daemon:** Node.js 20 ESM (`/daemon`), polls DDB for PENDING jobs, spawns Claude CLI subprocesses on EC2.
- **Infra:** SST v4 (Pulumi), us-east-1, PAY_PER_REQUEST DynamoDB, Lambda Function URL with CORS configured at the URL level (not in Hono).
- **Testing:** Vitest 3 (jsdom), Playwright 1.59 (Chromium smoke), Testing Library 16.

### Existing Codebase Conventions

- DynamoDB: one table per concern (never single-table). Table names from SST-injected env vars.
- Repositories: pure functions per file at `functions/shared/repositories/<concern>-repository.ts`.
- Schemas: Zod at `functions/shared/schemas/<domain>-schema.ts`, always `safeParse`.
- Types: shared at `functions/shared/types/<domain>.ts`, type-only imports across boundaries.
- Hooks: per-domain at `src/hooks/use-<domain>.ts`, wrap TanStack Query + `apiClient`.
- Components: feature-per-folder at `src/components/<area>/<module>/`.
- Styles: semantic theme tokens (`success`, `warning`, `accent-blue`); no hard-coded hex.
- API auth: Bearer JWT only; no cookies. CORS at Function URL level.
- Daemon templates: `daemon/pipelines/templates/<name>.md.tpl`; parsed outputs at `daemon/pipelines/lib/<name>-parser.mjs`.

---

## The Change

### Problem Statement

Today the **Plan** is the top-level unit of work in Labs: one intent → 1..N epics → stories → waves. Plan owns its slug (URL segment, working-dir name), its lifecycle (`concept → developing → review → delivered`), and is treated as **terminal** once delivered. There is **no model for continuing work on a delivered Plan**: the operator cannot file a refinement, a new feature, an experiment, a bug fix, or any post-publish iteration without manually re-purposing the Plan or starting from scratch.

The motivating example: `dino3` shipped with all stories delivered, AC fully covered, deploy green. The operator then discovers it has no mobile support — a *refinement* (the original AC didn't scope mobile). The current pipeline has no entry point for this work.

A predecessor design (`published-feedback-loop-mvp.md`) addressed bug-fixes only via a Triage agent and a `delivered → fixing → delivered` cycle. That design conflates the problem: most post-publish work is *not* bugs — it's refinements, new features, or experiments — each with different routing and AC heritage. The MVP also kept Plans as the immortal unit, which forces ceremony around what is actually a normal continuation of work.

### Proposed Solution

Introduce a two-level hierarchy: **App** (immortal, owns the deployed product, the working tree, and the deploy history) and **Plan** (mutable iteration owned by an App). Each App has 1..N Plans ordered chronologically. Plans carry a `kind` (`initial` / `change` / `experiment`) and an `intent` (operator's free-text goal). The first Plan is `kind=initial`; everything after is a `change` or `experiment`.

A new **PM-augmentation** prompt mode classifies post-initial intents, proposes minimal epic/story breakdowns, and produces a **no-touch list** that constrains downstream dev agents to respect already-shipped behavior. The existing pipeline (wave runner, dev agents, QA, deploy) is **reused unchanged** for non-initial Plans — only the planning step is new.

The operator UX shifts from *"file a bug ticket"* to *"continue working on this App"*. The frontend gains an Apps grid (`/labs`), an App detail page with a Plan timeline (`/labs/[appId]`), and re-shells the existing Plan detail UI under `/labs/[appId]/plans/[planId]`.

Concurrency is enforced at two layers (API + daemon): one non-terminal Plan per App. v1 omits git branching, snapshot-based restore, and knowledge-graph augmentation — those land in v2/v3.

### Scope

**In Scope (Pipeline v1):**

1. New `futurator-apps` DynamoDB table + repository + Zod schemas.
2. `Plan` schema modifications: add `appId` FK, `kind`, `intent`, `iterationLabel`, `noTouchPaths`; remove `name` / `workingDir` / `deployJobIds[]` / `useEpicOrchestrator`; replace `fixing` and `archived` statuses with `abandoned`.
3. Seven new App-centric API endpoints under `/api/apps/*`; one server-side enrichment of `GET /api/apps` to return `AppCardData[]`.
4. Daemon dispatch guard: pre-dispatch checks for terminal Plan, dirty App working tree, and concurrency-violation defense-in-depth. New `ORPHANED` job status + atomic abandon transition (DynamoDB `transactWrite`).
5. New PM-augmentation prompt template (`pm-augmentation-prompt.md.tpl`) + parser (`pm-augmentation-parser.mjs`) + job-router wiring.
6. Frontend: rewrite `/labs` as Apps grid; new `/labs/[appId]` App detail with Plan timeline + dirty-tree banner + concurrency banner + deploys panel; rewrite `/labs/[appId]/plans/[planId]` as a re-shell of the existing pipeline UI with breadcrumb + status-driven actions bar.
7. Centralized link builder at `src/lib/links.ts` to absorb the URL migration.
8. Tests: Zod schema unit tests, repository unit tests, API integration tests, daemon dispatch-guard tests, parser tests, a single Playwright smoke for the App detail navigation.

**Out of Scope (deferred):**

- **Pipeline v2** — git branching, branch-per-Plan, fast-forward merge on `delivered`, agents committing/PR-ing.
- **Pipeline v3** — Mycelium knowledge graph as input to PM-augmentation.
- Snapshot-on-delivery for true "Discard changes" recovery (v1 ships *Mark resolved* flag-flip only).
- Multi-tenancy / per-user App ownership (single-tenant admin v1).
- Auto-promote `rigor` from `prototype` → `mvp` on first refinement (deferred to v1.x).
- "Amend an existing story" prompt mode for the dev agent (v1 always creates new stories).
- Backwards-compatibility redirects from `/labs?planId=X` (existing data is throwaway prototypes).
- Visitor / dogfooder feedback widget injected into deployed apps (v3+).
- Auto-accept of high-confidence PM-augmentation proposals (v2+).

---

## Implementation Details

### Source Tree Changes

**Backend (`functions/`):**

| File | Action | Purpose |
|---|---|---|
| `functions/shared/types/app.ts` | CREATE | `App` interface |
| `functions/shared/types/plan.ts` | MODIFY | Add `appId`, `kind`, `intent`, `iterationLabel`, `noTouchPaths`; remove old fields; new statuses |
| `functions/shared/schemas/app-schema.ts` | CREATE | Zod schemas: `appSchema`, `createAppInputSchema`, `updateAppInputSchema`; `slugRegex`; `RESERVED_APP_IDS` denylist |
| `functions/shared/schemas/plan-schema.ts` | MODIFY | New `planKindSchema`, `planStatusSchema`; `LEGAL_TRANSITIONS` table; updated `planSchema` and `createPlanInputSchema` |
| `functions/shared/repositories/app-repository.ts` | CREATE | `getApp`, `listApps`, `createApp`, `updateApp`, `appendDeployJobId`, `deleteApp` |
| `functions/shared/repositories/plan-repository.ts` | MODIFY | Add `listPlansByApp`, `getActivePlanForApp`, `transitionPlanStatus`; mutate `createPlan` to require `appId`; remove `name` from create surface |
| `functions/shared/services/plan-reducer.ts` | MODIFY | Drop `fixing`/`archived` paths; add `abandoned` handling |
| `functions/api/index.ts` | MODIFY | Append seven `/apps/*` routes under a `app.basePath('/apps')` group; add error codes; cascade delete in `DELETE /apps/:appId`; abandon-Plan transactWrite logic in transition handler |
| `functions/shared/repositories/__tests__/app-repository.test.ts` | CREATE | Unit tests for App repo |
| `functions/shared/schemas/__tests__/app-schema.test.ts` | CREATE | Slug regex, reserved-list, schema validation tests |
| `functions/shared/schemas/__tests__/plan-schema.test.ts` | MODIFY | Update for new fields; add transition-table tests |

**Daemon (`daemon/`):**

| File | Action | Purpose |
|---|---|---|
| `daemon/agent-daemon.mjs` | MODIFY | Add `canDispatchJob()` pre-dispatch guard with three checks (Plan terminal / App dirty-tree / concurrency); insert into existing dispatch loop |
| `daemon/pipelines/job-router.mjs` | MODIFY | Add `pm-augmentation` job kind handler |
| `daemon/pipelines/templates/pm-augmentation-prompt.md.tpl` | CREATE | New prompt template (see §"PM-Augmentation Prompt" below) |
| `daemon/pipelines/lib/pm-augmentation-parser.mjs` | CREATE | Parses `<PM_AUGMENTATION_RESULT>` block, validates against Zod schema, throws typed `ParseError` on three failure modes |
| `daemon/pipelines/lib/render-pm-augmentation-prompt.mjs` | CREATE | Templating helper: assembles prompt from Plan, App, prior Plans |
| `daemon/pipelines/__tests__/pm-augmentation-parser.test.mjs` | CREATE | Parser unit tests including each failure mode |
| `daemon/pipelines/__tests__/dispatch-guard.test.mjs` | CREATE | Guard unit tests covering three pre-dispatch checks |

**Frontend (`src/`):**

| File | Action | Purpose |
|---|---|---|
| `src/lib/links.ts` | CREATE | Centralized link builders: `links.apps()`, `links.app(id)`, `links.plan(appId, planId)` |
| `src/lib/api/apps-api.ts` | CREATE | Thin api-client wrappers for `/apps/*` endpoints |
| `src/lib/api/plans-api.ts` | MODIFY | Add `createPlanForApp`, transition helpers |
| `src/types/app.ts` | CREATE | Frontend `App` and `AppCardData` types (mirror backend) |
| `src/hooks/use-apps.ts` | CREATE | TanStack Query hook for Apps grid |
| `src/hooks/use-app.ts` | CREATE | App detail (with conditional 5s polling when active Plan in `developing`) |
| `src/hooks/use-create-app.ts` | CREATE | Mutation + cache invalidation |
| `src/hooks/use-update-app.ts` | CREATE | Mutation |
| `src/hooks/use-delete-app.ts` | CREATE | Mutation + navigation |
| `src/hooks/use-redeploy-app.ts` | CREATE | Mutation |
| `src/hooks/use-create-plan.ts` | CREATE | Mutation, navigates to new Plan on success |
| `src/hooks/use-plan.ts` | MODIFY | Existing hook; ensure compat with new shape (no API change) |
| `src/app/labs/page.tsx` | REWRITE | Apps grid (was Plans-list page) |
| `src/app/labs/[appId]/page.tsx` | CREATE | App detail page |
| `src/app/labs/[appId]/plans/[planId]/page.tsx` | CREATE | Plan detail re-shell |
| `src/components/labs/app-card.tsx` | CREATE | Apps grid card |
| `src/components/labs/app-status-pill.tsx` | CREATE | Four states: live / building / dirty-tree / no-deploy |
| `src/components/labs/apps-grid.tsx` | CREATE | Grid container |
| `src/components/labs/apps-grid-skeleton.tsx` | CREATE | Loading state |
| `src/components/labs/empty-apps-state.tsx` | CREATE | Empty-state UI |
| `src/components/labs/new-app-modal.tsx` | CREATE | Create-App modal (slug + displayName + icon + executionMode) |
| `src/components/labs/app-detail-header.tsx` | CREATE | Icon + name + URL + preview + settings/delete entry points |
| `src/components/labs/plan-timeline.tsx` | CREATE | Horizontal (desktop) / vertical (mobile) timeline of Plans |
| `src/components/labs/plan-timeline-node.tsx` | CREATE | Single Plan node with status glyph |
| `src/components/labs/new-plan-cta.tsx` | CREATE | Conditional + New Plan button with always-explanatory disabled tooltip |
| `src/components/labs/new-plan-modal.tsx` | CREATE | Single-textarea Plan creation modal |
| `src/components/labs/concurrency-banner.tsx` | CREATE | Informational banner (active Plan exists) |
| `src/components/labs/dirty-tree-banner.tsx` | CREATE | Amber banner with `Mark resolved` action |
| `src/components/labs/deploys-panel.tsx` | CREATE | Last 5 deploys with re-deploy action |
| `src/components/labs/app-settings-dialog.tsx` | CREATE | Editable displayName / icon / executionMode |
| `src/components/labs/delete-app-dialog.tsx` | CREATE | Typed-slug-to-confirm |
| `src/components/labs/plan-detail-shell.tsx` | CREATE | Breadcrumb + Plan header + Plan actions bar wrapping existing pipeline UI |
| `src/components/labs/plan-actions-bar.tsx` | CREATE | Status-driven action group |
| `src/components/labs/plan-breadcrumb.tsx` | CREATE | Apps › icon + App name › Plan # · iterationLabel |
| `[everywhere using /labs?planId=]` | MODIFY | Sweep + replace via `links.plan(appId, planId)` |
| `tests/e2e/app-navigation.spec.ts` | CREATE | Playwright smoke: Apps grid → App detail → Plan detail |

**Infrastructure (`sst.config.ts`):**

| Field | Action | Purpose |
|---|---|---|
| `Apps` Dynamo resource | CREATE | New table, PK=`appId`, no GSIs, PAY_PER_REQUEST, no PITR (regenerable) |
| `Plans` Dynamo resource | MODIFY | Add `appId-createdAt-index` GSI |
| API Lambda env | MODIFY | Inject `APPS_TABLE_NAME` |

---

## Data Model

### `App` (new — `futurator-apps` table)

```typescript
// functions/shared/types/app.ts
export interface App {
  appId: string;            // PK · kebab-case slug · locked at creation · URL segment
  displayName: string;      // mutable · human-readable
  workingDir: string;       // /home/ubuntu/projects/<appId>
  executionMode: 'pipeline' | 'orchestrator';   // default for new Plans
  currentlyDeployedPlanId: string | null;
  deployJobIds: string[];   // append-only history
  workingTreeStatus: 'clean' | 'dirty-from-abandoned-plan';
  icon?: string;            // emoji string, e.g., "🦖"; default "📦"
  createdAt: string;
  updatedAt: string;
}
```

**Validation rules (Zod):**

- `appId`: regex `/^[a-z0-9]+(-[a-z0-9]+)*$/`, length 1–40.
- Reserved slugs (rejected at create): `data`, `media`, `apps`, `knowledge-live`, `admin`, `api`.
- `workingDir`: must start with `/home/ubuntu/projects/`.
- `displayName`: 1–80 chars.
- `icon`: optional single emoji (no length validation in v1).

**SST table definition:**

```typescript
const appsTable = new sst.aws.Dynamo("Apps", {
  fields: { appId: "string" },
  primaryIndex: { hashKey: "appId" },
  // No GSIs needed in v1
});
```

### `Plan` (modified)

```typescript
// functions/shared/types/plan.ts
export interface Plan {
  planId: string;            // PK · ulid · unchanged
  appId: string;             // NEW · FK to App · GSI hash key
  kind: 'initial' | 'change' | 'experiment';   // NEW
  intent: string;            // NEW · operator's free-text · 10–2000 chars
  iterationLabel?: string;   // NEW · "v1.1 — mobile pass" · PM-suggested
  displayName: string;       // unchanged
  executionMode: 'pipeline' | 'orchestrator';
  rigor: 'prototype' | 'mvp' | 'production';
  epicIds: string[];
  status: 'concept' | 'developing' | 'review' | 'delivered' | 'abandoned';   // CHANGED
  noTouchPaths?: string[];   // NEW · PM-augmentation output
  createdAt: string;
  updatedAt: string;
}
```

**Removed (now on App):** `name`, `workingDir`, `deployJobIds[]`.
**Removed (legacy):** `useEpicOrchestrator`, `fixing` and `archived` statuses.

**Validation rules (Zod):**

- `intent`: 10–2000 chars (forces meaningful operator input).
- `iterationLabel`: optional, max 80 chars.
- `noTouchPaths`: optional array of strings (paths or globs).

**SST GSI addition:**

```typescript
const plansTable = new sst.aws.Dynamo("Plans", {
  fields: {
    planId: "string",
    appId: "string",
    createdAt: "string",
  },
  primaryIndex: { hashKey: "planId" },
  globalIndexes: {
    "appId-createdAt-index": { hashKey: "appId", rangeKey: "createdAt" },
  },
});
```

### Plan State Machine

```
  ┌────────────┐
  │  concept   │ ── PM augmentation runs · operator reviews proposed plan
  └─────┬──────┘
        │  approve
        ▼
  ┌────────────┐
  │ developing │ ── waves run (existing pipeline)
  └─────┬──────┘
        │  waves complete
        ▼
  ┌────────────┐
  │   review   │ ── operator signs off OR sends back
  └─────┬──────┘
        │  sign-off + deploy success
        ▼
  ┌────────────┐
  │ delivered  │ ── terminal · iterate via new Plan on the App
  └────────────┘

  Any non-terminal state can transition to `abandoned`.
  `abandoned` is terminal and sets App.workingTreeStatus = 'dirty-from-abandoned-plan'.
```

**Legal transitions table:**

```typescript
const LEGAL_TRANSITIONS: Record<Plan['status'], Plan['status'][]> = {
  concept:    ['developing', 'abandoned'],
  developing: ['review', 'abandoned'],
  review:     ['delivered', 'developing', 'abandoned'],
  delivered:  [],
  abandoned:  [],
};
```

### Concurrency Invariant

**One non-terminal Plan per App.** Enforced at three layers:

1. **API on `POST /api/apps/:appId/plans`** (Step 3): rejects with `409 plan_already_active` if `getActivePlanForApp(appId)` returns non-null.
2. **API on transition** (Step 3): rejects transitions back into non-terminal states from terminal ones.
3. **Daemon `canDispatchJob` guard** (Step 4): refuses dispatch if `getActivePlanForApp(plan.appId).planId !== job.planId` — defense in depth against direct DDB edits or transactional gaps.

**Initial-plan invariant.** Exactly one `kind: 'initial'` per App, and it must be the first Plan. Validated in `createPlan`.

---

## API Endpoints

All endpoints wrapped in existing `authRequired` middleware. CORS handled at Lambda Function URL level (do not add Hono middleware — per CLAUDE.md).

| Method | Path | Purpose |
|---|---|---|
| `GET`    | `/api/apps`                              | List Apps grid (returns enriched `AppCardData[]`) |
| `POST`   | `/api/apps`                              | Create App |
| `GET`    | `/api/apps/:appId`                       | App detail (`{ app, plans, activePlan, recentDeploys }`) |
| `PATCH`  | `/api/apps/:appId`                       | Update mutable App fields (displayName, icon, executionMode, workingTreeStatus) |
| `DELETE` | `/api/apps/:appId`                       | Hard delete + cascade Plans + Epics |
| `POST`   | `/api/apps/:appId/plans`                 | Create Plan (enforces concurrency + initial-uniqueness; enqueues PM-augmentation) |
| `POST`   | `/api/apps/:appId/redeploy`              | v1 rollback — re-sync prior bundle from S3 versioning |

**Existing `/api/plans/:planId/*` endpoints stay flat** — they handle reads, edits, and lifecycle transitions. The URL migration in Step 8 is a *frontend-only* concern; API routes are unchanged.

### Server-Side Enrichment (Step 6 amendment)

`GET /api/apps` returns `AppCardData[]`:

```typescript
type AppCardData = App & {
  planCount: number;
  currentlyLiveLabel: string | null;          // "v1.1 — mobile pass" or null
  derivedStatus: 'live' | 'building' | 'dirty-tree' | 'no-deploy';
};
```

Computed at the API layer with a single batch read of plans-by-app. Prevents N+1 fetching on the client.

### App-Detail Response Shape

```typescript
GET /api/apps/:appId →
{
  app: App,
  plans: Plan[],              // sorted by createdAt asc
  activePlan: Plan | null,    // first non-terminal in plans[]
  recentDeploys: DeployJob[], // last 5 from App.deployJobIds[]
}
```

### Error Taxonomy

All errors follow the existing `AppError` envelope with a `details` payload where helpful.

| Code | HTTP | When |
|---|---|---|
| `app_not_found` | 404 | App doesn't exist |
| `app_id_taken` | 409 | Slug collision on create |
| `app_id_reserved` | 400 | Slug in `RESERVED_APP_IDS` |
| `plan_already_active` | 409 | Concurrency rule hit; `details.activePlanId`, `details.activePlanStatus` |
| `initial_plan_already_exists` | 409 | Trying to create a 2nd `kind: 'initial'` |
| `first_plan_must_be_initial` | 409 | Non-`initial` kind on empty App |
| `deploy_job_not_in_app_history` | 400 | Re-deploy targeting unrelated bundle |
| `illegal_plan_transition` | 409 | Transition not in `LEGAL_TRANSITIONS[from]` |

### Atomic Abandon Transition

When a Plan transitions to `abandoned`, the API performs a DynamoDB `transactWrite` that updates Plan + App + all that Plan's PENDING jobs atomically:

```typescript
async function abandonPlan(planId: string): Promise<void> {
  const plan = await getPlan(planId);
  const pendingJobs = await listPendingJobsForPlan(planId);

  await ddb.transactWrite([
    updatePlan(planId, { status: 'abandoned' }),
    updateApp(plan.appId, { workingTreeStatus: 'dirty-from-abandoned-plan' }),
    ...pendingJobs.map(j =>
      updateJob(j.jobId, { status: 'ORPHANED', orphanReason: 'plan_abandoned' })
    ),
  ]);
}
```

Cap: 100 items per `transactWrite`; comfortably above realistic Plan job counts.

---

## Daemon Changes

### Job Status Extension

```typescript
type JobStatus =
  | 'PENDING' | 'RUNNING'
  | 'COMPLETED' | 'FAILED'
  | 'ORPHANED'                  // NEW · Plan went terminal before dispatch
  | 'COMPLETED_VIA_SALVAGE';    // existing
```

`ORPHANED` is rendered distinctly in the admin UI (collapsed footer "N jobs cancelled"); `FAILED` continues to surface as attention items.

### Pre-Dispatch Guard

In `daemon/agent-daemon.mjs`, insert a `canDispatchJob(job)` function before subprocess spawn. Three checks:

```javascript
async function canDispatchJob(job) {
  // 1. Plan must exist and be non-terminal
  const plan = await getPlan(job.planId);
  if (!plan) {
    await markJobFailed(job.jobId, 'plan_not_found');
    return { ok: false, reason: 'plan_not_found' };
  }
  if (plan.status === 'delivered' || plan.status === 'abandoned') {
    await markJobOrphaned(job.jobId, `plan_${plan.status}`);
    return { ok: false, reason: `plan_${plan.status}` };
  }

  // 2. App must exist and have a clean working tree
  const app = await getApp(plan.appId);
  if (!app) {
    await markJobFailed(job.jobId, 'app_not_found');
    return { ok: false, reason: 'app_not_found' };
  }
  if (app.workingTreeStatus === 'dirty-from-abandoned-plan') {
    return { ok: false, reason: 'app_working_tree_dirty', hold: true };
  }

  // 3. Defense-in-depth: this Plan must be the App's active Plan
  const active = await getActivePlanForApp(plan.appId);
  if (!active || active.planId !== plan.planId) {
    log.error(`integrity_violation: job ${job.jobId} for plan ${plan.planId} but active plan for app ${plan.appId} is ${active?.planId ?? 'none'}`);
    await markJobFailed(job.jobId, 'concurrency_violation');
    return { ok: false, reason: 'concurrency_violation' };
  }

  return { ok: true };
}
```

When `hold: true` is returned, the job stays PENDING and is retried next poll cycle. The job row gains a transient `holdReason` column the admin UI surfaces (so held jobs are not silently invisible).

### Running-Job Behavior on Abandon

v1 design: **let running subprocesses finish.** The atomic abandon transition marks PENDING jobs `ORPHANED` but does not kill RUNNING subprocesses. Their output is discarded on completion (Plan is terminal, no apply step runs). Rationale: SIGTERM mid-edit produces a *worse* dirty state than letting the edit complete. v2 with branches changes this trade-off.

### Operability

A CloudWatch metric `OrphanedJobsPerHour` per App is emitted from the daemon. Nonzero values for stable Apps indicate an abandonment-flow integrity bug and should alert.

---

## PM-Augmentation Prompt

### Scope

Runs **only** for `kind ∈ {change, experiment}` Plans. Greenfield (`kind=initial`) Plans use the existing PM prompt unchanged.

### Tool Grant

`Read, Grep, Glob, Bash`. **No** `Edit` or `Write` — the agent is read-only. Constraint enforced both at the daemon level (tools array) and explicitly in the prompt body (belt-and-suspenders).

### Inputs (templated)

- `intent` — operator's free-text (10–2000 chars).
- `app` — `{ appId, displayName, workingDir, priorDeploys }`.
- `priorPlans` — chronological list of all prior Plans for the App, each with `kind`, `iterationLabel`, `status`, `intent`, and full epic/story breakdown including AC.
- Working tree access via tools (read-only).

### Output Contract

A single tagged YAML block:

```yaml
---PM_AUGMENTATION_RESULT---
kind: change                              # change | experiment | CLARIFICATION_NEEDED
kind_confidence: 0.9
iteration_label: "v1.1 — mobile pass"

intent_restated: |
  ...

reasoning: |
  ...

no_touch_paths:
  - "src/game/physics.ts"
  - "src/game/sprites/**"

epics:
  - id: e1
    title: "Mobile responsiveness pass"
    description: |
      ...
    stories:
      - id: e1s1
        title: "Replace keyboard input with touch handlers"
        description: |
          ...
        acceptance_criteria:
          - "Tap on left half of viewport triggers move-left action"
          - ...
        depends_on: []

epic_dependencies: []                     # optional, only if multi-epic

notes_for_dev: |
  ...

clarification_needed:                     # only present if kind == CLARIFICATION_NEEDED
  question: ""
---END_PM_AUGMENTATION_RESULT---
```

### AC Quality Rules (encoded in the prompt)

1. **Every AC must be verifiable in code** — browser test, unit test, or visual test.
2. **AC voice must match prior plans' AC voice** — agent reads 2-3 sample ACs first.
3. **Story sizing**: 3–5 AC bullets target; 6+ forces a split with `depends_on`.

### Escape Hatch

`kind: CLARIFICATION_NEEDED` — the agent does not produce a plan when intent is genuinely ambiguous. Plan stays in `concept`, an attention item is raised, operator either edits the proposal manually or rejects.

### Apply Step (post-parse)

Atomic DynamoDB `transactWrite`:

1. Update Plan with `kind`, `iterationLabel`, `noTouchPaths`.
2. Create one Epic record per `epics[]` entry (linked via `planId` FK, ordered by `orderIndex`).
3. Plan **stays in `concept`** — operator must approve (`concept → developing`) via the Plan detail page actions bar.

### Failure Modes

| Failure | Cause | Recovery |
|---|---|---|
| `pm_augmentation_result_block_missing` | Agent forgot wrapper tags | Retry with reminder |
| `pm_augmentation_yaml_invalid` | YAML syntax error | Retry with parse error in reminder |
| `pm_augmentation_schema_invalid` | Zod validation failed | Retry with specific issues |

After 2 retries → escalate via existing self-correction salvage path (`pipelinev1-self-corrections-escalation.md`).

---

## Frontend

### URL Structure

```
/labs                              Apps grid (was: Plans list)
/labs/[appId]                      App detail
/labs/[appId]/plans/[planId]       Plan detail (re-shells existing pipeline UI)
```

Old `/labs?planId=X` query-param routing is **removed**. No backwards-compat redirect (existing data is throwaway).

### Centralized Link Builder

```typescript
// src/lib/links.ts
export const links = {
  apps: () => '/labs',
  app: (appId: string) => `/labs/${appId}`,
  plan: (appId: string, planId: string) => `/labs/${appId}/plans/${planId}`,
};
```

All `Link` and `router.push` references in `/src/components/labs/**` and `/src/app/labs/**` use these helpers — one place to change for the v2 GitHub URL evolution.

### Apps Grid (`/labs`)

- 1/3/4 column responsive grid (mobile/tablet/desktop).
- Card surfaces (max five facts): icon, displayName, slug, status pill + label, plan count.
- Status states: `live` (green dot) / `building` (pulsing accent) / `dirty-tree` (amber ⚠) / `no-deploy` (gray).
- Empty state: centered "No Apps yet" + single CTA.
- New App modal: slug (regex-validated, live availability check), displayName, icon (emoji picker), executionMode radio.
- Two-step creation: create App → land on App detail (empty timeline) → "Start your first Plan" separately.

### App Detail (`/labs/[appId]`)

Five regions, vertical reading order:

1. **Header** — icon, displayName, slug, live URL with `↗`, preview, gear (settings), `⋯` (delete).
2. **Banner row** — at most one banner; priority dirty-tree (amber) > concurrency (info blue).
   - **Dirty-tree banner** copy framing: *"Plan #N didn't ship. Some files may still be in mid-edit state. [Mark resolved] when you're ready to start the next iteration."* Two actions: `Mark resolved` (flag flip), `View affected files` (drawer).
   - **Concurrency banner** is informational, not blocking — links to active Plan.
3. **Plan timeline** — horizontal desktop, vertical mobile. Node states: filled / pulsing / X-marked / empty ring.
4. **`+ New Plan` node** — conditional. Disabled when active Plan exists OR tree dirty; tooltip explains why. First-Plan label reads "Start your first Plan".
5. **Deploys panel** — last 5 deploys, currently-live badge, re-deploy confirm.

`useApp(appId)` polls every 5s while `activePlan.status === 'developing'`; otherwise relies on 5-min staleTime.

### Plan Detail Re-Shell (`/labs/[appId]/plans/[planId]`)

The existing pipeline UI mounts inside a new shell:

- **Breadcrumb:** `Apps  ›  🦖 dino3  ›  Plan #2 · v1.1 — mobile pass`
- **Plan header** — current status + iterationLabel + intent excerpt.
- **Plan actions bar** — status-driven:
  - `concept` → `Approve & Start Building` · `Edit Proposal` · `Abandon`
  - `developing` → status indicator with wave progress · `Abandon`
  - `review` → `Sign Off & Deploy` · `Send back to dev` · `Abandon`
  - `delivered` → muted "Delivered" badge + link to App page
  - `abandoned` → muted "Abandoned" badge + link back to App
- **URL/data integrity guard** — if URL `appId` doesn't match `plan.appId`, auto-redirect to canonical URL (3 lines of code; prevents an entire class of bookmark drift).

Action buttons are spatially separated: primary action left, danger action right with `ml-auto`. Eye should never accidentally land on Abandon when targeting Approve.

### Motion Budget

Compositor-only properties (transform, opacity). All durations 150–250ms. `prefers-reduced-motion` collapses pulses to solid + skips translates.

| Element | Motion |
|---|---|
| Card hover | `translateY(-2px)` + shadow elevation, 150ms ease-out |
| `building` pill dot | opacity 1 → 0.4 → 1, 1.5s ease-in-out infinite |
| `dirty-tree` pill | static (warnings should not pulse) |
| Modal open | 200ms slide-down + fade-in |
| Card grid first paint | 30ms stagger, max 5 cards |
| New card after creation | 250ms scale 0.95 → 1 + fade |

---

## Testing

### Unit (Vitest)

| Target | File |
|---|---|
| App schema (regex, reserved, validation) | `functions/shared/schemas/__tests__/app-schema.test.ts` |
| Plan schema (kind, status, transitions) | `functions/shared/schemas/__tests__/plan-schema.test.ts` |
| App repository (CRUD, hard delete) | `functions/shared/repositories/__tests__/app-repository.test.ts` |
| Plan repository (`listPlansByApp`, `getActivePlanForApp`) | extend existing test file |
| PM-augmentation parser (3 failure modes + happy path) | `daemon/pipelines/__tests__/pm-augmentation-parser.test.mjs` |
| Daemon dispatch guard (3 pre-dispatch checks) | `daemon/pipelines/__tests__/dispatch-guard.test.mjs` |

### Integration (Vitest)

| Target | Coverage |
|---|---|
| `POST /apps` happy path + validation errors | New |
| `POST /apps/:appId/plans` concurrency rejection | New |
| `POST /apps/:appId/plans` initial-uniqueness rejection | New |
| Atomic abandon transition (Plan + App + jobs) | New |
| `GET /apps` enrichment correctness | New |

### E2E (Playwright)

One smoke at `tests/e2e/app-navigation.spec.ts`:

1. Navigate to `/labs`, verify Apps grid renders.
2. Click an App card → land on `/labs/[appId]`.
3. Verify Plan timeline renders.
4. Click a Plan node → land on `/labs/[appId]/plans/[planId]`.
5. Verify breadcrumb is correct.
6. Verify back-navigation to App detail.

Auth pre-seeded in sessionStorage; API routes mocked via `page.route()` per existing pattern.

---

## Risks & Open Questions

### Risks

| Risk | Mitigation |
|---|---|
| PM-augmentation produces low-quality plans without Mycelium | Force the prompt to read prior AC samples; AC-voice match rule; `clarification_needed` escape hatch |
| Working tree dirty state accumulates silently | Banner is unmissable; daemon holds *all* App jobs until resolved |
| Two RUNNING subprocesses corrupt working tree on abandon | v1 lets them finish (no SIGTERM); v2 with branches solves cleanly |
| Mass URL-string sweep misses references | Centralized `links.ts` + grep audit + Playwright smoke |
| `transactWrite` fails partially on abandon | DDB guarantees all-or-nothing; surface 500 with retry path on API |
| `appId` slug collides with S3 reserved paths | `RESERVED_APP_IDS` denylist enforced at create |

### Deferred Decisions

- **Auto-promote `rigor`** from `prototype` → `mvp` on first refinement. Out of v1.
- **Snapshot-on-delivery** for true "Discard changes" recovery. v1 ships flag-flip only.
- **`experiment` rollback automation.** v1 stores the label only; behavior identical to `change`.
- **Story-amendment dev-prompt mode.** v1 always creates new stories; existing stories are read-only history.
- **Multi-fix queueing** when multiple iterations are filed quickly. v1 hard-blocks on concurrency.

### Migration

User confirmed existing Plans in `futurator-plans` are **throwaway prototypes** (the 2026-04-21 wipe still holds modulo any test data). The migration path is:

1. **Drop existing DDB rows** in `futurator-plans` (manual `aws dynamodb scan` + delete, or a one-time script).
2. **Drop existing project folders** under `/home/ubuntu/projects/` if any are stale.
3. **Deploy** the new schema via `sst deploy`.
4. **Start fresh** — create the first App via the new UI.

No data preservation, no backfill, no compat layer.

---

## Acceptance Criteria

The feature is "done" when all of the following hold:

1. **Schema:** `futurator-apps` table provisioned via SST; `Plan` schema migrated; new GSI on Plans table.
2. **API:** all seven new `/apps/*` endpoints respond per the contract; concurrency invariant enforced; atomic abandon works.
3. **Daemon:** `canDispatchJob` guard runs before every dispatch; `ORPHANED` status surfaces in UI; metric `OrphanedJobsPerHour` emits to CloudWatch.
4. **PM-augmentation:** new prompt template runs on `POST /apps/:appId/plans` for non-initial Plans; parser handles all three failure modes; clarification escape hatch reachable.
5. **Frontend:** `/labs` renders Apps grid; `/labs/[appId]` renders App detail with all five regions; `/labs/[appId]/plans/[planId]` renders existing pipeline UI inside the new shell with breadcrumb.
6. **Concurrency UX:** "+ New Plan" button is conditionally disabled with explanatory tooltip; dirty-tree banner appears with correct copy framing.
7. **Tests:** all listed unit + integration tests pass; one Playwright smoke navigates the App → Plan flow end-to-end.
8. **Lint/Type:** `npm run ci` passes (lint + format + knip + typecheck + test + build).
9. **Manual smoke:** create an App, kick a `kind=initial` Plan, ship it through `concept → developing → review → delivered`, then create a `kind=change` Plan, watch PM-augmentation propose epics, approve, ship to delivered. Verify deploy bundle reaches `s3://futurator-ai-website/apps/<appId>/`.
10. **Docs:** this tech spec finalized; predecessor `published-feedback-loop-mvp.md` marked Superseded with a pointer here.

---

## Implementation Sequence

A suggested ordering for implementation, optimized for testable increments:

1. **Schema + repos** (Steps 1, 2) — all backend types, schemas, repositories. Unit tests pass.
2. **API endpoints** (Step 3) — routes + integration tests. Frontend can mock against this.
3. **Daemon guard** (Step 4) — pre-dispatch checks + `ORPHANED` status + atomic abandon.
4. **PM-augmentation prompt** (Step 5) — template + parser + apply step. Test against a fixture App.
5. **Apps grid** (Step 6) — new `/labs` page; existing Plan detail still works at old URL.
6. **App detail** (Step 7) — `/labs/[appId]` page with timeline, banners, deploys.
7. **Plan detail re-shell + URL migration** (Step 8) — `/labs/[appId]/plans/[planId]`, link sweep, delete old `?planId=` logic.

Each numbered phase is a coherent PR with green tests; the feature is incrementally testable without leaving the codebase in a broken state.

---

## Open for Review

Push back on any of the following before implementation begins:

- **Three kinds (`initial` / `change` / `experiment`)** vs Rick's two-kind suggestion (`initial` / `change`). v1 ships three, but `experiment` is metadata-only — first behavior divergence comes in v2.
- **Server-side enrichment** of `GET /apps` (`AppCardData` shape) — adds ~50 LOC of server code; saves N+1 client fetches.
- **5s polling interval** for `useApp` while developing — could go to 3s (noisier) or 10s (slower wave-progress feedback).
- **Hard delete vs soft delete** of Apps. v1 hard; reversibility deferred.
- **No backwards-compat redirect** from old `/labs?planId=X`. Confirmed acceptable per "throwaway prototypes."

After review, ready for story breakdown and implementation.
