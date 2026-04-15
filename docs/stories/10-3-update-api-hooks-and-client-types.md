# Story 10.3: Update API Hooks and Client Types

Status: done

## Story

As a developer,
I want the frontend API hooks and constants updated for the expanded project types,
so that the UI can read and write new project fields without TypeScript errors.

## Acceptance Criteria

1. **Hooks updated**: `useProjects()` and `useProject(id)` return the new `Project` type. New `useUpdateProject()` mutation hook added: calls `PUT /api/projects/:id`, invalidates queries on success, returns mutation state.

2. **Constants added**: `src/lib/constants.ts` has `AWS_SERVICES`, `AI_PROVIDERS`, `INTEGRATIONS` arrays for autocomplete suggestions.

3. **Existing references fixed**: All components reading `project.brief` updated to `project.descriptions.brief`. No TypeScript errors.

4. **Build succeeds**: `npm run build` passes.

## Tasks / Subtasks

- [x] Task 1: Add useUpdateProject mutation hook (AC: 1)
  - [x] 1.1 Add `useMutation` in `src/hooks/use-projects.ts`
  - [x] 1.2 POST to `PUT /api/projects/:id` via api-client
  - [x] 1.3 Invalidate `['projects']` and `['project', id]` queries on success

- [x] Task 2: Add service provider constants (AC: 2)
  - [x] 2.1 Add `AWS_SERVICES` array (24 services)
  - [x] 2.2 Add `AI_PROVIDERS` array (9 providers)
  - [x] 2.3 Add `INTEGRATIONS` array (11 integrations)

- [x] Task 3: Fix brief → descriptions references (AC: 3, 4)
  - [x] 3.1 Update `project-card.tsx`: `project.brief` → `project.descriptions?.brief`
  - [x] 3.2 Update `project-tabs.tsx`: same
  - [x] 3.3 Grep for any other `project.brief` references and fix
  - [x] 3.4 Run `npm run build`

## Dev Notes

