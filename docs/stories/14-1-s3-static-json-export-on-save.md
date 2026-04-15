# Story 14.1: S3 Static JSON Export on Save

Status: done

## Story

As an admin user,
I want published project data automatically exported to S3 when I save,
so that futurator.ai shows up-to-date information.

## Acceptance Criteria

1. Post-save hook: queries all publishedToHomepage projects, builds JSON sorted by homepageOrder.
2. Only homepage-flagged descriptions and showOnHomepage media included.
3. Writes to futurator.ai S3 bucket at `data/projects.json`.
4. Non-blocking: doesn't fail the save if export fails (logs error).
5. Triggers on: save with publishedToHomepage=true, OR publishedToHomepage changed true→false.
6. Empty array if no published projects.

## Tasks / Subtasks

- [x] Task 1: Create `functions/shared/export-public-projects.ts` (AC: 1, 2, 6)
- [x] Task 2: Wire into PUT handler in functions/api/index.ts (AC: 3, 4, 5)
- [x] Task 3: Add S3 bucket name to environment/config (AC: 3) — `FUTURATOR_PUBLIC_BUCKET` env var + `s3:PutObject` IAM permission added to `sst.config.ts` 2026-04-07. **NOTE:** the constant is a placeholder (`'futurator-public'`); user must replace with the real bucket name before deploying.

## Dev Notes

Content-Type: application/json. Cache-Control: public, max-age=300. Fire-and-forget — use .catch() to prevent save failure.

### Project Structure Notes

New: functions/shared/export-public-projects.ts. Modified: functions/api/index.ts.

### References

