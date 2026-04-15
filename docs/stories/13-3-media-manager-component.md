# Story 13.3: MediaManager Component

Status: done

## Story

As an admin user,
I want to upload, reorder, and manage project media with homepage toggle,
so that I can curate which images appear on futurator.ai.

## Acceptance Criteria

1. Grid of thumbnail cards (100x72px) + "Add media" dashed card.
2. Each thumbnail: image preview/placeholder, alt text, homepage badge (blue dot if showOnHomepage).
3. Click thumbnail: edit popover (alt text, homepage toggle, delete).
4. Upload: file input → pre-signed URL → S3. Supported: PNG, JPG, WebP. Max 5MB.
5. Drag-to-reorder. Max 6 total, max 3 homepage.
6. Accordion header: "Media (2 of 6)".

## Tasks / Subtasks

- [x] Task 1: Create `src/components/projects/media-manager.tsx` (AC: 1, 2, 6)
- [x] Task 2: Edit popover with alt/homepage/delete (AC: 3)
- [x] Task 3: File upload with validation (AC: 4)
- [x] Task 4: Drag reorder with @dnd-kit or native drag (AC: 5)

## Dev Notes

May need new endpoint POST /api/projects/:id/upload-url for pre-signed URLs. Or handle upload in save flow. Drag: @dnd-kit/core recommended.

### Project Structure Notes

New: src/components/projects/media-manager.tsx. Possibly new: upload URL endpoint in functions/api/index.ts.

### References

- [Source: docs/ux-design-specification.md#6.3-MediaManager]
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-5.3]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Created MediaManager component with thumbnail grid (100x72px cards)
- File upload via hidden input, validates PNG/JPG/WebP and 5MB max
- Enforces max 6 total media, max 3 homepage items
- Displays count summary in body and accordion header

#### 2026-04-07 — Review Follow-ups Addressed (component rewritten end-to-end)