- Service provider lists from [Source: docs/concepts/project-hub-enhancement.md#7-Service-Provider-Reference-Lists]
- The mutation hook follows TanStack Query patterns already established in the codebase

### Project Structure Notes

- **Modified**: `src/hooks/use-projects.ts`, `src/lib/constants.ts`, `src/components/projects/project-card.tsx`, `src/components/projects/project-tabs.tsx`

### References

- [Source: docs/epics-project-hub-enhancement.md#Story-PH-2.3]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Added useUpdateProject mutation hook using useMutation from @tanstack/react-query
- Mutation calls api.put('/projects/:id', data) and invalidates ['projects'] and ['project', id] on success
- Added AWS_SERVICES (24 items), AI_PROVIDERS (9 items), INTEGRATIONS (11 items) as const arrays to constants.ts
- Fixed project.brief to project.descriptions?.brief in project-card.tsx and project-tabs.tsx (done in Story 10-1, verified here)
- Grepped entire src directory: no remaining project.brief references
- All modified files pass TypeScript compilation

### File List

- src/hooks/use-projects.ts
- src/lib/constants.ts
- src/components/projects/project-card.tsx (fixed in Story 10-1)
- src/components/projects/project-tabs.tsx (fixed in Story 10-1)

## Change Log

| Date       | Version | Description                            | Author |
| ---------- | ------- | -------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **✅ Approve** (1 Low note about misleading dead code)

### Summary

Clean, minimal changes. `useUpdateProject` hook follows the established TanStack Query mutation pattern. Constants arrays match the AC counts exactly (24 / 9 / 11). Build passes. The `brief` → `descriptions.brief` rename was already completed in 10-1, and the dev correctly notes this.

### Key Findings

**LOW**

- **Misleading dead code in `useUpdateProject` query invalidation** — `src/hooks/use-projects.ts:28`
  - Code invalidates two query keys on success: `['projects']` (line 27) and `['project', id]` (line 28)
  - **The second key is dead code** because no `useQuery` in this file uses `['project', id]` (singular). `useProject(id)` uses `['projects', id]` (plural, line 15)
  - **The mutation still works correctly** because `invalidateQueries({ queryKey: ['projects'] })` is a prefix match that automatically invalidates `['projects', id]` and any other query under the `['projects']` namespace
  - **Net effect:** AC1 is functionally satisfied, but the code is misleading. A future maintainer reading this might think `['project', id]` is a real key being invalidated and add a query that uses it, missing the actual invalidation
  - Recommended cleanup: delete line 28 entirely. Not actionable for closing this story.

### Acceptance Criteria Coverage

| AC  | Description                                                      | Status          | Evidence                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | `useProjects()`, `useProject(id)`, `useUpdateProject()` mutation | **IMPLEMENTED** | `src/hooks/use-projects.ts:6-31`. Mutation calls `PUT /api/projects/:id` (`:25`), invalidates queries on success (`:26-29` — works via prefix match despite dead-code line)                                                                                         |
| AC2 | `AWS_SERVICES`, `AI_PROVIDERS`, `INTEGRATIONS` arrays            | **IMPLEMENTED** | `src/lib/constants.ts:36-50`. Counts: `AWS_SERVICES` = 24 ✓, `AI_PROVIDERS` = 9 ✓, `INTEGRATIONS` = 11 ✓ — all match dev claim                                                                                                                                      |
| AC3 | All `project.brief` references fixed                             | **IMPLEMENTED** | Verified in 10-1 review via grep — all consumers use `project.descriptions?.brief` pattern. Files: `project-card.tsx`, `project-list-row.tsx`, `project-tabs.tsx`, `project-edit-modal.tsx`, `functions/api/index.ts`, `functions/shared/export-public-projects.ts` |
| AC4 | Build succeeds                                                   | **VERIFIED**    | Build run during earlier review: 23/23 static pages                                                                                                                                                                                                                 |

**Summary: 4 of 4 ACs fully implemented.**

### Task Completion Validation

| Task                                   | Marked | Verified     | Evidence                                             |
| -------------------------------------- | ------ | ------------ | ---------------------------------------------------- |
| 1. Add useUpdateProject mutation hook  | [x]    | **VERIFIED** | `use-projects.ts:21-31`                              |
| 1.1 Add useMutation                    | [x]    | **VERIFIED** | `:23`                                                |
| 1.2 PUT to api-client                  | [x]    | **VERIFIED** | `:25` `api.put<Project>(`/projects/${id}`, data)`    |
| 1.3 Invalidate queries on success      | [x]    | **VERIFIED** | `:26-29` (functionally — see Low finding for nuance) |
| 2. Add service provider constants      | [x]    | **VERIFIED** | `constants.ts:36-50`                                 |
| 2.1 AWS_SERVICES (24 services)         | [x]    | **VERIFIED** | 24 items counted                                     |
| 2.2 AI_PROVIDERS (9 providers)         | [x]    | **VERIFIED** | 9 items counted                                      |
| 2.3 INTEGRATIONS (11 integrations)     | [x]    | **VERIFIED** | 11 items counted                                     |
| 3. Fix brief → descriptions references | [x]    | **VERIFIED** | Done in 10-1, confirmed by grep                      |
| 3.1 project-card.tsx                   | [x]    | **VERIFIED** | Uses `project.descriptions?.brief`                   |
| 3.2 project-tabs.tsx                   | [x]    | **VERIFIED** | Uses `project.descriptions?.brief`                   |
| 3.3 Grep for any other references      | [x]    | **VERIFIED** | No legacy references remain                          |
| 3.4 Run npm run build                  | [x]    | **VERIFIED** | Build passes                                         |

**Summary: 13 of 13 tasks verified, 0 false completions.**

### Test Coverage and Gaps

- No tests added for `useUpdateProject`. TanStack Query mutation hooks are typically tested via integration tests against a mock fetch — out of scope for this story but worth noting as a long-term gap
- Constants arrays don't need tests (they're literal data)

### Architectural Alignment

- ✅ **TanStack Query mutation pattern** — matches existing hooks in the codebase
- ✅ **`as const` on constant arrays** — correct for getting literal types out of TypeScript
- ✅ **Constants colocated in `src/lib/constants.ts`** — appropriate for shared static data
- ✅ **Hooks colocated in `src/hooks/`** — follows project convention

### Security Notes

- No security concerns. The mutation hook delegates auth handling to `api-client` which handles Bearer token injection and 401-refresh
- Constants are public reference data — no sensitive values

### Best-Practices and References

- **TanStack Query mutation pattern** — [https://tanstack.com/query/latest/docs/framework/react/guides/mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations) — used correctly
- **`invalidateQueries` prefix matching** — [https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation) — `['projects']` invalidates all queries whose key starts with `['projects']`, which is why the singular `['project', id]` line is dead code

### Action Items

**Code Changes Required:** None.

**Advisory Notes (no action required):**

- Note: Delete the dead invalidation line `queryClient.invalidateQueries({ queryKey: ['project', id] });` at `use-projects.ts:28` in a future cleanup. Either delete it (the broad `['projects']` invalidation already covers everything) or — if you want a more targeted invalidation pattern in the future — update the singular form to match `['projects', id]` and then optionally remove the broad `['projects']` invalidation
- Note: Consider adding `onError` and `onMutate` (optimistic update) handlers to `useUpdateProject` in a future polish pass. Not required for the current AC, but would improve UX for the project edit modal in Story 12-4
