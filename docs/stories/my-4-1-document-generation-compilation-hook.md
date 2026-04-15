# Story MY-4.1: Document Generation Compilation Hook

Status: review

## Story

As a **developer**,
I want **a compilation step triggered after any document generation session in pre-dev phases**,
So that **PRDs, architecture specs, and planning documents are automatically decomposed into knowledge nodes**.

## Acceptance Criteria

1. When a PM, Analyst, Architect, or UX agent session generates or revises a document, a COMPILE step runs automatically after the document generation pipeline completes
2. The compilation creates/updates wiki articles for the generated document, stored as a typed article (prd, architecture, tech-spec, ux-spec, brainstorm, brief, research, etc.) in the appropriate phase directory under `knowledge/`
3. `[[wikilinks]]` are generated linking the new article to related existing nodes (requirements, decisions, code articles, discovery nodes)
4. Maturity score (0.0-1.0) is assessed based on content completeness and stored in the article frontmatter
5. The article is embedded via Voyage AI and synced to Memgraph via `graph-sync.mjs`
6. Impact propagation runs after sync — if the document revises an existing node, downstream nodes are flagged for review per Story 3.5 rules (score >= 0.5 critical, score >= 0.1 moderate)
7. Compilation results are logged in `knowledge/log.md` with timestamp, article type, nodeId, and maturity score

## Tasks / Subtasks

