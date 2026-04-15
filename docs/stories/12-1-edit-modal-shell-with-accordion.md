# Story 12.1: Edit Modal Shell with Accordion Layout

Status: done

## Story

As an admin user,
I want a modal dialog that opens when I click the edit icon on a project row,
so that I can edit project data without navigating away from the list.

## Acceptance Criteria

1. shadcn/ui Dialog, max-width 800px, max-height 85vh, glassmorphic overlay (backdrop-filter blur 4px).
2. Header: "Edit Project: [name]" (weight 200, 20px) + close button.
3. Scrollable body with 5 collapsible accordion sections (Identity, Descriptions, Media, Features, Team).
4. Footer: save status text + Cancel + Save Changes buttons.
5. Identity and Descriptions open by default; others collapsed.
6. Does NOT close on overlay click. Focus trapped. Escape to close.
7. role="dialog", aria-labelledby. Auto-focus Name field.

## Tasks / Subtasks

- [x] Task 1: Create `src/components/projects/project-edit-modal.tsx` (AC: 1, 2, 3, 4)
- [x] Task 2: Implement accordion sections with Collapsible (AC: 3, 5)
- [x] Task 3: Wire edit button in list row to open modal with project ID (AC: all)
- [x] Task 4: Focus trap and accessibility (AC: 6, 7)

## Dev Notes

Pass projectId as prop, fetch via useProject(id). Sections are empty shells in this story — content added in subsequent stories.

### Project Structure Notes

New: src/components/projects/project-edit-modal.tsx. Modified: src/components/projects/project-list-row.tsx.

### References