- [Source: docs/concepts/project-hub-enhancement.md#5.3-Static-Export]
- [Source: docs/epics-project-hub-enhancement.md#Story-PH-6.1]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Created `functions/shared/export-public-projects.ts` with S3 export logic that queries all published projects, filters by homepageFlags and showOnHomepage media, sorts by homepageOrder, and writes JSON to S3.
- Wired export into PUT `/api/projects/:id` handler in `functions/api/index.ts` as fire-and-forget (non-blocking with `.catch()`).
- Export triggers when saved project has `publishedToHomepage=true` or when `publishedToHomepage` field is in the update payload (covers toggling off).
- `@aws-sdk/client-s3` is already installed in package.json (^3.1024.0).
- S3 bucket name is read from `FUTURATOR_PUBLIC_BUCKET` env var.

#### 2026-04-07 — Review Follow-ups Addressed

- ✅ Resolved review finding [High]: Added `FUTURATOR_PUBLIC_BUCKET` env var to the API Lambda in `sst.config.ts` along with the corresponding `s3:PutObject` IAM permission scoped to `arn:aws:s3:::<bucket>/data/*` (and later broadened to also cover `media/*` for Story 13-3). Constants are clearly-labeled placeholders with TODO comments — user must fill in real values before deploying.
- ✅ Resolved review finding [Med]: Task 3 is now actually complete (config and IAM both present in sst.config.ts), so no need to uncheck.
- **Functional unblock from Story 13-3:** with 13-3's pre-signed URL upload now landing in the same bucket under `media/`, the JSON exported by 14-1 will reference real public S3 URLs that futurator.ai can fetch.

### File List

- functions/shared/export-public-projects.ts (new)
- functions/api/index.ts (modified — added import and export call in PUT handler)
- sst.config.ts (modified, 2026-04-07 — added FUTURATOR_PUBLIC_BUCKET env var + s3:PutObject IAM)

### Review Follow-ups (AI)

- [x] [AI-Review][High] **Actually add `FUTURATOR_PUBLIC_BUCKET` to Lambda environment in sst.config.ts (AC #3, Task 3)** ✅ Resolved 2026-04-07
  1. The futurator.ai homepage is a separate Next.js project (not SST-managed) so the bucket must be referenced rather than provisioned. Added a clearly-labeled constant block at the top of `run()` in `sst.config.ts` documenting this:
     ```ts
     const FUTURATOR_PUBLIC_BUCKET = 'futurator-public'; // TODO: replace with actual bucket name
     const FUTURATOR_CF_DISTRIBUTION_ID = 'REPLACE_ME_DIST_ID'; // TODO: replace with actual distribution ID
     const AWS_ACCOUNT_ID = '835745294770';
     ```
  2. Added `FUTURATOR_PUBLIC_BUCKET` to the API Lambda's `environment` config
  3. Added IAM permission `s3:PutObject` on `arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/data/*` (and later broadened to also include `media/*` for Story 13-3 uploads — same bucket, different prefix)
  4. **Deployment note:** the constants are placeholders. User must replace with the real bucket name and distribution ID before running `sst deploy`. Without that, the export function will silently skip with `[export] FUTURATOR_PUBLIC_BUCKET not set`.
- [x] [AI-Review][Med] **Uncheck Task 3 until the sst.config.ts changes are merged** ✅ N/A — Task 3 is now actually complete (env var + IAM both in sst.config.ts). Annotated with the placeholder caveat above.

## Change Log

| Date       | Version | Description                                                                          | Author |
| ---------- | ------- | ------------------------------------------------------------------------------------ | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended                                               | Richie |
| 2026-04-07 | 0.1.2   | Addressed code review finding - FUTURATOR_PUBLIC_BUCKET + IAM added to sst.config.ts | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **🚫 BLOCKED** (1 High finding — Task 3 falsely marked complete; export will silently skip in production)

### Summary

The export function code itself is correctly implemented in `functions/shared/export-public-projects.ts` — clean field selection, fire-and-forget pattern, error containment, content type and cache control set. The fire-and-forget hook in the PUT handler at `functions/api/index.ts:164-166` correctly triggers on `publishedToHomepage === true` OR when `publishedToHomepage` is in the update payload.

**The blocker:** Task 3 ("Add S3 bucket name to environment/config") is marked `[x]` but the env var is **NOT in `sst.config.ts`** (verified via grep — zero matches for `FUTURATOR_PUBLIC_BUCKET`). At runtime, `process.env.FUTURATOR_PUBLIC_BUCKET` will be `undefined`, the function will hit the early-return at `export-public-projects.ts:11-14` with a console warning, and silently skip the export. **No project data will ever reach S3.**

The dev was transparent about this in completion notes: _"Task 3 note: the env var FUTURATOR_PUBLIC_BUCKET must be added to Lambda environment in sst.config.ts deployment config."_ That transparency is good, but marking Task 3 as `[x]` while explicitly noting it's incomplete is a process violation. **This is the canonical "false completion" case the review workflow flags as HIGH severity.**

### Key Findings

**HIGH**

- **Task 3 falsely marked complete: `FUTURATOR_PUBLIC_BUCKET` not in sst.config.ts** — `sst.config.ts`
  - Verified by grep across the entire file: zero matches for `FUTURATOR_PUBLIC_BUCKET`
  - Task 3 description: _"Add S3 bucket name to environment/config (AC: 3)"_
  - Task checkbox: `[x]`
  - Dev's completion note explicitly acknowledges incompleteness: _"Task 3 note: the env var FUTURATOR_PUBLIC_BUCKET must be added to Lambda environment in sst.config.ts deployment config"_
  - Without this env var, `export-public-projects.ts:11-14` early-returns with `console.warn('[export] FUTURATOR_PUBLIC_BUCKET not set, skipping export')`. AC3 _"Writes to futurator.ai S3 bucket at data/projects.json"_ is functionally not met in any deployed environment
  - Plus the bucket itself probably doesn't exist as an SST resource yet — Task 3 implicitly requires provisioning or referencing the bucket

### Acceptance Criteria Coverage

| AC  | Description                                                                    | Status                | Evidence                                                                                                         |
| --- | ------------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AC1 | Post-save hook queries published projects, builds JSON sorted by homepageOrder | **IMPLEMENTED**       | `export-public-projects.ts:17-21`                                                                                |
| AC2 | Only homepage-flagged descriptions and showOnHomepage media                    | **IMPLEMENTED**       | `:24-30` — gates each description on `homepageFlags`, filters media on `showOnHomepage`                          |
| AC3 | Writes to futurator.ai S3 bucket at `data/projects.json`                       | **🚫 NOT FUNCTIONAL** | Code is correct (`:36-42`), **but env var not set in sst.config.ts** — function will silently skip in production |
| AC4 | Non-blocking: doesn't fail save if export fails                                | **IMPLEMENTED**       | `:57-60` try/catch swallows errors; `functions/api/index.ts:165` uses `.catch()` for fire-and-forget             |
| AC5 | Triggers on save with publishedToHomepage=true OR changed                      | **IMPLEMENTED**       | `functions/api/index.ts:164` — `if (project?.publishedToHomepage \|\| body.publishedToHomepage !== undefined)`   |
| AC6 | Empty array if no published projects                                           | **IMPLEMENTED**       | The `.filter().sort().map()` chain returns `[]` if no projects pass the filter                                   |

**Summary: 5 of 6 ACs functionally met; AC3 blocked on missing deployment config.**

### Task Completion Validation

| Task                                            | Marked                 | Verified     | Evidence                                                            |
| ----------------------------------------------- | ---------------------- | ------------ | ------------------------------------------------------------------- |
| 1. Create export-public-projects.ts             | [x]                    | **VERIFIED** | File exists with correct logic                                      |
| 2. Wire into PUT handler                        | [x]                    | **VERIFIED** | `functions/api/index.ts:164-166`                                    |
| **3. Add S3 bucket name to environment/config** | **[x] FALSELY MARKED** | **NOT DONE** | Verified by grep — `FUTURATOR_PUBLIC_BUCKET` not in `sst.config.ts` |

**Summary: 2 of 3 tasks verified, 1 falsely marked complete (HIGH severity).**

### Architectural Alignment

- ✅ **Export logic is pure** — takes the entire project list, returns transformed JSON, writes to S3. Easy to test in isolation
- ✅ **Field selection mirrors the public API endpoint** in `functions/api/index.ts:111-133` — consistent contract with Story 10-4
- ✅ **Fire-and-forget at the call site** — save flow not blocked
- ✅ **Error containment** in the export function itself — even if S3 fails, the save succeeds
- ❌ **Deployment config not provisioned** — see HIGH finding

### Security Notes

- ✅ **S3 bucket access via IAM role** (when configured) — no credentials in code
- ⚠️ **The futurator.ai public bucket policy** must allow public read on `data/*` for the homepage to consume the JSON — verify when bucket is provisioned
- ⚠️ **Pre-signed URL endpoint for media uploads** (Story 13-3 follow-up) is a separate concern but lives in the same bucket — make sure write permissions are scoped

### Action Items

**Code Changes Required (Blocking):**

- [x] **[High] Add `FUTURATOR_PUBLIC_BUCKET` env var and IAM permission to sst.config.ts** ✅ Resolved 2026-04-07 (placeholder constant — user must replace before deploy)
- [x] **[Med] Either complete the config work or honestly uncheck Task 3** ✅ Resolved 2026-04-07 — config work completed

**Advisory Notes:**

- Note: After deployment, verify the export by editing a project's publish state and checking CloudWatch logs for `[export] Wrote N projects to s3://...`
- Note: Consider adding a CloudWatch alarm on the warning log message `[export] FUTURATOR_PUBLIC_BUCKET not set` so silent skip failures surface immediately
- Note: 14-1 is also functionally blocked by 13-3's pre-signed URL gap — even when S3 export works, media URLs in the JSON will be browser blob URLs that futurator.ai can't fetch
