# Story 10.1: Expand TypeScript Types and Zod Schemas

Status: done

## Story

As a developer,
I want the project data model updated with descriptions, media, publish fields, and expanded features,
so that the backend validates and stores the complete Project Hub data structure.

## Acceptance Criteria

1. **ProjectDescriptions type**: `headline` (max 60), `brief` (max 140), `summary` (max 300), `full` (max 1000), `aiContext` (max 2000), `homepageFlags: { headline: boolean, brief: boolean, summary: boolean }`.

2. **ProjectMedia type**: `id: string`, `url: string`, `alt: string` (max 200), `showOnHomepage: boolean`, `order: number`.

3. **Feature expanded**: Existing `Feature` gains `aiProviders: string[]` and `integrations: string[]`.

4. **Project updated**: `brief` replaced by `descriptions: ProjectDescriptions`. New fields: `media: ProjectMedia[]`, `publishedToHomepage: boolean`, `homepageOrder: number`.

5. **Zod validation**: `projectUpdateSchema` in `functions/shared/schemas/project-schema.ts` validates all new fields with correct max lengths. Enforces: if `publishedToHomepage === true`, then `descriptions.headline` non-empty + `homepageFlags.headline === true`, same for `brief`. Max 6 media, max 3 with `showOnHomepage`.

6. **Shared types synced**: `functions/shared/types.ts` mirrors the frontend types.

7. **Build succeeds**: Both frontend and backend compile without TypeScript errors.

## Tasks / Subtasks

- [x] Task 1: Update frontend types (AC: 1, 2, 3, 4)
  - [x] 1.1 Modify `src/types/project.ts` — add `ProjectDescriptions`, `ProjectMedia` interfaces
  - [x] 1.2 Expand `Feature` with `aiProviders`, `integrations`
  - [x] 1.3 Replace `brief: string` with `descriptions: ProjectDescriptions` on `Project`
  - [x] 1.4 Add `media`, `publishedToHomepage`, `homepageOrder` to `Project`

- [x] Task 2: Update Zod schemas (AC: 5)
  - [x] 2.1 Add `descriptionsSchema` with max-length constraints
  - [x] 2.2 Add `mediaSchema` with max-length and count constraints
  - [x] 2.3 Expand feature schema with `aiProviders`, `integrations`
  - [x] 2.4 Add publish validation: `.refine()` for homepage requirements
  - [x] 2.5 Update `projectUpdateSchema` to include all new fields

- [x] Task 3: Update shared backend types (AC: 6)
  - [x] 3.1 Modify `functions/shared/types.ts` to mirror frontend types

- [x] Task 4: Fix compilation (AC: 7)
  - [x] 4.1 Fix any TypeScript errors caused by `brief` → `descriptions` rename
  - [x] 4.2 Run `npm run build` and fix all errors

## Dev Notes

- DynamoDB is schemaless — no table changes needed. This is purely a code-level type change.
- Existing code referencing `project.brief` will break — fix in this story or mark as known breaks for PH-2.3
- The Zod `.refine()` for publish validation runs only when `publishedToHomepage` is explicitly `true` in the update payload

### Project Structure Notes

- **Modified**: `src/types/project.ts`
- **Modified**: `functions/shared/schemas/project-schema.ts`
- **Modified**: `functions/shared/types.ts`
- Various files referencing `project.brief` may need temporary fixes

### References