- [Source: docs/ux-design-specification.md#6.3-ProjectEditModal]
- [Source: docs/ux-design-directions.html#Panel-3]
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-4.1]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created Dialog-based edit modal at 800px max-width, 85vh max-height
- 5 collapsible sections (Identity, Descriptions, Media, Features, Team) using base-ui Collapsible
- Identity and Descriptions open by default; others collapsed
- disablePointerDismissal prevents close on overlay click; Escape and close button work via dirty-check guard
- Focus trap handled natively by base-ui Dialog (modal=true default)
- Header with "Edit Project: [name]" and close button; footer with save status, Cancel, and Save Changes
- Created base-ui wrapper components: switch.tsx, checkbox.tsx, collapsible.tsx, alert-dialog.tsx
- ✅ Resolved review finding [High] (2026-04-07): Wired ProjectEditModal into `src/app/projects/page.tsx`. Imported the component, replaced the discarded `[, setEditingProject]` state with `[editingProjectId, setEditingProjectId]`, updated `onEdit` to populate the new state, and rendered `<ProjectEditModal>` next to the Create dialog with proper open/onOpenChange wiring. Task 3 now complete; the modal is reachable from the project list pencil icon.

### File List

- src/components/projects/project-edit-modal.tsx (new)
- src/components/ui/switch.tsx (new)
- src/components/ui/checkbox.tsx (new)
- src/components/ui/collapsible.tsx (new)
- src/components/ui/alert-dialog.tsx (new)
- src/app/projects/page.tsx (modified, 2026-04-07 — Task 3 wiring)

### Review Follow-ups (AI)

- [x] [AI-Review][High] **Wire ProjectEditModal into projects page (Task 3, AC: all)** — `src/app/projects/page.tsx` ✅ Resolved 2026-04-07
  1. Imported: `import { ProjectEditModal } from '@/components/projects/project-edit-modal';`
  2. State migrated from discarded `[, setEditingProject]` → `const [editingProjectId, setEditingProjectId] = useState<string | null>(null);`
  3. `onEdit={(id) => setEditingProjectId(id)}`
  4. Modal rendered alongside Create dialog: `<ProjectEditModal projectId={editingProjectId} open={!!editingProjectId} onOpenChange={(open) => { if (!open) setEditingProjectId(null); }} />`
  5. Build + tests verified clean. Modal is now reachable from the UI; Stories 12-2/12-3/12-4/13-2/13-3 are all functionally usable through this modal.

## Change Log

| Date       | Version | Description                                                      | Author |
| ---------- | ------- | ---------------------------------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended                           | Richie |
| 2026-04-07 | 0.1.2   | Addressed code review findings - Task 3 (modal wiring) completed | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **Changes Requested** (1 High finding — Task 3 explicitly unchecked, modal is orphaned)

### Summary

The modal SHELL is well-built and structurally complete. All 5 collapsible sections, header with title and close button, scrollable body, footer with Save/Cancel, dialog config (max-w-800px, max-h-85vh, `disablePointerDismissal`), and the discard-confirmation `AlertDialog` are all in place. The auxiliary base-ui wrapper components (`switch.tsx`, `checkbox.tsx`, `collapsible.tsx`, `alert-dialog.tsx`) were also created as part of this story.

**However, Task 3 ("Wire edit button in list row to open modal with project ID") is explicitly UNCHECKED `[ ]`**, and the dev's completion notes are honest about this: _"Task 3 (wiring edit button in list row) deferred to list-row component integration"_. This deferral means the entire `ProjectEditModal` component is **orphaned** — `grep` confirms no other file in the codebase imports it. The modal cannot be opened from the UI by any user action. **Stories 12-2, 12-3, and 12-4 all built features inside this modal — and none of them are reachable until 12-1's Task 3 is completed.**

This isn't a "false completion" (the dev was transparent), but it IS a HIGH severity finding because Task 3 was within scope of 12-1 (the AC tag says "AC: all") and the story was moved to `review` status without it being done. The story should not be marked done until the wiring exists.

### Key Findings

**HIGH**

- **Task 3 incomplete: ProjectEditModal is orphaned, never imported anywhere** — `src/app/projects/page.tsx:25,102`
  - Verified by grep across `src/`: only one match for `ProjectEditModal` — its own definition file
  - `projects/page.tsx:25`: `const [, setEditingProject] = useState<string | null>(null);` — first destructured value (the actual ID) is **discarded** with `_`. Only the setter is exported, but no consumer reads the state
  - `projects/page.tsx:102`: `onEdit={(id) => setEditingProject(id)}` — sets the orphaned state
  - Result: clicking the pencil icon does literally nothing visible to the user. The modal exists in code but is dead
  - **This blocks all of Stories 12-2, 12-3, 12-4 from being functionally usable** even though their internal code is correct
  - Fix is small (5 lines in `projects/page.tsx`) — see Review Follow-ups section above

**LOW**

- **Custom close button instead of `showCloseButton={true}`** — `src/components/projects/project-edit-modal.tsx:392-403`
  - Story explicitly hides the default close button (`showCloseButton={false}`) and renders a custom close SVG. Functionally equivalent, but the custom SVG is inline (12 lines) instead of using `<X />` from lucide-react which is already imported elsewhere in the codebase
  - Cosmetic — not blocking

### Acceptance Criteria Coverage

| AC  | Description                                                   | Status                            | Evidence                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | Dialog max-w 800px, max-h 85vh, glassmorphic overlay          | **IMPLEMENTED (but unreachable)** | `:391` `sm:max-w-[800px] max-h-[85vh] flex flex-col p-0`. The "glassmorphic overlay backdrop-filter blur 4px" is provided by the shadcn Dialog primitive's overlay. **However the modal is never opened so this can't be visually verified end-to-end** |
| AC2 | Header with "Edit Project: [name]" + close button             | **IMPLEMENTED**                   | `:395-405` — `Edit Project: {project?.name}` with custom close button                                                                                                                                                                                   |
| AC3 | Scrollable body with 5 collapsible accordion sections         | **IMPLEMENTED**                   | `:408` `overflow-y-auto`; sections at `:424` (Identity), `:525` (Descriptions), `:613` (Media), and presumably Features + Team further down                                                                                                             |
| AC4 | Footer with save status + Cancel + Save Changes buttons       | **IMPLEMENTED**                   | DialogFooter present in modal (verified earlier in file structure)                                                                                                                                                                                      |
| AC5 | Identity and Descriptions open by default; others collapsed   | **IMPLEMENTED**                   | `:182-186` — `identityOpen: true`, `descriptionsOpen: true`, `mediaOpen/featuresOpen/teamOpen: false`                                                                                                                                                   |
| AC6 | Does NOT close on overlay click; Escape closes; focus trapped | **IMPLEMENTED**                   | `:389` `disablePointerDismissal`; `handleRequestClose` (`:365-376`) intercepts Escape/close and shows discard confirm if dirty; focus trap is native to base-ui Dialog                                                                                  |
| AC7 | role="dialog", aria-labelledby, auto-focus Name field         | **PARTIAL**                       | role="dialog" provided by Dialog primitive ✓; auto-focus on Name field via `autoFocus` at `:445` ✓; **`aria-labelledby` not explicitly verified** — relying on shadcn DialogTitle to handle this, which is the documented pattern                       |

**Summary: 6 of 7 ACs structurally implemented (AC1 unverifiable visually due to wiring gap). All ACs become moot if Task 3 is not completed because the modal cannot be opened.**

### Task Completion Validation

| Task                                              | Marked  | Verified              | Evidence                                                                       |
| ------------------------------------------------- | ------- | --------------------- | ------------------------------------------------------------------------------ |
| 1. Create project-edit-modal.tsx                  | [x]     | **VERIFIED**          | File exists, ~700 lines, well-structured                                       |
| 2. Implement accordion sections with Collapsible  | [x]     | **VERIFIED**          | 5 `<Collapsible>` blocks at `:424, :525, :613, ...`                            |
| **3. Wire edit button in list row to open modal** | **[ ]** | **NOT DONE (honest)** | Confirmed by grep — `ProjectEditModal` only appears in its own definition file |
| 4. Focus trap and accessibility                   | [x]     | **VERIFIED**          | Native to base-ui Dialog, plus explicit `autoFocus`                            |

**Summary: 3 of 4 tasks verified complete, 1 honestly-uncompleted (Task 3 — explicitly marked `[ ]` and acknowledged in completion notes).**

### Test Coverage and Gaps

- No tests for the modal. Modal interaction tests (open, fill, save, discard) are well-suited to Playwright
- The orphaned-modal situation is the canonical example of why a smoke test like "click pencil → expect modal visible" would have caught this immediately

### Architectural Alignment

- ✅ **`disablePointerDismissal`** — correct for modal shells with unsaved-data risk
- ✅ **Discard confirmation via `AlertDialog`** — standard pattern, well-implemented at `:365-381`
- ✅ **Form state isolated to modal** — no leak into TanStack Query cache until Save mutates
- ✅ **5 base-ui wrapper components created** — shadcn-style adapters for the base-ui primitives, consistent with how the rest of the project handles base-ui
- ❌ **Integration step missing** — see HIGH finding

### Security Notes

No security concerns in the modal shell itself. The Save flow (12-4) handles input through Zod validation which is correct.

### Action Items

**Code Changes Required (Blocking):**

- [x] **[High] Complete Task 3 — wire ProjectEditModal into projects page** ✅ Resolved 2026-04-07. See Review Follow-ups for the exact 5-line change applied to `src/app/projects/page.tsx`. 12-1, 12-2, 12-3, 12-4, 13-2, and 13-3 are now all functionally usable through the modal.

**Advisory Notes:**

- Note: After Task 3 wiring is done, replace the inline close SVG with `<X />` from lucide-react for consistency (already imported in `filter-bar.tsx`)
- Note: A Playwright smoke test for "click pencil → modal opens → fill name → save → modal stays open with success flash" would have caught the orphaned-modal situation immediately. Consider adding when test infrastructure is introduced
