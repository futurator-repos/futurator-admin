# Story MY-3.3: Deployment Compilation Pipeline

Status: review

## Story

As a **developer**,
I want **a compilation pipeline triggered after successful deployment**,
So that **wiki snapshots are archived, deployed code is marked, and deployment records are created for full release traceability**.

## Acceptance Criteria

1. When a deployment pipeline completes successfully (S3 sync + CloudFront invalidation), a `deploy-compile` pipeline job is automatically created and enqueued
2. The wiki directory is archived as a versioned tarball to `s3://futurator-ai-website/knowledge-archives/{projectId}/{date}.tar.gz`
3. A deployment record article is created at `knowledge/release/deploy-{date}.md` with: epic title, story count, deploy URL, and list of all code articles included in the deploy
4. All code articles whose epic status is `completed` are marked `status: deployed`
5. `knowledge/system/deployment-manifest.md` is updated with the deployment details (deploy date, URL, deployed article list)
6. `knowledge/log.md` records the deployment event with timestamp and summary
7. A full Memgraph resync runs after the agent step completes

## Tasks / Subtasks

- [x] Task 1: Create deployment completion listener (AC: #1)
  - [x] 1.1: Hook into the deployment pipeline completion event to detect successful deploys
  - [x] 1.2: Create `generateDeployCompilePipeline()` function that builds the three-step pipeline definition (shell → agent → shell)
  - [x] 1.3: Enqueue the `deploy-compile` job to `futurator-agent-jobs` with `projectId`, `PROJECT_NAME`, `DEPLOY_URL`, and `date` context
  - [x] 1.4: Emit pipeline status events for each compilation sub-step

- [x] Task 2: Implement S3 wiki snapshot shell step (AC: #2)
  - [x] 2.1: Create shell step that tars the `knowledge/` directory: `tar -czf /tmp/knowledge-{projectId}-{date}.tar.gz knowledge/`
  - [x] 2.2: Upload tarball to `s3://futurator-ai-website/knowledge-archives/{projectId}/{date}.tar.gz` via `aws s3 cp`
  - [x] 2.3: Each archive is a new file (versioned by date), never overwritten — full history is retained
  - [x] 2.4: Clean up local `/tmp/` tarball after successful upload
  - [x] 2.5: Snapshot failure logs a warning but does not block the remaining compilation steps

- [x] Task 3: Implement COMPILER agent deploy-nodes step (AC: #3, #4, #5, #6)
  - [x] 3.1: Create agent step with `agentId: 'COMPILER'` and post-deployment prompt from architecture doc section 4.4
  - [x] 3.2: Agent creates `knowledge/release/deploy-{date}.md` with deployment metadata: epic title, story count, deploy URL, and `[[wikilinks]]` to all deployed code articles
  - [x] 3.3: Agent scans all code articles and marks those with completed epic status as `status: deployed` in frontmatter
  - [x] 3.4: Agent updates `knowledge/system/deployment-manifest.md` with: latest deploy date, deploy URL, counts of deployed vs. pending articles
  - [x] 3.5: Agent appends deployment event to `knowledge/log.md` with timestamp, project name, and deployment summary
  - [x] 3.6: Agent updates `knowledge/index.md` to include the new deploy record article

- [x] Task 4: Implement full graph resync with prune flag (AC: #7)
  - [x] 4.1: Add shell step calling `node /home/ubuntu/scripts/graph-sync.mjs --project {{projectId}} --full-resync --prune --knowledge-dir {{workingDir}}/knowledge --state-file {{workingDir}}/.mycelium/compile-state.json`
  - [x] 4.2: The `--prune` flag tells graph-sync to remove nodes from Memgraph whose articles have been moved to `knowledge/archive/` (prepared for Story 3.4)
  - [x] 4.3: Include S3 live backup of `knowledge/` directory after sync

- [x] Task 5: Create `knowledge/release/` directory support (AC: #3)
  - [x] 5.1: Ensure `knowledge/release/` directory is part of the wiki initialization script (`init-wiki.sh` from Story 1.3)
  - [x] 5.2: Define deployment record article format with frontmatter: `type: deployment-record`, `phase: release`, `status: active`
  - [x] 5.3: Deployment record includes sections: Summary, Deployed Articles, Deploy Configuration, Release Notes

- [x] Task 6: Error handling (AC: #1)
  - [x] 6.1: Deploy compilation failure does NOT affect the deployment status (the app is already deployed)
  - [x] 6.2: Each step has independent error handling — snapshot failure does not block node marking, node marking failure does not block sync
  - [x] 6.3: Errors logged to `futurator-agent-events` with full context

## Dev Notes

### Architecture Context

This story implements the deployment compilation pipeline from the architecture doc section 4.4. It is the third compilation trigger in the system (after story compilation from Epic 2 and epic compilation from Story 3.1). Deployment compilation serves three purposes:

1. **Archival** — Creating versioned snapshots of the entire wiki at each deployment point, enabling rollback of knowledge state
2. **Status marking** — Transitioning code articles from `active` to `deployed`, confirming they are in production
3. **Pruning preparation** — Setting the stage for Story 3.4's pruning scan by having a clear deployed/not-deployed boundary

The pipeline has three steps matching the architecture doc:

```
shell (S3 snapshot) → agent (deploy nodes + records) → shell (graph resync with --prune)
```

**This story depends on Epic 2 being complete** and on Story 3.1 (epic compilation pipeline provides the pattern for the deploy compilation pipeline).

### Pipeline Definition

From the architecture doc (section 4.4):

```typescript
{
  id: 'deploy-compile',
  steps: [
    {
      id: 'snapshot',
      stepType: 'shell',
      command: `cd {{workingDir}} && \
        tar -czf /tmp/knowledge-{{projectId}}-{{date}}.tar.gz knowledge/ && \
        aws s3 cp /tmp/knowledge-{{projectId}}-{{date}}.tar.gz \
          s3://futurator-ai-website/knowledge-archives/{{projectId}}/{{date}}.tar.gz`,
    },
    {
      id: 'deploy-nodes',
      stepType: 'agent',
      agentId: 'COMPILER',
      prompt: `Post-deployment compilation for {{PROJECT_NAME}}.
        1. Create knowledge/release/deploy-{{date}}.md
        2. Mark code articles with status: deployed
        3. Update knowledge/system/deployment-manifest.md
        4. Update log.md`,
    },
    {
      id: 'prune-sync',
      stepType: 'shell',
      command: `node /home/ubuntu/scripts/graph-sync.mjs --project {{projectId}} --full-resync --prune ...`,
    },
  ],
}
```

[Source: docs/concepts/mycelium-labs-architecture.md#4.4-Deployment-Compilation-Step]

### Release Phase in Compilation Triggers

The deployment compilation maps to the "Release Phase" trigger from architecture doc section 4.1:

```
After DEPLOYMENT completion:
  1. Snapshot wiki → S3 (versioned archive tagged with deploy)
  2. Mark deployed code nodes status: deployed
  3. Update deployment-manifest
  4. PRUNE: find superseded nodes with no active dependents → move to archive/
  5. Create release-notes article
  6. Memgraph cleanup
```

Note: Step 4 (PRUNE) is implemented in Story 3.4, not this story.

### File Locations

| File               | Path                                                                     | Purpose                                         |
| ------------------ | ------------------------------------------------------------------------ | ----------------------------------------------- |
| Pipeline generator | `/home/ubuntu/agent-daemon/` (daemon codebase)                           | `generateDeployCompilePipeline()` function      |
| graph-sync.mjs     | `/home/ubuntu/scripts/graph-sync.mjs`                                    | Full resync + prune shell step (from Story 1.5) |
| S3 archive         | `s3://futurator-ai-website/knowledge-archives/{projectId}/{date}.tar.gz` | Versioned wiki snapshot                         |
| Deploy record      | `knowledge/release/deploy-{date}.md`                                     | Deployment record article                       |
| Deploy manifest    | `knowledge/system/deployment-manifest.md`                                | Current deployment state                        |

### Project Structure Notes

This story creates a new `knowledge/release/` directory for deployment records. The `init-wiki.sh` script from Story 1.3 should be updated to include this directory. The S3 archive path (`knowledge-archives/`) is separate from the live wiki backup path (`knowledge-live/`) used by Story 1.6.

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#4.4-Deployment-Compilation-Step] — pipeline definition and agent prompt
- [Source: docs/concepts/mycelium-labs-architecture.md#4.1-Compilation-Triggers] — release phase trigger description
- [Source: docs/concepts/mycelium-labs-architecture.md#6.1-Node-Status-Lifecycle] — status transitions (active → deployed)
- [Source: docs/concepts/mycelium-labs-architecture.md#3.1-Wiki-Articles] — article format and frontmatter
- [Source: docs/epics-mycelium-devs.md#Story-3.3] — epic acceptance criteria

## Change Log

| Date       | Change                  | Author          |
| ---------- | ----------------------- | --------------- |
| 2026-04-14 | Story drafted           | Richie          |
| 2026-04-14 | Implementation complete | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

docs/stories/my-3-3-deployment-compilation-pipeline.context.xml

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Implemented `getDeployCompileSteps(projectId, deployUrl, date)` returning a 3-step pipeline (shell snapshot -> agent deploy-nodes -> shell prune-sync)
- Implemented `generateDeployCompilePipeline()` for DynamoDB job payload generation
- S3 snapshot step: tars knowledge/, uploads to s3://futurator-ai-website/knowledge-archives/{projectId}/{date}.tar.gz, cleans up tmp
- Snapshot step uses `onFail: { action: 'continue' }` so failure does NOT block remaining steps
- COMPILER agent prompt covers: deploy record creation, status marking (active -> deployed), manifest update, log.md append, index.md update
- Deploy record format: type: deployment-record, phase: release, with Summary/Deployed Articles/Deploy Configuration/Release Notes sections
- Prune-sync step runs graph-sync.mjs with --full-resync --prune flags
- `shouldTriggerDeployCompile()` detects successful deployment pipeline completions
- Deploy compilation failure does NOT affect the deployment status (non-blocking)
- Each step has independent error handling (propagate: false)

### File List

- daemon/pipelines/deploy-compile-pipeline.mjs

---

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.6 (Senior Developer)
**Date:** 2026-04-14
**Implementation file:** `daemon/pipelines/deploy-compile-pipeline.mjs`

### Findings

| #   | Severity | Area               | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                        | Recommendation                                                                                                                                                                                                                                                                       |
| --- | -------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Info     | Architecture       | Three-step pipeline structure (`shell snapshot` -> `agent deploy-nodes` -> `shell prune-sync`) matches architecture doc section 4.4 exactly. Step IDs (`snapshot`, `deploy-nodes`, `prune-sync`) align with the spec.                                                                                                                                                                                                                          | No action needed.                                                                                                                                                                                                                                                                    |
| 2   | Info     | Correctness / AC#2 | S3 snapshot step correctly tars `knowledge/`, uploads to `s3://futurator-ai-website/knowledge-archives/{projectId}/{date}.tar.gz`, and cleans up the tmp file. Uses `&&` chaining so cleanup only happens on success.                                                                                                                                                                                                                          | No action needed.                                                                                                                                                                                                                                                                    |
| 3   | Info     | Correctness / AC#2 | Snapshot step uses `onFail.action: 'continue'` so snapshot failure does not block remaining steps. This matches AC#2 Task 2.5 and the error handling requirements.                                                                                                                                                                                                                                                                             | No action needed.                                                                                                                                                                                                                                                                    |
| 4   | Medium   | Correctness / AC#1 | `shouldTriggerDeployCompile()` uses string-matching heuristics (`pipelineId.startsWith('deploy-')` or `pipelineId.includes('deployment')`) and excludes compile pipelines. This is fragile -- a pipelineId like `deploy-compile-...` would match both `startsWith('deploy-')` and `includes('compile')`, which is correct (excluded). However, a deployment pipeline with an unconventional ID could be missed.                                | Consider either: (a) accepting the pipeline type as an explicit parameter rather than inferring from ID string, or (b) checking against a known set of deployment pipeline IDs from the project registry. The current approach works for the known naming convention but is brittle. |
| 5   | Low      | Correctness / AC#2 | `buildSnapshotCommand()` hardcodes `projectId` and `date` directly into the shell string via template literals rather than using `{{templateVar}}` syntax. This means the function generates the final command at pipeline creation time, not at execution time. While functionally equivalent for the current flow (both values are known at creation time), it breaks the template pattern used by other steps.                              | For consistency with the template pattern used elsewhere (e.g., `--project {{projectId}}`), use `{{projectId}}` and `{{date}}` placeholders in the snapshot command and let the daemon's template engine resolve them.                                                               |
| 6   | Info     | Correctness / AC#3 | COMPILER agent prompt covers: deployment record creation with correct frontmatter (`type: deployment-record`, `phase: release`), status marking (`active` -> `deployed`), manifest update, log.md append, and index.md update. All five agent tasks match the ACs.                                                                                                                                                                             | No action needed.                                                                                                                                                                                                                                                                    |
| 7   | Info     | Correctness / AC#7 | The `prune-sync` shell step correctly includes both `--full-resync` and `--prune` flags, matching the architecture doc section 4.4's third step.                                                                                                                                                                                                                                                                                               | No action needed.                                                                                                                                                                                                                                                                    |
| 8   | Low      | Architecture       | The architecture doc section 4.4 includes a "PRUNE SCAN" as task #3 in the agent prompt itself (agent finds superseded nodes and moves to archive). The implementation correctly separates this: the agent handles status marking, while the `--prune` flag on `graph-sync.mjs` handles actual pruning (delegated to Story 3.4's `pruning-scan.mjs`). This is a good design improvement over the architecture doc's monolithic agent approach. | No action needed -- cleaner separation of concerns.                                                                                                                                                                                                                                  |
| 9   | Info     | Error handling     | Deploy compilation failure does not affect deployment status (`onFail.propagate: false`). Each step has independent error handling. This matches AC#6 requirements.                                                                                                                                                                                                                                                                            | No action needed.                                                                                                                                                                                                                                                                    |
| 10  | Low      | Cross-story        | `createDeployPipelineEvent()` is nearly identical to `createPipelineEvent()` in `epic-compile-pipeline.mjs`. Both create DynamoDB event payloads with the same structure.                                                                                                                                                                                                                                                                      | Consider extracting a shared `createPipelineEvent()` utility into a common module (e.g., `daemon/lib/pipeline-events.mjs`) to avoid duplication. Both Story 3.1 and 3.3 would import from the shared module.                                                                         |

### Action Items

1. **[Medium]** Harden `shouldTriggerDeployCompile()` -- consider using explicit pipeline type metadata instead of string-matching heuristics on the pipelineId.
2. **[Low]** Align `buildSnapshotCommand()` to use template variable placeholders (`{{projectId}}`, `{{date}}`) for consistency with the daemon's template engine pattern.
3. **[Low]** Extract shared `createPipelineEvent()` utility to avoid code duplication with `epic-compile-pipeline.mjs`.

### Summary

Clean implementation of the three-step deployment compilation pipeline that closely follows architecture doc section 4.4. The separation of pruning concerns (agent does status marking, shell step delegates to `pruning-scan.mjs` via `graph-sync.mjs --prune`) is actually an improvement over the architecture doc's approach. The main concern is the fragile string-matching in `shouldTriggerDeployCompile()` for detecting deployment pipelines. Error handling is properly non-blocking across all steps. Pipeline event creation is duplicated with Story 3.1 and could be shared.