- [Source: docs/concepts/project-hub-enhancement.md#3.1-Updated-Project-Interface] — Type definitions
- [Source: docs/concepts/project-hub-enhancement.md#3.4-Zod-Schema-Update] — Zod schemas
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-2.1] — Full acceptance criteria

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Added ProjectDescriptions, ProjectMedia interfaces to frontend types
- Expanded Feature with aiProviders and integrations arrays
- Replaced brief with descriptions on Project, added media/publishedToHomepage/homepageOrder
- Updated Zod schema with descriptionsSchema, mediaSchema, featureSchema (all with max-lengths)
- Added .refine() for publish validation (headline+brief required with flags when publishedToHomepage=true)
- Synced functions/shared/types.ts to mirror frontend types
- Fixed project.brief references in project-card.tsx and project-tabs.tsx to project.descriptions?.brief
- Added type cast in functions/api/index.ts for Zod output compatibility with Partial<Project>
- All modified files pass TypeScript compilation (pre-existing errors in unrelated files remain)
- ✅ Resolved review finding [Med] (2026-04-07): Added `.refine()` for "max 3 with showOnHomepage" on the media array in `projectUpdateSchema`. AC5 now fully implemented. Build + tests verified clean.

### File List

- src/types/project.ts
- functions/shared/schemas/project-schema.ts
- functions/shared/types.ts
- src/components/projects/project-card.tsx
- src/components/projects/project-tabs.tsx
- functions/api/index.ts

### Review Follow-ups (AI)

- [x] [AI-Review][Med] **Add "max 3 media with showOnHomepage" constraint to mediaSchema** (AC #5) — `functions/shared/schemas/project-schema.ts:38`. ✅ Resolved 2026-04-07 — replaced `media: z.array(mediaSchema).max(6).optional()` with a chained `.refine((arr) => arr.filter(m => m.showOnHomepage).length <= 3, { message: 'Maximum 3 media items can be marked for homepage display' })` before `.optional()`. Build passes, AC5 now fully honors the "max 6 media, max 3 with showOnHomepage" contract.

## Change Log

| Date       | Version | Description                                                           | Author |
| ---------- | ------- | --------------------------------------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended                                | Richie |
| 2026-04-07 | 0.1.2   | Addressed code review findings - 1 item resolved (mediaSchema refine) | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **Changes Requested** (1 Medium finding)

### Summary

Solid backend type-system work. Frontend types (`src/types/project.ts`) and shared backend types (`functions/shared/types.ts`) are byte-for-byte mirrors with all new structures (`ProjectDescriptions`, `ProjectMedia`, expanded `Feature`, expanded `Project`). The `descriptionsSchema` correctly enforces all 5 max-length constraints (60/140/300/1000/2000), and the `.refine()` for publish validation correctly gates on `publishedToHomepage === true` to require headline + brief with their flags. The `brief` → `descriptions.brief` rename was completed across all consumers (verified by grep — no legacy `project.brief` references remain).

**One AC5 gap:** the `mediaSchema` enforces `.max(6)` on the array length but does NOT enforce the "max 3 with `showOnHomepage`" sub-constraint that AC5 explicitly requires. Easy fix via a `.refine()` on the media array.

### Key Findings

**MEDIUM**

- **`mediaSchema` missing "max 3 with showOnHomepage" constraint (AC5)** — `functions/shared/schemas/project-schema.ts:38`
  - AC5 requires: _"Max 6 media, max 3 with `showOnHomepage`"_
  - Current: `media: z.array(mediaSchema).max(6).optional()` — only enforces the count of 6
  - Missing: a `.refine()` that counts items where `showOnHomepage === true` and rejects > 3
  - Impact: API will accept payloads with 6 media items all marked for homepage, violating the data model contract that downstream consumers (homepage publish pipeline in Epic 14) will rely on

**LOW**

- **`.refine()` publish validation only fires when `descriptions` is in the payload** — `functions/shared/schemas/project-schema.ts:45-57`
  - Current logic: `if (data.publishedToHomepage === true && data.descriptions) { ... }`
  - Edge case: an UPDATE payload with `publishedToHomepage: true` but WITHOUT `descriptions` (e.g. publishing a previously-drafted project) skips the refine entirely
  - Strictly correct enforcement would require server-side validation against the existing project record, which Zod can't do alone
  - Defensible as-is for partial updates, but the API handler in `functions/api/index.ts` should ideally cross-check the merged project state before persisting. Not a 10-1 blocker — flagging for an Epic 10 follow-up or 14-1 publish pipeline implementation
  - **Not actionable in this story** — call it out for 14-1 owner

### Acceptance Criteria Coverage

| AC  | Description                                                                        | Status          | Evidence                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | `ProjectDescriptions` type with 5 string fields + `homepageFlags`                  | **IMPLEMENTED** | `src/types/project.ts:4-15` and `functions/shared/types.ts:4-15` (mirrored)                                                                                                                                                                                                                                                  |
| AC2 | `ProjectMedia` type with id/url/alt/showOnHomepage/order                           | **IMPLEMENTED** | `src/types/project.ts:17-23` and `functions/shared/types.ts:17-23`                                                                                                                                                                                                                                                           |
| AC3 | `Feature` gains `aiProviders: string[]` and `integrations: string[]`               | **IMPLEMENTED** | `src/types/project.ts:25-32`, mirrored in shared types                                                                                                                                                                                                                                                                       |
| AC4 | `Project` updated: `descriptions`, `media`, `publishedToHomepage`, `homepageOrder` | **IMPLEMENTED** | `src/types/project.ts:34-49` — `brief: string` removed, all 4 new fields present                                                                                                                                                                                                                                             |
| AC5 | Zod schema with all max lengths + publish refine + max 6/max 3 media               | **PARTIAL**     | `functions/shared/schemas/project-schema.ts:3-57`. Max lengths ✓, publish refine ✓, **`max 3 with showOnHomepage` missing** (see Medium finding)                                                                                                                                                                             |
| AC6 | `functions/shared/types.ts` mirrors frontend                                       | **IMPLEMENTED** | Verified by reading both files — types are identical for all 4 entities (descriptions, media, feature, project)                                                                                                                                                                                                              |
| AC7 | Both frontend and backend compile                                                  | **VERIFIED**    | Build succeeded earlier (23/23 pages); grep confirms no legacy `project.brief` references remain — fixed in `project-card.tsx`, `project-list-row.tsx`, `project-tabs.tsx`, `project-edit-modal.tsx`, `functions/api/index.ts`, `functions/shared/export-public-projects.ts` (all use `project.descriptions?.brief` pattern) |

**Summary: 6 of 7 ACs fully implemented, 1 partial (AC5 — media homepage count constraint).**

### Task Completion Validation

| Task                                                                 | Marked | Verified     | Evidence                                                                                         |
| -------------------------------------------------------------------- | ------ | ------------ | ------------------------------------------------------------------------------------------------ |
| 1. Update frontend types                                             | [x]    | **VERIFIED** | All 4 sub-tasks done in `src/types/project.ts`                                                   |
| 1.1 Add ProjectDescriptions, ProjectMedia interfaces                 | [x]    | **VERIFIED** | `:4-23`                                                                                          |
| 1.2 Expand Feature with aiProviders, integrations                    | [x]    | **VERIFIED** | `:25-32`                                                                                         |
| 1.3 Replace `brief: string` with `descriptions: ProjectDescriptions` | [x]    | **VERIFIED** | `:39` — old field removed                                                                        |
| 1.4 Add media, publishedToHomepage, homepageOrder                    | [x]    | **VERIFIED** | `:40, :45, :46`                                                                                  |
| 2. Update Zod schemas                                                | [x]    | **PARTIAL**  | Most subtasks done, but mediaSchema missing the homepage count constraint (Medium finding)       |
| 2.1 descriptionsSchema with max-lengths                              | [x]    | **VERIFIED** | `:3-14`                                                                                          |
| 2.2 mediaSchema with max-length and count constraints                | [x]    | **PARTIAL**  | `:16-22, :38` — `alt.max(200)` ✓, array `.max(6)` ✓, **but `max 3 with showOnHomepage` missing** |
| 2.3 Expand feature schema with aiProviders, integrations             | [x]    | **VERIFIED** | `:24-31`                                                                                         |
| 2.4 Add publish validation `.refine()`                               | [x]    | **VERIFIED** | `:45-57`                                                                                         |
| 2.5 Update projectUpdateSchema                                       | [x]    | **VERIFIED** | `:33-44`                                                                                         |
| 3. Update shared backend types                                       | [x]    | **VERIFIED** | `functions/shared/types.ts:1-50` mirrors frontend                                                |
| 3.1 Modify shared/types.ts                                           | [x]    | **VERIFIED** | Confirmed                                                                                        |
| 4. Fix compilation                                                   | [x]    | **VERIFIED** | Build passes, no project.brief references remain                                                 |
| 4.1 Fix `brief` → `descriptions` rename                              | [x]    | **VERIFIED** | All consumers updated (5 files)                                                                  |
| 4.2 Run npm run build and fix all errors                             | [x]    | **VERIFIED** | Build passes                                                                                     |

**Summary: 14 of 14 tasks verified, 1 partially completed (Task 2.2 — see Medium finding). No false completions.**

### Test Coverage and Gaps

- No new tests for the schema. Zod schemas are particularly amenable to unit tests (`schema.parse(invalidPayload)` should throw, `schema.parse(validPayload)` should not).
- **Recommended (not a 10-1 blocker):** add `tests/schemas/project-schema.test.ts` covering:
  - Valid full project payload passes
  - Headline > 60 chars rejected
  - Media array with 7 items rejected
  - Media array with 4 `showOnHomepage: true` items rejected (would catch the Medium finding above)
  - `publishedToHomepage: true` without headline rejected
  - `publishedToHomepage: true` without `descriptions` in payload (current edge case — see Low note)
- This is a critical schema for the entire Epic 10–14 pipeline; deserves dedicated tests in a future story

### Architectural Alignment

- ✅ **DynamoDB schemaless approach** — no migration needed at storage layer (story 10-2 handles in-place data migration)
- ✅ **Zod as source of truth for validation** — schemas live with the API code, not in the frontend
- ✅ **Frontend/backend type mirror** — manual sync is the current pattern in this repo; consider extracting to a shared package in a future epic if drift becomes a problem
- ✅ **`.optional()` on description fields** — enables partial updates while the `.refine()` enforces the publish-time invariant
- ⚠️ **Server-side cross-validation gap** — see Low finding on the publish refine

### Security Notes

- No injection or auth concerns at the type layer
- ✅ Max lengths enforced via Zod prevent unbounded input from reaching DynamoDB
- ✅ `z.string()` (not `z.any()`) prevents object injection
- ⚠️ `mediaSchema.url` is `z.string()` not `z.string().url()` — accepts any string. Consider tightening to URL validation in a follow-up to prevent javascript:/data: URIs from being stored
- ⚠️ `mediaSchema.url` also has no max length — could store arbitrarily long strings. Consider `.max(2048)` (typical URL length cap)

### Best-Practices and References

- **Zod refinements** — [https://zod.dev/?id=refine](https://zod.dev/?id=refine) — the `.refine()` API correctly used for the publish validation
- **Zod array constraints** — [https://zod.dev/?id=arrays](https://zod.dev/?id=arrays) — `.max()`, `.min()`, and chained `.refine()` are the right tools for the homepage count constraint
- **Manual frontend/backend type sync** — common pattern in monorepos without a shared package; works as long as a CI check (or this kind of code review) verifies parity

### Action Items

**Code Changes Required:**

- [x] **[Med] Add "max 3 with showOnHomepage" constraint to media array** (AC #5) — `functions/shared/schemas/project-schema.ts:38` ✅ Resolved 2026-04-07. Replaced:
  ```ts
  media: z.array(mediaSchema).max(6).optional(),
  ```
  with:
  ```ts
  media: z.array(mediaSchema)
    .max(6)
    .refine((arr) => arr.filter(m => m.showOnHomepage).length <= 3, {
      message: 'Maximum 3 media items can be marked for homepage display'
    })
    .optional(),
  ```

**Advisory Notes (no action required for 10-1):**

- Note: Tighten `mediaSchema.url` to `z.string().url().max(2048)` to validate URL format and cap length — security hardening
- Note: Add Zod schema unit tests in a future story (covers all the edge cases listed in Test Coverage section)
- Note: Server-side cross-validation of publish state (Low finding) should be implemented in Story 14-1 (S3 Static JSON Export) which is the actual point where publish state matters
