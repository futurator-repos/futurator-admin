# Story 17.6: Plan detail page

**Status:** Backlog

---

## User Story

As **Richie (operator)**,
I want **a Plan detail page where I can edit the intent, edit the epic tree, start development, watch progress, and manage deployment — all in one coherent surface**,
So that **everything I do with a plan lives in one place instead of being scattered across today's generator, workflow view, and deploy panel**.

---

## Acceptance Criteria

**AC #1** — Route `/labs/plans/:planId` renders `<PlanDetail>` with three tabs: **Plan · Workflow · Deploy**.

**AC #2** — Page header: breadcrumb `Labs / Plans / <name>` + status badge + overflow `⋮` menu (Edit Intent · Duplicate · Archive · Delete).

**AC #3** — **Plan tab (Concept state)** — `<PlanTab>` + `<EpicTreeEditor>`:
- Intent section: single textarea (controlled), auto-save debounced 500ms via `PATCH /api/plans/:id`. `[↻ Regenerate Plan]` button runs `PATCH /api/plans/:id/regenerate` (confirms "This will overwrite current epic tree" if epics exist).
- Epic tree editor: Each epic is a collapsible row with:
  - Title (inline-editable).
  - Goal (inline-editable, 2-line textarea).
  - Dependencies multi-select showing other epics (options filtered to exclude self + circular refs client-side).
  - Story list: each story is a row with title (editable), "dependsOn" multi-select of other stories in this epic, and an expand toggle to edit description + ACs.
  - `[+ Add Story]` at the bottom of each epic.
- `[+ Add Epic]` at the bottom of the tree.
- Reorder via drag handles (use `@dnd-kit/core`, already in repo).
- Auto-save on any edit via `PATCH /api/plans/:id` (server syncs `plan.md`).
- Footer: `[Start Plan Development →]` button — enabled only when `status === 'concept'` AND tree has ≥ 1 epic with ≥ 1 story. Clicking calls `POST /api/plans/:id/start` (from 17.4). Navigates back to same page which now renders the Developing variant.

**AC #4** — **Plan tab (Developing / Review / Delivered)** — same tree but **read-only**, with live-state indicators:
- Each epic shows its plan-wave position + progress bar (`wave 0/2`, `3/5 stories done`).
- Each story shows a status dot (pending/running/done/failed), elapsed time if running, cost if done.
- Clicking a running story opens a bottom drawer with `<StoryLiveOutput>` (existing component from Epic 16). If failed, shows `[Retry]` button calling `POST /api/epic-workflows/:epicId/stories/:storyId/run` (Story 16.3).
- Plan-build-check status (if any) shown as a banner above the footer: "Integration check: running / passed / failed".

**AC #5** — **Workflow tab** — `<PlanWorkflowTab>`:
- Flat table of all stories across all epics, sortable by: status, wave (epic-wave.story-wave), cost, duration.
- Columns: status, epic, wave, title, jobId, cost, duration, `[Actions ▾]` menu (Retry / View Logs / Go to Story in Plan Tree).
- Useful for triaging a failing plan — "which story is blocking us?".

**AC #6** — **Deploy tab** — `<PlanDeployTab>`:
- Dev Server section: `[Start Dev Server]` calls `POST /api/epic-workflows/:epicId/dev-server` (Story 16.3) against the last epic (or first — pick the stable one). Shows the extracted public URL once ready.
- Visual QA section: `[Run Visual QA]` button calling `POST /api/epic-workflows/:epicId/visual-qa` against the final epic. Shows latest QA summary (PASS/FAIL + test counts).
- Publish section: `[Publish]` button deploys to `s3://futurator-ai-website/apps/<name>/` + CloudFront invalidation; shows the resulting public URL.
- Deployed URL displayed prominently when delivered.

**AC #7** — Top-right overflow menu `⋮`:
- `Edit Intent` scrolls to the intent section.
- `Duplicate` opens New Plan form pre-filled.
- `Archive` opens archive confirmation (Story 17.7).
- `Delete` opens delete confirmation modal (Story 17.7).

**AC #8** — Component tests:
- Tree editor: add/remove epic propagates to `PATCH` mock.
- DependsOn multi-select excludes self + cycles.
- Start-Plan button enablement.
- Tab switching preserves local state (intent draft).
- Read-only mode in Developing state (no inline-edit affordances shown).

**AC #9** — `npm run ci` passes.

---

## Implementation Details

### Tasks / Subtasks

- [ ] Create `src/app/labs/plans/[planId]/page.tsx`.
- [ ] Create `<PlanDetail>` + the three tab components + `<EpicTreeEditor>`.
- [ ] Generalize `<StoryLiveOutput>` (currently tied to the old workflow view) to accept any `jobId` directly.
- [ ] Wire `PATCH /api/plans/:id` auto-save with debounce.
- [ ] Wire `[Start Plan Development]` button.
- [ ] Wire drag-drop reorder via `@dnd-kit/core`.
- [ ] Component tests.
- [ ] Manual smoke against a real 3-epic plan post-deploy.
- [ ] `npm run ci` passes.

### Key Code References

- `src/components/labs/agentic-workflow/story-live-output.tsx` — reuse (generalize).
- `src/components/labs/agentic-workflow/index.tsx` — Workflow view — migrate into `<PlanWorkflowTab>`.
- `src/components/labs/agentic-workflow/epic-info-panel.tsx` — useful bits (deploy-url display) — migrate into `<PlanDeployTab>`.

---

## Context References

**Epic:** [../epics-plan-based-labs.md](../epics-plan-based-labs.md).
**Depends on:** 17.4 (plan-start endpoint), 17.5 (plans list navigates here).

---

## Dev Agent Record

<!-- -->