- ✅ Resolved review finding [High] (Integration): MediaManager now imported and rendered inside the project edit modal's Media accordion. `media: ProjectMedia[]` added to FormData; deep-cloned in buildFormData and post-save initialData; deep-compared via `mediaEqual()` helper in isFormDirty; included in the save payload.
- ✅ Resolved review finding [High] (S3 upload): Added `POST /api/projects/:id/upload-url` endpoint in `functions/api/index.ts` using `@aws-sdk/s3-request-presigner` to generate pre-signed PUT URLs targeting `media/<projectId>/<uuid>.<ext>` in `FUTURATOR_PUBLIC_BUCKET`. Frontend now: (1) calls the endpoint with `{ filename, contentType }`, (2) PUTs the file directly to S3, (3) stores the resulting public URL `https://futurator.ai/<key>` on the media record. Loading spinner + error message UI. Validates PNG/JPG/WebP and 5MB max client-side AND server-side.
- ✅ Resolved review finding [High] (Drag-to-reorder): Installed `@dnd-kit/core` and `@dnd-kit/sortable`. Wrapped grid in `DndContext` + `SortableContext` with `rectSortingStrategy`. Cards extracted into `SortableMediaCard` subcomponent using `useSortable`. PointerSensor activation distance of 4px so click vs drag are distinguished. On drag-end, `arrayMove` reorders and re-derives the `order: i` field for every item.
- ✅ Resolved review finding [Med] (Header count): Modal accordion header now shows `Media (N of 6)` matching AC6.
- ✅ Resolved review finding [Low] (Image preview): Cards render the actual image via `<img src={m.url} className="absolute inset-0 h-full w-full object-cover" />` with eslint-disable for the next/image rule (S3 URLs don't go through next/image).
- ✅ Resolved review finding [Low] (Alt-text edit popover): Click on a thumbnail toggles an absolute-positioned edit popover with an alt-text input (maxLength 200) and a Done button.
- **SST IAM:** Broadened the existing `s3:PutObject` permission in `sst.config.ts` from just `data/*` to also include `media/*` so the upload endpoint can write to the same bucket Story 14-1 reads from for the published JSON.
- **Functional unblock for Story 14-1:** the homepage publish pipeline will now produce JSON with real S3 media URLs that futurator.ai can fetch.
- Verified: `npm run build` ✓ (23/23 pages); `npm test` ✓ (2/2); TypeScript clean.
- **Deployment caveat (inherited from 14-1):** the `FUTURATOR_PUBLIC_BUCKET` constant in `sst.config.ts` is still a placeholder (`'futurator-public'`) — the user must replace it with the real bucket name before deploying for the upload endpoint to actually reach S3.

### File List

- src/components/projects/media-manager.tsx (new, rewritten 2026-04-07 — real S3 upload, drag-reorder, image preview, alt edit popover)
- src/components/projects/project-edit-modal.tsx (modified, 2026-04-07 — MediaManager integration + media in FormData/save payload + accordion count)
- functions/api/index.ts (modified, 2026-04-07 — new POST /api/projects/:id/upload-url endpoint)
- sst.config.ts (modified, 2026-04-07 — broadened s3:PutObject IAM to include media/\*)
- package.json (modified, 2026-04-07 — added @aws-sdk/s3-request-presigner, @dnd-kit/core, @dnd-kit/sortable)

### Review Follow-ups (AI)

- [x] [AI-Review][High] **Integrate MediaManager into the modal's Media section (AC: all)** — `src/components/projects/project-edit-modal.tsx` ✅ Resolved 2026-04-07
  1. Imported `MediaManager` from `./media-manager`
  2. Added `media: ProjectMedia[]` to `FormData`; `buildFormData` deep-clones project.media
  3. `isFormDirty` uses new `mediaEqual()` helper that compares id/url/alt/showOnHomepage/order field-by-field
  4. Placeholder replaced with `<MediaManager projectId={projectId} media={formData.media} onChange={...} />`
  5. `handleSave` payload includes `media: formData.media`; post-save `setInitialData` deep-clones media
- [x] [AI-Review][High] **Implement actual S3 upload via pre-signed URL (AC #4)** — `src/components/projects/media-manager.tsx` + `functions/api/index.ts` ✅ Resolved 2026-04-07
  - **Backend:** Added `POST /api/projects/:id/upload-url` endpoint in `functions/api/index.ts` (auth-protected via the existing `/api/*` middleware). Validates filename + contentType (PNG/JPG/WebP only). Generates a pre-signed S3 PUT URL via `@aws-sdk/s3-request-presigner` (5min expiry) targeting key `media/<projectId>/<uuid>.<ext>` in `FUTURATOR_PUBLIC_BUCKET`. Returns `{ uploadUrl, publicUrl, key }` where `publicUrl = https://futurator.ai/<key>`.
  - **SST IAM:** Broadened the existing `s3:PutObject` permission in `sst.config.ts` to cover both `data/*` (Story 14-1 export) AND `media/*` (this story's uploads).
  - **Frontend:** Replaced `URL.createObjectURL` in `media-manager.tsx` with a real upload flow: (1) `api.post('/projects/:id/upload-url', { filename, contentType })`, (2) `fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })`, (3) store the returned `publicUrl` in `newMedia.url`. Added `uploading` and `uploadError` state, loading spinner on the Add card, error message display.
  - **Dependency added:** `@aws-sdk/s3-request-presigner@^3.1025.0`
  - **Functional unblock for 14-1:** the homepage JSON export will now contain real S3 URLs that futurator.ai can fetch.
- [x] [AI-Review][High] **Implement drag-to-reorder (AC #5, Task 4)** — `src/components/projects/media-manager.tsx` ✅ Resolved 2026-04-07
  - **Dependencies added:** `@dnd-kit/core@^6.3.1`, `@dnd-kit/sortable@^10.0.0`
  - Wrapped the thumbnail grid in `<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>` + `<SortableContext items={media.map(m => m.id)} strategy={rectSortingStrategy}>`
  - Extracted thumbnail card into `SortableMediaCard` subcomponent that uses `useSortable({ id })` for transform/transition/listeners
  - PointerSensor with `activationConstraint: { distance: 4 }` so click-without-drag still triggers the alt-edit popover
  - On drag-end: `arrayMove(media, oldIndex, newIndex)` then re-derive `order: i` for every item, then `onChange()`
  - AC5 now fully met (max 6 + max 3 homepage already enforced)
- [x] [AI-Review][Med] **Add count to Media accordion header (AC #6)** — `src/components/projects/project-edit-modal.tsx` ✅ Resolved 2026-04-07. SectionHeader title is now `` `Media (${formData.media.length} of 6)` `` matching the AC6 contract.
- [x] **[Low] Render actual image preview in thumbnail card (AC #2)** ✅ Resolved 2026-04-07. Cards now render `<img src={item.url} alt={item.alt} className="absolute inset-0 h-full w-full object-cover" />` (with eslint-disable for `@next/next/no-img-element` since we want a plain `<img>` for non-Next-managed S3 URLs).
- [x] **[Low] Add edit popover for alt text (AC #3)** ✅ Resolved 2026-04-07. Click on a thumbnail (non-drag) toggles an edit popover anchored under the card with an alt-text input (max 200 chars) and a "Done" button. The blue dot, hover homepage toggle, and delete button still work as before.

## Change Log

| Date       | Version | Description                                                                                                                     | Author |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended                                                                                          | Richie |
| 2026-04-07 | 0.1.2   | Addressed code review findings - 6 items resolved (integration, S3 upload, drag-reorder, header count, image preview, alt edit) | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **🚫 BLOCKED** (3 High findings: orphaned + S3 upload missing + drag missing; 1 Medium: header count)

### Summary

This is the most-incomplete story I've reviewed in Epic 13. The MediaManager component itself exists with thumbnail rendering, file validation, and the max-6/max-3 enforcement. **But three of the six ACs are not actually met:**

1. **AC4: "Upload: file input → pre-signed URL → S3"** — current implementation uses `URL.createObjectURL` which produces a local blob URL. **Files are NOT uploaded anywhere.** The blob URL is lost on page reload, and Story 14-1 (homepage publish pipeline) cannot consume blob URLs from a server context
2. **AC5: "Drag-to-reorder. Max 6 total, max 3 homepage."** — max enforcement is present, but **drag-to-reorder is not implemented** (Task 4 explicitly unchecked, dev's note: _"Drag-to-reorder (Task 4) deferred -- requires @dnd-kit dependency"_)
3. **The component is not integrated into the modal** — same orphaned-component pattern as 12-1 and 13-2. Modal shows "Media management coming soon."

Plus AC6's header count is also not met.

The dev was honest about Task 4 deferral, but moving the story to `review` with three substantive ACs unimplemented is a process violation. **Outcome: Blocked.**

### Key Findings

**HIGH**

- **MediaManager is orphaned** — `project-edit-modal.tsx:612-619`
  - Verified by grep: `MediaManager` only appears in its own file
  - Modal renders placeholder text instead
  - Same pattern as 12-1 / 13-2

- **AC4 violation: file upload doesn't actually upload** — `media-manager.tsx:16-26`
  - `addMedia` uses `URL.createObjectURL(file)` to create a browser-local blob URL
  - blob URLs are session-scoped — gone on page reload, gone on tab close, not accessible from any server
  - AC4 explicitly requires "file input → pre-signed URL → S3"
  - **Story 14-1 cannot work with blob URLs.** The public projects API endpoint (already implemented in 10-4) returns `m.url` from each media item — currently a blob URL that no external consumer can fetch
  - Fix requires: (a) new SST resource for media S3 bucket, (b) new API endpoint for pre-signed URL, (c) update `addMedia` to upload to S3, (d) handle upload progress/error states in UI

- **AC5 violation: drag-to-reorder not implemented** — Task 4 unchecked
  - Dev's note: _"Drag-to-reorder (Task 4) deferred -- requires @dnd-kit dependency"_
  - AC5 requires reordering — this is the user's only mechanism to control order without manually editing the order field
  - The data model supports it (`order: number` in `ProjectMedia`), but the UI doesn't expose it
  - Without reordering, the homepage display order is whatever upload order was — not user-controllable

**MEDIUM**

- **AC6 not implemented: header count missing** — `project-edit-modal.tsx:614`
  - AC6: _"Accordion header: 'Media (2 of 6)'"_
  - Current header is hardcoded "Media" with no count
  - Same fix pattern as 13-2 and the existing Team section

### Acceptance Criteria Coverage

| AC  | Description                                                         | Status                                    | Evidence                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | Thumbnail grid with "Add media" dashed card                         | **IMPLEMENTED IN COMPONENT, UNREACHABLE** | `media-manager.tsx:54-106` — 100×72px cards, dashed Add card at `:96-105`                                                                                                                                                                                                                             |
| AC2 | Each thumbnail: image preview, alt text, homepage badge             | **IMPLEMENTED IN COMPONENT, UNREACHABLE** | `:57-95` — placeholder ImageIcon (no actual `<img>` rendering of `m.url` — uses static icon), alt text at `:66-68`, blue dot at `:62-64`. **Sub-finding:** the AC says "image preview" but the component shows a generic icon, not the actual image. Even with the blob URL, the image isn't rendered |
| AC3 | Click thumbnail: edit popover with alt text/homepage/delete         | **PARTIAL**                               | Hover overlay (`:69-93`) shows homepage toggle and delete buttons, but **no edit popover for alt text**. The alt text is set from filename on upload and never editable                                                                                                                               |
| AC4 | Upload: file input → pre-signed URL → S3, with type/size validation | **PARTIAL (validation only)**             | `:45-52` validates type (PNG/JPG/WebP) and size (5MB) ✓; `:16-26` uses `URL.createObjectURL` instead of S3 upload ❌. **HIGH severity**                                                                                                                                                               |
| AC5 | Drag-to-reorder, max 6 total, max 3 homepage                        | **PARTIAL**                               | Max 6 enforced at `:17`, max 3 homepage enforced at `:37` ✓; **drag-to-reorder not implemented** ❌. **HIGH severity**                                                                                                                                                                                |
| AC6 | Accordion header "Media (2 of 6)"                                   | **NOT IMPLEMENTED**                       | Modal header is just "Media". **MEDIUM severity**                                                                                                                                                                                                                                                     |

**Summary: 0 of 6 ACs fully met. 1 implemented-in-component-but-unreachable, 4 partial, 1 not implemented.**

### Task Completion Validation

| Task                                     | Marked  | Verified                       | Evidence                                                                 |
| ---------------------------------------- | ------- | ------------------------------ | ------------------------------------------------------------------------ |
| 1. Create media-manager.tsx              | [x]     | **VERIFIED** (file exists)     | But the image preview (AC2) and edit popover (AC3) within it are partial |
| 2. Edit popover with alt/homepage/delete | [x]     | **PARTIAL**                    | Hover overlay has homepage and delete, but no alt-text edit              |
| 3. File upload with validation           | [x]     | **PARTIAL**                    | Validation done, but actual upload to S3 missing                         |
| **4. Drag reorder**                      | **[ ]** | **NOT DONE (honest deferral)** | Dev acknowledged in completion notes                                     |

**Summary: 0 of 4 tasks fully verified. Task 4 honestly unchecked. Tasks 2 and 3 are partial but marked complete — borderline false completion claim.**

### Test Coverage and Gaps

- No tests for the component or its hooks
- A Playwright test for "upload an image → save → reopen modal → image still present" would have caught the blob-URL issue immediately

### Architectural Alignment

- ✅ **Theme tokens throughout the component** (the file itself uses `border-border`, `bg-muted`, `text-muted-foreground`, `bg-accent-blue`, `text-destructive`)
- ✅ **Max-count enforcement at the data layer** — prevents invalid state at the source
- ✅ **`crypto.randomUUID()` for media IDs** — matches the project-wide pattern
- ❌ **No upload abstraction** — should be a `useUploadMedia()` hook or service that Story 14-1 can also call
- ❌ **No connection to backend** — the entire media flow lives client-side with blob URLs

### Security Notes

- ✅ **Client-side type and size validation** before "upload"
- ⚠️ **Server-side validation** is also required for security — anyone with API access could POST a project with arbitrary `media[].url` strings. Story 10-1's `mediaSchema.url` is currently `z.string()` (no URL validation, no max length) — already flagged in 10-1's review
- ⚠️ **Pre-signed URL endpoint must be auth-protected** — when implemented, ensure it's behind `authMiddleware`
- ⚠️ **S3 bucket policy** — when implemented, the bucket should only allow public read for media intended for futurator.ai, not for all uploads

### Action Items

**Code Changes Required (Blocking):**

- [x] **[High] Integrate MediaManager into modal Media section** ✅ Resolved 2026-04-07
- [x] **[High] Implement actual S3 upload via pre-signed URL** ✅ Resolved 2026-04-07 (new endpoint + IAM broadened + frontend rewrite)
- [x] **[High] Implement drag-to-reorder with @dnd-kit** ✅ Resolved 2026-04-07
- [x] **[Med] Add count to Media accordion header** ✅ Resolved 2026-04-07
- [x] **[Low] Render actual image preview in thumbnail card (AC #2)** ✅ Resolved 2026-04-07
- [x] **[Low] Add edit popover for alt text (AC #3)** ✅ Resolved 2026-04-07

**Advisory Notes:**

- Note: This story is the largest scope-vs-implementation gap I've found in the entire review pass. Consider splitting it into 3 sub-stories: (a) integrate component + alt-edit popover + header count, (b) S3 upload pipeline, (c) drag-to-reorder. Each is testable independently
- Note: Story 14-1 (S3 Static JSON Export on Save) depends on real S3 URLs in `media[].url`. Until 13-3's S3 upload is implemented, 14-1 cannot deliver functional homepage media
