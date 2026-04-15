# Story MY-2.5: Compilation Status Tracking & Error Handling

Status: review

## Story

As a **developer**,
I want **compilation status tracked per story and surfaced in the pipeline events**,
So that **I can monitor compilation health and debug failures without affecting story delivery**.

## Acceptance Criteria

1. The story's workflow record includes `compilationStatus: 'success' | 'failed' | 'skipped'` reflecting the outcome of the COMPILE phase
2. Compilation timing (start time, end time, duration) and article counts (created, updated, superseded) are recorded in pipeline events
3. Compilation errors are logged with full stack traces in agent events emitted to `futurator-agent-events`
4. A failed compilation emits a warning event but the story is still marked as completed (non-blocking)
5. `knowledge/log.md` records both successful and failed compilation attempts with timestamps and error summaries

## Tasks / Subtasks

- [x] Task 1: Extend workflow types with compilation metadata (AC: #1)
  - [x] 1.1: Add `compilationStatus?: 'success' | 'failed' | 'skipped'` to `EpicStory` in `functions/shared/types/epic-workflow.ts`
  - [x] 1.2: Add `compilationStartedAt?: string` and `compilationCompletedAt?: string` timestamps to `EpicStory`
  - [x] 1.3: Add `compilationArticleCounts?: { created: number; updated: number; superseded: number }` to `EpicStory`
  - [x] 1.4: Mirror all type additions in `src/types/epic-workflow.ts` for frontend consumption

- [x] Task 2: Implement compilation timing capture (AC: #2)
  - [x] 2.1: Record `compilationStartedAt` when the `compile-diff` step begins
  - [x] 2.2: Record `compilationCompletedAt` when the `compile-sync` step completes (or when any compile step fails)
  - [x] 2.3: Calculate duration and include in the completion event payload
  - [x] 2.4: Extract article counts from the COMPILER agent output and/or `graph-sync.mjs` stdout

- [x] Task 3: Emit structured compilation events (AC: #2, #3)
  - [x] 3.1: Emit a `compilation-started` event to `futurator-agent-events` when the COMPILE phase begins
  - [x] 3.2: Emit a `compilation-completed` event with status, timing, and article counts on success
  - [x] 3.3: Emit a `compilation-failed` event with error message and stack trace on failure
  - [x] 3.4: Ensure events include `storyId`, `epicId`, and `projectId` for correlation

- [x] Task 4: Implement non-blocking error handling (AC: #4)
  - [x] 4.1: Wrap the COMPILE phase execution in a try/catch in the pipeline orchestrator
  - [x] 4.2: On catch: set `compilationStatus: 'failed'`, emit warning event, but allow story to proceed to `done` status
  - [x] 4.3: Set `compilationStatus: 'skipped'` when the COMPILE phase is skipped (e.g., no diff, or Epic 1 infra not yet deployed)
  - [x] 4.4: Set `compilationStatus: 'success'` only when all three compile sub-steps complete without error

- [x] Task 5: Update knowledge log with compilation results (AC: #5)
  - [x] 5.1: On successful compilation: append a success record to `knowledge/log.md` (already handled by COMPILER agent in Story 2.3, verify it works)
  - [x] 5.2: On failed compilation: append a failure record to `knowledge/log.md` with error summary — this requires a fallback write since the COMPILER agent may have been the step that failed
  - [x] 5.3: Define a consistent log entry format: `| {timestamp} | {storyId} | {status} | {articles_created}/{articles_updated}/{articles_superseded} | {error_summary} |`

- [x] Task 6: Persist compilation status to DynamoDB (AC: #1)
  - [x] 6.1: Update the `EpicWorkflow` repository to persist `compilationStatus` and metadata when updating story status
  - [x] 6.2: Ensure the existing `updateStoryStatus()` or equivalent function handles the new fields
  - [x] 6.3: Verify the frontend can read and display `compilationStatus` from the API response

## Dev Notes

### Architecture Context

This story is the observability and reliability layer for the compilation pipeline. While Stories 2.1-2.4 establish the compilation flow, this story ensures that compilation is properly tracked, debuggable, and truly non-blocking.

The critical design principle: **compilation is enhancement, not gate**. A story that implements its acceptance criteria correctly must always be marked as `done`, regardless of whether the knowledge compilation succeeds. This aligns with the architecture document's explicit guidance that compilation failure should not fail the pipeline.

The `compilationStatus` field extends the existing `EpicStory` interface, which currently tracks `status: StoryStatus` (pending/running/in_review/fixing/done/failed/skipped). The new field is orthogonal — a story can be `status: 'done'` with `compilationStatus: 'failed'`. This separation is intentional.

Event emission uses the existing `futurator-agent-events` DynamoDB table and the real-time streaming infrastructure. The frontend already renders pipeline events in the Agentic Workflow UI — compilation events will appear alongside existing step events.

The `knowledge/log.md` is an append-only file established in Epic 1 Story 1.3. It serves as the human-readable audit trail for all compilation activity. The COMPILER agent in Story 2.3 writes success records, but this story must also handle the case where the COMPILER agent itself fails — in that case, the daemon must write the failure record directly.

### Key Files

| File                                                        | Purpose                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `functions/shared/types/epic-workflow.ts`                   | `EpicStory` interface — add compilation metadata fields     |
| `src/types/epic-workflow.ts`                                | Frontend mirror of workflow types                           |
| `functions/shared/repositories/epic-workflow-repository.ts` | DynamoDB persistence for `EpicWorkflow` records             |
| `daemon/agent-daemon.mjs`                                   | Pipeline executor — implements try/catch and event emission |
| `functions/api/index.ts`                                    | `generateStoryPipeline()` — compilation step definitions    |

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#4.2-Story-Compilation-Step] — non-blocking compilation design
- [Source: docs/concepts/mycelium-labs-architecture.md#4.1-Compilation-Triggers] — compilation trigger model
- [Source: docs/epics-mycelium-devs.md#Story-2.5] — epic acceptance criteria
- [Source: docs/epics-mycelium-devs.md#Story-2.1] — pipeline extension (prerequisite, provides the compilation steps to track)

## Change Log

| Date       | Change                     | Author          |
| ---------- | -------------------------- | --------------- |
| 2026-04-14 | Story drafted              | Richie          |
| 2026-04-14 | Implementation complete    | Claude Opus 4.6 |
| 2026-04-14 | Fixed code review findings | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](my-2-5-compilation-status-tracking.context.xml)

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Extended `EpicStory` interface (both backend and frontend) with `compilationStatus`, `compilationStartedAt`, `compilationCompletedAt`, `compilationArticleCounts`
- Added `CompilationStatus` type alias and `CompilationArticleCounts` interface to both type files
- Extended `AgentEventType` union with `compilation-started`, `compilation-completed`, `compilation-failed`
- Extended `AgentEvent` interface with compilation-specific fields: `compilationEvent`, `compilationStatus`, timestamps, error fields, article counts, story/epic/project IDs
- Extended `AgentJob` interface with `compilationStatus`, `compilationStartedAt`, `compilationCompletedAt`
- Daemon `executePipeline()` now tracks `compilationStartedAt`/`compilationCompletedAt` and calculates duration
- Daemon emits `compilation-started` event when first compile step begins, `compilation-completed` or `compilation-failed` with full metadata
- Non-blocking error handling: compile step failures are caught, logged, and skip remaining compile steps; pipeline continues to COMPLETED status
- Compilation failure writes fallback record to `knowledge/log.md` directly from daemon (handles case where COMPILER agent is the failing step)
- Created `daemon/pipelines/compile-events.mjs` with reusable event emission helpers: `emitCompilationStarted`, `emitCompilationCompleted`, `emitCompilationFailed`, `writeCompilationLog`, `parseArticleCounts`
- All event emitters wrapped in `nonBlocking()` to ensure they never throw
- DynamoDB persistence works via existing `updateJobFields()` — compilation metadata fields are stored alongside step results
- The `EpicWorkflow` repository's `updateEpicFields()` already handles partial updates; compilation metadata flows through the existing stories array update mechanism
- Backward compatible: `compilationStatus` is optional, existing stories without compilation have `undefined`
- TypeScript compiles cleanly

### File List

- `functions/shared/types/epic-workflow.ts` — MODIFIED: Added `CompilationStatus`, `CompilationArticleCounts`, and compilation metadata fields to `EpicStory`
- `src/types/epic-workflow.ts` — MODIFIED: Mirrored all type additions from backend
- `functions/shared/types/agent-orchestrator.ts` — MODIFIED: Added compilation event types, event fields, and `AgentJob` compilation metadata
- `daemon/agent-daemon.mjs` — MODIFIED: Non-blocking compile phase with timing capture, event emission, and fallback log writing
- `daemon/pipelines/compile-events.mjs` — NEW: Structured event emission helpers with non-blocking wrappers, log writer, and article count parser

## Senior Developer Review (AI)

- **Reviewer:** Claude Opus 4.6 (Senior Developer)
- **Date:** 2026-04-14
- **Outcome:** Changes Requested

### Findings

| #   | Severity | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | File(s)                                                                   | Recommendation                                                                                                                                                                                                                        |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | `compile-events.mjs` exports `emitCompilationStarted`, `emitCompilationCompleted`, `emitCompilationFailed`, `writeCompilationLog`, and `parseArticleCounts`, but **none are imported or used** by `daemon/agent-daemon.mjs`. The daemon implements its own inline event emission and log writing logic (lines ~698-757) that duplicates the functionality. This means the well-designed `nonBlocking()` wrapper, the structured `CompilationContext`/`CompilationResult` types, and the `parseArticleCounts()` regex parser are all dead code. | `daemon/pipelines/compile-events.mjs`, `daemon/agent-daemon.mjs`          | Import and use `compile-events.mjs` in the daemon, or remove the module. The module has better abstractions (typed contexts, non-blocking wrappers, sanitized log entries) than the inline implementation.                            |
| 2   | High     | The daemon's fallback log writer (agent-daemon.mjs line ~750) references `variables.STORY_ID` which is **never populated**. The pipeline variables start as `{ ITERATION: '1', MAX_ITERATIONS: '...' }` and no step injects `STORY_ID`. The fallback log entry will always show `"unknown"` as the story ID, making the failure record useless for debugging. By contrast, `compile-events.mjs`'s `writeCompilationLog()` takes `storyId` as an explicit parameter, which is the correct approach.                                             | `daemon/agent-daemon.mjs`                                                 | Either (a) inject `storyId` into the pipeline variables at job creation time, or (b) use the `writeCompilationLog()` from `compile-events.mjs` which takes storyId as a parameter and can source it from the job or pipeline context. |
| 3   | Medium   | The daemon does not persist `compilationArticleCounts` to the job record. Line ~813 calls `updateJobFields()` with `compilationStatus`, `compilationStartedAt`, `compilationCompletedAt` but not `compilationArticleCounts`. The `parseArticleCounts()` function in `compile-events.mjs` exists to extract these from the COMPILE_RESULT variable, but since the module is unused, article counts are never extracted or persisted. AC #2 requires "article counts (created, updated, superseded) are recorded in pipeline events."            | `daemon/agent-daemon.mjs`, `daemon/pipelines/compile-events.mjs`          | After the compile-knowledge step succeeds, parse `variables.COMPILE_RESULT` with `parseArticleCounts()` and include the counts in the completion event and job record.                                                                |
| 4   | Medium   | The `compilation-started`, `compilation-completed`, and `compilation-failed` event types are correctly added to the `AgentEventType` union in `agent-orchestrator.ts`, but the daemon emits all compilation events with `eventType: 'status'` (via `pushEvent(jobId, 'compile-phase', '__compiler__', 'status', {...})`), not with the new dedicated event types. The typed events are defined but never actually emitted.                                                                                                                     | `daemon/agent-daemon.mjs`, `functions/shared/types/agent-orchestrator.ts` | Use the new event types: `pushEvent(jobId, 'compile-phase', '__compiler__', 'compilation-started', {...})` etc. This enables frontend filtering and display of compilation events.                                                    |
| 5   | Medium   | AC #5 requires `knowledge/log.md` records "both successful and failed compilation attempts." The daemon writes a failure record to `knowledge/log.md` in the catch block, but does **not** write a success record. The success case relies on the COMPILER agent (Story 2.3) writing the log entry as part of its prompt instructions. If the COMPILER agent completes but forgets to append to `log.md`, there is no fallback success logging from the daemon.                                                                                | `daemon/agent-daemon.mjs`                                                 | Add a success log-write fallback after `compilationStatus = 'success'` is set (line ~715), similar to the failure fallback. This ensures the log is complete even if the COMPILER agent skips the log write.                          |
| 6   | Low      | The `AgentEvent` interface additions for compilation fields (lines 166-178 in `agent-orchestrator.ts`) use `string` for `compilationStatus` rather than the `CompilationStatus` type alias. While both are string-based, using the type alias would provide better type safety and documentation.                                                                                                                                                                                                                                              | `functions/shared/types/agent-orchestrator.ts`                            | Change `compilationStatus?: string` to `compilationStatus?: CompilationStatus` (import from `epic-workflow.ts`). Same for `compilationEvent?: string` -- define a union type.                                                         |
| 7   | Low      | The backend and frontend `EpicStory` interfaces are correctly synchronized (`functions/shared/types/epic-workflow.ts` and `src/types/epic-workflow.ts`). Both have `compilationStatus`, `compilationStartedAt`, `compilationCompletedAt`, and `compilationArticleCounts`. Good type mirroring.                                                                                                                                                                                                                                                 | Both type files                                                           | No change needed.                                                                                                                                                                                                                     |
| 8   | Info     | The `nonBlocking()` wrapper pattern in `compile-events.mjs` is a good defensive programming technique. It ensures that any event emission error is logged but never propagated. The daemon's inline try/catch blocks achieve the same goal but less elegantly.                                                                                                                                                                                                                                                                                 | `daemon/pipelines/compile-events.mjs`                                     | Adopt this pattern in the daemon by importing the module.                                                                                                                                                                             |
| 9   | Info     | The `compilationStatus` field correctly defaults to `undefined` for existing stories (backward compatible). The daemon sets it to `'skipped'` when compile steps exist but were never started, which could happen if a non-compile step fails before reaching the compile phase.                                                                                                                                                                                                                                                               | `daemon/agent-daemon.mjs`                                                 | No change needed. Backward compatibility is maintained.                                                                                                                                                                               |

### Action Items

- [x] Import and use `compile-events.mjs` in the daemon instead of inline event logic (eliminates findings #1, #2, #8)
- [x] Fix `STORY_ID` variable reference in daemon fallback log writer (high priority, also flagged in Story 2.1)
- [x] Persist `compilationArticleCounts` by parsing `COMPILE_RESULT` after successful compilation
- [x] Emit events with typed event types (`compilation-started`, etc.) instead of generic `status`
- [x] Add success log-write fallback to `knowledge/log.md`
- [x] Use `CompilationStatus` type alias in `AgentEvent` interface

### Summary

The type definitions are clean and correctly synchronized between backend and frontend. The `CompilationStatus`, `CompilationArticleCounts`, and new `AgentEventType` values are well-defined and aligned with the architecture. The `compile-events.mjs` module is well-designed with proper non-blocking wrappers, structured event emitters, a fallback log writer, and an article-count parser. However, the critical problem is that this module is **completely unused** -- the daemon inlines its own less robust versions of the same logic. This results in: (a) the `STORY_ID` bug, (b) missing article count tracking, (c) generic event types instead of typed compilation events, and (d) no success log fallback. Integrating `compile-events.mjs` into the daemon would resolve most findings in a single change.
