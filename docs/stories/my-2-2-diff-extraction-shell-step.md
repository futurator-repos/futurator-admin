# Story MY-2.2: Diff Extraction Shell Step

Status: review

## Story

As a **developer**,
I want **a shell step that extracts the list of changed files after a story completes**,
So that **the Knowledge Compiler knows exactly which files to process**.

## Acceptance Criteria

1. The diff extraction step outputs a `DIFF_MANIFEST` listing all created, modified, and deleted files
2. When git history is available, the step uses `git diff --name-status HEAD~1 HEAD` to determine changes
3. When git is not available, the step falls back to `find . -newer .mycelium/last-compile-marker -type f` to detect changes by timestamp
4. The output excludes `node_modules/`, `.git/`, and `knowledge/` directories
5. The step updates `.mycelium/last-compile-marker` timestamp after successful extraction
6. The output format is one line per file: `STATUS\tFILENAME` (A=added, M=modified, D=deleted)

## Tasks / Subtasks

- [x] Task 1: Implement the diff extraction shell command (AC: #1, #2, #6)
  - [x] 1.1: Define the `compile-diff` shell step in `generateStoryPipeline()` with the git diff command
  - [x] 1.2: Set `captureAs: 'DIFF_MANIFEST'` so the output is available to the next step
  - [x] 1.3: Ensure the command runs in the project's `workingDir` via `cd ${workingDir}`
  - [x] 1.4: Validate output format matches `STATUS\tFILENAME` for each changed file

- [x] Task 2: Implement the fallback detection mechanism (AC: #3, #4)
  - [x] 2.1: Add `2>/dev/null ||` fallback to `find` command when git diff fails
  - [x] 2.2: Configure `find` with `-not -path` exclusions for `node_modules/`, `.git/`, and `knowledge/`
  - [x] 2.3: Ensure the find fallback produces compatible output format (map found files to `A\tFILENAME`)

- [x] Task 3: Handle the compile marker file (AC: #5)
  - [x] 3.1: Create `.mycelium/last-compile-marker` if it does not exist (first compilation)
  - [x] 3.2: After successful diff extraction, update the marker with `touch .mycelium/last-compile-marker`
  - [x] 3.3: Ensure the marker update is appended to the shell command so it only runs on success

- [x] Task 4: Add directory exclusion filters (AC: #4)
  - [x] 4.1: For git diff mode: pipe through `grep -v` to exclude `node_modules/`, `.git/`, `knowledge/`
  - [x] 4.2: For find fallback mode: use `-not -path` arguments for each excluded directory
  - [x] 4.3: Verify exclusions work for nested paths (e.g., `src/node_modules/` should still be excluded)

- [x] Task 5: Test edge cases (AC: #1, #2, #3)
  - [x] 5.1: Verify behavior when no files have changed (empty DIFF_MANIFEST)
  - [x] 5.2: Verify behavior on first-ever compilation (no git history, no marker file)
  - [x] 5.3: Verify behavior when git repository has uncommitted changes

## Dev Notes

### Architecture Context

This is "Step A" of the Story Compilation pipeline as defined in the architecture document section 4.2. It is a pure shell step with zero cost (~2 seconds execution time, $0 API cost). The diff extraction runs in the project workspace on the EC2 instance.

The shell command from the architecture doc:

```bash
cd ${workingDir} && \
  git diff --name-status HEAD~1 HEAD 2>/dev/null || \
  find . -newer .mycelium/last-compile-marker -type f \
    -not -path './node_modules/*' -not -path './.git/*'
```

The output is captured via the `captureAs: 'DIFF_MANIFEST'` mechanism in the daemon's pipeline executor. The daemon already handles `captureAs` for shell steps — when a shell step completes, `variables[step.captureAs] = stdout` (see `daemon/agent-daemon.mjs`). The `DIFF_MANIFEST` variable is then injected into the Knowledge Compiler agent's prompt via `{{DIFF_MANIFEST}}` template substitution.

The `.mycelium/` directory is established in Epic 1 Story 1.3 (Wiki Directory Structure). The `last-compile-marker` file is specific to this story — it provides the timestamp reference for the `find` fallback path.

Note: `git diff --name-status` output naturally produces the `STATUS\tFILENAME` format (e.g., `M\tsrc/app.tsx`), making it directly compatible with the expected output contract. The `find` fallback needs formatting to match.

### Key Files

| File                                           | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `functions/api/index.ts`                       | `generateStoryPipeline()` — where the shell step is defined |
| `daemon/agent-daemon.mjs`                      | Shell step executor with `captureAs` variable capture       |
| `functions/shared/types/agent-orchestrator.ts` | `PipelineStep` interface with `captureAs` field             |

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#4.2-Story-Compilation-Step] — Step A shell command specification
- [Source: docs/concepts/mycelium-labs-architecture.md#4.1-Compilation-Triggers] — implementation phase trigger model
- [Source: docs/epics-mycelium-devs.md#Story-2.2] — epic acceptance criteria

## Change Log

| Date       | Change                     | Author          |
| ---------- | -------------------------- | --------------- |
| 2026-04-14 | Story drafted              | Richie          |
| 2026-04-14 | Implementation complete    | Claude Opus 4.6 |
| 2026-04-14 | Fixed code review findings | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](my-2-2-diff-extraction-shell-step.context.xml)

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created standalone `daemon/scripts/compile-diff.sh` script with git diff primary path and find fallback
- Implemented in `generateStoryPipeline()` as inline shell command (compile-diff step) with `captureAs: 'DIFF_MANIFEST'`
- Git diff path: `git diff --name-status HEAD~1 HEAD` piped through `grep -v` for exclusions
- Find fallback: uses `-newer .mycelium/last-compile-marker` with `-not -path` exclusions, output formatted as `A\tFILENAME` via `sed`
- Handles first-run (no marker, no git parent) by treating all files as Added
- `.mycelium/` directory created via `mkdir -p` before diff
- Marker file touched only after successful extraction (chained with `&&`)
- Excludes: `node_modules/`, `.git/`, `knowledge/` (and nested occurrences)
- Empty diff output is valid (exit 0) — no files changed means no compilation needed

### File List

- `daemon/scripts/compile-diff.sh` — NEW: Standalone diff extraction script for reuse and testing
- `functions/api/index.ts` — MODIFIED: compile-diff step definition with inline shell command in `generateStoryPipeline()`
- `daemon/pipelines/compile-pipeline.mjs` — NEW: Contains the same diff command as a reusable pipeline step definition

## Senior Developer Review (AI)

- **Reviewer:** Claude Opus 4.6 (Senior Developer)
- **Date:** 2026-04-14
- **Outcome:** Changes Requested

### Findings

| #   | Severity | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | File(s)                                                    | Recommendation                                                                                                                                                                                                                                                                       |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | High     | The inline shell command in `generateStoryPipeline()` uses `\|\|` (OR) between the git diff pipeline and the find fallback. However, because `git diff` output is piped through `grep -v`, **if git diff succeeds but grep filters out all lines** (e.g., all changed files are in excluded directories), the pipeline exit code is non-zero (grep returns 1 for no matches), which triggers the `find` fallback unnecessarily. This can produce incorrect results (find may report files that are not actually changed). | `functions/api/index.ts` (compile-diff step)               | Add `\|\| true` after the `grep -v` to ensure an empty grep result does not trigger the fallback: `git diff --name-status HEAD~1 HEAD 2>/dev/null \| grep -v -E '...' \|\| true`. Then separate the fallback with an explicit git-availability check.                                |
| 2   | Medium   | The standalone `compile-diff.sh` script is well-written with proper `set -euo pipefail`, structured functions, and edge-case handling, but it is **never referenced** from the pipeline. The inline command in `generateStoryPipeline()` is a simpler one-liner that diverges from the script's logic (e.g., the script excludes `.mycelium/*` but the inline command does not; the script has a `git ls-files` fallback for repos with no parent commit, the inline does not).                                           | `daemon/scripts/compile-diff.sh`, `functions/api/index.ts` | Either reference the standalone script (`bash /home/ubuntu/daemon/scripts/compile-diff.sh ${workingDir}`) in the pipeline step, or remove the standalone script to avoid drift. The script has better edge-case coverage.                                                            |
| 3   | Medium   | AC #6 requires output format `STATUS\tFILENAME`. The `git diff --name-status` output natively matches this. However, the `find` fallback uses `sed 's/^/A\\t/'` which inserts a literal backslash-t, not a tab character, in some sed implementations. In the inline command, the double-escaped `\\t` within a JS template literal becomes `\t` in the shell, which sed on Linux interprets as a tab. However, on macOS (dev environment), BSD sed does **not** interpret `\t` as tab -- it produces a literal `\t`.     | `functions/api/index.ts`, `daemon/scripts/compile-diff.sh` | Use `sed "s/^/A\t/"` with a literal tab (printf) or use `awk '{print "A\t"$0}'` which handles tab portably. The standalone script uses the same pattern -- verify on the target EC2 environment (Linux) where it works correctly. This is low risk if the daemon only runs on Linux. |
| 4   | Low      | The inline command chains `&& touch .mycelium/last-compile-marker` at the end. If the git diff succeeds but produces empty output (no changes), the `&&` still succeeds, and the marker is updated. This is correct per AC #5. However, the command structure `(...) && touch` means the touch only runs if the subshell (diff or find) succeeds. With the `\|\|` fallback, if both git diff and find fail, the touch is skipped. This is correct behavior.                                                               | `functions/api/index.ts`                                   | No change needed -- behavior is correct. Document the intent in a code comment for maintainability.                                                                                                                                                                                  |
| 5   | Low      | The `.mycelium/` directory exclusion is missing from the inline command's `grep -v` filter pattern. Files in `.mycelium/` could appear in the DIFF_MANIFEST if they were committed. The standalone script correctly excludes `.mycelium/*`.                                                                                                                                                                                                                                                                               | `functions/api/index.ts`                                   | Add `\\.mycelium/` to the `grep -v` exclusion pattern in the inline command.                                                                                                                                                                                                         |
| 6   | Info     | The `find` fallback in the inline command does not strip the leading `./` from paths, while the standalone script does (`sed 's\|^\./\|\|'`). This means the DIFF_MANIFEST format differs between the two implementations, potentially confusing the COMPILER agent.                                                                                                                                                                                                                                                      | `functions/api/index.ts`                                   | Add `\| sed 's\|^\./\|\|'` to the find fallback in the inline command for consistent output.                                                                                                                                                                                         |

### Action Items

- [x] Fix the `grep -v` exit code issue that causes false fallback to `find`
- [x] Resolve the divergence between standalone `compile-diff.sh` and the inline command (use one or the other)
- [x] Add `.mycelium/` to the inline command's exclusion filter
- [x] Verify `sed` tab handling on the target Linux environment

### Summary

The diff extraction logic is functionally correct for the happy path (git repo with recent commit). The standalone `compile-diff.sh` is more robust with better edge-case handling (no parent commit, first compilation, `.mycelium/` exclusion) and is the recommended implementation. The main issue is that the inline command in `generateStoryPipeline()` and the standalone script have diverged, creating maintenance risk. The grep exit-code issue (finding #1) could cause incorrect DIFF_MANIFEST contents in edge cases where all changed files are in excluded directories. Overall, the `captureAs: 'DIFF_MANIFEST'` wiring is correct and the output format matches the contract expected by the Knowledge Compiler in Story 2.3.
