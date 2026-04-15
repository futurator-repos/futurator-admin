# Story 12.2: Identity Section

Status: done

## Story

As an admin user,
I want to edit a project's name, status, category, publish state, and homepage order,
so that I can control project identity and homepage visibility.

## Acceptance Criteria

1. Name text input (max 100, char counter).
2. Status dropdown (planning/in-progress/beta/active).
3. Category dropdown (personal/independent/joint-venture/shared-infra).
4. Published to Homepage toggle switch (accent-blue when on).
5. Homepage Order number input (visible only when published ON, animates in/out).
6. Changing any field enables Save button (dirty state detection).

## Tasks / Subtasks

- [x] Task 1: Implement Identity section content in modal (AC: 1-5)
- [x] Task 2: Local form state with dirty detection (AC: 6)
- [x] Task 3: Conditional Homepage Order visibility (AC: 5)

## Dev Notes

Uses shadcn/ui Switch, Select, Input. Initialize form state from project data. Compare with initial for dirty detection.

### Project Structure Notes

Modified: src/components/projects/project-edit-modal.tsx.

### References

- [Source: docs/ux-design-directions.html#Panel-3]
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-4.2]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Name input with character counter (max 100), warning at 90%, error at limit
- Status dropdown with 4 options (planning, in-progress, beta, active) using base-ui Select
- Category dropdown with 4 options using base-ui Select
- Published to Homepage toggle using base-ui Switch
- Homepage Order number input, conditionally visible with animate-in transition when published=true
- Dirty state detection via deep comparison of form state vs initial project data (isFormDirty helper)
- Save button disabled when form is clean

### File List

- src/components/projects/project-edit-modal.tsx (modified)

## Change Log

| Date       | Version | Description                            | Author |
| ---------- | ------- | -------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **✅ Approve** (1 Low note about hardcoded yellow color; 12-2's scoped work is complete in the modal code)

### Summary

Identity section is fully implemented inside `project-edit-modal.tsx`. All 5 ACs map cleanly to code in the Identity Collapsible block (`:424-522`). Form state, dirty detection, and conditional Homepage Order rendering all work as specified.

**Caveat shared with all 12-x stories:** the modal itself is currently orphaned (Story 12-1 Task 3 not yet wired into `projects/page.tsx`). 12-2's scoped work IS complete inside the modal. The integration is owned by 12-1's Review Follow-ups, not 12-2.

### Key Findings

**LOW**

- **Char counter uses hardcoded `text-yellow-600 dark:text-yellow-400` instead of theme token** — `project-edit-modal.tsx:433`
  - Pattern: `formData.name.length > 100 ? 'text-destructive' : formData.name.length >= 90 ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground'`
  - The 90% warning state uses hardcoded `yellow-*` colors
  - **Could use the new `--warning` token** added in Story 9-1: `text-warning`. But the `--warning` token uses hex (`#d97706` light / `#fbbf24` dark) and would need a Tailwind utility class set up
  - Out of scope for 12-2 — can be folded into Story 9-5 if desired

### Acceptance Criteria Coverage

| AC  | Description                                             | Status          | Evidence                                                                                                                                                     |
| --- | ------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC1 | Name input (max 100, char counter)                      | **IMPLEMENTED** | `project-edit-modal.tsx:439-446` Input with `value`/`onChange`; `:432-437` counter `{formData.name.length}/100` with color thresholds; `:444` `aria-invalid` |
| AC2 | Status dropdown (4 options)                             | **IMPLEMENTED** | `:455-469` Select with `STATUS_OPTIONS` (`:68-73` defines all 4: planning, in-progress, beta, active)                                                        |
| AC3 | Category dropdown (4 options)                           | **IMPLEMENTED** | `:475-489` Select with `CATEGORY_OPTIONS` (`:75-80` defines all 4)                                                                                           |
| AC4 | Published toggle (Switch component)                     | **IMPLEMENTED** | `:497-500` shadcn `Switch` bound to `formData.publishedToHomepage`                                                                                           |
| AC5 | Homepage Order visible only when published, animates in | **IMPLEMENTED** | `:504-519` conditional render with `animate-in fade-in slide-in-from-top-1 duration-200`                                                                     |
| AC6 | Dirty state detection enables Save button               | **IMPLEMENTED** | `isFormDirty` helper at `:94-116` deep-compares all fields including identity; Save button disabled state derives from this via `dirty` memo at `:230-233`   |

**Summary: 6 of 6 ACs fully implemented.**

### Task Completion Validation

| Task                                           | Marked | Verified     | Evidence                                                                                             |
| ---------------------------------------------- | ------ | ------------ | ---------------------------------------------------------------------------------------------------- |
| 1. Implement Identity section content in modal | [x]    | **VERIFIED** | `:424-522`                                                                                           |
| 2. Local form state with dirty detection       | [x]    | **VERIFIED** | `formData`/`initialData` state at `:189-190`, `isFormDirty` at `:94-116`, `dirty` memo at `:230-233` |
| 3. Conditional Homepage Order visibility       | [x]    | **VERIFIED** | `:504-519` conditional render with animation                                                         |

**Summary: 3 of 3 tasks verified, 0 false completions.**

### Architectural Alignment

- ✅ **Theme tokens used** (with one hardcoded exception flagged above)
- ✅ **Form field updaters via `useCallback`** at `:237-240` — stable reference avoids unnecessary child re-renders
- ✅ **Dirty detection via deep comparison** — appropriate for the small form size; could be optimized later if performance becomes an issue
- ✅ **`autoFocus` on Name input** — matches AC7 of 12-1

### Action Items

**Code Changes Required:** None.

**Advisory Notes:**

- Note: Replace `text-yellow-600 dark:text-yellow-400` with theme-aware warning token in a future polish pass (could fold into Story 9-5)
- Note: This story is functionally blocked from end-to-end testing until Story 12-1 Task 3 is completed (modal wiring)
