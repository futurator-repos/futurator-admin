# Story 13.2: FeatureEditor with Multi-Provider Chips

Status: done

## Story

As an admin user,
I want to edit project features with status and all associated services,
so that I have a complete dependency map.

## Acceptance Criteria

1. Each feature: inline name input, status badge/dropdown, AWS chips (gold), AI chips (purple), Integration chips (green).
2. "+ Add Feature" button. New features: empty name (focused), status "planning", empty arrays.
3. Delete with inline confirmation: "Remove [name]? [Cancel] [Remove]".
4. Accordion header shows count: "Features & Services (5)".

## Tasks / Subtasks

- [x] Task 1: Create `src/components/projects/feature-editor.tsx` (AC: 1, 2, 3, 4)
- [x] Task 2: Wire ChipInput with variant-specific autocomplete lists (AC: 1)
- [x] Task 3: Add/delete feature logic (AC: 2, 3)

## Dev Notes

Uses ChipInput from PH-5.1. New feature ID: crypto.randomUUID(). Feature list is local form state.

### Project Structure Notes

New: src/components/projects/feature-editor.tsx. Modified: src/components/projects/project-edit-modal.tsx.

### References

- [Source: docs/ux-design-specification.md#6.3-FeatureEditor]
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-5.2]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Created FeatureEditor component with inline name editing and status dropdown
- Each feature has AWS (gold), AI (purple), Integration (green) ChipInput fields
- Uses AWS_SERVICES, AI_PROVIDERS, INTEGRATIONS from constants.ts as suggestion lists
- Add Feature button creates new feature with crypto.randomUUID(), status "planning", empty arrays
- Delete confirmation shows inline "Remove [name]? [Cancel] [Remove]" pattern
- Reuses ChipInput component from Story 13-1

#### 2026-04-07 — Review Follow-ups Addressed

- ✅ Resolved review finding [High]: FeatureEditor is now integrated into `project-edit-modal.tsx`. Imported, added to `FormData`, deep-cloned in `buildFormData`, deep-compared in `isFormDirty` via new `featuresEqual()` helper, rendered in the Features Collapsible, and included in the `handleSave` payload + post-save `setInitialData`.
- ✅ Resolved review finding [Med]: Features accordion header now shows `Features & Services (N)` matching the AC4 contract.
- Build + tests verified clean (23/23 pages, 2/2 tests). Modal Features section is now fully functional end-to-end.

### File List

- src/components/projects/feature-editor.tsx (new)
- src/components/projects/project-edit-modal.tsx (modified, 2026-04-07 — FeatureEditor integration + features in FormData/save payload + accordion count)

### Review Follow-ups (AI)

