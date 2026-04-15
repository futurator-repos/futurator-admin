# Story 10.4: Public Projects API Endpoint

Status: done

## Story

As a developer,
I want a public unauthenticated endpoint returning published projects,
so that futurator.ai can fetch project data without auth.

## Acceptance Criteria

1. **Endpoint exists**: `GET /api/public/projects` — no auth middleware.
2. **Returns published only**: Filters `publishedToHomepage === true`. Sorted by `homepageOrder`.
3. **Selective fields**: Returns `{ name, headline, brief, summary, media, status, services, order }`. Only homepage-flagged descriptions and `showOnHomepage` media.
4. **CORS**: Allows `https://futurator.ai` origin in addition to existing admin origins.
5. **Cacheable**: Response includes `Cache-Control: public, max-age=300`.
6. **Empty array**: Returns `[]` if no projects published.

## Tasks / Subtasks

- [x] Task 1: Add route before auth middleware in `functions/api/index.ts` (AC: 1, 4)
- [x] Task 2: Implement DynamoDB scan with filter + field mapping (AC: 2, 3, 6)
- [x] Task 3: Add cache headers (AC: 5)
- [x] Task 4: Update CORS config to include futurator.ai origin (AC: 4)

## Dev Notes

- Route must be registered BEFORE the auth middleware in Hono's chain
- DynamoDB scan is fine for 11 items — no index needed
- Ref: [Source: docs/concepts/project-hub-enhancement.md#5.2-New-Public-Endpoint]

### Project Structure Notes

- **Modified**: `functions/api/index.ts`

### References

- [Source: docs/epics-project-hub-enhancement.md#Story-PH-2.4]

## Dev Agent Record

### Context Reference

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Added GET /api/public/projects route before auth middleware in functions/api/index.ts
- Route uses projectRepo.getAllProjects(), filters publishedToHomepage, sorts by homepageOrder
- Returns selective fields: name, headline/brief/summary (only if homepageFlags enabled), filtered media, status, services, order
- Added Cache-Control: public, max-age=300 header
- Added /api/public/projects to auth middleware skip list
- Added https://futurator.ai to CORS allowOrigins in sst.config.ts
- Returns empty array when no projects are published
- All modified files pass TypeScript compilation

### File List

- functions/api/index.ts
- sst.config.ts

## Change Log

| Date       | Version | Description                            | Author |
| ---------- | ------- | -------------------------------------- | ------ |
| 2026-04-07 | 0.1.1   | Senior Developer Review notes appended | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-07
**Outcome:** **✅ Approve** (1 Low note about scan-vs-query for scale)

### Summary

Tight, complete implementation. The endpoint is correctly placed before the auth middleware, the field selection respects both `homepageFlags` and `showOnHomepage` filtering, CORS is configured for `https://futurator.ai`, and the cache header is set. All 6 ACs are met with file:line evidence.

### Key Findings

**LOW**

- **Endpoint relies on `getAllProjects()` (DynamoDB scan)** — `functions/api/index.ts:112`
  - Currently 11 projects → fine. Scan cost is trivial
  - At ~50+ projects, consider adding a GSI on `publishedToHomepage` and using `Query` instead of `Scan`
  - Dev notes correctly identify this: _"DynamoDB scan is fine for 11 items — no index needed"_
  - Not a 10-4 blocker — flagging for the Epic 10 retrospective

### Acceptance Criteria Coverage

| AC  | Description                                                                  | Status          | Evidence                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | `GET /api/public/projects` exists, no auth                                   | **IMPLEMENTED** | `functions/api/index.ts:111` defines the route. Auth middleware skip list at `:141` explicitly bypasses this path. Route is also defined BEFORE the `app.use('/api/*', ...)` middleware at `:136` so even without the skip-list, the public route would handle requests first                                                                 |
| AC2 | Filters publishedToHomepage, sorted by homepageOrder                         | **IMPLEMENTED** | `:114-116` — `.filter(p => p.publishedToHomepage).sort((a,b) => a.homepageOrder - b.homepageOrder)`                                                                                                                                                                                                                                           |
| AC3 | Selective fields with homepage-flagged descriptions and showOnHomepage media | **IMPLEMENTED** | `:117-129`. Returns `name`, `headline` (only if `homepageFlags.headline`), `brief` (only if flag), `summary` (only if flag), `media` filtered by `showOnHomepage` and sorted, `status`, `services` (from awsServices), `order` (from homepageOrder). Media items mapped to `{ url, alt, order }` excluding internal `id` and `showOnHomepage` |
| AC4 | CORS allows `https://futurator.ai`                                           | **IMPLEMENTED** | `sst.config.ts:123` — `allowOrigins: ['https://admin.futurator.ai', 'https://futurator.ai', 'http://localhost:3000']`                                                                                                                                                                                                                         |
| AC5 | `Cache-Control: public, max-age=300`                                         | **IMPLEMENTED** | `functions/api/index.ts:131` — `c.header('Cache-Control', 'public, max-age=300')`                                                                                                                                                                                                                                                             |
| AC6 | Returns `[]` if no published projects                                        | **IMPLEMENTED** | The `.filter().sort().map()` chain returns an empty array if no projects pass the filter. `c.json([])` is the natural result. No special-case code needed                                                                                                                                                                                     |

**Summary: 6 of 6 ACs fully implemented.**

### Task Completion Validation

| Task                                                | Marked | Verified     | Evidence                                                                   |
| --------------------------------------------------- | ------ | ------------ | -------------------------------------------------------------------------- |
| 1. Add route before auth middleware                 | [x]    | **VERIFIED** | `functions/api/index.ts:111` (route) is defined before `:136` (middleware) |
| 2. Implement DynamoDB scan + filter + field mapping | [x]    | **VERIFIED** | `:112-129`                                                                 |
| 3. Add cache headers                                | [x]    | **VERIFIED** | `:131`                                                                     |
| 4. Update CORS for futurator.ai                     | [x]    | **VERIFIED** | `sst.config.ts:123`                                                        |

**Summary: 4 of 4 tasks verified, 0 false completions.**

### Test Coverage and Gaps

- No tests for the public endpoint. Recommended for a future story:
  - Unit test verifying field-stripping behavior (e.g., a project with `homepageFlags.headline = false` should NOT include `headline` in the response)
  - Integration test verifying the cache header
  - CORS preflight test (OPTIONS request from `https://futurator.ai`)
- Not blocking — the logic is simple enough to verify by inspection

### Architectural Alignment

- ✅ **Route placement** — defined before auth middleware AND in the auth skip-list (defense in depth)
- ✅ **Field stripping at the API boundary** — public consumers only see what they need, not the full project document
- ✅ **CORS configured at the Lambda Function URL level via SST** — matches the existing pattern noted in the file comment at `:25-26`: _"CORS is handled by Lambda Function URL config in sst.config.ts. Do NOT add Hono CORS middleware — it causes duplicate headers"_
- ✅ **Fire-and-forget export** at `:165-166` — the PUT handler triggers `exportPublicProjects()` when publish state changes, prepping for Story 14-1 (S3 Static JSON Export). Good cross-story coordination
- ✅ **`Cache-Control: public, max-age=300`** — 5-minute cache balances freshness with CDN cacheability. Reasonable for project data which doesn't change second-by-second

### Security Notes

- ✅ **Field-level access control** — the response intentionally excludes internal fields (budget, team, awsServices beyond what's exposed as `services`, etc.). Public consumers cannot enumerate sensitive metadata
- ✅ **No auth required and explicit skip-list** — by design for the public endpoint
- ⚠️ **No rate limiting** — public unauthenticated endpoint with DynamoDB scan on every request. With 11 projects this is trivially cheap, but consider adding a CloudFront edge cache or API Gateway rate limit if futurator.ai traffic grows. Not actionable for 10-4
- ✅ **CORS scoped to `https://futurator.ai`** — does not allow `*`, so the endpoint can only be called from the intended consumer

### Best-Practices and References

- **Hono routing** — [https://hono.dev/docs/api/routing](https://hono.dev/docs/api/routing) — middleware order matters; the public route is correctly registered before the auth middleware
- **Cache-Control directives** — [MDN Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control) — `public, max-age=300` is correct for CDN/browser caching of public resources
- **DynamoDB Scan vs Query** — [https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html) — Scan is acceptable for small tables but should be replaced with Query + GSI as the table grows

### Action Items

**Code Changes Required:** None.

**Advisory Notes (no action required for 10-4):**

- Note: At ~50+ projects, replace `getAllProjects()` Scan with a Query against a GSI keyed on `publishedToHomepage`. Not actionable now
- Note: Add an integration test for the field-stripping behavior in a future test infrastructure story
- Note: Consider whether `https://www.futurator.ai` (with www subdomain) should also be in the CORS allowlist — depends on how the futurator.ai homepage is deployed
