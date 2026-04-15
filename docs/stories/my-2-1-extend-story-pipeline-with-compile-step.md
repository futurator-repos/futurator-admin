# Story MY-2.1: Extend Story Pipeline with COMPILE Step

Status: review

## Story

As a **developer**,
I want **the existing story pipeline extended to include a COMPILE step after the REVIEWER step**,
So that **every completed story automatically triggers knowledge compilation**.

## Acceptance Criteria

1. The `generateStoryPipeline()` function appends three new steps after the REVIEWER step: `compile-diff` (shell), `compile-knowledge` (agent), `compile-sync` (shell)
2. The COMPILE phase begins only after the REVIEWER step passes
3. Pipeline status events are emitted for each compilation sub-step (compile-diff, compile-knowledge, compile-sync)
4. Compilation failure does NOT fail the overall story pipeline — the story is still marked as completed
5. Each compilation sub-step captures output for the next step via the `captureAs` pattern (e.g., `DIFF_MANIFEST` from diff-extract feeds into compile-knowledge)
6. A `compilationStatus` field is added to story/epic workflow tracking with values: `'success' | 'failed' | 'skipped'`

## Tasks / Subtasks

- [x] Task 1: Add COMPILE step definitions to `generateStoryPipeline()` (AC: #1, #2)
  - [x] 1.1: Open `functions/api/index.ts` and locate `generateStoryPipeline()`
  - [x] 1.2: Append `compile-diff` shell step after the reviewer step — runs `git diff --name-status HEAD~1 HEAD` with fallback to `find`
  - [x] 1.3: Append `compile-knowledge` agent step with `agentId: 'COMPILER'`, prompt template referencing `{{DIFF_MANIFEST}}` and `{{WORK_SUMMARY}}`
  - [x] 1.4: Append `compile-sync` shell step calling `node /home/ubuntu/scripts/graph-sync.mjs`
  - [x] 1.5: Wire `captureAs` on each step so outputs chain correctly

- [x] Task 2: Add COMPILER agent configuration (AC: #1, #3)
  - [x] 2.1: Add `COMPILER` agent entry to the `agents` record in the pipeline definition
  - [x] 2.2: Configure allowed tools: `Read, Write, Edit, Glob, Grep`
  - [x] 2.3: Set appropriate model and effort parameters for the compiler agent

- [x] Task 3: Implement non-blocking error handling for COMPILE phase (AC: #4)
  - [x] 3.1: Wrap the three compile steps in a try/catch boundary in the daemon's `executePipeline()` loop
  - [x] 3.2: On compile step failure, log the error and emit a warning event but allow the pipeline to complete
  - [x] 3.3: Ensure `onFail.action` for compile steps is set to `'fail'` at step level but the pipeline treats the COMPILE phase as non-blocking

- [x] Task 4: Add `compilationStatus` field to workflow types (AC: #6)
  - [x] 4.1: Extend `EpicStory` interface in `functions/shared/types/epic-workflow.ts` with `compilationStatus?: 'success' | 'failed' | 'skipped'`
  - [x] 4.2: Update the story status update logic to set `compilationStatus` based on compile step outcomes
  - [x] 4.3: Mirror the type addition in `src/types/epic-workflow.ts` for frontend awareness

- [x] Task 5: Emit pipeline status events for compile sub-steps (AC: #3)
  - [x] 5.1: Ensure each compile step emits start/complete/failed events to `futurator-agent-events`
  - [x] 5.2: Include step ID, timing, and article counts in event payloads
  - [x] 5.3: Verify events appear in the existing event streaming infrastructure

## Dev Notes

### Architecture Context

This story bridges the existing Labs Testing Pipeline (Phases 1-4, fully implemented) with the Mycelium knowledge compilation system. The current story pipeline flows: `DEV → build-check → server-check → REVIEWER → (done)`. This story extends it to: `DEV → build-check → server-check → REVIEWER → COMPILE → (done)`.

The COMPILE step is a hybrid sequence of three sub-steps:

- **Step A (shell):** Diff extraction — identifies changed files ($0, ~2s)
- **Step B (agent):** Knowledge Compiler — creates/updates wiki articles (~$0.03-0.08)
- **Step C (shell):** Embed + sync — embeds articles via Voyage AI and upserts to Memgraph (~$0.001, ~3s)

The critical design decision is that compilation is **non-blocking**. A compilation failure must never prevent a story from being marked as completed. Knowledge compilation is an enhancement layer, not a gate. The `captureAs` pattern already exists in the daemon (see `agent-daemon.mjs` line ~470 where `variables[step.captureAs] = stdout`) and is the mechanism for chaining step outputs.

The pipeline already supports both `agent` and `shell` step types via the `PipelineStep` interface, so no new step type infrastructure is needed — only new step definitions and the COMPILER agent config.

### Key Files

| File                                           | Purpose                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `functions/api/index.ts`                       | Contains `generateStoryPipeline()` — the function to extend             |
| `daemon/agent-daemon.mjs`                      | Pipeline executor with `captureAs` support and `executePipeline()` loop |
| `functions/shared/types/agent-orchestrator.ts` | `PipelineStep`, `PipelineDefinition` types                              |
| `functions/shared/types/epic-workflow.ts`      | `EpicStory`, `StoryStatus` types to extend                              |
| `src/types/epic-workflow.ts`                   | Frontend mirror of workflow types                                       |

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#4.2-Story-Compilation-Step] — pipeline extension design and step definitions
- [Source: docs/concepts/mycelium-labs-architecture.md#4.1-Compilation-Triggers] — trigger model for implementation phase
- [Source: docs/epics-mycelium-devs.md#Story-2.1] — epic acceptance criteria
- [Source: docs/concepts/labs-testing-pipeline-plan.md#1.3-Pipeline-Definition-Changes] — existing `generateStoryPipeline()` structure

## Change Log

| Date       | Change                     | Author          |
| ---------- | -------------------------- | --------------- |
| 2026-04-14 | Story drafted              | Richie          |
| 2026-04-14 | Implementation complete    | Claude Opus 4.6 |
| 2026-04-14 | Fixed code review findings | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](my-2-1-extend-story-pipeline-with-compile-step.context.xml)

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Extended `generateStoryPipeline()` with 3 compile steps (compile-diff, compile-knowledge, compile-sync) appended after the review/retry steps
- Added COMPILER agent config with `allowedTools: 'Read,Write,Edit,Glob,Grep'` and model `sonnet`
- Added `epicId` parameter to opts and updated both call sites to pass it
- Derived `projectId` from `workingDir` path for graph-sync and S3 paths
- Created reusable `daemon/pipelines/compile-pipeline.mjs` with `getCompileSteps()` and `getCompilerAgent()` exports
- Modified `executePipeline()` in daemon to wrap compile steps in try/catch — failures log warnings but pipeline continues to COMPLETED
- Added `CompilationStatus` type and `compilationArticleCounts` interface to `epic-workflow.ts` (both backend and frontend)
- Added compilation metadata fields to `EpicStory` interface: `compilationStatus`, `compilationStartedAt`, `compilationCompletedAt`, `compilationArticleCounts`
- Added compilation event types to `AgentEventType` union and `AgentEvent` interface
- Added `compilationStatus`/timing fields to `AgentJob` interface
- TypeScript compiles cleanly with all changes

### File List

- `functions/api/index.ts` — MODIFIED: Extended `generateStoryPipeline()` with COMPILER agent and 3 compile steps; updated 2 call sites with `epicId`
- `functions/shared/types/epic-workflow.ts` — MODIFIED: Added `CompilationStatus` type, `CompilationArticleCounts` interface, compilation fields on `EpicStory`
- `src/types/epic-workflow.ts` — MODIFIED: Mirrored all type additions from backend
- `functions/shared/types/agent-orchestrator.ts` — MODIFIED: Added compilation event types, event fields, and `AgentJob` compilation metadata
- `daemon/agent-daemon.mjs` — MODIFIED: Added `isCompileStep()`, non-blocking compile phase handling in `executePipeline()`, compilation status tracking, fallback log writing
- `daemon/pipelines/compile-pipeline.mjs` — NEW: Reusable compile step definitions with `getCompileSteps()`, `getCompilerAgent()`, `isCompileStep()`, `COMPILE_STEP_IDS`

## Senior Developer Review (AI)

- **Reviewer:** Claude Opus 4.6 (Senior Developer)
- **Date:** 2026-04-14
- **Outcome:** Changes Requested

### Findings

| #   | Severity | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                        | File(s)                                                                                      | Recommendation                                                                                                                                                                                               |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Medium   | `compile-pipeline.mjs` exports `getCompileSteps()`, `getCompilerAgent()`, and `isCompileStep()` but **none are imported** by `functions/api/index.ts` or `daemon/agent-daemon.mjs`. The steps and agent config are inlined in `generateStoryPipeline()` and the daemon defines its own `isCompileStep()`. This creates **duplicate, divergent definitions** that will inevitably drift.                                                                            | `daemon/pipelines/compile-pipeline.mjs`, `functions/api/index.ts`, `daemon/agent-daemon.mjs` | Either (a) import from `compile-pipeline.mjs` in both consumers, or (b) remove the module and keep inline-only. Duplicated logic is a maintenance hazard.                                                    |
| 2   | Medium   | The daemon fallback log writer references `variables.STORY_ID` (line ~750 in `agent-daemon.mjs`), but `STORY_ID` is **never set** in the pipeline's `variables` map. The initial variables are `{ ITERATION: '1', MAX_ITERATIONS: '...' }`, and no step sets `STORY_ID`. This will always produce `"unknown"` in the failure log entry.                                                                                                                            | `daemon/agent-daemon.mjs`                                                                    | Either inject `STORY_ID` into the variables map at pipeline start (from the job's metadata), or extract the story ID from context passed differently (e.g., parse from prompt).                              |
| 3   | Low      | The `epicId` parameter was added to `opts` in `generateStoryPipeline()` and both call sites pass it correctly (lines 1331, 1633). However, it defaults to empty string (`opts.epicId \|\| ''`) in the compile-knowledge prompt rather than `undefined`, meaning the COMPILER agent sees `createdByEpic: ""` which is semantically misleading in frontmatter.                                                                                                       | `functions/api/index.ts`                                                                     | Default to a more explicit fallback like `'(not provided)'` or make `epicId` required since both call sites already supply it.                                                                               |
| 4   | Low      | The `projectId` derivation (`workingDir.split('/').filter(Boolean).pop()`) is fragile -- it assumes `workingDir` always ends with the project name and has no trailing slash. A path like `/home/ubuntu/projects/my-project/` would yield an empty string after `pop()` if there is a trailing slash.                                                                                                                                                              | `functions/api/index.ts`                                                                     | Use `path.basename(workingDir)` or strip trailing slashes first: `workingDir.replace(/\/+$/, '').split('/').pop()`.                                                                                          |
| 5   | Low      | The compile steps are appended to the `steps` array after the `retry` step (the loop-only target). This means they appear at indices 3-5. The daemon's loop-target detection (`loopTargetIds`) correctly skips `retry` in linear flow, but the ordering places compile steps after a loop-only step, which could confuse future maintainers.                                                                                                                       | `functions/api/index.ts`                                                                     | Add a comment block or visual separator in the steps array to clearly delineate the COMPILE phase from the DEV/REVIEW phase. (Already partially done with the `// -- COMPILE phase` comment, which is good.) |
| 6   | Info     | The `compile-pipeline.mjs` loads `compiler-prompt.md` via `readFileSync` at step-generation time, with a fallback inline prompt. This is good resilience. However, the inline prompt in `generateStoryPipeline()` and the file-based prompt in `compile-pipeline.mjs` are **different** -- the inline version is significantly shorter. Since only the inline version is actually used, the comprehensive prompt in `compiler-prompt.md` is effectively dead code. | `daemon/pipelines/compile-pipeline.mjs`, `functions/api/index.ts`                            | Reconcile: either load the file prompt from within `generateStoryPipeline()` or consolidate the prompts.                                                                                                     |

### Action Items

- [x] Resolve duplicate step definitions: either use `compile-pipeline.mjs` exports or remove the unused module
- [x] Fix `STORY_ID` variable reference in daemon fallback log writer so it resolves correctly
- [x] Improve `projectId` derivation robustness (handle trailing slashes)
- [x] Reconcile the two divergent compiler prompts (inline vs. file-based)

### Summary

The core architecture is sound: three compile sub-steps are correctly appended to `generateStoryPipeline()`, the COMPILER agent config is properly defined, the `captureAs` chaining pattern is correctly wired (`DIFF_MANIFEST` -> `COMPILE_RESULT`), and both call sites pass `epicId`. The non-blocking error handling in the daemon is well-implemented with proper try/catch, skip-remaining-steps logic, and event emission. The main concern is the **duplicate definitions**: `compile-pipeline.mjs` and `compile-events.mjs` were created as reusable modules but are never imported, resulting in two independent copies of step definitions, `isCompileStep()`, and event logic that will inevitably diverge. The `STORY_ID` variable bug should be fixed before merge.
