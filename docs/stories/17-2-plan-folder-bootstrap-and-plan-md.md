# Story 17.2: Plan folder bootstrap + plan.md read/write

**Status:** Backlog

---

## User Story

As **Richie (operator)**,
I want **the project folder and `plan.md` to materialize on EC2 when a Plan is created, and stay in sync with DDB edits**,
So that **the Plan has a persistent disk presence from Concept state onward, survives browser refresh, and is recoverable from the filesystem alone if DDB is ever lost**.

---

## Acceptance Criteria

**AC #1** — `functions/shared/services/plan-folder-service.ts` exports:
- `bootstrapPlanFolder(plan, deps): Promise<void>` — SSM-executes `mkdir -p /home/ubuntu/projects/<name> && <writes plan.md>`. Path validated against the same regex as `DELETE /ec2/files` to prevent escape.
- `writePlanMarkdown(plan, deps): Promise<void>` — re-serializes the plan and writes the file (overwrites).
- `readPlanMarkdown(planName, deps): Promise<Plan>` — reads the file via SSM, parses back to Plan.
- `movePlanFolderToTrash(plan, timestamp, deps): Promise<string>` — renames folder into `.trash/plans/<name>-<iso>/`, returns new path.
- `restorePlanFolder(plan, deps): Promise<void>` — moves from `archivePath` back to `/home/ubuntu/projects/<name>`.

**AC #2** — `plan.md` format:
```markdown
---
planId: <uuid>
name: <kebab-name>
status: concept
createdAt: 2026-04-21T10:00:00.000Z
---

# Plan: <name>

## Intent

<raw user intent>

## Description

<PM-agent summary>

## Epics

### Epic 1 — <title>  (no deps)

**Goal:** <...>

**Acceptance Criteria:**
- AC-1: <...>
- AC-2: <...>

#### Stories
- **S1** — <title>  _(no deps)_
  <description>
- **S2** — <title>  _(depends: S1)_
  <description>

### Epic 2 — <title>  (depends: Epic 1)
...
```

**AC #3** — `POST /api/plans` (Story 17.1) calls `bootstrapPlanFolder` AFTER the DDB write succeeds. If SSM fails, the plan's status is flipped to `archived` with an error message (never leave an orphan DDB row pointing at a non-existent folder).

**AC #4** — `PATCH /api/plans/:id` triggers `writePlanMarkdown` after the DDB patch to keep the file in sync. Writes are best-effort — if SSM is unreachable, the API returns 200 with a warning field `{plan, warnings: ['plan-md-not-synced']}` so the UI can surface the drift.

**AC #5** — Delete cascade (stub in 17.1, implemented in 17.7) calls `rm -rf` via the same guarded path regex.

**AC #6** — Markdown serializer/parser in `functions/shared/services/plan-markdown.ts` — pure functions, no I/O:
- `planToMarkdown(plan, epics): string`
- `parsePlanMarkdown(text): { frontmatter: { planId, name, status, createdAt }, plan: Partial<Plan>, epics: Array<...> }`

**AC #7** — Unit tests in `__tests__/plan-folder-service.test.ts` + `__tests__/plan-markdown.test.ts`:
- Markdown serializer round-trip (Plan → MD → parsed back → equals original).
- Frontmatter parsing edge cases (missing fields, malformed YAML).
- `bootstrapPlanFolder` calls SSM with the correct guarded command (mocked SSM client).
- `movePlanFolderToTrash` + `restorePlanFolder` round-trip.
- SSM-failure path returns error, not hang.

**AC #8** — `npm run ci` passes.

---

## Implementation Details

### Tasks / Subtasks

- [ ] Create `functions/shared/services/plan-markdown.ts` (pure serializer/parser).
- [ ] Create `functions/shared/services/plan-folder-service.ts` (SSM-calling wrapper, deps-injected for tests).
- [ ] Wire `bootstrapPlanFolder` into `POST /api/plans` in `functions/api/index.ts`.
- [ ] Wire `writePlanMarkdown` into `PATCH /api/plans/:id`.
- [ ] Write unit tests for both modules.
- [ ] Manual smoke: curl `POST /api/plans` with a fake plan, SSM into EC2 and verify folder + plan.md exist with correct content.
- [ ] `npm run ci` passes.

### Key Code References

- `functions/api/index.ts:2195 sendSsmCommand` + `functions/api/index.ts:~2170 waitForSsmOutput` — reuse for SSM execution.
- `functions/api/index.ts:2221 PROJECT_FOLDER_RE` — regex pattern for guarded paths.
- `daemon/agent-daemon.mjs` — reference for how SSM commands are structured server-side.

---

## Context References

**Epic:** [../epics-plan-based-labs.md](../epics-plan-based-labs.md) — Epic 17 scope.
**Previous story:** [17-1-plan-data-model-and-crud.md](./17-1-plan-data-model-and-crud.md).

---

## Dev Agent Record

<!-- -->

### Agent Model Used
### Debug Log References
### Completion Notes
### Files Modified
### Test Results
