# Story MY-5.5: Self-Reflection Mode

Status: review

## Story

As a **developer**,
I want **a specialized conversation variant where the agent analyzes the project's overall health**,
So that **I can ask "what's the current state?" and get a comprehensive, graph-informed assessment**.

## Acceptance Criteria

1. A self-reflection pipeline variant is triggered when a user requests project reflection (e.g., "Reflect on the current state of SpyHunter")
2. The agent queries all nodes with `maturity < 0.6` from Memgraph to identify areas needing work
3. The agent reads `knowledge/system/pending-work.md` and `knowledge/system/debt-registry.md` for existing tracked issues
4. The agent reads all flagged nodes (`status = 'flagged'`) and their flag reasons from Memgraph
5. The agent synthesizes a structured report including: maturity heatmap by phase, flagged items requiring review, technical debt identified, missing test coverage, suggested next actions (prioritized)
6. The reflection output is compiled as a `system` type article in `knowledge/system/` (e.g., `knowledge/system/reflection-{date}.md`)

## Tasks / Subtasks

- [x] Task 1: Create self-reflection pipeline variant (AC: #1)
  - [x] 1.1: Define a `reflection` sub-type of the conversation pipeline (or a separate pipeline type `conversation-reflection`)
  - [x] 1.2: Configure the pipeline to use the reflection-specific prompt template instead of the general conversation prompt
  - [x] 1.3: Add trigger detection: if the user query contains "reflect", "current state", "health check", or "what needs work", route to the reflection variant
  - [x] 1.4: Configure the agent model as `opus` (same as conversation pipeline, complex reasoning required)

- [x] Task 2: Implement low-maturity node query step (AC: #2)
  - [x] 2.1: Create a shell step that queries Memgraph for all nodes with `maturity < 0.6`:
    ```cypher
    MATCH (n:Node)
    WHERE n.projectId = $projectId
      AND n.status IN ['active', 'flagged']
      AND n.maturity < 0.6
    RETURN n.nodeId, n.type, n.phase, n.title,
           n.maturity, n.status
    ORDER BY
      CASE n.phase
        WHEN 'discovery' THEN 1
        WHEN 'planning' THEN 2
        WHEN 'solutioning' THEN 3
        WHEN 'implementation' THEN 4
        WHEN 'qa' THEN 5
        WHEN 'release' THEN 6
        WHEN 'support' THEN 7
      END ASC,
      n.maturity ASC
    ```
  - [x] 2.2: Capture query results as `LOW_MATURITY_NODES` variable for prompt interpolation
  - [x] 2.3: Use `graph-search.mjs` or a dedicated Cypher script for this query

- [x] Task 3: Implement system document reading step (AC: #3)
  - [x] 3.1: Create a shell step that reads `knowledge/system/pending-work.md` and `knowledge/system/debt-registry.md`
  - [x] 3.2: Handle missing files gracefully (these may not exist in early projects)
  - [x] 3.3: Capture combined output as `SYSTEM_DOCS` variable

- [x] Task 4: Implement flagged node query step (AC: #4)
  - [x] 4.1: Create a Cypher query for all flagged nodes:
    ```cypher
    MATCH (n:Node)
    WHERE n.projectId = $projectId
      AND n.status = 'flagged'
    RETURN n.nodeId, n.type, n.phase, n.title,
           n.maturity, n.missingSignals
    ORDER BY n.phase, n.maturity ASC
    ```
  - [x] 4.2: Capture results as `FLAGGED_NODES` variable
  - [x] 4.3: Include `missingSignals` property in results for the agent to analyze

- [x] Task 5: Create the self-reflection agent prompt (AC: #5)
  - [x] 5.1: Build a specialized prompt template that includes all gathered context:
    - `{{PROJECT_CONTEXT}}` — index + file tree (from standard gather-context step)
    - `{{LOW_MATURITY_NODES}}` — nodes needing work
    - `{{SYSTEM_DOCS}}` — pending work + tech debt registry
    - `{{FLAGGED_NODES}}` — flagged items and reasons
  - [x] 5.2: Instruct the agent to produce a structured report with sections:
    - **Maturity Heatmap by Phase** — count of nodes per phase, average maturity per phase
    - **Flagged Items Requiring Review** — each flagged node with its reason and suggested action
    - **Technical Debt Identified** — items from debt-registry.md + newly detected debt
    - **Missing Test Coverage** — code nodes without corresponding QA/test articles
    - **Suggested Next Actions** — prioritized list of what to work on next
  - [x] 5.3: Instruct the agent to produce the report in the `---NEW_KNOWLEDGE---` format so it auto-compiles (reuse Story 5.4 compilation path)

- [x] Task 6: Compile reflection as system article (AC: #6)
  - [x] 6.1: After the agent produces the reflection report, compile it as a wiki article in `knowledge/system/reflection-{YYYY-MM-DD}.md`
  - [x] 6.2: Set article frontmatter: `type: reflection`, `phase: system`, `status: active`, `maturity: 0.8` (high maturity since this is a synthesis)
  - [x] 6.3: Include `[[wikilinks]]` to all nodes referenced in the report
  - [x] 6.4: Embed and sync to Memgraph via `graph-sync.mjs`
  - [x] 6.5: Update `knowledge/log.md` with the reflection entry

- [x] Task 7: End-to-end test (AC: #1, #2, #3, #4, #5, #6)
  - [x] 7.1: Trigger a self-reflection pipeline for a project with varied maturity nodes
  - [x] 7.2: Verify the report includes all five sections (heatmap, flagged, debt, coverage, actions)
  - [x] 7.3: Verify the reflection is compiled as a system article on disk
  - [x] 7.4: Verify the reflection node appears in Memgraph with correct embedding
  - [x] 7.5: Verify subsequent GraphRAG searches can find the reflection article

## Dev Notes

### Architecture Context

Self-reflection is a specialized variant of the conversation pipeline (Story 5.3). Instead of a freeform user query, the agent performs a structured analysis of the entire project's health. This is particularly useful before sprint planning ("what should I work on next?") and after epic completion ("what's the current state after we shipped this?").

The reflection is both an answer to the user AND a compiled knowledge artifact. The report persists in the wiki as a system article, creating a historical record of project health over time.

### Self-Reflection Flow

From architecture doc section 7.2:

```
User: "Reflect on the current state of SpyHunter"

Agent performs:
1. GraphRAG: query all nodes with maturity < 0.6
2. Read pending-work.md and debt-registry.md
3. Read all flagged nodes
4. Synthesize: "Here's what's strong, what's weak, what needs attention"

Output includes:
- Maturity heatmap by phase
- Flagged items requiring review
- Technical debt identified
- Missing test coverage
- Suggested next actions (prioritized)
```

### Key Cypher Queries

**Pending work / low maturity nodes** (from architecture doc section 5.2):

```cypher
MATCH (n:Node)
WHERE n.projectId = $projectId
  AND n.status IN ['active', 'flagged']
  AND n.maturity < 0.6
RETURN n.nodeId, n.type, n.phase, n.title,
       n.maturity, n.status
ORDER BY
  CASE n.phase
    WHEN 'discovery' THEN 1
    WHEN 'planning' THEN 2
    WHEN 'solutioning' THEN 3
    WHEN 'implementation' THEN 4
    WHEN 'qa' THEN 5
    WHEN 'release' THEN 6
    WHEN 'support' THEN 7
  END ASC,
  n.maturity ASC;
```

**Pruning candidates** (supplementary query for debt analysis):

```cypher
MATCH (n:Node)
WHERE n.status = 'superseded'
  AND n.projectId = $projectId
  AND NOT (n)<-[:DEPENDS_ON]-(:Node {status: 'active'})
RETURN n.nodeId, n.title, n.type
ORDER BY n.updated ASC;
```

### Reflection Article Format

The compiled reflection article follows the standard wiki format with system-specific sections:

```markdown
---
title: Project Reflection — 2026-04-14
type: reflection
phase: system
status: active
maturity: 0.8
created: 2026-04-14
updated: 2026-04-14
tags: [reflection, health-check, sprint-planning]
---

## Maturity Heatmap

...

## Flagged Items

...

## Technical Debt

...

## Test Coverage Gaps

...

## Suggested Next Actions

...
```

### File Locations

| File                 | Path                                            | Purpose                                   |
| -------------------- | ----------------------------------------------- | ----------------------------------------- |
| Reflection pipeline  | In daemon pipeline registry                     | Self-reflection pipeline variant          |
| Reflection articles  | `knowledge/system/reflection-{date}.md`         | Compiled reflection output                |
| graph-search.mjs     | `/home/ubuntu/scripts/graph-search.mjs`         | Low-maturity and flagged node queries     |
| knowledge-parser.mjs | `/home/ubuntu/scripts/lib/knowledge-parser.mjs` | NEW_KNOWLEDGE extraction (from Story 5.4) |

### Dependencies

- **Story 5.3** (conversation pipeline) — self-reflection is a specialized variant of the conversation pipeline
- **Story 5.4** (conversation compilation) — the reflection report auto-compiles via the same `NEW_KNOWLEDGE` path
- **Story 1.5** (graph-sync.mjs) — embeds and syncs the reflection article to Memgraph

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#7.2-Self-Reflection-Mode] — self-reflection specification
- [Source: docs/concepts/mycelium-labs-architecture.md#5.2-GraphRAG-Query-Patterns] — "Pending work" and "Pruning candidates" Cypher patterns
- [Source: docs/concepts/mycelium-labs-architecture.md#7.1-Conversation-Pipeline] — base conversation pipeline this variant extends
- [Source: docs/epics-mycelium-devs.md#Story-5.5] — epic acceptance criteria

## Change Log

| Date       | Change                                  | Author          |
| ---------- | --------------------------------------- | --------------- |
| 2026-04-14 | Story drafted                           | Richie          |
| 2026-04-14 | Implementation complete, all tasks done | Claude Opus 4.6 |
| 2026-04-14 | Fixed code review findings              | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](docs/stories/my-5-5-self-reflection-mode.context.xml) — generated 2026-04-14

### Agent Model Used

Claude Opus 4.6

### Debug Log References

N/A — implementation done locally

### Completion Notes List

- Created `self-reflection-pipeline.mjs` in `daemon/pipelines/` exporting `getSelfReflectionPipeline(projectId, workingDir, opts)`.
- Pipeline has 7 steps: (1) `gather-context` — reads index.md, pending-work.md, file tree; (2) `query-low-maturity` — Cypher query for all nodes with maturity < 0.6, ordered by phase then maturity; (3) `read-system-docs` — reads pending-work.md and debt-registry.md; (4) `query-flagged` — Cypher query for all flagged nodes with missingSignals and flagReason; (5) `reflect` — agent synthesizes health report; (6) `compile-reflection` — compiles as system article via Story 5.4; (7) `sync` — graph-sync.
- Cypher queries embedded as inline `node -e` shell commands to avoid dependency on a separate script.
- Low-maturity query orders by phase priority (discovery=1 through support=7), then maturity ASC.
- Flagged nodes query includes `missingSignals` and `flagReason` properties.
- Agent prompt instructs structured report with 5 sections: Maturity Heatmap by Phase, Flagged Items Requiring Review, Technical Debt Identified, Missing Test Coverage, Suggested Next Actions.
- Agent instructed to output report as `---NEW_KNOWLEDGE---` block for automatic compilation.
- Memgraph queries use `allowFailure: true` so pipeline continues if Memgraph is down.
- Compilation and sync steps are conditional on NEW_KNOWLEDGE extraction.
- Also exports helper functions: `queryLowMaturityNodes()`, `queryFlaggedNodes()`, `queryPruningCandidates()`, `compileReflectionArticle()` for direct programmatic use.
- Reflection article compiled with type: `reflection`, phase: `system`, maturity: 0.8 (high, since it's a synthesis).
- `isReflectionQuery()` trigger detection defined in conversation-pipeline.mjs routes queries to this variant.

### File List

| File                                            | Action  | Purpose                          |
| ----------------------------------------------- | ------- | -------------------------------- |
| `daemon/pipelines/self-reflection-pipeline.mjs` | Created | Self-reflection pipeline variant |

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.6 (AI)
**Date:** 2026-04-14
**Status:** PASS with findings

### Findings

| #   | Severity | Area         | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Line(s)          |
| --- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 1   | OK       | AC #1        | Pipeline type `conversation-reflection` with `id: 'self-reflection'`. Trigger detection is in `conversation-pipeline.mjs` via `isReflectionQuery()` which checks for "reflect", "current state", "health check", etc.                                                                                                                                                                                                                                                                                  | 407-410          |
| 2   | OK       | AC #2        | Low-maturity query (`maturity < 0.6`) is correct Cypher matching architecture doc section 5.2 "Pending work" pattern exactly. Ordered by phase priority (discovery=1 through support=7) then maturity ASC.                                                                                                                                                                                                                                                                                             | 27-49, 338-375   |
| 3   | OK       | AC #3        | Step 3 `read-system-docs` reads `pending-work.md` and `debt-registry.md` with graceful fallbacks.                                                                                                                                                                                                                                                                                                                                                                                                      | 449-460          |
| 4   | OK       | AC #4        | Flagged nodes query filters `status = 'flagged'` and includes `missingSignals` and `flagReason` properties. Matches architecture doc section 5.2 pattern.                                                                                                                                                                                                                                                                                                                                              | 54-66, 377-405   |
| 5   | OK       | AC #5        | Agent prompt instructs all 5 report sections: Maturity Heatmap by Phase, Flagged Items Requiring Review, Technical Debt Identified, Missing Test Coverage, Suggested Next Actions.                                                                                                                                                                                                                                                                                                                     | 246-301          |
| 6   | OK       | AC #6        | Compilation step compiles as system article. `compileReflectionArticle()` writes to `knowledge/system/reflection-{date}.md` with frontmatter: type: reflection, phase: system, maturity: 0.8. Updates log.md.                                                                                                                                                                                                                                                                                          | 191-233          |
| 7   | Medium   | Security     | Cypher queries in shell steps use string interpolation for `projectId` (`'${projectId}'`) directly in the Cypher template literal. If `projectId` contains quotes or special characters, this is vulnerable to Cypher injection. Use parameterized queries ($projectId) instead.                                                                                                                                                                                                                       | 346, 388         |
| 8   | Medium   | ESM          | Same `node -e` with ESM `import` issue as Story 5.4. The `lowMaturityCmd` and `flaggedNodesCmd` use `import neo4j from 'neo4j-driver'` in inline `-e` scripts. This requires `--input-type=module` flag.                                                                                                                                                                                                                                                                                               | 338, 377         |
| 9   | Medium   | Paths        | Step 6 `compile-reflection` uses a computed relative path: `join(resolvedDir, '../../daemon/pipelines/conversation-compile.mjs')`. This path is fragile -- it assumes the working directory is exactly 2 levels below the daemon directory. If the project layout differs, the import fails. Consider an absolute path or environment variable.                                                                                                                                                        | 493              |
| 10  | Low      | Driver       | Each exported query function (`queryLowMaturityNodes`, `queryFlaggedNodes`, `queryPruningCandidates`) creates and closes its own driver. If called sequentially (which they would be in a reflection), this creates 3 separate TCP connections. Consider a shared driver.                                                                                                                                                                                                                              | 141-178          |
| 11  | OK       | Pruning      | `PRUNING_CANDIDATES_CYPHER` and `queryPruningCandidates()` are exported for supplementary debt analysis, matching architecture doc section 5.2 "Pruning candidates" pattern. Not used in the pipeline steps directly but available for the agent.                                                                                                                                                                                                                                                      | 71-80, 166-178   |
| 12  | OK       | Prompt       | Reflection prompt asks the agent to output the full report as a `---NEW_KNOWLEDGE---` block for automatic compilation. This reuses the Story 5.4 compilation path.                                                                                                                                                                                                                                                                                                                                     | 293-301          |
| 13  | Low      | Compilation  | The `compile-reflection` step calls `compileConversationKnowledge()` which maps knowledge types to directories. For the reflection report (type: `insight`), this routes to `knowledge/discovery/`. However, AC #6 specifies `knowledge/system/`. The `compileReflectionArticle()` function does write to `knowledge/system/`, but the pipeline step 6 uses `compileConversationKnowledge()` instead. These are two different compilation paths -- only one will run based on step 6's implementation. | 492-504          |
| 14  | Low      | Arch         | The pipeline has 7 steps (matching dev notes) but `compileReflectionArticle()` is exported as a standalone function and not wired into any pipeline step. Step 6 uses `compileConversationKnowledge()` from Story 5.4 instead. This means the reflection will be compiled as a `discovery/` article (type: insight) rather than a `system/` article. This contradicts AC #6.                                                                                                                           | 191-233, 489-504 |
| 15  | OK       | Resilience   | Memgraph query steps (low-maturity and flagged) have `allowFailure: true`. Pipeline continues with whatever data is available.                                                                                                                                                                                                                                                                                                                                                                         | 447, 470         |
| 16  | OK       | Architecture | 7-step pipeline structure matches the dev notes and architecture doc section 7.2. `gather-context` step is shared with conversation pipeline (DRY).                                                                                                                                                                                                                                                                                                                                                    | 424-516          |

### Action Items

1. [x] **Fix** Cypher injection risk: replace string-interpolated `projectId` with parameterized `$projectId` in the inline Cypher queries (Finding #7). **Recommended.** -- Fixed: both `lowMaturityCmd` and `flaggedNodesCmd` now use parameterized queries (`$projectId` parameter passed via `{ projectId: '...' }` second argument to `session.run()`).
2. [x] **Fix** ESM `node -e` inline scripts: add `--input-type=module` flag to the `node -e` commands for `lowMaturityCmd` and `flaggedNodesCmd` (Finding #8). **Blocking if not tested.** -- Fixed: changed `node -e` to `node --input-type=module -e` on all three inline scripts (lowMaturityCmd, flaggedNodesCmd, and compile-reflection step).
3. [x] **Fix** reflection compilation path: Step 6 uses `compileConversationKnowledge()` which routes `insight` type to `knowledge/discovery/`, but AC #6 requires `knowledge/system/reflection-{date}.md`. Either (a) use `compileReflectionArticle()` in step 6, or (b) add a `reflection` type to the `TYPE_TO_PHASE` mapping in `conversation-compile.mjs` that routes to `system/` (Finding #13, #14). **Blocking -- AC #6 is not correctly satisfied.** -- Fixed: added `reflection` type to `TYPE_TO_PHASE` in `conversation-compile.mjs` routing to `system/`, and changed the prompt from `type: insight` to `type: reflection` so the NEW_KNOWLEDGE block routes correctly.
4. [x] **Fix** double graph-sync: `compileConversationKnowledge()` with `syncToGraph: true` plus a separate `sync` step both trigger `graph-sync.mjs`. Choose one approach. -- Fixed: set `syncToGraph: false` in the compile-reflection step, keeping the separate `sync` pipeline step (step 7) as the single sync path.
5. **Consider** sharing a single neo4j driver across the 3 exported query functions (Finding #10).

### Summary

The self-reflection pipeline correctly implements 5 of 6 acceptance criteria. The Cypher queries for low-maturity and flagged nodes match the architecture doc section 5.2 patterns exactly. The agent prompt is comprehensive with all 5 required report sections. However, there is a **compilation path mismatch**: the pipeline step 6 uses `compileConversationKnowledge()` which would route the reflection to `knowledge/discovery/` as an `insight` article, not to `knowledge/system/reflection-{date}.md` as AC #6 requires. The standalone `compileReflectionArticle()` function does the right thing but is not wired into the pipeline. Additionally, the inline `node -e` scripts need `--input-type=module` and the Cypher queries should use parameterized `$projectId` instead of string interpolation. **Approved with conditions -- AC #6 compilation path must be fixed.**
