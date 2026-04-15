# Story 11.2: FilterBar with Sorting

Status: done

## Story

As an admin user,
I want to filter projects by status, category, and published state, and sort by various fields,
so that I can quickly narrow down what I need.

## Acceptance Criteria

1. Three filter dropdowns: Status (multi-select), Category (multi-select), Published (All/Published/Not Published).
2. Sort dropdown (right-aligned): Name A-Z, Name Z-A, Status, Category, Last Updated, Homepage Order.
3. Active filters as removable chips below filter bar.
4. Count updates: "Projects (4 of 11)".
5. Client-side filtering — instant, no loading.
6. Default: no filters, sort Name A-Z.
7. Empty state: "No projects match your filters" with "Clear filters" button.

## Tasks / Subtasks

- [x] Task 1: Create `src/components/projects/filter-bar.tsx` (AC: 1, 2, 3)
- [x] Task 2: Implement client-side filter/sort logic with useMemo (AC: 5, 6)
- [x] Task 3: Wire into projects page with count display (AC: 4)
- [x] Task 4: Empty state for no results (AC: 7)

## Dev Notes

All filtering is client-side with useMemo. Only 11 projects — no server-side needed. Filter state is ephemeral (not persisted).

### Project Structure Notes

New: src/components/projects/filter-bar.tsx. Modified: src/app/projects/page.tsx.

### References

- [Source: docs/ux-design-specification.md#6.3-Custom-Components]
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-3.2]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created FilterBar component with three filter dropdowns (Status, Category, Published) and one sort dropdown (right-aligned)
- Filters: Status (All/Planning/In Progress/Beta/Active), Category (All/Personal/Independent/Joint Venture/Shared Infra), Published (All/Published/Not Published)
- Sort options: Name A-Z (default), Name Z-A, Status, Category, Last Updated
- Active filters shown as removable chips with accent-blue styling below filter bar
- useMemo drives client-side filtering/sorting -- instant, no loading states
- Empty state "No projects match your filters" with "Clear filters" button rendered inside FilterBar
- Projects page shows count as "(4 of 11)" when filtered, "(11)" when unfiltered
- Adapted to base-ui Select API: onValueChange receives nullable value, handled with null guard
- useCallback wraps onFilteredChange to stabilize reference

#### 2026-04-07 — Review Follow-ups Addressed

- ✅ Resolved review finding [Med]: Status filter is now multi-select via `DropdownMenu` + `DropdownMenuCheckboxItem`. State: `Set<ProjectStatus>` (empty = all). Filter: `if (statusFilter.size > 0) result = result.filter((p) => statusFilter.has(p.status))`.
- ✅ Resolved review finding [Med]: Category filter migrated to the same multi-select pattern with `Set<ProjectCategory>`.
- ✅ Resolved review finding [Med]: Added 6th sort option "Homepage Order". `SortKey` union now: `'name-asc' | 'name-desc' | 'status' | 'category' | 'updated' | 'homepage-order'`. Sort case: `(a.homepageOrder ?? 0) - (b.homepageOrder ?? 0)`.
- Active-filter chip rendering rebuilt: one chip per selected status/category, plus the published chip when applicable. Each chip has its own remove (X) handler that deletes only that value from the Set.
- Trigger button labels are dynamic: "Status: All" / "Status: Planning" / "Status: 3 selected". Same pattern for Category.
- Verified: `npm run build` ✓ (23/23 pages); `npm test` ✓ (2/2). TypeScript clean. AC8 grep clean (no hardcoded color classes introduced).

### File List

- src/components/projects/filter-bar.tsx (new, rewritten 2026-04-07 for multi-select)
- src/app/projects/page.tsx (modified)

### Review Follow-ups (AI)

