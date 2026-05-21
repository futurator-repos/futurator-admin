# Story 20.13: Pipeline-v2 `commit-metadata.ts` calls `composeAgentCommit`

Status: TODO
Depends on: 19.5 (composer exists + tested)

## Story

As a maintainer of pipeline-v2's commit composition,
I want `functions/shared/pipelines/commit-metadata.ts::buildCommitShellSnippet` to delegate the message structure to the shared `agent-commit-composer.mjs` (Story 19.5),
so that pipeline-v2 and party-push compose commits through one code path and `git log --grep` queries work uniformly across both classes.

## Acceptance Criteria

1. `buildCommitShellSnippet` keeps its current input shape and returns the SAME bash snippet shape (the daemon's compile-commit-on-pass step's contract doesn't change).
2. Internally, the function calls `composeAgentCommit({ kind: 'pipeline', storyId, storyTitle, planId, planSlug, epicId, wave, rigor, ... })` to build the message structure, then renders the bash to assemble it at shell-time (because Skills-Used + Skills-Manifest-Sha are computed on EC2, not in the Lambda).
3. **Byte-for-byte regression**: existing pipeline-v2 commits look IDENTICAL before/after this refactor. Confirmed via:
   - The existing `commit-metadata.test.ts` tests stay green (no shell-output change)
   - A new "snapshot" test that asserts the bash output for a known input matches a pre-refactor snapshot
4. Skills lines (`Skills-Used`, `Skills-Manifest-Sha`) remain computed in shell at exec time (the composer can't know the EC2 filesystem state — it just emits placeholders the shell substitutes).
5. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: Refactor `buildCommitShellSnippet` to delegate (AC: 1, 2)
- [ ] Task 2: Snapshot test (AC: 3)
- [ ] Task 3: Existing tests stay green (AC: 3)
- [ ] Task 4: Typecheck (AC: 5)

## Dev Notes

- This is a non-functional refactor — same output, one source of truth. Worth doing because Epic 22's party UI will trigger debugging across both classes; one composer = less surface area.
- The composer's `kind: 'pipeline'` case emits subject + trailers; this story's bash wrapper adds the shell-time Skills computation around it.
- Per `plan.md` §11.4 step 13.
