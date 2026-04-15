# Story 13.1: ChipInput Component with Autocomplete

Status: done

## Story

As an admin user,
I want a tag-style input with autocomplete for adding/removing services,
so that I can quickly map services to features.

## Acceptance Criteria

1. Container with chips + text input. Type to filter suggestions dropdown (max 8 items).
2. Enter/click adds chip. Backspace removes last. X on chip removes it.
3. Free-text entry allowed for unlisted items.
4. Visual variants: AWS (gold), AI (purple), Integration (green), Default (neutral).
5. Keyboard: Tab to input, arrows for suggestions, Enter to select.
6. ARIA: aria-label on input, role="listbox" on dropdown, role="option" on suggestions.
7. Reusable across Features and Team sections.

## Tasks / Subtasks

- [x] Task 1: Create `src/components/projects/chip-input.tsx` (AC: 1-7)
- [x] Task 2: Implement autocomplete filtering and selection (AC: 1, 2, 3)
- [x] Task 3: Chip color variants (AC: 4)
- [x] Task 4: Keyboard navigation and accessibility (AC: 5, 6)

## Dev Notes

Props: value: string[], onChange, suggestions: string[], variant, placeholder. Filter: case-insensitive substring.

### Project Structure Notes

New: src/components/projects/chip-input.tsx.

### References

- [Source: docs/ux-design-specification.md#6.3-ChipInput]
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-5.1]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Created ChipInput component with full autocomplete support
- Supports 4 visual variants: aws (gold), ai (purple), integration (green), default (neutral)
- Implements keyboard navigation (ArrowUp/Down, Enter, Escape, Backspace)
- ARIA attributes: aria-label on input, role="listbox" on dropdown, role="option" on suggestions
- Free-text entry supported for unlisted items
- Filters suggestions case-insensitively, excludes already-selected items, limited to 8 results

### File List

- src/components/projects/chip-input.tsx (new)

## Change Log

| Date       | Version | Description                            | Author |
| ---------- | ------- | -------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **✅ Approve** (clean — minor advisory only)

### Summary

Excellent reusable component. All 7 ACs implemented in 145 lines with full keyboard navigation, ARIA, 4 chip variants (using semantic theme tokens — no hardcoded colors), free-text entry, click-outside-via-blur, and proper focus management. Used by `feature-editor.tsx` and the modal's Team section, fulfilling AC7's "reusable across Features and Team sections."

### Acceptance Criteria Coverage

| AC  | Description                                              | Status          | Evidence                                                                                                                                                                                                          |
| --- | -------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | Container with chips + input + filtered dropdown (max 8) | **IMPLEMENTED** | `chip-input.tsx:82-119` (chip+input row), `:121-142` (dropdown), `:38` `.slice(0, 8)`                                                                                                                             |
| AC2 | Enter/click adds chip; Backspace removes last; X removes | **IMPLEMENTED** | `:60-78` (key handlers), `:93-100` (X button), `:127-136` (click handler)                                                                                                                                         |
| AC3 | Free-text entry for unlisted items                       | **IMPLEMENTED** | `:67-69` — if highlight is -1 and query is non-empty, `addChip(query.trim())`                                                                                                                                     |
| AC4 | 4 visual variants with semantic colors                   | **IMPLEMENTED** | `:15-20` — aws=`bg-warning/10 text-warning`, ai=`bg-accent-purple/10 text-accent-purple`, integration=`bg-success/10 text-success`, default=`bg-muted text-foreground`. **All theme tokens, no hardcoded colors** |
| AC5 | Keyboard nav: Tab, ArrowUp/Down, Enter                   | **IMPLEMENTED** | `:60-79` — handles ArrowDown, ArrowUp, Enter, Backspace, Escape; Tab is native browser behavior                                                                                                                   |
| AC6 | ARIA: aria-label, role=listbox, role=option              | **IMPLEMENTED** | `:117` `aria-label`, `:124` `role="listbox"`, `:130` `role="option"`, `:131` `aria-selected`                                                                                                                      |
| AC7 | Reusable across Features and Team sections               | **IMPLEMENTED** | Imported by `feature-editor.tsx:12` (3 instances per feature) and `project-edit-modal.tsx:33` (Team section at `:637-643`)                                                                                        |

**Summary: 7 of 7 ACs fully implemented.**

### Task Completion Validation

| Task                                     | Marked | Verified     | Evidence                                |
| ---------------------------------------- | ------ | ------------ | --------------------------------------- |
| 1. Create chip-input.tsx                 | [x]    | **VERIFIED** | File exists, 145 lines                  |
| 2. Autocomplete filtering and selection  | [x]    | **VERIFIED** | `:34-38` filter logic, `:40-51` addChip |
| 3. Chip color variants                   | [x]    | **VERIFIED** | `:15-20`                                |
| 4. Keyboard navigation and accessibility | [x]    | **VERIFIED** | `:60-79`, ARIA attrs                    |

**Summary: 4 of 4 tasks verified, 0 false completions.**

### Architectural Alignment

- ✅ **Theme tokens throughout** — exemplary for the codebase
- ✅ **Controlled component pattern** — `value` + `onChange` props, no internal state for the actual values
- ✅ **`useCallback` on add/remove handlers** — stable references
- ✅ **`onBlur` with timeout** for click-vs-blur race condition (line 113) — common pattern, works correctly
- ✅ **`onMouseDown` (not `onClick`) on dropdown items** at `:133` — fires before blur, prevents the suggestion list from disappearing on click

### Action Items

**Code Changes Required:** None.

**Advisory Notes:**

- Note: The dropdown's `onBlur` timeout pattern (`setTimeout(() => setShowSuggestions(false), 150)`) works but is fragile. A more robust approach would be using a focus-within ref or a click-outside hook. Not actionable for closing this story
- Note: Consider exposing `onCreateNewItem` callback to let parents track free-text entries differently from suggestion picks (useful for analytics or for differentiating "user added a custom value" vs "user picked from list")
