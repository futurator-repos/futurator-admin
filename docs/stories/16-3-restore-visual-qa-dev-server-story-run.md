# Story 16.3: Restore /visual-qa + /dev-server + /stories/:id/run

**Status:** Review

---

## User Story

As **Richie (operator)**,
I want **per-story re-run, visual QA, and dev-server endpoints available as discrete operations**,
So that **I can isolate a failed story and retry just that one, re-validate visual criteria, or spin up a dev environment without respawning the whole epic**.

---

## Acceptance Criteria

**AC #1 — `POST /api/epic-workflows/:id/stories/:storyId/run`.**
Returns 410 today. Replace with a handler that:
- Looks up `epic` + `story` (404 if either missing).
- Builds `pipeline = generateStoryPipeline(story, epic.title, epic.workingDir, {devModel, devEffort, reviewerModel, reviewerEffort, epicId})`.
- Creates a new PENDING `AgentJob` with a fresh `jobId`.
- Updates `epic.stories`: sets `story.status = 'running'` + `story.jobId = <new jobId>` for the targeted story only (other stories untouched).
- Sets `epic.status = 'in_progress'`.
- Returns `{ jobId, storyId }` with HTTP 201.

**AC #2 — `POST /api/epic-workflows/:id/visual-qa`.**
Returns 410 today. Replace with a handler that:
- Backfills `story.visualTests` from `job.variables.VISUAL_TESTS` for any story with `hasBrowserTests` but no stored `visualTests` (parsed via the existing `parseVisualTests` helper). Persists backfilled `stories` to DDB.
- Collects all `visualTests` across all stories. If empty, returns 400 `{ error: 'No visual tests defined in any story…' }`.
- Uses `epic.testingProfile?.viewport || '1280x720'`.
- Builds `pipeline = buildQaPipeline(epic.workingDir, epic.title, viewport, allVisualTests)`.
- Creates a PENDING `AgentJob`.
- Persists `epic.qaJobId = jobId` + `epic.status = 'in_review'`.
- Returns `{ jobId, epicId }` with HTTP 201.

**AC #3 — `POST /api/epic-workflows/:id/dev-server`.**
Returns 410 today. Replace with a handler that:
- Builds a single-step agent pipeline that runs `npm run dev` in background, waits 8s, extracts the URL from the log, and returns it (same shape as the pre-orchestrator `73ac1ae~1` implementation — an OPS agent step with regex extractors for `DEV_SERVER_URL`, `DEV_SERVER_PID`, `STATUS`).
- Creates a PENDING `AgentJob`.
- Returns `{ jobId, epicId }` with HTTP 201.

**AC #4 — Mode-agnostic.**
None of the three endpoints check `useEpicOrchestrator`. They all unconditionally use step-based pipelines. An epic running with `useEpicOrchestrator: true` can still re-run a story or kick off visual QA via these endpoints.

**AC #5 — UI wiring verified.**
The Labs UI's "Retry story" affordance in `story-card.tsx` calls `POST /stories/:storyId/run`. No new frontend code required — confirm the card re-renders properly on success (the existing polling picks up `story.jobId` + `story.status='running'`).

