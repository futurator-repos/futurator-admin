# Story 11.3: Create Project Button (Informational)

Status: done

## Story

As an admin user,
I want a Create Project button visible on the projects page,
so that I can see the project structure even though creation requires future backend work.

## Acceptance Criteria

1. Primary button "+ Create Project" in page header, right-aligned, accent-blue style.
2. Click opens dialog with informational banner: "Project creation requires infrastructure provisioning, cost tracking setup, and service registration. This capability is coming in a future update."
3. Shows modal structure preview (sections visible but disabled/grayed).
4. Close button dismisses. No API call.

## Tasks / Subtasks

- [x] Task 1: Add button to projects page header (AC: 1)
- [x] Task 2: Create informational dialog with banner and disabled preview (AC: 2, 3, 4)

## Dev Notes

Reuse Dialog component. Disabled fields have reduced opacity. Simplified preview — not the full edit modal.

### Project Structure Notes

Modified: src/app/projects/page.tsx.

### References

- [Source: docs/epics-project-hub-enhancement.md#Story-PH-3.3]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Added "+ Create Project" button in page header, right-aligned, accent-blue with white text
- Uses Plus icon from lucide-react
- Click opens Dialog with informational title "Create New Project"
- DialogDescription explains future capability (infrastructure provisioning, cost tracking, service registration)
- Shows grayed-out (opacity-50, pointer-events-none) preview of form structure: Name field, Status/Category grid, Descriptions textarea area
- Uses base-ui Dialog component with open/onOpenChange controlled state
- Close button (built into DialogContent) dismisses; no API calls

### File List

- src/app/projects/page.tsx (modified)

## Change Log

| Date       | Version | Description                            | Author |
| ---------- | ------- | -------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **✅ Approve** (clean — no findings)

### Summary

Smallest story in Epic 11 and the cleanest. Button is in the right place with the right styling, the dialog has the exact informational copy from AC2, the preview is appropriately disabled with `pointer-events-none opacity-50`, and there are zero API calls. Theme tokens used (`text-modal-title`, `text-label text-muted-foreground`, `border-border`, `bg-muted`).

### Acceptance Criteria Coverage

| AC  | Description                                                   | Status          | Evidence                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC1 | "+ Create Project" button, right-aligned, accent-blue         | **IMPLEMENTED** | `src/app/projects/page.tsx:52-57` — `<Button onClick={() => setShowCreate(true)} className="bg-accent-blue text-white hover:bg-accent-blue/90"><Plus className="mr-1.5 h-4 w-4" /> Create Project</Button>`. Right-aligned via `flex items-center justify-between` on the wrapper at `:41`                               |
| AC2 | Dialog with informational banner                              | **IMPLEMENTED** | `:110-149` — Dialog opens on button click; `:113-115` title "Create New Project" using `text-modal-title`; `:116-120` DialogDescription contains the exact copy: _"Project creation requires infrastructure provisioning, cost tracking setup, and service registration. This capability is coming in a future update."_ |
| AC3 | Modal structure preview, sections visible but disabled/grayed | **IMPLEMENTED** | `:122-148` — wrapper div has `pointer-events-none opacity-50`; preview shows Name field, Status/Category 2-col grid, Descriptions field — all rendered as empty bordered placeholders (`bg-muted`)                                                                                                                       |
| AC4 | Close button dismisses, no API call                           | **IMPLEMENTED** | Dialog uses controlled `open={showCreate}` + `onOpenChange={setShowCreate}` — built-in close button works. No API call anywhere in the dialog body                                                                                                                                                                       |

**Summary: 4 of 4 ACs fully implemented.**

### Task Completion Validation

| Task                                                            | Marked | Verified     | Evidence   |
| --------------------------------------------------------------- | ------ | ------------ | ---------- |
| 1. Add button to projects page header                           | [x]    | **VERIFIED** | `:52-57`   |
| 2. Create informational dialog with banner and disabled preview | [x]    | **VERIFIED** | `:110-149` |

**Summary: 2 of 2 tasks verified, 0 false completions.**

### Architectural Alignment

- ✅ Button uses `bg-accent-blue` semantic token
- ✅ Dialog uses shadcn/ui Dialog component (consistent with other modals)
- ✅ Disabled preview is `pointer-events-none opacity-50` — accessible disabled state without focusable controls
- ✅ Plus icon from lucide-react matches the icon-set used elsewhere
- ✅ No API call — correctly informational only, matching the "informational" suffix in the story title

### Security Notes

No security concerns. No data fetching, no user input processing, no auth surface.

### Action Items

**Code Changes Required:** None.

**Advisory Notes:** None — clean.