- [x] [AI-Review][Med] **Implement multi-select for Status and Category filters (AC #1)** — `src/components/projects/filter-bar.tsx`. ✅ Resolved 2026-04-07 — replaced both single-select `<Select>`s with `DropdownMenu` + `DropdownMenuCheckboxItem` (base-ui's Menu CheckboxItem defaults to `closeOnClick={false}`, perfect for multi-select). State now uses `Set<ProjectStatus>` / `Set<ProjectCategory>` (empty Set = "all"). Filter logic uses `.has()`. Active-filter chips render one per selected value with individual remove. Trigger button label adapts: "Status: All" / "Status: Planning" / "Status: 3 selected".
- [x] [AI-Review][Med] **Add "Homepage Order" sort option (AC #2)** — `src/components/projects/filter-bar.tsx`. ✅ Resolved 2026-04-07 — added `'homepage-order'` to the `SortKey` union, added `<SelectItem value="homepage-order">Sort: Homepage Order</SelectItem>`, and `case 'homepage-order': return (a.homepageOrder ?? 0) - (b.homepageOrder ?? 0);` in the sort switch. All 6 AC2 sort options now present.

## Change Log

| Date       | Version | Description                                                                                                         | Author |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended                                                                              | Richie |
| 2026-04-07 | 0.1.2   | Addressed code review findings - 3 items resolved (multi-select Status, multi-select Category, Homepage Order sort) | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **Changes Requested** (2 Medium findings — both are AC partial-implementations)

### Summary

The filter and sort plumbing is well-built: client-side `useMemo` filtering is fast, the empty state and clear-filters flow is correct, active filters render as removable chips with theme-token styling, and the count display in `projects/page.tsx` correctly shows "(N of M)" when filtered. **However, two AC requirements are not met:**

1. **AC1 explicitly says "multi-select" for Status and Category** — current implementation uses single-select dropdowns. You can only filter by ONE status at a time, not multiple. This is a substantive feature gap.
2. **AC2 lists 6 sort options including "Homepage Order"** — only 5 are implemented (Homepage Order missing). This blocks the natural workflow of "sort projects by their homepage display order to validate the publishing pipeline."

Both findings are MEDIUM (not HIGH) because the existing single-select / 5-sort behavior works correctly for what it implements — it's just incomplete relative to the AC contract.

### Key Findings

**MEDIUM**

- **AC1: Status and Category use single-select instead of multi-select** — `src/components/projects/filter-bar.tsx:96-110, 112-126`
  - AC1: _"Three filter dropdowns: Status (multi-select), Category (multi-select), Published (All/Published/Not Published)"_
  - Current: `<Select value={statusFilter} onValueChange={...}>` — single-value Select component
  - State: `useState<StatusFilter>('all')` where `StatusFilter = ProjectStatus | 'all'` — can only hold one value
  - Filter logic: `if (statusFilter !== 'all') result = result.filter((p) => p.status === statusFilter);` — single comparison
  - **Impact:** A user cannot filter for "show me planning + in-progress projects" simultaneously, which is a core scan-and-narrow workflow on a project list of 11
  - Fix: replace with a multi-select pattern (Set or array state, .has() or .includes() filter, multiple chips on display)

- **AC2: "Homepage Order" sort option missing** — `src/components/projects/filter-bar.tsx:20, 150-156`
  - AC2: _"Sort dropdown (right-aligned): Name A-Z, Name Z-A, Status, Category, Last Updated, Homepage Order"_ — 6 options
  - Current: 5 SelectItems for sortKey (missing `homepage-order`)
  - SortKey type: `'name-asc' | 'name-desc' | 'status' | 'category' | 'updated'` — 5 values
  - Switch statement covers 5 cases plus default
  - **Impact:** No way to validate "are my published projects in the right display order" via sort. This is the natural QA path for Story 14 (homepage publish pipeline)

### Acceptance Criteria Coverage

| AC  | Description                                                     | Status          | Evidence                                                                                                                                                      |
| --- | --------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | 3 filter dropdowns: Status (multi), Category (multi), Published | **PARTIAL**     | All 3 dropdowns exist (`:96-140`), but Status and Category are **single-select**, not multi-select as required. Published is correctly single-select per spec |
| AC2 | Sort dropdown right-aligned with 6 options                      | **PARTIAL**     | Right-aligned via `ml-auto` (`:142`) ✓; sort dropdown exists ✓; **only 5 of 6 sort options implemented** (missing "Homepage Order")                           |
| AC3 | Active filters as removable chips                               | **IMPLEMENTED** | `:161-178` — chips with X button, accent-blue styling, individual `clear()` callbacks                                                                         |
| AC4 | Count "(4 of 11)" display                                       | **IMPLEMENTED** | `src/app/projects/page.tsx:43-50` — shows "(N of M)" when filtered, "(M)" when unfiltered                                                                     |
| AC5 | Client-side filtering, instant, no loading                      | **IMPLEMENTED** | `:35-66` — `useMemo` over `projects` + filter state, no async, no loading flags                                                                               |
| AC6 | Default no filters, sort Name A-Z                               | **IMPLEMENTED** | `:27-31` — initial state `'all'/'all'/'all'/'name-asc'`                                                                                                       |
| AC7 | Empty state with "Clear filters" button                         | **IMPLEMENTED** | `:180-193` — empty state shown when filtered set is empty AND filters are active; clear button calls `clearAllFilters()`                                      |

**Summary: 5 of 7 ACs fully implemented, 2 partial (AC1 and AC2).**

### Task Completion Validation

| Task                                    | Marked | Verified               | Evidence                                                                                                             |
| --------------------------------------- | ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1. Create filter-bar.tsx                | [x]    | **PARTIALLY VERIFIED** | File exists with 3 filter dropdowns + 1 sort, but multi-select missing on Status/Category, and 1 sort option missing |
| 2. Client-side filter/sort with useMemo | [x]    | **VERIFIED**           | `:35-66`                                                                                                             |
| 3. Wire into projects page with count   | [x]    | **VERIFIED**           | `projects/page.tsx:42-50`                                                                                            |
| 4. Empty state for no results           | [x]    | **VERIFIED**           | `:180-193`                                                                                                           |

**Summary: 4 of 4 tasks structurally complete, but Task 1 has 2 partial-implementation gaps relative to AC1/AC2. Not "false completions" — the dev did real work and was probably reading "multi-select" loosely. But the AC contract is explicit and not honored.**

### Test Coverage and Gaps

- No tests for filter/sort logic. This is testable in pure isolation (give the hook a list of projects, set filter state, assert filtered output). Recommended for a future test infrastructure story
- The multi-select fix will benefit from a unit test covering: 0 selected, 1 selected, multiple selected, all-deselected (should fall back to "all")

### Architectural Alignment

- ✅ **`useMemo` driven filtering** — correct for the data size and avoids re-computing on unrelated re-renders
- ✅ **`useCallback`-stabilized `onFilteredChange`** — prevents the parent state update from triggering effect loops
- ✅ **Theme tokens throughout** — chips use `border-accent-blue/30 bg-accent-blue/10 text-accent-blue`, empty state uses `text-muted-foreground`. **No `gray-*` hardcoding** — this story is a clean PH-1 token consumer
- ✅ **base-ui Select API adapted correctly** — `onValueChange` null-guards (`:98, 114, 130, 145`) handle the base-ui-vs-Radix difference noted in dev notes
- ⚠️ **Component is doing too much when multi-select is added** — at that point, consider extracting the filter logic into a `useProjectFilters(projects)` hook to keep the JSX manageable. Not actionable for this iteration

### Security Notes

- No security concerns. Pure client-side filtering of in-memory data. No injection vectors.

### Best-Practices and References

- **shadcn/ui Combobox / multi-select pattern** — [https://ui.shadcn.com/docs/components/combobox](https://ui.shadcn.com/docs/components/combobox) — the recommended primitive for multi-select. Alternative: build a checkbox dropdown manually with `<Popover>` + `<CheckboxGroup>`
- **TanStack Query + client-side filtering** — the current pattern (fetch all 11 projects via `useProjects()`, filter in-memory) is correct for the data scale. Don't over-engineer with server-side filtering

### Action Items

**Code Changes Required (Blocking):**

- [x] **[Med] Implement multi-select for Status filter** — `src/components/projects/filter-bar.tsx` ✅ Resolved 2026-04-07
  - State migrated to `useState<Set<ProjectStatus>>(() => new Set())`
  - UI replaced with `DropdownMenu` + `DropdownMenuCheckboxItem` (base-ui Menu CheckboxItem defaults to `closeOnClick={false}`)
  - Filter logic: `if (statusFilter.size > 0) result = result.filter((p) => statusFilter.has(p.status))`
  - Active filters: one chip per selected status with individual remove

- [x] **[Med] Implement multi-select for Category filter** — same pattern as Status ✅ Resolved 2026-04-07

- [x] **[Med] Add "Homepage Order" sort option** — `src/components/projects/filter-bar.tsx` ✅ Resolved 2026-04-07
  - `SortKey` union extended with `'homepage-order'`
  - Added `<SelectItem value="homepage-order">Sort: Homepage Order</SelectItem>`
  - Added case: `(a.homepageOrder ?? 0) - (b.homepageOrder ?? 0)`

**Advisory Notes (no action required):**

- Note: After multi-select is added, consider extracting filter logic to a `useProjectFilters(projects)` hook for testability
- Note: Add unit tests for the filter logic in a future test infrastructure story