**AC #6 — Unit tests.**
New tests in `functions/shared/services/__tests__/` (or a new `functions/api/__tests__/` file, consistent with the repo's test layout):

1. `runStory` handler creates a PENDING job with a `generateStoryPipeline`-shaped pipeline and updates only the target story's `jobId` + `status`.
2. `visualQa` handler returns 400 when no story has visualTests.
3. `visualQa` handler backfills visualTests from `job.variables.VISUAL_TESTS` when stories haven't stored them.
4. `devServer` handler creates a PENDING job with the OPS agent + regex extractors.

Because the handlers are inline in `functions/api/index.ts` and not currently factored into a service module, the implementer may either (a) extract the pipeline-builder + job-creation logic into a small service module (mirroring `pipeline-launcher.ts`), or (b) add an integration test with a mocked Hono request. (a) is preferred for consistency with 16.1 + 16.2.

**AC #7 — `npm run ci` passes** (typecheck, tests, build).

---

## Implementation Details

### Tasks / Subtasks

**Restore `/stories/:storyId/run` (AC #1)**

- [x] Replace the 410-stub at `functions/api/index.ts:1511`. Full logic matches `git show 73ac1ae~1:functions/api/index.ts` lines 1838-1877 with minor adjustments: reuse our existing `generateStoryPipeline` import (already in place from 16.2) and `agentJobsRepo.createJob`.

**Restore `/visual-qa` (AC #2)**

- [x] Replace the 410-stub at `functions/api/index.ts:1968`. Backfill + collection logic matches `73ac1ae~1` lines 2091-2154. `buildQaPipeline` already exists at `functions/api/index.ts:~1842` and is currently flagged by ESLint as unused — restoring the endpoint silences that warning.

**Restore `/dev-server` (AC #3)**

- [x] Replace the 410-stub at `functions/api/index.ts:1981`. OPS agent pipeline matches `73ac1ae~1` lines 2158-2222.

**Tests (AC #6)**

- [x] Preferred path (mirror 16.1/16.2): extract a `story-rerun.ts` and `visual-qa.ts` and `dev-server.ts` service module each exporting a pure function that builds the pipeline + creates the job via injected deps. Write unit tests against those.
- [x] Minimum acceptable: add integration tests that import the Hono `app` and simulate requests via `app.request(url, { method, headers, body })`, with `agentJobsRepo.createJob` + `epicRepo.*` mocked.

**Verify**

- [x] `npx tsc --noEmit` clean.
- [x] `npx vitest run` — new tests pass, no regressions in existing 157.
- [x] `npx eslint` on modified files — zero new warnings. Confirm the pre-existing `buildQaPipeline is defined but never used` warning is gone.
- [x] `npm run build` clean.

### Technical Summary

Minimal-risk story: every handler being restored has a reference implementation in `git show 73ac1ae~1`. The only architectural decision is whether to extract handlers into service modules for testability (recommended to match the pattern Stories 16.1 + 16.2 established) or to test them via Hono request integration.

`buildQaPipeline` and `parseVisualTests` already exist in `functions/api/index.ts` — the visual-qa handler just needs to call them.

### Project Structure Notes

- **Files to modify:**
  - `functions/api/index.ts` (restore 3 handlers; ~130 LOC total)
- **Optional new files (if extracting for testability):**
  - `functions/shared/services/story-rerun-launcher.ts`
  - `functions/shared/services/visual-qa-launcher.ts`
  - `functions/shared/services/dev-server-launcher.ts`
  - Corresponding `__tests__/*.test.ts` files
- **Expected effort:** 2 story points (~1-2 days).

### Key Code References

- `git show 73ac1ae~1:functions/api/index.ts` lines 1838-2222 — canonical pre-orchestrator handlers.
- `functions/api/index.ts:~1842 buildQaPipeline` — QA pipeline builder (extant).
- `functions/api/index.ts:~2940 parseVisualTests` — YAML-like test definition parser (extant, used for visualTests backfill).
- `functions/shared/services/pipeline-launcher.ts` — pattern for deps-injected service modules (Story 16.1).

---

## Context References

**Epic:** [../epics-orchestration-recovery.md](../epics-orchestration-recovery.md) — Epic 16 scope + story map.

**Previous story:** [16-2-multi-wave-gating-and-wave-build-check.md](./16-2-multi-wave-gating-and-wave-build-check.md) — Wave gating + cron reducer.

**Behavioral spec:** [../concepts/agentic-pipeline-forensic-report.md](../concepts/agentic-pipeline-forensic-report.md) §PER-STORY PIPELINE — canonical 6-step shape used by `/stories/:id/run`.

---

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Opus 4.7, 1M context)

### Debug Log References

- `npx vitest run functions/` — 164 passed (18 files), including 2 story-rerun + 3 visual-qa + 2 dev-server launcher tests.
- `npx tsc --noEmit` — clean.
- `npm run build` — clean (static export, all routes rendered).
- `npx eslint functions/` — zero errors; 1 pre-existing warning in `agent-orchestrator-schema.test.ts:64` (`_ac` unused, from commit 73ac1ae) unrelated to this work. `buildQaPipeline is defined but never used` warning is gone (endpoint restored).

### Completion Notes

Chose the service-module extraction path (preferred per AC #6) to match the Story 16.1/16.2 pattern: each restored handler delegates to a pure, deps-injected launcher that is unit-tested in isolation. Handlers in `api/index.ts` are thin wrappers that wire repos + generators into the launcher.

`buildQaPipeline` and `parseVisualTests` stayed inline in `api/index.ts` — the visual-qa launcher accepts them as injected deps rather than importing, keeping the separation between Hono-layer helpers and service-layer launchers.

`/stories/:storyId/run` matches the `73ac1ae~1` handler shape exactly (minus the implicit dep of `agentJobsRepo.createJob` via the launcher). `/visual-qa` preserves the backfill-from-job-variables behavior that the original handler introduced so operators can click Visual QA even when dev agents persisted VISUAL_TESTS via extractor variables but stories didn't yet carry them. `/dev-server` uses the same OPS-agent pipeline shape as before.

### Files Modified

**Created:**

- `functions/shared/services/story-rerun-launcher.ts`
- `functions/shared/services/visual-qa-launcher.ts`
- `functions/shared/services/dev-server-launcher.ts`
- `functions/shared/services/__tests__/story-rerun-launcher.test.ts`
- `functions/shared/services/__tests__/visual-qa-launcher.test.ts`
- `functions/shared/services/__tests__/dev-server-launcher.test.ts`

**Modified:**

- `functions/api/index.ts` — 3 handlers restored (`/stories/:storyId/run`, `/visual-qa`, `/dev-server`) + 3 launcher imports.

### Test Results

- 2 story-rerun launcher tests — target-story mutation isolation; story-not-found error path.
- 3 visual-qa launcher tests — no-visual-tests 400 path; variables-backfill; viewport override.
- 2 dev-server launcher tests — pipeline shape (OPS agent, regex extractors); PENDING job creation.
- Full `functions/` suite: 164/164 passing (+7 new from 157 baseline after 16.2).
- `npm run build` clean.

---

## Review Notes

<!-- -->
