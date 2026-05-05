# Story 17.1: Plan data model + repository + CRUD API

**Status:** Backlog

---

## User Story

As **Richie (operator)**,
I want **Plan as a first-class DDB object with basic CRUD endpoints**,
So that **Plans can be listed, fetched, updated, and deleted via the API — the foundation the UI will build on**.

---

## Acceptance Criteria

**AC #1** — New DDB table `futurator-plans` (partition key `planId`, PAY_PER_REQUEST, PITR enabled). Schema + table creation wired into `sst.config.ts`. `TABLE_NAMES.plans` exported from `functions/shared/dynamo-client.ts`.

**AC #2** — `functions/shared/types/plan.ts` defines:

```ts
export type PlanStatus = 'concept' | 'developing' | 'review' | 'delivered' | 'archived';
export type PlanExecutionMode = 'pipeline' | 'orchestrator';

export interface Plan {
  planId: string;
  name: string;                  // kebab-case, locked after creation
  intent: string;                // raw user input
  description: string;           // PM-agent summary
  status: PlanStatus;
  epicIds: string[];             // 1..N epics under this plan
  workingDir: string;            // /home/ubuntu/projects/<name>
  deployUrl?: string;            // set on deliver
  devModel?: string;
  devEffort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  yoloMode?: boolean;
  executionMode: PlanExecutionMode;
  totalCostUsd: number;
  totalStories: number;
  doneStories: number;
  preArchiveStatus?: PlanStatus;
  archivedAt?: string;
  archivePath?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}
```

**AC #3** — `functions/shared/repositories/plan-repository.ts` exports `createPlan`, `getAllPlans`, `getPlanById`, `getPlanByName`, `updatePlanFields`, `deletePlan` (pattern matches `epic-workflow-repository.ts`).

**AC #4** — Zod schema `planCreateSchema` in `functions/shared/schemas/plan-schema.ts` validates:
- `name: string.regex(/^[a-z][a-z0-9-]{2,40}$/)` — kebab-case, 3-41 chars, starts with letter.
- Uniqueness check: `createPlan` rejects (409) if another non-archived plan has the same `name` (repo-level scan on create).

**AC #5** — Hono endpoints in `functions/api/index.ts`:
- `POST /api/plans` — create; 201 `{plan}`; 409 on name collision.
- `GET /api/plans` — list summaries `{planId, name, status, totalStories, doneStories, totalCostUsd, createdAt, updatedAt, archivedAt?}`.
- `GET /api/plans/:id` — full plan with `epics` array populated from `epic-workflow-repository`.
- `PATCH /api/plans/:id` — partial update (intent, description, settings).
- `DELETE /api/plans/:id` — stub returning 501 `Not Implemented — see Story 17.7`. Real cascade added in 17.7.

**AC #6** — `functions/shared/types/epic-workflow.ts` gains `planId: string` (required for new epics) and `dependsOnEpics?: string[]` (default empty).

**AC #7** — Unit tests in `functions/shared/repositories/__tests__/plan-repository.test.ts`:
- Create + get round-trip.
- Name validation: valid `my-cool-plan`, invalid `MY-Plan`, `1-starts-with-digit`, `too-short`, `way-too-long-pla-exceeding-forty-one-characters-oops`.
- Duplicate name on create → 409.
- `getPlanByName` finds non-archived plan with that name, skips archived.

**AC #8** — `npm run ci` passes.

---

## Implementation Details

### Tasks / Subtasks

- [ ] Add `PlansTable` resource in `sst.config.ts` (mirror existing AgentJobsTable pattern with PITR).
- [ ] Export `TABLE_NAMES.plans` in `functions/shared/dynamo-client.ts`.
- [ ] Create `functions/shared/types/plan.ts`.
- [ ] Create `functions/shared/schemas/plan-schema.ts` with `planCreateSchema` + `planPatchSchema`.
- [ ] Create `functions/shared/repositories/plan-repository.ts` with CRUD + `getPlanByName`.
- [ ] Add `planId` + `dependsOnEpics?` to `EpicWorkflow` type.
- [ ] Wire 5 Hono endpoints in `functions/api/index.ts`.
- [ ] Write unit tests in `__tests__/plan-repository.test.ts`.
- [ ] `npx tsc --noEmit` + `npx vitest run functions/` + `npx eslint functions/` + `npm run build` — clean.

### Key Code References

- `functions/shared/repositories/epic-workflow-repository.ts` — pattern to mirror.
- `functions/shared/types/epic-workflow.ts` — Epic type gets extended.
- `functions/shared/dynamo-client.ts` — `TABLE_NAMES` map.
- `sst.config.ts:115 EpicWorkflowsTable` — reference pattern for PlansTable.

---

## Context References

**Epic:** [../epics-plan-based-labs.md](../epics-plan-based-labs.md) — Epic 17 scope + full story map.

---

## Dev Agent Record

<!-- Populated during dev-story execution -->

### Agent Model Used

<!-- -->

### Debug Log References

<!-- -->

### Completion Notes

<!-- -->

### Files Modified

<!-- -->

### Test Results

<!-- -->