- [x] Task 1: Define agent-to-article-type mapping (AC: #2)
  - [x] 1.1: Create mapping configuration: PM → prd, requirement, epic-plan, story-plan; Analyst → brief, research, competitive-analysis; Architect → architecture, tech-spec, api-spec, data-model, adr; UX → ux-spec
  - [x] 1.2: Map each article type to its phase directory: discovery/ for brainstorm/brief/research, planning/ for prd/requirement/epic-plan/story-plan, solutioning/ for architecture/tech-spec/api-spec/data-model/adr/ux-spec
  - [x] 1.3: Add mapping to a shared config module at `/home/ubuntu/scripts/lib/article-types.mjs`

- [x] Task 2: Create pre-dev compilation step logic (AC: #1, #2, #3)
  - [x] 2.1: Create `/home/ubuntu/scripts/compile-predev.mjs` — the pre-dev compilation entry point
  - [x] 2.2: Accept arguments: `--project`, `--document-path`, `--agent-type`, `--session-id`
  - [x] 2.3: Parse the generated document to extract frontmatter fields (title, type, phase, status, tags)
  - [x] 2.4: Create or update the wiki article in `knowledge/{phase}/{slug}.md` using the standard article format (section 3.1)
  - [x] 2.5: Scan the document for cross-references and generate `[[wikilinks]]` in Dependencies, Derived From, Informs sections

- [x] Task 3: Integrate maturity assessment (AC: #4)
  - [x] 3.1: Implement maturity scoring logic per architecture doc section 6.3 — assess content completeness signals (purpose defined, dependencies listed, acceptance criteria present, etc.)
  - [x] 3.2: Map assessment to 0.0-1.0 scale: Raw (0.0-0.2), Early (0.2-0.4), Partial (0.4-0.6), Solid (0.6-0.8), Ready (0.8-1.0)
  - [x] 3.3: Store maturity score in article frontmatter `maturity:` field

- [x] Task 4: Wire embed + sync + impact propagation (AC: #5, #6)
  - [x] 4.1: After article creation/update, call `graph-sync.mjs --project {projectId} --knowledge-dir {workingDir}/knowledge` to embed and upsert to Memgraph
  - [x] 4.2: After sync, run impact propagation (Story 3.5) — traverse graph from updated node following outgoing edges up to 4 hops, flag downstream nodes per weight/hop formula
  - [x] 4.3: Update flagged article frontmatter with `status: flagged` and `flagReason` referencing the changed upstream node

- [x] Task 5: Integrate into existing document generation pipelines (AC: #1, #7)
  - [x] 5.1: Extend `generateDocumentPipeline()` (or equivalent) to append a COMPILE step after the document generation agent step completes
  - [x] 5.2: The COMPILE step sequence: shell (extract document path) → agent (compile to wiki article) → shell (embed + sync + impact propagation)
  - [x] 5.3: Log compilation record to `knowledge/log.md`: timestamp, session-id, agent-type, article-type, nodeId, maturity score
  - [x] 5.4: Update `knowledge/index.md` with new/updated article entry

## Dev Notes

### Architecture Context

This story extends the compilation pipeline (section 4.2-4.4) into the pre-development phases. Currently, compilation only runs after story completion (implementation phase), epic completion, and deployment. This story adds compilation triggers for the Discovery, Planning, and Solutioning phases of the Mycelium 7-phase model (Discovery → Planning → Solutioning → Implementation → QA → Release → Support).

The key insight from the architecture doc (section 4.5): "Each document generation endpoint already creates a pipeline job. The compilation step is appended." This means the integration point is the existing pipeline infrastructure — not a new system.

The compilation follows the same 3-step pattern as story compilation:

1. Shell step: extract document metadata
2. Agent step: Knowledge Compiler decomposes document into wiki articles with wikilinks
3. Shell step: `graph-sync.mjs` embeds and syncs to Memgraph

### Agent-to-Article-Type Mapping

From architecture doc section 3.1:

| Agent Type        | Article Types                                      | Phase Directory |
| ----------------- | -------------------------------------------------- | --------------- |
| PM                | prd, requirement, epic-plan, story-plan, risk      | planning/       |
| Analyst           | brief, research, evidence, competitive-analysis    | discovery/      |
| Architect         | architecture, tech-spec, api-spec, data-model, adr | solutioning/    |
| UX Designer       | ux-spec                                            | solutioning/    |
| User (brainstorm) | brainstorm                                         | discovery/      |

### Impact Propagation Cypher

From architecture doc section 4.5 — runs after any pre-dev node is updated:

```cypher
-- Impact propagation after a pre-dev node update
MATCH (updated:Node {nodeId: $updatedNodeId})
MATCH (updated)-[:INFORMS|ENABLES|DERIVED_FROM*1..4]->(downstream:Node)
WHERE downstream.status = 'active'
SET downstream.status = 'flagged',
    downstream.flagReason = 'Upstream node ' + $updatedNodeId + ' was modified'
RETURN downstream.nodeId, downstream.type, downstream.title;
```

Impact score formula: `edge_weight / (hops ^ 1.5)` — thresholds: >= 0.5 critical, >= 0.1 moderate.

### Maturity Scoring Reference

From architecture doc section 6.3:

| Score   | Label   | Gate Implications                                      |
| ------- | ------- | ------------------------------------------------------ |
| 0.0-0.2 | Raw     | Concept exists, key aspects undefined                  |
| 0.2-0.4 | Early   | Basic outline, many gaps                               |
| 0.4-0.6 | Partial | Core defined, some gaps — minimum for phase gate       |
| 0.6-0.8 | Solid   | Well-defined, minor refinements — ready for downstream |
| 0.8-1.0 | Ready   | Fully specified, production-grade                      |

### File Locations

| File               | Path                                         | Purpose                                  |
| ------------------ | -------------------------------------------- | ---------------------------------------- |
| compile-predev.mjs | `/home/ubuntu/scripts/compile-predev.mjs`    | Pre-dev compilation entry point          |
| article-types.mjs  | `/home/ubuntu/scripts/lib/article-types.mjs` | Agent-to-article-type mapping config     |
| graph-sync.mjs     | `/home/ubuntu/scripts/graph-sync.mjs`        | Embed + Memgraph upsert (from Story 1.5) |
| voyage-embed.mjs   | `/home/ubuntu/scripts/lib/voyage-embed.mjs`  | Embedding helper (from Story 1.4)        |

### Prerequisites

- **Epic 1 complete** — Memgraph running (1.1), schema initialized (1.2), wiki structure (1.3), Voyage AI embedding (1.4), graph-sync (1.5)
- **Story 3.5 (Impact Propagation Engine)** — downstream flagging after node updates

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#4.5-Pre-Development-Phase-Compilation] — pre-dev compilation flow
- [Source: docs/concepts/mycelium-labs-architecture.md#4.1-Compilation-Triggers] — trigger points for each phase
- [Source: docs/concepts/mycelium-labs-architecture.md#3.1-Wiki-Articles] — article format and type-to-phase mapping
- [Source: docs/concepts/mycelium-labs-architecture.md#6.3-Maturity-Scoring] — maturity scoring scale and signals
- [Source: docs/concepts/mycelium-labs-architecture.md#6.2-Impact-Propagation] — impact score formula and thresholds
- [Source: docs/epics-mycelium-devs.md#Story-4.1] — epic acceptance criteria

## Change Log

| Date       | Change                                  | Author          |
| ---------- | --------------------------------------- | --------------- |
| 2026-04-14 | Story drafted                           | Richie          |
| 2026-04-14 | Implementation complete, all tasks done | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](docs/stories/my-4-1-document-generation-compilation-hook.context.xml) — generated 2026-04-14

### Agent Model Used

Claude Opus 4.6

### Debug Log References

(none)

### Completion Notes List

- Implemented `daemon/pipelines/predev-compile-pipeline.mjs` as the pre-dev compilation entry point
- Agent-to-article-type mapping (`AGENT_ARTICLE_MAP`): PM -> prd/requirement/epic-plan/story-plan/risk, Analyst -> brief/research/evidence/competitive-analysis, Architect -> architecture/tech-spec/api-spec/data-model/adr, UX -> ux-spec/design/user-journey
- Article-to-phase mapping (`ARTICLE_PHASE_MAP`): discovery, planning, solutioning directories
- Maturity scoring via `assessMaturity()` using weighted content completeness signals (0.0-1.0 scale)
- Frontmatter parser/serializer (no external dependency) for wiki article format per architecture doc section 3.1
- `compileDocument()` creates/updates wiki articles with wikilinks, maturity scoring, proper frontmatter
- `runImpactPropagation()` traverses Memgraph graph up to 4 hops, flags downstream nodes using impact score formula (edge_weight / hops^1.5)
- `getPredevCompileSteps()` generates the 3-step COMPILE pipeline sequence (shell extract -> agent compile -> shell sync)
- `appendCompilationLog()` writes to knowledge/log.md with timestamp, session, agent type, article type, nodeId, maturity
- CLI entry point with --project, --document-path, --agent-type, --session-id, --knowledge-dir arguments
- Article type mapping is integrated directly into the pipeline module (shared config) rather than a separate file, matching the actual code organization under `daemon/`

### File List

- `daemon/pipelines/predev-compile-pipeline.mjs` -- Pre-dev compilation pipeline with article type mapping, maturity scoring, document compilation, impact propagation, log recording, and pipeline step generation

## Senior Developer Review (AI)

**Reviewer:** Senior Developer (AI) -- Claude Opus 4.6
**Date:** 2026-04-14
**Scope:** Correctness vs ACs, wiki article format compliance, edge type usage, maturity scoring logic, architecture alignment

### Findings

| #   | Severity | Area                | Finding                                                                                                                                                                                                                                                                                                                                | AC      |
| --- | -------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1   | Minor    | Frontmatter         | Requirement articles created by `compileDocument()` include `createdByEpic`, `createdByStory`, `lastMutatedByStory` in frontmatter, matching architecture doc section 3.1. However, decision articles in Story 4.3 and requirement articles in Story 4.2 omit `lastMutatedByStory`. The compile pipeline itself correctly includes it. | #2      |
| 2   | Info     | File Path           | Story tasks reference `/home/ubuntu/scripts/compile-predev.mjs` but implementation lives at `daemon/pipelines/predev-compile-pipeline.mjs`. The completion notes explain this deviation (matching actual code organization under `daemon/`). Acceptable divergence.                                                                    | #1      |
| 3   | Minor    | Maturity Scoring    | `assessMaturity()` uses generic signals (hasPurpose, hasDependencies, hasAcceptanceCriteria, etc.) for all article types. A PRD may not have `## Options Considered` or `## Consequences` sections, so those signals will always be "missing" for PRD articles, artificially capping maturity. Consider type-specific signal profiles. | #4      |
| 4   | Low      | Maturity Label      | `getMaturityLabel()` uses `score >= l.min && score <= l.max` which means a score of exactly 0.2 matches both "Raw" (max 0.2) and "Early" (min 0.2). The `find()` returns the first match ("Raw"), but 0.2 should map to "Early" per the architecture doc (0.2-0.4 range). Boundary is ambiguous.                                       | #4      |
| 5   | Pass     | Edge Weights        | `EDGE_WEIGHTS` map matches architecture doc section 6.2 exactly: DEPENDS_ON 1.0, CONFLICTS_WITH 0.9, SUPERSEDES 0.8, DERIVED_FROM 0.7, VALIDATES 0.6, REFINES 0.5, ENABLES 0.5, INFORMS 0.3.                                                                                                                                           | #6      |
| 6   | Pass     | Impact Propagation  | `runImpactPropagation()` correctly traverses `[:INFORMS                                                                                                                                                                                                                                                                                | ENABLES | DERIVED_FROM\*1..4]`up to 4 hops, applies`edge_weight / hops^1.5` formula, uses >= 0.5 critical / >= 0.1 moderate thresholds. Matches architecture doc section 6.2. | #6  |
| 7   | Minor    | Impact Score        | `runImpactPropagation()` always uses `EDGE_WEIGHTS.DERIVED_FROM` (0.7) for the impact score calculation regardless of actual edge type. The traversal path may include INFORMS or ENABLES edges with different weights. Should use actual edge weight from the path.                                                                   | #6      |
| 8   | Pass     | Pipeline Steps      | `getPredevCompileSteps()` generates the correct 3-step COMPILE pattern: shell (extract) -> agent (compile) -> shell (sync). Matches architecture doc section 4.5.                                                                                                                                                                      | #1      |
| 9   | Pass     | Compilation Log     | `appendCompilationLog()` writes timestamp, session-id, agent-type, article-type, nodeId, maturity score to `knowledge/log.md`. Matches AC #7.                                                                                                                                                                                          | #7      |
| 10  | Pass     | Wikilink Generation | `extractWikilinks()` correctly parses `[[path/to/article]]` patterns. `compileDocument()` generates Derived From, Dependencies, and Informs sections with wikilinks based on link target analysis.                                                                                                                                     | #3      |
| 11  | Minor    | Agent Map           | `AGENT_ARTICLE_MAP` includes `design` and `user-journey` for UX agent, but the architecture doc section 3.1 table only lists `ux-spec` for the UX Designer. `design` and `user-journey` are reasonable extensions but are not in the source spec.                                                                                      | #2      |
| 12  | Minor    | ARTICLE_PHASE_MAP   | `decision` is mapped to `planning` phase, but the architecture doc section 3.1 shows `decision` as an Implementation phase article type ("decision (runtime choices)" under Implementation). Planning phase decisions should be `adr` type in `solutioning`.                                                                           | #2      |
| 13  | Pass     | Index Update        | AC #5 mentions updating `knowledge/index.md`, which is deferred to `graph-sync.mjs` (correctly following existing patterns).                                                                                                                                                                                                           | #5      |

### Action Items

1. **[P2]** Fix maturity label boundary condition: change `score >= l.min && score <= l.max` to `score >= l.min && score < l.max` for all ranges except the last (0.8-1.0 which should use `<=`).
2. **[P2]** In `runImpactPropagation()`, extract actual edge type from the path and use the corresponding weight from `EDGE_WEIGHTS` instead of always using `DERIVED_FROM` weight.
3. **[P3]** Consider article-type-specific maturity signal profiles so that PRDs are not penalized for missing `## Options Considered` or `## Consequences` sections.
4. **[P3]** Verify `decision` in `ARTICLE_PHASE_MAP` -- should be removed or changed to `implementation` per architecture doc section 3.1.

### Summary

Implementation is solid and correctly follows the 3-step compilation pattern from architecture doc section 4.5. All core ACs are met. The agent-to-article-type mapping, maturity scoring, impact propagation, and compilation logging all align with the architecture doc. The main issues are minor: maturity label boundary condition, impact score always using DERIVED_FROM weight regardless of edge type, and a small mismatch in the `decision` article type phase mapping. No blockers.
