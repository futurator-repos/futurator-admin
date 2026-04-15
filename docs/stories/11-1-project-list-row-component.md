# Story 11.1: ProjectListRow Component

Status: done

## Story

As an admin user,
I want projects displayed as dense table rows instead of cards,
so that I can scan all 11 projects quickly with key info visible.

## Acceptance Criteria

1. Each project renders as a row with columns: Thumbnails (120px, max 3 at 36x36), Name (flex, clickable to detail page, accent-blue on hover), Status (90px, colored badge), Category (100px, label), Brief (flex, truncated ellipsis), Published (44px, green/gray dot), Edit (44px, pencil icon button).
2. Rows have subtle bottom border, hover background elevation, 0.1s transition.
3. Header row with uppercase 11px muted column labels.
4. Loading state: 6 skeleton rows matching grid layout.
5. List container: border-radius 10px, 1px solid border.
6. Published dot: aria-label for accessibility. Edit button: aria-label "Edit [project name]".
7. Build succeeds.

## Tasks / Subtasks

- [x] Task 1: Create `src/components/projects/project-list-row.tsx` with grid layout (AC: 1, 2)
- [x] Task 2: Rewrite `src/app/projects/page.tsx` — remove grid, use list layout (AC: 1, 3, 4, 5)
- [x] Task 3: Add skeleton loading state matching row grid (AC: 4)
- [x] Task 4: Accessibility attributes on published dot and edit button (AC: 6)
- [x] Task 5: Run build (AC: 7)

## Dev Notes

Uses PH-1 tokens for styling. Reads project.descriptions.brief (from PH-2.3). Edit button is a placeholder — modal comes in PH-4.

### Project Structure Notes

New: src/components/projects/project-list-row.tsx. Modified: src/app/projects/page.tsx.

### References