- [x] [AI-Review][High] **Integrate FeatureEditor into the modal's Features section (AC: all)** — `src/components/projects/project-edit-modal.tsx` ✅ Resolved 2026-04-07
  1. Imported `FeatureEditor` from `./feature-editor`
  2. Added `features: Feature[]` to `FormData` interface
  3. `buildFormData` deep-clones features (each one's awsServices/aiProviders/integrations arrays spread)
  4. `isFormDirty` uses a new `featuresEqual()` helper that compares id/name/status and array equality of awsServices, aiProviders, integrations
  5. Placeholder JSX replaced with `<FeatureEditor features={formData.features} onChange={(features) => setFormData((prev) => (prev ? { ...prev, features } : prev))} />`
  6. `handleSave` payload now includes `features: formData.features`
  7. Post-save `setInitialData` deep-clones features so subsequent edits dirty-check correctly
- [x] [AI-Review][Med] **Add count to Features accordion header (AC #4)** — `src/components/projects/project-edit-modal.tsx` ✅ Resolved 2026-04-07. SectionHeader title is now `` `Features & Services (${formData.features.length})` `` matching the pattern used by the Team section.

## Change Log

| Date       | Version | Description                                                                                     | Author |
| ---------- | ------- | ----------------------------------------------------------------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended                                                          | Richie |
| 2026-04-07 | 0.1.2   | Addressed code review findings - 2 items resolved (FeatureEditor integration + accordion count) | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **🚫 BLOCKED** (1 High finding — FeatureEditor is orphaned; 1 Medium — AC4 header count not implemented)

### Summary

The FeatureEditor component itself is well-built (`feature-editor.tsx:1-167`): inline name input, status dropdown, three ChipInput integrations with proper variants and suggestion lists, add button, inline delete confirmation. Theme tokens used correctly throughout.

**However**, just like Story 12-1's modal-not-wired-up problem and Story 9-2's charts-not-theme-aware problem, **FeatureEditor is completely orphaned** — verified by grep, the only references are inside its own definition file. The modal's Features accordion (`project-edit-modal.tsx:622-630`) currently shows hardcoded placeholder text: _"Feature editor coming soon."_

Additionally, AC4's "header count" requirement is not met — the modal section header just says "Features" with no count.

This blocks the entire story because the user-facing feature is unreachable.

### Key Findings

**HIGH**

- **FeatureEditor component is orphaned** — `src/components/projects/project-edit-modal.tsx:622-630`
  - Verified by grep: `FeatureEditor` only appears in its own definition file
  - The modal renders this hardcoded placeholder instead of the component:
    ```tsx
    <Collapsible open={featuresOpen} ...>
      <SectionHeader title="Features" open={featuresOpen} />
      <CollapsibleContent>
        <div className="px-3 pb-4 pt-2">
          <p className="text-sm text-muted-foreground">Feature editor coming soon.</p>
        </div>
      </CollapsibleContent>
    </Collapsible>
    ```
  - The `FormData` interface (`:54-62`) doesn't include `features`, so even if the component were rendered, the form state wouldn't track changes
  - The `handleSave` payload (`:340-348`) doesn't include `features`, so changes wouldn't persist
  - **All of AC1, AC2, AC3 are technically implemented in the component file but unreachable**

**MEDIUM**

- **AC4 not implemented: header count missing** — `src/components/projects/project-edit-modal.tsx:624`
  - AC4: _"Accordion header shows count: 'Features & Services (5)'"_
  - Current: `<SectionHeader title="Features" open={featuresOpen} />` — no count, no "& Services" suffix
  - Compare to the correctly-implemented Team section at `:634`: `<SectionHeader title={`Team (${formData.team.length})`}` — this is the pattern that should be applied to Features
  - Requires `features` in FormData first (which is the HIGH finding above)

### Acceptance Criteria Coverage

| AC  | Description                                                                | Status                                    | Evidence                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC1 | Feature row: name, status badge, AWS/AI/Integration chips                  | **IMPLEMENTED IN COMPONENT, UNREACHABLE** | `feature-editor.tsx:78-152` — name Input, status Select, 3 ChipInputs with correct variants and suggestions from `AWS_SERVICES`/`AI_PROVIDERS`/`INTEGRATIONS`                              |
| AC2 | "+ Add Feature" with empty name (focused), status "planning", empty arrays | **IMPLEMENTED IN COMPONENT, UNREACHABLE** | `feature-editor.tsx:29-39` (`addFeature`), `:157-163` (button). **Auto-focus on the new feature's name input is NOT implemented** — the dev didn't pass a ref/autoFocus. Minor sub-finding |
| AC3 | Delete with inline confirmation "Remove [name]?"                           | **IMPLEMENTED IN COMPONENT, UNREACHABLE** | `feature-editor.tsx:53-74` — Cancel/Remove buttons in confirmation state                                                                                                                   |
| AC4 | Accordion header shows count "Features & Services (5)"                     | **NOT IMPLEMENTED**                       | See Medium finding                                                                                                                                                                         |

**Summary: 3 of 4 ACs implemented in the component file but unreachable due to integration gap; 1 AC (header count) not implemented at all.**

### Task Completion Validation

| Task                                                 | Marked | Verified                        | Evidence                                                          |
| ---------------------------------------------------- | ------ | ------------------------------- | ----------------------------------------------------------------- |
| 1. Create feature-editor.tsx                         | [x]    | **VERIFIED** (component exists) | File present, well-structured                                     |
| 2. Wire ChipInput with variant-specific autocomplete | [x]    | **VERIFIED**                    | 3 ChipInput instances with correct variants and suggestion arrays |
| 3. Add/delete feature logic                          | [x]    | **VERIFIED**                    | `addFeature`, `removeFeature`, confirmation state                 |

**Summary: 3 of 3 tasks structurally complete IN THE COMPONENT, but the missing modal integration is implicit in Task 1's "Create" scope and is what blocks usability.**

### Architectural Alignment

- ✅ **Reuses ChipInput correctly** — passes correct variant per chip type and the appropriate constants array
- ✅ **`crypto.randomUUID()` for new feature IDs** — matches the seed-projects pattern
- ✅ **Inline confirmation pattern** — appropriate for destructive actions in a list
- ✅ **Theme tokens throughout the new component** — `border-border`, `bg-background`, `text-muted-foreground`, `text-destructive`
- ❌ **Not integrated into the modal** — see HIGH finding

### Action Items

**Code Changes Required (Blocking):**

- [x] **[High] Integrate FeatureEditor into modal Features section** ✅ Resolved 2026-04-07 — see Review Follow-ups for the applied changes
- [x] **[Med] Add count to Features accordion header** ✅ Resolved 2026-04-07
- [x] **[Low] Auto-focus the new feature's Name input on add** ✅ Resolved 2026-04-07 — used a callback `ref` Map keyed by feature.id + a `newFeatureIdRef` set during `addFeature()` and consumed by a `useEffect([features])` that calls `.focus()` on the matching input then clears the ref. This avoids stealing focus from other inputs on every re-render.

**Advisory Notes:**

- Note: After integration is done, add a Playwright test for the full flow: open modal → add feature → set name → add chips → save → reopen → verify persistence
