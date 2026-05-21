# Story 20.12: Pipeline-launcher accepts `sourceCommitSha` parameter

Status: DONE (2026-05-21)

## Story

As an operator clicking a future "Start story-pipeline from this branch" button (UI in Epic 22),
I want the launched pipeline to pin to the EXACT commit SHA at click time, not "whatever HEAD of the party branch happens to be when the pipeline runs the first story,"
so that a debate continuing after pipeline kickoff doesn't move the goalposts mid-run (mitigates `plan.md` §12.4 risk 26).

## Acceptance Criteria

1. `functions/shared/services/pipeline-launcher.ts::launchPipelineWave` (or sibling) accepts optional `sourceCommitSha?: string` in `planOpts`.
2. When `sourceCommitSha` is set, the launcher:
   - Passes it through to per-story `generateStoryPipeline` opts (already accepts `planSlug`, `planId`; new field `sourcePinSha`)
   - The story-pipeline's `compile-commit-on-pass` step's plan-branch checkout becomes: `git checkout <sourcePinSha>` first (puts the worktree at the pinned SHA), then `git checkout -b plan/<slug>` from THAT (the plan branch starts at the pinned SHA, not main's current HEAD)
3. When `sourceCommitSha` is unset (current behavior): plan branch starts at `main` HEAD (no change).
4. Validation: `sourceCommitSha` must match `/^[a-f0-9]{40}$/`. API rejects malformed input with 400.
5. **Pipeline-v2 regression**: existing pipelines (without `sourceCommitSha`) behave identically. Existing tests stay green.
6. New test (`functions/shared/pipelines/__tests__/story-pipeline-source-pin.test.ts`):
   - With `sourceCommitSha`: the compile-commit-on-pass shell includes `git checkout <sha>` before the plan-branch checkout
   - Without: no SHA pin appears in the shell (current behavior unchanged)
   - `bash -n` syntax check passes for both shell variants
7. Typecheck baseline maintained.

## Tasks / Subtasks

- [x] Task 1: Add `sourceCommitSha` to `PlanExecutionOpts` + thread through (AC: 1)
- [x] Task 2: Modify `compile-commit-on-pass` shell to pin when set (AC: 2)
- [x] Task 3: Validation (AC: 4) — `SOURCE_COMMIT_SHA_REGEX = /^[a-f0-9]{40}$/` + `isValidSourceCommitSha(x)` helper exported from `pipeline-launcher.ts`; launcher also throws if a malformed SHA reaches it (belt-and-suspenders for upstream caller)
- [x] Task 4: Test (AC: 6) — 5 new tests in `story-pipeline-source-pin.test.ts`
- [x] Task 5: Regression (AC: 5) — 54 existing baseline tests stay green
- [x] Task 6: Typecheck (AC: 7) — baseline 79 maintained

## Implementation notes (2026-05-21)

- `PlanExecutionOpts.sourceCommitSha?: string` threads through `launchPipelineWave` → `opts.sourceCommitSha` on the per-story pipeline → `generateStoryPipeline`'s `compile-commit-on-pass` step.
- Shell injection point: `git checkout <sha> && ` lands BEFORE the existing plan-branch checkout block, so the subsequent `git checkout -b plan/<slug>` creates the branch starting at the pinned SHA. Verified by an indexOf-ordering test.
- Validation: API routes that accept `sourceCommitSha` in their body (Epic 22's "Start story-pipeline from this branch" route) should call `isValidSourceCommitSha(sha)` first and 400 on false. The launcher itself throws if a malformed SHA reaches it — defense-in-depth against an upstream caller forgetting to validate.
- Short SHAs (7-12 chars) intentionally rejected. Git would accept them but the baked pipeline's checkout must be unambiguous across worktree contexts (e.g., if the bare repo gets garbage-collected between bake-time and run-time, a 7-char ambiguous prefix could resolve to a different commit).
- 5 tests added; 54 existing baseline tests stay green; `bash -n` syntax check passes for both pin and no-pin variants.

## Dev Notes

- This is a precondition for Epic 22's "Start story-pipeline from this branch" button — without the pin, the pipeline reads whatever the party branch HEAD happens to be at story-time, which races the live debate.
- The pin lives in the BAKED pipeline (per `architecture.md` §5.3 — job rows bake the pipeline at create time). Once the job is PENDING, subsequent party commits on the same branch are invisible to it.
- Don't break the existing pipeline-v2 contract: `sourceCommitSha` is optional and absent for all current callers.