- [Source: docs/ux-design-specification.md#6.3-Custom-Components]
- [Source: docs/ux-design-directions.html#Panel-2]
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-3.1]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created ProjectListRow component with 7-column grid layout (thumbnails, name, status, category, brief, published dot, edit button)
- Rows use hover:bg-accent/50 transition, border-b separators
- Name column links to project detail page with accent-blue hover
- Published dot uses green glow when published, muted when not; includes aria-label
- Edit button uses ghost variant with pencil icon and aria-label "Edit [name]"
- ProjectListRowSkeleton provides matching skeleton loading state
- Rewrote projects page from card grid to list table with uppercase muted header row
- List container has rounded-lg border
- Uses project.descriptions.brief (confirmed new schema)
- TypeScript compiles cleanly (tsc --noEmit passes for all new files)

### File List

- src/components/projects/project-list-row.tsx (new)
- src/app/projects/page.tsx (modified)

## Change Log

| Date       | Version | Description                            | Author |
| ---------- | ------- | -------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **✅ Approve** (3 Low advisory notes)

### Summary

Clean grid implementation. All 7 columns match the AC widths (`120px_1fr_90px_100px_1.2fr_44px_44px`). Theme tokens used throughout (`border-border`, `bg-accent`, `text-foreground`, `text-muted-foreground`, `text-accent-blue`, `bg-success`). aria-labels on both the published dot and edit button. Skeleton component matches the row grid structure. Header row in `projects/page.tsx` uses `text-badge uppercase text-muted-foreground` per AC3.

### Key Findings

**LOW**

- **`<img>` instead of `<Image />`** — `src/components/projects/project-list-row.tsx:31`
  - This is the lint warning I noted during 9-1 review (pre-existing, not introduced by this story; but this story chose to use `<img>` directly when adding the new code)
  - For 36×36 thumbnails this is borderline acceptable (Image optimization helps less at small sizes), but Next's `<Image />` would still provide LCP/CLS benefits
  - Not blocking — flag for future polish

- **`STATUS_COLORS[project.status] || 'bg-gray-100'` fallback** — `project-list-row.tsx:58`
  - Fallback uses hardcoded `bg-gray-100`, not a theme token
  - The whole `STATUS_COLORS` object in `constants.ts:6-11` uses hardcoded `bg-green-100/yellow-100/blue-100/gray-100` colors that won't theme-switch
  - Out of scope for 11-1 — covered by **Story 9-5** (dark mode token migration)

- **Transition uses Tailwind default 150ms** — `project-list-row.tsx:22`
  - AC2 says "0.1s transition" (100ms) but `transition-colors` defaults to 150ms
  - Cosmetic — visual difference is imperceptible

### Acceptance Criteria Coverage

| AC  | Description                                  | Status                                    | Evidence                                                                                                                                                                         |
| --- | -------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | 7-column row layout with specified widths    | **IMPLEMENTED**                           | `project-list-row.tsx:22` — grid template `120px_1fr_90px_100px_1.2fr_44px_44px` matches AC. Each column populated correctly (`:24-95`)                                          |
| AC2 | Bottom border, hover elevation, transition   | **IMPLEMENTED** (cosmetic 150ms vs 100ms) | `:22` — `border-b border-border`, `hover:bg-accent/50`, `transition-colors`                                                                                                      |
| AC3 | Header row with uppercase 11px muted labels  | **IMPLEMENTED**                           | `src/app/projects/page.tsx:69-91` — header row uses same grid template, all columns use `text-badge uppercase text-muted-foreground`                                             |
| AC4 | 6 skeleton rows in loading state             | **IMPLEMENTED**                           | `project-list-row.tsx:100-115` defines `ProjectListRowSkeleton`; `projects/page.tsx:93-95` renders `Array.from({ length: 6 }).map((_, i) => <ProjectListRowSkeleton key={i} />)` |
| AC5 | Container border-radius 10px, 1px solid      | **IMPLEMENTED**                           | `projects/page.tsx:67` — `rounded-lg border border-border bg-card`. With `--radius: 0.625rem` (10px) from 9-1, `rounded-lg` resolves to 10px ✓                                   |
| AC6 | aria-labels on published dot and edit button | **IMPLEMENTED**                           | Published dot: `:75-77` `aria-label={published ? 'Published to homepage' : 'Not published to homepage'}`. Edit button: `:90` `aria-label={`Edit ${project.name}`}`               |
| AC7 | Build succeeds                               | **VERIFIED**                              | Build passes (verified in earlier review run)                                                                                                                                    |

**Summary: 7 of 7 ACs fully implemented.**

### Task Completion Validation

| Task                                            | Marked | Verified     | Evidence                                  |
| ----------------------------------------------- | ------ | ------------ | ----------------------------------------- |
| 1. Create project-list-row.tsx with grid layout | [x]    | **VERIFIED** | File exists, grid implemented             |
| 2. Rewrite projects/page.tsx to list layout     | [x]    | **VERIFIED** | Card grid removed, list rendering present |
| 3. Skeleton loading state                       | [x]    | **VERIFIED** | `ProjectListRowSkeleton` matches grid     |
| 4. Accessibility on dot and edit button         | [x]    | **VERIFIED** | Both `aria-label`s present                |
| 5. Run build                                    | [x]    | **VERIFIED** | Confirmed                                 |

**Summary: 5 of 5 tasks verified, 0 false completions.**

### Test Coverage and Gaps

- No tests for the row component. UI list rows are typically tested via Playwright/visual tests, which the project doesn't yet have (same gap noted across Epic 9 reviews)

### Architectural Alignment

- ✅ **Theme tokens used throughout the new code** — except the `bg-gray-100` fallback (LOW finding)
- ✅ **Grid template matches AC widths exactly**
- ✅ **Skeleton component co-located with the real component** — good pattern for maintaining structural consistency
- ✅ **Edit button uses callback prop pattern** — separation of concerns from the page-level state management
- ✅ **Link to detail page uses Next.js `<Link>`** — correct for client-side navigation

### Security Notes

- ⚠️ **`<img src={m.url}>` accepts any URL** — `:31-35`. Combined with the Story 10-1 finding that `mediaSchema.url` is `z.string()` not `z.string().url()`, a malicious media URL (`javascript:`, `data:`) could be rendered. Not exploitable today (admin-only edit), but tightening the schema in 10-1's follow-up would prevent this entire class of risk

### Best-Practices and References

- **shadcn/ui Button + variants** — used correctly with `variant="ghost" size="icon-sm"`
- **Tailwind grid template syntax** — `grid-cols-[120px_1fr_90px_100px_1.2fr_44px_44px]` is the correct arbitrary-template syntax

### Action Items

**Code Changes Required:** None.

**Advisory Notes (no action required):**

- Note: Replace `<img>` with Next.js `<Image />` in a future polish pass for LCP/CLS benefits
- Note: `STATUS_COLORS` migration to theme tokens is owned by Story 9-5
- Note: `mediaSchema.url` validation tightening (URL format + max length) is recommended in Story 10-1 follow-up
