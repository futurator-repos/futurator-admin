# Story 17.5: Plans list view + New Plan form

**Status:** Backlog

---

## User Story

As **Richie (operator)**,
I want **the Labs home to be a searchable list of my plans with a prominent "+ New Plan" button**,
So that **creating, finding, and opening prototypes is one-click and the New Plan affordance isn't hidden at the bottom of a dropdown**.

---

## Acceptance Criteria

**AC #1** — Route `/labs` renders `<PlansList>`. No `ProjectPicker` dropdown. No `activeAppName` store dependency.

**AC #2** — `<PlansList>` component:
- Page header: `Labs` title + `[+ New Plan]` button top-right (primary color).
- Filter chips row: `All (default) · Concept · Developing · Review · Delivered` — multi-select.
- Rows sorted by `updatedAt DESC`. Each row:
  - Status dot (color by status) + plan name (large, bold).
  - Intent snippet (truncated to 80 chars, italics).
  - Right side: progress summary (`E1 done · E2 wave 1/2`), cost, last-updated relative time.
  - Overflow menu `⋮`: **Open · Duplicate · Archive · Delete**.
- Collapsed `🗑 Archived (N) ▸` section at bottom — expanding reveals archived plans with `[Restore]` + `[Delete Forever]` buttons inline.
- Empty state (0 non-archived plans): renders `<NewPlanForm>` directly as the main content (no wrapper card).

**AC #3** — `<NewPlanForm>`:
- Inline label: "What are you building?"
- Plan name input (kebab-case validated, inline "already taken" check via debounced `GET /api/plans?nameCheck=<name>` — a small new endpoint returning 200 + `{ available: boolean }`).
- Intent textarea (10 rows, auto-growing).
- Advanced collapsible (default collapsed):
  - Execution mode (Pipeline default / Orchestrator)
  - Dev model dropdown (Sonnet default, Opus, Haiku)
  - Dev effort dropdown (Low / Medium / High)
  - Reviewer model + effort
  - YOLO toggle
- Submit: `POST /api/plans/from-intent` → redirects to `/labs/plans/<planId>` on success (plan created in `concept` status with PM agent job queued).

**AC #4** — Auto-suggest plan name: when user types 50+ chars of intent, a small API call `POST /api/plans/suggest-name` (new endpoint using a fast Haiku prompt) returns a proposed kebab-name. Shown as greyed-out placeholder; clicking fills the input. If user typed their own name, the suggestion is suppressed.

**AC #5** — `src/hooks/use-plans.ts`:
- `usePlansList()` — queryKey `['plans']`, fetches `GET /api/plans`.
- `usePlan(planId)` — queryKey `['plans', planId]`, fetches `GET /api/plans/:id`.
- `useCreatePlan()` — mutation `POST /api/plans/from-intent`, invalidates `['plans']`.
- `useArchivePlan()`, `useRestorePlan()`, `useDeletePlan()` — hooked up in 17.7.
- `useStartPlanDevelopment(planId)` — mutation `POST /api/plans/:id/start`, invalidates `['plans', planId]` + `['plans']`.

**AC #6** — Duplicate action: opens New Plan form pre-filled with source plan's intent + `<name>-copy` suffix.

**AC #7** — `Cmd+K` palette component `<PlanCmdK>`: fuzzy-search plans by name, enter = open, `+ New Plan` sticky at top.

**AC #8** — Component tests (Vitest + Testing Library):
- Empty state renders NewPlanForm inline.
- Plans list renders rows with correct status badges.
- Filter chips hide/show matching rows.
- Name validation blocks invalid + collision names.
- Cmd+K opens + fuzzy-filters.

**AC #9** — `npm run ci` passes.

---

## Implementation Details

### Tasks / Subtasks

- [ ] Create `src/hooks/use-plans.ts`.
- [ ] Create `src/components/labs/plans/plans-list.tsx` + `plan-row.tsx` + `new-plan-form.tsx` + `plan-cmdk.tsx`.
- [ ] Replace content of `src/app/labs/page.tsx` to render `<PlansList>`.
- [ ] Update `src/stores/labs-store.ts` — remove `activeAppName`, add `activePlanId` (set via route).
- [ ] Wire `POST /api/plans/suggest-name` in `functions/api/index.ts` (small Haiku prompt for kebab-name suggestion; or simple regex from description for V1).
- [ ] Component tests.
- [ ] Manual smoke on `admin.futurator.ai` post-deploy.
- [ ] `npm run ci` passes.

### Key Code References

- `src/components/labs/project-picker.tsx` — today's dropdown; reference for styling but replaced.
- `src/components/labs/agentic-workflow/epic-generator.tsx` — existing intent-capture logic (will be retired in 17.8).
- `src/hooks/use-epic-workflow.ts` — shape reference for `use-plans.ts`.

---

## Context References

**Epic:** [../epics-plan-based-labs.md](../epics-plan-based-labs.md).
**Depends on:** 17.1, 17.3 (GET /plans + POST /plans/from-intent).

---

## Dev Agent Record

<!-- -->
