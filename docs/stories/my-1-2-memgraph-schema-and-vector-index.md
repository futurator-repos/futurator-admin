# Story MY-1.2: Memgraph Schema & Vector Index Setup

Status: review

## Story

As a **developer**,
I want **the Memgraph schema (constraints, vector index) initialized and validated**,
So that **knowledge nodes can be stored with embeddings and queried via Cypher + vector search**.

## Acceptance Criteria

1. A uniqueness constraint exists on `Node.nodeId`
2. A vector index `knowledge_index` is created on `:Node(embedding)` with config: dimension 1024, capacity 50000, metric cosine, scalar f16
3. All 8 edge types are usable (DEPENDS_ON, DERIVED_FROM, INFORMS, REFINES, VALIDATES, SUPERSEDES, CONFLICTS_WITH, ENABLES)
4. A test node with a dummy 1024-dim embedding can be inserted and retrieved via vector search
5. The schema initialization script is idempotent (safe to re-run without errors or duplication)

## Tasks / Subtasks

- [x] Task 1: Create schema initialization script `init-memgraph.mjs` (AC: #1, #2, #3, #5)
  - [x] 1.1: Create `/home/ubuntu/scripts/init-memgraph.mjs` using `neo4j-driver`
  - [x] 1.2: Connect to Memgraph via `bolt://localhost:7687`
  - [x] 1.3: Create uniqueness constraint: `CREATE CONSTRAINT ON (n:Node) ASSERT n.nodeId IS UNIQUE;`
  - [x] 1.4: Create vector index: `CREATE VECTOR INDEX knowledge_index ON :Node(embedding) WITH CONFIG {"dimension": 1024, "capacity": 50000, "metric": "cos", "scalar_kind": "f16"};`
  - [x] 1.5: Verify all 8 edge types can be created between test nodes (DEPENDS_ON, DERIVED_FROM, INFORMS, REFINES, VALIDATES, SUPERSEDES, CONFLICTS_WITH, ENABLES)
  - [x] 1.6: Make script idempotent — check for existing constraints/indexes before creating, use `IF NOT EXISTS` where supported or catch duplicate errors gracefully

- [x] Task 2: Validate vector search capability (AC: #4)
  - [x] 2.1: Insert a test node with all expected properties (nodeId, projectId, type, phase, status, maturity, title, summary, tags, embedding)
  - [x] 2.2: Generate a dummy 1024-dimensional embedding vector (e.g., normalized random floats)
  - [x] 2.3: Execute vector search query: `CALL vector_search.search('knowledge_index', 5, $testVector) YIELD node, similarity`
  - [x] 2.4: Verify the test node is returned with similarity > 0.9
  - [x] 2.5: Clean up test data after validation

- [x] Task 3: Verify edge type creation and traversal (AC: #3)
  - [x] 3.1: Create two test nodes and one edge of each of the 8 types between them
  - [x] 3.2: Run traversal query: `MATCH (a)-[r]->(b) RETURN type(r), a.nodeId, b.nodeId`
  - [x] 3.3: Verify all 8 edge types are returned
  - [x] 3.4: Verify edges carry `weight` property as specified in the architecture doc
  - [x] 3.5: Clean up test data

- [x] Task 4: Add init-memgraph to setup flow (AC: #5)
  - [x] 4.1: Update `setup-memgraph.sh` or create a post-startup hook to call `init-memgraph.mjs` after Memgraph container is ready
  - [x] 4.2: Add retry logic for cases where Memgraph is still starting up (wait for Bolt port)
  - [x] 4.3: Log schema initialization results to stdout

## Dev Notes

### Architecture Context

This story initializes the Memgraph schema that underpins the entire knowledge graph query layer. Memgraph serves as the query accelerator — it is NOT the source of truth (wiki markdown files are). The schema defines:

1. **Node structure** — A single `:Node` label with properties mirroring wiki article frontmatter. The `nodeId` matches the wiki filename (e.g., `code/src--components--auth.tsx`).
2. **Vector index** — Enables semantic search via Voyage AI embeddings (1024-dim, voyage-3-large). The `knowledge_index` allows combined Cypher traversal + vector search in a single query (GraphRAG pattern).
3. **Edge types** — 8 relationship types with weights, derived from `[[wikilinks]]` in wiki articles. Each wiki section header maps to an edge type (e.g., `## Dependencies` maps to `DEPENDS_ON`).

The vector index config uses `f16` scalar kind to halve memory usage vs `f32` — important given the 512MB Memgraph memory limit on t4g.small.

### Schema DDL

From the architecture document, the complete schema:

```cypher
-- Uniqueness constraint
CREATE CONSTRAINT ON (n:Node) ASSERT n.nodeId IS UNIQUE;

-- Vector index
CREATE VECTOR INDEX knowledge_index ON :Node(embedding)
WITH CONFIG {
  "dimension": 1024,
  "capacity": 50000,
  "metric": "cos",
  "scalar_kind": "f16"
};
```

Node properties:

```cypher
(:Node {
  nodeId: "code/src--components--auth.tsx",
  projectId: "spyhunter",
  type: "code",
  phase: "implementation",
  status: "active",
  maturity: 0.7,
  title: "src/components/auth.tsx",
  summary: "Auth component with JWT login",
  tags: ["authentication", "jwt"],
  createdByEpic: "E1",
  createdByStory: "E1-S3",
  lastMutatedByStory: "E2-S1",
  created: "2026-04-13",
  updated: "2026-04-13",
  embedding: [0.023, -0.117, ...]
})
```

Edge types with weights:

| Edge Type      | Weight | Meaning                  |
| -------------- | ------ | ------------------------ |
| DEPENDS_ON     | 1.0    | B needs A                |
| DERIVED_FROM   | 0.7    | B extracted from A       |
| INFORMS        | 0.3    | A provides context for B |
| REFINES        | 0.5    | B adds detail to A       |
| VALIDATES      | 0.6    | B verifies/tests A       |
| SUPERSEDES     | 0.8    | B replaces A             |
| CONFLICTS_WITH | 0.9    | A and B contradict       |
| ENABLES        | 0.5    | A makes B possible       |

### File Locations

| File              | Path                                     | Purpose                                                            |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| init-memgraph.mjs | `/home/ubuntu/scripts/init-memgraph.mjs` | Schema initialization (constraints, vector index, edge validation) |
| package.json      | `/home/ubuntu/scripts/package.json`      | Already created in Story 1.1 with `neo4j-driver` dependency        |

### Prerequisites

- **Story MY-1.1** must be complete — Memgraph must be running and accessible on port 7687.
- The `neo4j-driver` package installed in Story 1.1 (`/home/ubuntu/scripts/package.json`) is reused here.

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#3.2-Memgraph-Schema] — node properties, vector index config, edge types with weights
- [Source: docs/concepts/mycelium-labs-architecture.md#5.2-GraphRAG-Query-Patterns] — vector search query syntax used in validation
- [Source: docs/concepts/mycelium-labs-architecture.md#8.2-Memgraph-Deployment] — Memgraph container config and memory constraints
- [Source: docs/concepts/mycelium-labs-architecture.md#9-Decisions-Log] — D2 (Memgraph chosen for semantic + structural search), D3 (Voyage AI voyage-3-large, 1024-dim)
- [Source: docs/epics-mycelium-devs.md#Story-1.2] — epic acceptance criteria

## Change Log

| Date       | Change                  | Author          |
| ---------- | ----------------------- | --------------- |
| 2026-04-14 | Story drafted           | Richie          |
| 2026-04-14 | Implementation complete | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](docs/stories/my-1-2-memgraph-schema-and-vector-index.context.xml) — generated 2026-04-14

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created `daemon/scripts/init-memgraph.mjs` — idempotent schema initialization script
- Script creates uniqueness constraint on `Node.nodeId` with graceful handling of "already exists" errors
- Creates vector index `knowledge_index` with 1024-dim, cosine, f16, 50k capacity config
- Validates all 8 edge types by creating test nodes/edges, running traversal queries, and verifying weights
- Vector search validation available via `--validate` flag (inserts test node with 1024-dim embedding, searches, verifies similarity > 0.9)
- All test data cleaned up after validation
- Includes `waitForMemgraph()` retry logic (10 attempts, 2s delay) for cold-start scenarios
- Updated `setup-memgraph.sh` to call `init-memgraph.mjs` as a post-startup step
- Added npm scripts to `package.json`: `init-memgraph`, `init-memgraph:validate`, `init-memgraph:json`

### File List

| Status   | File                                |
| -------- | ----------------------------------- |
| NEW      | `daemon/scripts/init-memgraph.mjs`  |
| MODIFIED | `daemon/memgraph/setup-memgraph.sh` |
| MODIFIED | `daemon/scripts/package.json`       |

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-14
**Outcome:** Approve

### Findings

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                    | File                                       | Recommendation                                                                                                                                                   |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Med      | Edge type validation always runs (not gated by `--validate`), which creates and deletes test nodes on every invocation. While the cleanup is solid, this adds unnecessary writes on routine schema-init calls (e.g., after EC2 reboot).                                                                                                                    | `daemon/scripts/init-memgraph.mjs:291-299` | Consider gating edge validation behind `--validate` as well, or add a `--skip-validation` flag. For now this is acceptable since init is infrequent.             |
| 2   | Low      | The PRNG in `generateTestEmbedding()` uses a simple LCG that produces deterministic floats. The normalization is correct. This is test-only code so the quality of randomness is irrelevant.                                                                                                                                                               | `daemon/scripts/init-memgraph.mjs:133-144` | No action needed.                                                                                                                                                |
| 3   | Low      | Edge creation in `validateEdgeTypes` uses string interpolation for the edge type name (`CREATE (a)-[:${type} ...]->(b)`). This is safe because the types come from a hardcoded constant array, not user input. However, this same pattern appears in `graph-sync.mjs` where edge types come from `SECTION_EDGE_MAP` (also hardcoded). Consistent and safe. | `daemon/scripts/init-memgraph.mjs:167`     | No action needed — Cypher parameterization does not support dynamic relationship types, so string interpolation from trusted constants is the standard approach. |
| 4   | Low      | The idempotent error matching checks for `'already exists'`, `'Constraint already'`, and `'equivalent'` — this covers known Memgraph error messages well.                                                                                                                                                                                                  | `daemon/scripts/init-memgraph.mjs:82-85`   | No action needed — good defensive coding.                                                                                                                        |

### Action Items

- [x] Uniqueness constraint on `Node.nodeId` created correctly (AC #1)
- [x] Vector index `knowledge_index` with correct config: 1024-dim, 50k capacity, cosine, f16 (AC #2)
- [x] All 8 edge types validated with correct weights per architecture doc (AC #3)
- [x] Vector search validation via `--validate` flag (AC #4)
- [x] Script is idempotent — catches "already exists" errors gracefully (AC #5)
- [x] `waitForMemgraph()` retry logic with 10 attempts and 2s delay
- [x] Proper session lifecycle — sessions opened and closed in finally blocks
- [x] Test data cleanup in finally blocks prevents leaked test nodes
- [x] No hardcoded secrets

### Summary

Solid schema initialization script. The idempotency handling is thorough, covering multiple Memgraph error message variants. The vector index configuration exactly matches the architecture doc. Edge type validation with weight verification is a nice touch. The only minor concern is that edge validation runs unconditionally, but given this script runs infrequently (setup and reboots only), the overhead is negligible.
