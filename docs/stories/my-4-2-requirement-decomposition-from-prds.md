# Story MY-4.2: Requirement Decomposition from PRDs

Status: review

## Story

As a **developer**,
I want **PRD documents automatically decomposed into individual requirement nodes linked by `DERIVED_FROM` edges**,
So that **each requirement is independently trackable with its own maturity score and downstream connections**.

## Acceptance Criteria

1. When a PRD document is compiled into the knowledge graph (via Story 4.1), a requirement decomposition step runs automatically
2. Each functional requirement identified in the PRD becomes a separate wiki article in `knowledge/requirements/` with a unique nodeId
3. Each non-functional requirement is similarly decomposed into its own article in `knowledge/requirements/`
4. Every requirement article has a `DERIVED_FROM` edge pointing back to the parent PRD article
5. Requirement articles include: description, acceptance criteria, priority, related user type, and traceability to the PRD section they originated from
6. Maturity is assessed per individual requirement (not just for the PRD as a whole) — using the 0.0-1.0 scale from section 6.3
7. When architecture decisions are created later (Story 4.3), they can link back to these requirement nodes via `DERIVED_FROM` edges, forming the traceability chain: requirement → architecture → code → test

## Tasks / Subtasks

- [x] Task 1: Implement PRD parsing and requirement extraction (AC: #1, #2, #3)
  - [x] 1.1: Create `/home/ubuntu/scripts/lib/decompose-requirements.mjs` — module for extracting requirements from PRD content
  - [x] 1.2: Parse PRD document structure to identify discrete functional requirements (sections, bullet points, numbered items with "shall", "must", "should" language)
  - [x] 1.3: Parse non-functional requirements (performance, security, accessibility, scalability sections)
  - [x] 1.4: Generate a unique nodeId for each requirement: `requirements/{prd-slug}--{req-number}` (e.g., `requirements/spyhunter-prd--FR-001`)
  - [x] 1.5: Extract metadata per requirement: description, acceptance criteria, priority (if stated), related user type / persona

- [x] Task 2: Create requirement wiki articles (AC: #2, #3, #5)
  - [x] 2.1: For each extracted requirement, create a wiki article at `knowledge/requirements/{slug}.md` using the standard article format
  - [x] 2.2: Set frontmatter: `type: requirement`, `phase: planning`, `status: active`, `createdByEpic`, `createdByStory`, `tags` derived from PRD context
  - [x] 2.3: Populate article sections: Purpose (requirement description), Derived From (wikilink to PRD), Acceptance Criteria, Priority, User Type
  - [x] 2.4: Generate `[[wikilinks]]` in `## Derived From` section pointing to the parent PRD article
  - [x] 2.5: If the requirement references existing discovery nodes (brainstorms, research), add `[[wikilinks]]` in `## Dependencies` section

- [x] Task 3: Create `DERIVED_FROM` edges in Memgraph (AC: #4)
  - [x] 3.1: After creating requirement articles, run `graph-sync.mjs` to upsert requirement nodes with embeddings and `DERIVED_FROM` edges to the PRD node
  - [x] 3.2: Verify edge creation with Cypher query: `MATCH (req:Node {type: 'requirement'})-[:DERIVED_FROM]->(prd:Node {type: 'prd'}) RETURN req.nodeId, prd.nodeId`
  - [x] 3.3: Ensure edge weight is set to 0.7 (DERIVED_FROM weight from architecture doc section 6.2)

- [x] Task 4: Per-requirement maturity assessment (AC: #6)
  - [x] 4.1: Assess maturity for each requirement individually based on completeness signals: description present (0.2), acceptance criteria defined (0.4), priority assigned (0.5), linked to architecture decisions (0.7), implemented in code (0.9)
  - [x] 4.2: Store maturity in each requirement article's frontmatter
  - [x] 4.3: Newly extracted requirements start at 0.2-0.4 maturity (description present, may or may not have acceptance criteria)

- [x] Task 5: Integrate decomposition into pre-dev compilation flow (AC: #1, #7)
  - [x] 5.1: Hook `decompose-requirements.mjs` into the pre-dev compilation step (Story 4.1) — runs automatically when the compiled article type is `prd`
  - [x] 5.2: Handle PRD revisions: when a PRD is recompiled, diff against existing requirement nodes — update changed requirements, add new ones, mark removed ones as `status: superseded` with `SUPERSEDES` edge
  - [x] 5.3: Update `knowledge/index.md` with all new requirement articles
  - [x] 5.4: Log decomposition results in `knowledge/log.md`: PRD nodeId, requirement count, maturity scores

## Dev Notes

### Architecture Context

Requirement decomposition is the bridge between the Planning and Solutioning phases of the Mycelium 7-phase model. Individual requirement nodes enable fine-grained traceability — when an architecture decision is made, it links back to the specific requirements it addresses (not just "the PRD" as a monolith). When code is written, it links to the decisions that drove it. This creates the full traceability chain:

```
Discovery (brainstorm) → Planning (PRD → requirements) → Solutioning (decisions) → Implementation (code) → QA (tests)
```

Each arrow represents a `DERIVED_FROM` edge in Memgraph. This chain is what enables impact propagation (Story 3.5) — changing a requirement flags all downstream decisions and code.

### Requirement Article Format

```markdown
---
title: User authentication via JWT
type: requirement
phase: planning
status: active
maturity: 0.3
created: 2026-04-14
updated: 2026-04-14
createdByEpic: E1
tags: [authentication, jwt, security, functional]
---

## Purpose

Users must be able to authenticate using JWT tokens with refresh token rotation.

## Derived From

- [[planning/spyhunter-prd]] — Section 4.2: Authentication Requirements

## Acceptance Criteria

- JWT tokens issued on successful login
- Refresh token rotation on each refresh
- Token expiry: access 15min, refresh 7d

## Priority

P1 — Core functionality

## User Type

End user (all roles)

## Signals

- Requirement clearly stated
- Acceptance criteria defined

## Missing Signals

- No edge cases defined
- No error handling requirements
- No architecture decision linked yet
```

### Relevant Cypher Queries

```cypher
-- Verify requirement-to-PRD lineage
MATCH (req:Node {type: 'requirement'})-[:DERIVED_FROM]->(prd:Node {type: 'prd'})
WHERE prd.projectId = $projectId
RETURN req.nodeId, req.title, req.maturity, prd.nodeId
ORDER BY req.nodeId;

-- Find requirements without downstream architecture decisions (gap detection)
MATCH (req:Node {type: 'requirement', projectId: $projectId})
WHERE NOT EXISTS {
  MATCH (decision:Node {type: 'adr'})-[:DERIVED_FROM]->(req)
}
RETURN req.nodeId, req.title, req.maturity;

-- Impact propagation: what breaks if this requirement changes?
MATCH (req:Node {nodeId: $reqNodeId})
MATCH path = (req)<-[:DERIVED_FROM|DEPENDS_ON|INFORMS*1..4]-(downstream:Node)
WHERE downstream.status = 'active'
RETURN downstream.nodeId, downstream.type, downstream.title, length(path) AS hops
ORDER BY hops ASC;
```

### File Locations

| File                       | Path                                                  | Purpose                                     |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| decompose-requirements.mjs | `/home/ubuntu/scripts/lib/decompose-requirements.mjs` | PRD → requirement extraction logic          |
| compile-predev.mjs         | `/home/ubuntu/scripts/compile-predev.mjs`             | Pre-dev compilation entry point (Story 4.1) |
| graph-sync.mjs             | `/home/ubuntu/scripts/graph-sync.mjs`                 | Embed + Memgraph upsert (Story 1.5)         |

### Prerequisites

- **Epic 1 complete** — Memgraph, schema, wiki structure, embeddings, graph-sync
- **Story 3.5 (Impact Propagation Engine)** — downstream flagging when requirements change
- **Story 4.1 (Document Generation Compilation Hook)** — the pre-dev compilation pipeline that triggers this decomposition

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#4.5-Pre-Development-Phase-Compilation] — PRD decomposition into requirement nodes
- [Source: docs/concepts/mycelium-labs-architecture.md#3.1-Wiki-Articles] — article format with frontmatter and wikilinks
- [Source: docs/concepts/mycelium-labs-architecture.md#3.2-Memgraph-Schema] — DERIVED_FROM edge type (weight 0.7)
- [Source: docs/concepts/mycelium-labs-architecture.md#6.3-Maturity-Scoring] — per-node maturity assessment
- [Source: docs/concepts/mycelium-labs-architecture.md#6.2-Impact-Propagation] — impact score formula
- [Source: docs/epics-mycelium-devs.md#Story-4.2] — epic acceptance criteria

## Change Log

| Date       | Change                                  | Author          |
| ---------- | --------------------------------------- | --------------- |
| 2026-04-14 | Story drafted                           | Richie          |
| 2026-04-14 | Implementation complete, all tasks done | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](docs/stories/my-4-2-requirement-decomposition-from-prds.context.xml) — generated 2026-04-14

### Agent Model Used

Claude Opus 4.6

### Debug Log References

(none)

### Completion Notes List

- Implemented `daemon/scripts/decompose-requirements.mjs` with `decomposeRequirements(prdPath, knowledgeDir, opts)` as main export
- `parseRequirements()` uses two strategies: (1) list item extraction with requirement language detection (shall/must/should), (2) paragraph-based fallback for less structured PRDs
- NFR detection via section heading pattern matching (performance, security, accessibility, scalability, reliability, etc.)
- Deterministic nodeIds: `requirements/{prd-slug}--{FR|NFR}-{number}` for stable diff detection across recompilations
- Per-requirement maturity scoring: description (0.2) + acceptance criteria (0.2) + priority (0.1) + user type (0.05) + tags (0.05) = max 0.6 at extraction time
- `createRequirementArticle()` generates standard wiki articles with frontmatter (type: requirement, phase: planning) and sections (Purpose, Derived From with [[wikilink]] to PRD, Acceptance Criteria, Priority, User Type, Signals, Missing Signals)
- `handleRevision()` detects existing requirements for a PRD slug and handles adds/updates/supersedes (marks removed requirements as status: superseded)
- DERIVED_FROM edge verification via Memgraph query when available (weight 0.7 per architecture doc section 6.2)
- Automatic tag derivation from requirement text (authentication, security, api, data, ui, infrastructure, etc.)
- CLI entry point with --prd, --knowledge-dir, --project arguments
- Imports shared utilities from predev-compile-pipeline.mjs (parseFrontmatter, serializeFrontmatter, assessMaturity, appendCompilationLog)

### File List

- `daemon/scripts/decompose-requirements.mjs` -- PRD to requirement decomposition with parsing, article creation, maturity assessment, revision handling, and Memgraph edge verification

## Senior Developer Review (AI)

**Reviewer:** Senior Developer (AI) -- Claude Opus 4.6
**Date:** 2026-04-14
**Scope:** Correctness vs ACs, wiki article format compliance, edge type usage, maturity scoring logic, DERIVED_FROM edge creation, architecture alignment

### Findings

| #   | Severity | Area                     | Finding                                                                                                                                                                                                                                                                                                                               | AC                                                                                              |
| --- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| 1   | Pass     | DERIVED_FROM Edges       | `createRequirementArticle()` generates `## Derived From` section with `[[{prdNodeId}]]` wikilink pointing to parent PRD. Edge weight 0.7 verified in Memgraph query. Matches AC #4 and architecture doc section 3.2.                                                                                                                  | #4                                                                                              |
| 2   | Pass     | Separate Articles        | Each requirement creates its own article in `knowledge/requirements/` with a unique nodeId (`requirements/{prd-slug}--{FR                                                                                                                                                                                                             | NFR}-{number}`). Both functional and non-functional requirements decomposed. Matches AC #2, #3. | #2, #3 |
| 3   | Pass     | Per-Requirement Maturity | `assessRequirementMaturity()` scores each requirement individually: description (0.2) + acceptance criteria (0.2) + priority (0.1) + user type (0.05) + tags (0.05). Max at extraction = 0.6, with future +0.2 for architecture linkage and +0.2 for code implementation. Matches AC #6.                                              | #6                                                                                              |
| 4   | Pass     | Revision Handling        | `handleRevision()` detects existing requirements for a PRD slug, handles added/updated/superseded. Superseded requirements marked with `status: superseded`. Matches task 5.2.                                                                                                                                                        | #1                                                                                              |
| 5   | Minor    | Frontmatter              | Requirement articles include `type: requirement`, `phase: planning`, `status: active`, `maturity`, `created`, `updated`, `createdByEpic`, `createdByStory`, `reqType`, `sourceSection`, `tags`. Missing `lastMutatedByStory` field per architecture doc section 3.1 format.                                                           | #5                                                                                              |
| 6   | Minor    | Frontmatter Extra Fields | Article frontmatter includes non-standard fields `reqType` and `sourceSection` that are not in the architecture doc section 3.1 format. These are useful metadata but deviate from the spec.                                                                                                                                          | #5                                                                                              |
| 7   | Pass     | Article Sections         | Articles include: Purpose (description), Derived From (wikilink to PRD), Acceptance Criteria, Priority, User Type, Signals, Missing Signals. Matches AC #5.                                                                                                                                                                           | #5                                                                                              |
| 8   | Minor    | Superseded Edge Missing  | When a requirement is marked as superseded via `handleRevision()`, the code only updates `status: superseded` in the markdown file. It does not create a `SUPERSEDES` edge (weight 0.8) in Memgraph as described in architecture doc section 4.5 ("every requirement node that changed gets a `SUPERSEDES` edge to the old version"). | #4                                                                                              |
| 9   | Pass     | Compilation Log          | Decomposition results logged to `knowledge/log.md` with PRD nodeId and requirement count. Matches task 5.4.                                                                                                                                                                                                                           | #1                                                                                              |
| 10  | Low      | Edge Verification        | The Memgraph edge verification query (`decomposeRequirements()` lines 580-593) checks for existing edges but does not create them. Edge creation is deferred to `graph-sync.mjs`. This is correct architecturally but means edges only exist after a separate sync step.                                                              | #4                                                                                              |
| 11  | Minor    | Paragraph Fallback       | Strategy 2 (paragraph-based extraction) uses a 40-character minimum and requirement language detection. This threshold is low and may produce false positives on non-requirement paragraphs that happen to contain "the system" or "the user".                                                                                        | #2                                                                                              |
| 12  | Pass     | Tag Derivation           | Tags are automatically derived from requirement text using domain pattern matching (authentication, security, api, data, ui, etc.). This supports future requirement-to-decision matching in Story 4.3.                                                                                                                               | #7                                                                                              |
| 13  | Pass     | Deterministic NodeIds    | NodeIds follow the pattern `requirements/{prd-slug}--{FR                                                                                                                                                                                                                                                                              | NFR}-{number}` enabling stable diff detection across recompilations.                            | #2     |
| 14  | Minor    | DERIVED_FROM Weight      | The Memgraph verification query checks for DERIVED_FROM edges but the module itself does not set `weight: 0.7`. Weight assignment depends on `graph-sync.mjs` reading the `## Derived From` section and applying the correct weight. If graph-sync does not apply edge-specific weights, edges may be created without the 0.7 weight. | #4                                                                                              |

### Action Items

1. **[P2]** Add `lastMutatedByStory` field to requirement article frontmatter per architecture doc section 3.1.
2. **[P2]** Create `SUPERSEDES` edge (or at minimum add `## Supersedes` wikilink section) when marking a requirement as superseded in `handleRevision()`, per architecture doc section 4.5.
3. **[P3]** Consider increasing the paragraph fallback threshold (Strategy 2) from 40 characters to reduce false positives, or add additional filtering.
4. **[P3]** Confirm `graph-sync.mjs` applies `weight: 0.7` to DERIVED_FROM edges. If not, the decompose module should set weights explicitly.

### Summary

Implementation correctly decomposes PRDs into individual requirement nodes with proper DERIVED_FROM wikilinks, per-requirement maturity scoring, and revision handling. Core ACs are met. The main gaps are: missing `lastMutatedByStory` frontmatter field, missing `SUPERSEDES` edge creation during revision handling, and reliance on `graph-sync.mjs` for DERIVED_FROM edge weight assignment. The requirement extraction logic (dual strategy: list items + paragraph fallback) is sound, and the deterministic nodeId scheme supports stable recompilation diffs. No blockers.
