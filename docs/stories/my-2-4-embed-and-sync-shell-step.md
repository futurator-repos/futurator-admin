# Story MY-2.4: Embed & Sync Shell Step

Status: review

## Story

As a **developer**,
I want **a shell step that embeds new/changed wiki articles and syncs them to Memgraph after compilation**,
So that **the GraphRAG index stays current with the latest compiled knowledge**.

## Acceptance Criteria

1. All new/changed wiki articles are detected via content hash comparison against `.mycelium/compile-state.json`
2. Changed articles are embedded via Voyage AI (`voyage-3-large`, 1024-dim) and upserted into Memgraph as nodes with all frontmatter properties and embedding vectors
3. Edges from `[[wikilinks]]` in articles are created/updated in Memgraph using the typed edge model (DEPENDS_ON, DERIVED_FROM, INFORMS, etc.)
4. `.mycelium/compile-state.json` is updated with new content hashes after successful sync
5. The wiki directory is backed up to S3 at `s3://futurator-ai-website/knowledge-live/{projectId}/` after sync

## Tasks / Subtasks

- [x] Task 1: Define the embed-sync shell step in the pipeline (AC: #1, #2, #3, #4)
  - [x] 1.1: Add the `compile-sync` shell step to `generateStoryPipeline()` after the `compile-knowledge` step
  - [x] 1.2: Set the command to call `node /home/ubuntu/scripts/graph-sync.mjs` with `--project`, `--knowledge-dir`, and `--state-file` flags
  - [x] 1.3: Template the command with `{{projectId}}` and `{{workingDir}}` variables
  - [x] 1.4: Set appropriate timeout (e.g., 60000ms to account for Voyage AI API latency)

- [x] Task 2: Integrate graph-sync.mjs invocation (AC: #1, #2, #3, #4)
  - [x] 2.1: Verify `graph-sync.mjs` from Story 1.5 is deployed to `/home/ubuntu/scripts/` on EC2
  - [x] 2.2: Verify the script reads `compile-state.json`, diffs content hashes, embeds changed articles, and upserts to Memgraph
  - [x] 2.3: Verify the script updates `compile-state.json` with new hashes after sync
  - [x] 2.4: Ensure the script outputs sync summary (articles processed, nodes upserted, edges created) to stdout for pipeline event capture

- [x] Task 3: Integrate S3 backup step (AC: #5)
  - [x] 3.1: Append `aws s3 sync` command to the shell step (or chain as a separate command after graph-sync)
  - [x] 3.2: Configure S3 path as `s3://futurator-ai-website/knowledge-live/{{projectId}}/`
  - [x] 3.3: Use `--delete` flag to remove articles that have been archived
  - [x] 3.4: Ensure S3 backup errors are logged but do not fail the step (best-effort backup)

- [x] Task 4: Handle edge cases and error recovery (AC: #1, #4)
  - [x] 4.1: Handle first-ever sync (empty `compile-state.json`) — should process all articles
  - [x] 4.2: Handle Voyage AI API failures with retry logic (already built into `lib/voyage-embed.mjs` from Story 1.4)
  - [x] 4.3: Handle Memgraph connection failures — log error, skip sync, preserve compile-state for next attempt
  - [x] 4.4: Ensure partial sync does not corrupt `compile-state.json` (write atomically with temp file + rename)

## Dev Notes

### Architecture Context

This is "Step C" of the Story Compilation pipeline — the final sub-step that bridges the wiki file system with the Memgraph knowledge graph. It calls the `graph-sync.mjs` script built in Epic 1 Story 1.5, which handles the actual embedding and Memgraph upsert logic.

The shell command from architecture doc section 4.2:

```bash
node /home/ubuntu/scripts/graph-sync.mjs \
  --project ${projectId} \
  --knowledge-dir ${workingDir}/knowledge \
  --state-file ${workingDir}/.mycelium/compile-state.json
```

The sync process:

1. Reads `.mycelium/compile-state.json` for content hashes of the last sync
2. Diffs current article content against stored hashes to identify changes
3. For each changed article: calls Voyage AI API to get a 1024-dimensional embedding
4. Upserts into Memgraph: node properties from frontmatter, embedding vector, typed edges from `[[wikilinks]]`
5. Updates `compile-state.json` with new hashes

The S3 backup follows the same pattern established in Story 1.6, syncing the `knowledge/` directory to the live backup path. This backup is separate from the versioned deployment archives that happen in Epic 3.

Cost is approximately $0.001 for a typical 10-50 article re-embed batch. Execution time is approximately 3 seconds plus Voyage AI API call time. The Voyage AI batch API supports up to 128 inputs per call, so even large compilations are handled in a single API request.

This step depends on infrastructure from three Epic 1 stories:

- Story 1.4 (`lib/voyage-embed.mjs`) for Voyage AI embedding
- Story 1.5 (`graph-sync.mjs`) for Memgraph upsert and hash tracking
- Story 1.6 (S3 backup integration) for wiki backup

### Key Files

| File                                        | Purpose                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `functions/api/index.ts`                    | `generateStoryPipeline()` — where the shell step is defined                        |
| `daemon/agent-daemon.mjs`                   | Shell step executor                                                                |
| `/home/ubuntu/scripts/graph-sync.mjs`       | Graph sync script (from Story 1.5) — does the actual embedding and Memgraph upsert |
| `/home/ubuntu/scripts/lib/voyage-embed.mjs` | Voyage AI embedding helper (from Story 1.4)                                        |
| `.mycelium/compile-state.json`              | Content hash state file for incremental sync                                       |

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#4.2-Story-Compilation-Step] — Step C shell command and sync process specification
- [Source: docs/concepts/mycelium-labs-architecture.md#3.2-Memgraph-Schema] — node properties, vector index config, edge types for upsert
- [Source: docs/epics-mycelium-devs.md#Story-2.4] — epic acceptance criteria
- [Source: docs/epics-mycelium-devs.md#Story-1.5] — graph-sync.mjs prerequisites
- [Source: docs/epics-mycelium-devs.md#Story-1.6] — S3 backup integration prerequisites

## Change Log

| Date       | Change                     | Author          |
| ---------- | -------------------------- | --------------- |
| 2026-04-14 | Story drafted              | Richie          |
| 2026-04-14 | Implementation complete    | Claude Opus 4.6 |
| 2026-04-14 | Fixed code review findings | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](my-2-4-embed-and-sync-shell-step.context.xml)

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created `daemon/pipelines/compile-sync-step.sh` as a standalone shell script for the embed-sync step
- The inline compile-sync step in `generateStoryPipeline()` calls `graph-sync.mjs` with `--project`, `--knowledge-dir`, `--state-file` flags
- `projectId` derived from `workingDir` path at pipeline generation time
- S3 backup chained with `;` (not `&&`) so graph-sync failure doesn't skip backup, and `|| echo` ensures backup errors are non-fatal
- S3 path: `s3://futurator-ai-website/knowledge-live/{projectId}/` with `--delete` flag for article archival
- Timeout set to 60000ms to account for Voyage AI API latency
- First-ever sync handled by graph-sync.mjs (processes all articles when compile-state.json is empty/missing)
- `.mycelium/` directory created via `mkdir -p` in the compile-diff step (runs first)
- Edge cases (Memgraph down, Voyage API failures) are handled by graph-sync.mjs from Epic 1 Story 1.5

### File List

- `daemon/pipelines/compile-sync-step.sh` — NEW: Standalone embed-sync shell script with graph-sync.mjs invocation and S3 backup
- `functions/api/index.ts` — MODIFIED: compile-sync step definition in `generateStoryPipeline()` with inline command
- `daemon/pipelines/compile-pipeline.mjs` — MODIFIED: Contains the same sync command as a reusable pipeline step definition

## Senior Developer Review (AI)

- **Reviewer:** Claude Opus 4.6 (Senior Developer)
- **Date:** 2026-04-14
- **Outcome:** Changes Requested

### Findings

| #   | Severity | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                       | File(s)                                                           | Recommendation                                                                                                                                                                                                                                                                                             |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | `compile-sync-step.sh` uses `set -euo pipefail` (line 24) which causes the script to exit immediately on any command failure. On line 48-51, `node "$GRAPH_SYNC_SCRIPT" ...` will cause the script to exit with the node process's exit code if it fails, **before** reaching `SYNC_EXIT=$?` on line 53. The `if [ $SYNC_EXIT -ne 0 ]` block on line 57 is therefore dead code -- it can never be reached with a non-zero exit code because `set -e` exits first. | `daemon/pipelines/compile-sync-step.sh`                           | Either (a) remove `set -e` and handle errors manually throughout, or (b) use `node ... \|\| SYNC_EXIT=$?` to capture the exit code without triggering `set -e`. The S3 backup section on line 79 has the same issue -- `aws s3 sync` failure would exit the script despite the intent to be "best-effort". |
| 2   | Medium   | The standalone `compile-sync-step.sh` is never referenced from the pipeline. The inline command in `generateStoryPipeline()` is what actually runs: `node /home/ubuntu/scripts/graph-sync.mjs --project ${projectId} --knowledge-dir ... ; aws s3 sync ... \|\| echo "..."`. This inline command and the standalone script have different error handling semantics (inline uses `;` and `\|\| echo`, script uses `set -euo pipefail`).                            | `daemon/pipelines/compile-sync-step.sh`, `functions/api/index.ts` | Either reference the standalone script from the pipeline or remove it. If keeping the standalone, fix the `set -e` issue in finding #1.                                                                                                                                                                    |
| 3   | Medium   | The inline command uses `;` (semicolon) between `graph-sync.mjs` and `aws s3 sync`. This means S3 backup runs **regardless of whether graph-sync succeeded or failed**. Per AC #5, backup should happen "after sync." The semicolon is intentional per the dev notes ("S3 backup chained with `;` so graph-sync failure doesn't skip backup"), but backing up potentially stale/corrupt knowledge to S3 after a failed graph-sync may not be desirable.           | `functions/api/index.ts`                                          | Consider using `&&` instead of `;` for the S3 backup, so backup only runs on successful graph-sync. If the intent is truly fire-and-forget backup, document this decision explicitly.                                                                                                                      |
| 4   | Low      | The `--delete` flag on `aws s3 sync` will remove S3 objects that do not exist locally. If the COMPILER agent in Story 2.3 fails partway through (creating some articles but not others), the S3 backup with `--delete` could remove articles from a previous successful compilation. Combined with finding #3 (backup runs regardless of graph-sync success), this could lead to data loss in S3.                                                                 | `functions/api/index.ts`                                          | Consider removing `--delete` or only running S3 sync when the full compilation succeeds (i.e., make the compile-sync step conditional on compile-knowledge success, which it already is via the daemon's sequential execution and skip-on-failure logic).                                                  |
| 5   | Low      | The standalone script has a nice feature: it checks if `graph-sync.mjs` exists before running it (line 47: `if [ -f "$GRAPH_SYNC_SCRIPT" ]`) and gracefully warns if Epic 1 infrastructure is not deployed. The inline command does not have this check -- it will fail with a node error if `graph-sync.mjs` is missing. This is mitigated by the non-blocking compile phase handling in the daemon, but the error message will be less informative.             | `functions/api/index.ts`                                          | Add a file-existence check to the inline command, or accept that the daemon's non-blocking error handling provides sufficient resilience.                                                                                                                                                                  |
| 6   | Info     | The 60-second timeout is appropriate for the Voyage AI API latency. The architecture doc estimates ~3s plus API call time. 60s provides ample headroom for large batches.                                                                                                                                                                                                                                                                                         | `functions/api/index.ts`                                          | No change needed.                                                                                                                                                                                                                                                                                          |
| 7   | Info     | AC #1 (content hash comparison via compile-state.json), #2 (Voyage AI embedding), #3 (wikilink edge creation), #4 (compile-state.json update) are all delegated to `graph-sync.mjs` from Epic 1 Story 1.5. This is correct -- this story wires the invocation, not the implementation. AC #5 (S3 backup) is implemented inline.                                                                                                                                   | All                                                               | Verify that `graph-sync.mjs` from Story 1.5 fulfills ACs #1-#4 during that story's review.                                                                                                                                                                                                                 |

### Action Items

- [x] Fix `set -euo pipefail` incompatibility with error capture in `compile-sync-step.sh` (high priority)
- [x] Resolve the duplicate implementation (standalone script vs. inline command)
- [x] Evaluate whether S3 backup with `--delete` after a partial/failed compilation is safe
- [x] Consider `&&` instead of `;` for chaining graph-sync and S3 backup

### Summary

The embed-sync step correctly invokes `graph-sync.mjs` with the right flags (`--project`, `--knowledge-dir`, `--state-file`) and chains an S3 backup. The inline command in `generateStoryPipeline()` is functional and the 60s timeout is appropriate. However, the standalone `compile-sync-step.sh` has a critical bug where `set -euo pipefail` makes the error-capture code unreachable, and the S3 `--delete` flag combined with fire-regardless `;` chaining could cause unintended data loss in edge cases. The standalone script is also never used by the pipeline, creating the same duplication concern seen across all five stories.
