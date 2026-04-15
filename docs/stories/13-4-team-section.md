# Story 13.4: Team Section

Status: done

## Story

As an admin user,
I want to manage team members assigned to a project,
so that I can track who is working on what.

## Acceptance Criteria

1. ChipInput (default variant) with current team members as chips.
2. Suggestions from existing team members across all projects (deduplicated).
3. Free-text for new names. Backspace removes last.
4. Accordion header: "Team (1)".

## Tasks / Subtasks

- [x] Task 1: Implement Team accordion section using ChipInput (AC: 1, 2, 3, 4)
- [x] Task 2: Derive suggestions from useProjects() data (AC: 2)

## Dev Notes

Reuses ChipInput with variant="default". Suggestions: Array.from(new Set(projects.flatMap(p => p.team))).

### Project Structure Notes

Modified: src/components/projects/project-edit-modal.tsx.

### References

- [Source: docs/epics-project-hub-enhancement.md#Story-PH-5.4]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Integrated ChipInput into the Team accordion section of project-edit-modal.tsx
- Added `team: string[]` to FormData interface and buildFormData/isFormDirty helpers
- Added useProjects() hook to derive allTeamMembers (deduplicated across all projects)
- Team accordion header shows dynamic count: "Team (N)"
- Team changes included in save payload and dirty-checking logic
- ChipInput uses variant="default" with placeholder "Add team member..."

### File List

- src/components/projects/project-edit-modal.tsx (modified)

## Change Log

| Date       | Version | Description                            | Author |
| ---------- | ------- | -------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **✅ Approve** (clean — the only Epic 13 story that actually integrates into the modal)

### Summary

This is the only Epic 13 story whose component is **actually integrated** into the modal. AC1-AC4 all met cleanly. `formData.team` is included in `FormData`, in `buildFormData`, in `isFormDirty`, and in the `handleSave` payload. The Team accordion header dynamically shows the count via `Team (${formData.team.length})`. ChipInput uses `variant="default"` per AC1. Suggestions correctly derived from `useProjects()` data with deduplication.

**Reference for the rest of Epic 13's stuck stories:** this is the integration pattern that 12-1 / 13-2 / 13-3 are missing. Just plug your component into the modal section the same way.

### Acceptance Criteria Coverage

| AC  | Description                                                              | Status          | Evidence                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | --------------------------------------------------------------------------------------------- |
| AC1 | ChipInput (default variant) with team chips                              | **IMPLEMENTED** | `project-edit-modal.tsx:637-643` — `<ChipInput value={formData.team} onChange={...} suggestions={allTeamMembers} variant="default" placeholder="Add team member..." />`              |
| AC2 | Suggestions from existing team members across all projects, deduplicated | **IMPLEMENTED** | `project-edit-modal.tsx:176-179` — `useMemo(() => Array.from(new Set(projects?.flatMap((p) => p.team)                                                                                |     | [])), [projects])`. Uses `Set`for deduplication, sources from all projects via`useProjects()` |
| AC3 | Free-text for new names; Backspace removes last                          | **IMPLEMENTED** | Inherited from ChipInput component (verified in 13-1 review)                                                                                                                         |
| AC4 | Accordion header: "Team (1)"                                             | **IMPLEMENTED** | `project-edit-modal.tsx:634` — `<SectionHeader title={`Team (${formData.team.length})`} ...>`. **This is the canonical pattern** that 13-2 (Features) and 13-3 (Media) should follow |

**Summary: 4 of 4 ACs fully implemented and integrated.**

### Task Completion Validation

| Task                                                | Marked | Verified     | Evidence        |
| --------------------------------------------------- | ------ | ------------ | --------------- |
| 1. Implement Team accordion section using ChipInput | [x]    | **VERIFIED** | `:632-646`      |
| 2. Derive suggestions from useProjects() data       | [x]    | **VERIFIED** | `:172, 176-179` |

**Summary: 2 of 2 tasks verified.**

### Architectural Alignment

- ✅ **Reuses ChipInput component** correctly
- ✅ **Sources suggestions from `useProjects()`** — leverages the global cache so no extra API call
- ✅ **`useMemo` on dedup** — recomputes only when projects data changes
- ✅ **Team data fully integrated into form lifecycle** — buildFormData (`:90`), isFormDirty (`:112-113`), handleSave (`:347`), reset on close
- ✅ **Header count pattern** — exactly the pattern 13-2 and 13-3 should mirror

### Caveat

Like all 12-x and most 13-x stories, this section is functionally **unreachable** until Story 12-1 Task 3 is completed (modal wiring into projects page). That's not a 13-4 finding — it's a 12-1 blocker that prevents end-to-end testing of the entire modal.

### Action Items

**Code Changes Required:** None.

**Advisory Notes:**

- Note: This story is functionally blocked from end-to-end testing until Story 12-1 Task 3 is completed
- Note: The dedup pattern `Array.from(new Set(...))` is correct but could break if a team member is stored with leading/trailing whitespace inconsistently. Consider trimming on input. Not actionable
