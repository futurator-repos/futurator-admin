# Mycelium-Labs Integration — Architecture Document

**Date:** 2026-04-13
**Origin:** Party Mode deliberation — Rick, Winston, Ludwig, Dr. Quinn, John, Mary
**Status:** DRAFT — Solutioning Phase

---

## 1. Vision

Create a living development system where agentic workflows (Labs) produce applications that are self-aware — every code file, every decision, every requirement exists as a node in an interconnected knowledge graph that the AI can search semantically, traverse structurally, and maintain autonomously.

The system covers the full project lifecycle — from discovery and brainstorming through deployment and support — keeping all artifacts (code, docs, decisions, logs) perpetually updated, pruning what's obsolete, and always knowing what needs attention next.

### Core Principles

| Principle                             | Meaning                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The pipeline is the compiler**      | Knowledge isn't maintained separately — every pipeline run (story, epic, deployment, conversation) automatically compiles new knowledge into the graph     |
| **The wiki is the compiled output**   | Structured markdown articles are the persistent, human-readable knowledge layer — the LLM writes and maintains all of it (Karpathy pattern)                |
| **Memgraph is the query accelerator** | Vector embeddings + graph edges enable semantic search combined with structural traversal in one query (GraphRAG)                                          |
| **The organism prunes itself**        | Superseded nodes are detected, flagged, archived. The graph stays current. Dead knowledge composts into archival storage                                   |
| **Documents ARE the graph**           | PRDs, architecture docs, tech specs aren't separate from the knowledge graph — they are high-maturity nodes within it, connected to everything they inform |

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        EC2 INSTANCE (t4g.small)                  │
│                        i-0826d68c316ae97dd                       │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  Agent Daemon (agent-daemon.mjs)                        │     │
│  │  - Polls futurator-agent-jobs every 3s                  │     │
│  │  - Executes pipelines: agent steps + shell steps        │     │
│  │  - NEW: compilation steps after story/epic/deploy       │     │
│  │  - NEW: GraphRAG search available to all agents         │     │
│  └────────────────────┬────────────────────────────────────┘     │
│                       │                                          │
│  ┌────────────────────┼────────────────────────────────────┐     │
│  │  Project Workspace  │                                    │     │
│  │  /home/ubuntu/projects/{name}/                          │     │
│  │    ├── src/                    ← raw code (Dev agents)  │     │
│  │    ├── package.json                                     │     │
│  │    ├── knowledge/              ← compiled wiki (LLM)    │     │
│  │    │   ├── index.md            master catalog           │     │
│  │    │   ├── log.md              append-only ops log      │     │
│  │    │   ├── code/               one article per file     │     │
│  │    │   ├── decisions/          architecture choices     │     │
│  │    │   ├── requirements/       PRD-derived reqs         │     │
│  │    │   ├── discovery/          brainstorms, research    │     │
│  │    │   ├── planning/           epics, stories, roadmap  │     │
│  │    │   ├── solutioning/        arch, tech spec, API     │     │
│  │    │   ├── qa/                 test plans, results      │     │
│  │    │   ├── system/             cross-cutting synthesis  │     │
│  │    │   │   ├── dependency-map.md                        │     │
│  │    │   │   ├── deployment-manifest.md                   │     │
│  │    │   │   ├── debt-registry.md                         │     │
│  │    │   │   └── pending-work.md                          │     │
│  │    │   └── archive/            pruned nodes             │     │
│  │    └── .mycelium/              local graph metadata     │     │
│  │        ├── compile-state.json  hashes of last compile   │     │
│  │        └── embeddings-queue.json pending re-embeds      │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  Memgraph (Docker container)                            │     │
│  │  Port 7687 │ Memory limit 512MB                         │     │
│  │  - Node vector index (Voyage AI, 1024-dim, f16, cos)   │     │
│  │  - Knowledge nodes with embeddings                      │     │
│  │  - Typed edges (8 relationship types)                   │     │
│  │  - Cypher queries: traversal + vector search combined   │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
    DynamoDB              S3 Bucket           Voyage AI API
    (pipeline state)    (wiki backup +       (embeddings)
                         deployed apps)
```

---

## 3. Data Model

### 3.1 Wiki Articles (Markdown on EC2 + S3 backup)

Every knowledge artifact is a markdown file following the Karpathy wiki pattern. The LLM writes and maintains all articles. Humans read and direct — the LLM does the bookkeeping.

**Article format:**

```markdown
---
title: src/components/auth.tsx
type: code
phase: implementation
status: active
maturity: 0.7
created: 2026-04-13
updated: 2026-04-13
createdByEpic: E1
createdByStory: E1-S3
lastMutatedByStory: E2-S1
tags: [authentication, jwt, react-context]
---

## Purpose

Authentication component handling JWT-based login flow.

## Key Exports

- `AuthProvider` — React context provider wrapping the app
- `useAuth()` — hook returning current user + login/logout

## Dependencies

- [[code/src--utils--jwt.ts]] — token validation and refresh
- [[code/src--api--user-api.ts]] — user profile fetching
- [[decisions/auth-pattern-jwt]] — architecture decision driving this

## Dependents

- [[code/src--app.tsx]] — wraps entire app in AuthProvider
- [[code/src--pages--dashboard.tsx]] — uses useAuth() for gating

## Signals

- JWT refresh logic implemented
- Error handling for expired tokens
- Redirect on unauthorized

## Missing Signals

- No refresh token rotation
- No session timeout UI
- Mobile deep-link auth not addressed

## Notes

Rewritten in E2-S1 to replace cookie-based auth.
See [[decisions/auth-pattern-jwt]] for rationale.
```

**File naming convention:** `knowledge/{phase}/{slug}.md` where slug uses `--` for path separators in code files (e.g., `src--components--auth.tsx.md`).

**Article types by phase:**

| Phase          | Article Types                                                    | Created By                       |
| -------------- | ---------------------------------------------------------------- | -------------------------------- |
| Discovery      | brainstorm, brief, research, evidence, competitive-analysis      | User + PM/Analyst conversations  |
| Planning       | prd, requirement, epic-plan, story-plan, risk, decision          | PM/Analyst agents                |
| Solutioning    | architecture, tech-spec, api-spec, data-model, adr, ux-spec      | Architect/UX agents              |
| Implementation | code (per file), decision (runtime choices)                      | Dev agent compilation            |
| QA             | test-plan, test-result, visual-qa-report                         | QA/Visual QA agents              |
| Release        | deployment-record, release-notes                                 | Deploy pipeline                  |
| Support        | bug-report, feature-request, evolution-plan                      | Bug/feature pipelines            |
| System         | dependency-map, deployment-manifest, debt-registry, pending-work | Compilation step (cross-cutting) |

### 3.2 Memgraph Schema

Nodes and edges in Memgraph mirror the wiki articles. The wiki is the source of truth; Memgraph is the query accelerator rebuilt from wiki content at any time.

**Node labels (by type):**

```cypher
-- Create constraints
CREATE CONSTRAINT ON (n:Node) ASSERT n.nodeId IS UNIQUE;

-- Node properties
(:Node {
  nodeId: "code/src--components--auth.tsx",   -- matches wiki filename
  projectId: "spyhunter",
  type: "code",                               -- article type
  phase: "implementation",
  status: "active",                           -- active | superseded | flagged | pruned
  maturity: 0.7,
  title: "src/components/auth.tsx",
  summary: "Auth component with JWT login",   -- first 200 chars of Purpose section
  tags: ["authentication", "jwt"],
  createdByEpic: "E1",
  createdByStory: "E1-S3",
  lastMutatedByStory: "E2-S1",
  created: "2026-04-13",
  updated: "2026-04-13",
  embedding: [0.023, -0.117, ...]             -- Voyage AI voyage-3-large, 1024-dim
})
```

**Vector index:**

```cypher
CREATE VECTOR INDEX knowledge_index ON :Node(embedding)
WITH CONFIG {
  "dimension": 1024,
  "capacity": 50000,
  "metric": "cos",
  "scalar_kind": "f16"
};
```

**Edge types (8 relationship types from Mycelium):**

```cypher
-- Relationship types with weights
(:Node)-[:DEPENDS_ON     {weight: 1.0}]->(:Node)  -- B needs A
(:Node)-[:DERIVED_FROM   {weight: 0.7}]->(:Node)  -- B extracted from A
(:Node)-[:INFORMS        {weight: 0.3}]->(:Node)  -- A provides context for B
(:Node)-[:REFINES        {weight: 0.5}]->(:Node)  -- B adds detail to A
(:Node)-[:VALIDATES      {weight: 0.6}]->(:Node)  -- B verifies/tests A
(:Node)-[:SUPERSEDES     {weight: 0.8}]->(:Node)  -- B replaces A
(:Node)-[:CONFLICTS_WITH {weight: 0.9}]->(:Node)  -- A and B contradict
(:Node)-[:ENABLES        {weight: 0.5}]->(:Node)  -- A makes B possible
```

**Edges are derived from `[[wikilinks]]` in articles.** The `## Dependencies` section maps to outgoing `DEPENDS_ON` edges. The `## Dependents` section maps to incoming `DEPENDS_ON` edges. Each section header maps to an edge type:

| Wiki Section        | Edge Type        | Direction          |
| ------------------- | ---------------- | ------------------ |
| `## Dependencies`   | `DEPENDS_ON`     | outgoing           |
| `## Dependents`     | `DEPENDS_ON`     | incoming (reverse) |
| `## Derived From`   | `DERIVED_FROM`   | outgoing           |
| `## Informs`        | `INFORMS`        | outgoing           |
| `## Validates`      | `VALIDATES`      | outgoing           |
| `## Supersedes`     | `SUPERSEDES`     | outgoing           |
| `## Conflicts With` | `CONFLICTS_WITH` | bidirectional      |
| `## Enables`        | `ENABLES`        | outgoing           |

### 3.3 DynamoDB Tables (Existing + New)

**Existing tables (unchanged):**

| Table                        | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `futurator-agent-jobs`       | Pipeline job state, steps, results        |
| `futurator-agent-events`     | Streaming events for live UI (TTL)        |
| `futurator-epic-workflows`   | Epic definitions, stories, statuses       |
| `futurator-project-registry` | Project metadata, file manifest, sessions |

**Modified table:**

`futurator-project-registry` gains a new field:

```typescript
interface ProjectRegistry {
  // ... existing fields unchanged ...
  knowledgeGraph?: {
    nodeCount: number;
    edgeCount: number;
    lastCompileAt: string;
    lastLintAt?: string;
    lastPruneAt?: string;
    memgraphSynced: boolean;
  };
}
```

**No new DynamoDB tables.** The knowledge graph lives in wiki files (EC2 + S3) and Memgraph. DynamoDB tracks pipeline state only. This separation is intentional — the wiki is the source of truth for knowledge; DynamoDB is the source of truth for pipeline orchestration.

---

## 4. Compilation Pipeline

Compilation transforms raw pipeline outputs into structured knowledge. Inspired by the Claude Memory Compiler pattern (conversations → daily logs → compiled wiki), adapted for agentic pipelines (agent outputs → wiki articles → graph sync).

### 4.1 Compilation Triggers

```
DISCOVERY / PLANNING / SOLUTIONING PHASES
  ┌──────────────────────────────────┐
  │ User + Agent conversation        │
  │ (PM, Analyst, Architect, UX)     │
  │                                  │
  │ Trigger: after each document     │
  │ generation or revision session   │
  │                                  │
  │ Compile: decompose conversation  │
  │ into typed nodes, link to        │
  │ existing graph, update maturity  │
  │ scores, flag impacted downstream │
  │ nodes for review                 │
  └──────────────────────────────────┘

IMPLEMENTATION PHASE
  ┌──────────────────────────────────┐
  │ After STORY completion           │
  │                                  │
  │ Compile:                         │
  │  1. Diff files (shell, $0)       │
  │  2. Create/update code articles  │
  │  3. Extract decisions from       │
  │     WORK_SUMMARY                 │
  │  4. Update dependency map        │
  │  5. Embed new/changed nodes      │
  │  6. Sync to Memgraph             │
  └──────────────────────────────────┘
  ┌──────────────────────────────────┐
  │ After EPIC completion            │
  │                                  │
  │ Compile:                         │
  │  1. Cross-story synthesis        │
  │  2. Detect superseded nodes      │
  │  3. Update maturity scores       │
  │  4. Lint pass (contradictions,   │
  │     orphans, stale refs)         │
  │  5. Update pending-work.md       │
  │  6. Full Memgraph resync         │
  └──────────────────────────────────┘

RELEASE PHASE
  ┌──────────────────────────────────┐
  │ After DEPLOYMENT completion      │
  │                                  │
  │ Compile:                         │
  │  1. Snapshot wiki → S3 (versioned│
  │     archive tagged with deploy)  │
  │  2. Mark deployed code nodes     │
  │     status: deployed             │
  │  3. Update deployment-manifest   │
  │  4. PRUNE: find superseded nodes │
  │     with no active dependents    │
  │     → move to archive/           │
  │  5. Create release-notes article │
  │  6. Memgraph cleanup             │
  └──────────────────────────────────┘
```

### 4.2 Story Compilation Step (Daemon Integration)

Added to the existing story pipeline in `generateStoryPipeline()`, after the reviewer step passes:

```
Existing pipeline:
  DEV → build-check → server-check → REVIEWER → (done)

Extended pipeline:
  DEV → build-check → server-check → REVIEWER → COMPILE → (done)
```

The COMPILE step is a hybrid shell + agent sequence:

**Step A — Diff extraction (shell, ~2s, $0):**

```bash
cd ${workingDir} && \
  git diff --name-status HEAD~1 HEAD 2>/dev/null || \
  find . -newer .mycelium/last-compile-marker -type f \
    -not -path './node_modules/*' -not -path './.git/*'
```

Output: `DIFF_MANIFEST` — list of created, modified, deleted files.

**Step B — Knowledge compilation (agent, ~$0.03-0.08):**

Prompt injected with:

- `DIFF_MANIFEST` (what changed)
- `WORK_SUMMARY` (from Dev agent extractor)
- `knowledge/index.md` (existing catalog)
- Story acceptance criteria (what was being built and why)

Agent task:

```
You are the Knowledge Compiler. For each changed file in DIFF_MANIFEST:

1. If a wiki article exists in knowledge/code/ for this file:
   - UPDATE it: revise Purpose, Dependencies, Dependents, Signals, Missing Signals
   - Update frontmatter: lastMutatedByStory, updated date, maturity score

2. If no article exists:
   - CREATE one following the standard article format
   - Set frontmatter: createdByStory, type: code, phase: implementation

3. For deleted files: mark their article status: superseded

4. Extract any architectural DECISIONS from WORK_SUMMARY:
   - Library choices, pattern selections, API design decisions
   - Create/update articles in knowledge/decisions/
   - Link to the code articles that implement them

5. Update knowledge/system/dependency-map.md with new import relationships

6. Update knowledge/index.md — add new articles, update summaries

7. Update knowledge/log.md — append compilation record

Use [[wikilinks]] for all cross-references. Be precise about Dependencies
and Dependents — these become graph edges.
```

Allowed tools: `Read,Write,Edit,Glob,Grep`

**Step C — Embed and sync (shell, ~3s, ~$0.001):**

```bash
# Read new/changed articles, embed via Voyage AI, upsert into Memgraph
node /home/ubuntu/scripts/graph-sync.mjs \
  --project ${projectId} \
  --knowledge-dir ${workingDir}/knowledge \
  --state-file ${workingDir}/.mycelium/compile-state.json
```

This script:

1. Reads `.mycelium/compile-state.json` for content hashes of last sync
2. Diffs current articles against hashes — identifies changed articles
3. For each changed article: calls Voyage AI API → gets 1024-dim embedding
4. Upserts into Memgraph: node properties from frontmatter, embedding vector, edges from `[[wikilinks]]`
5. Updates compile-state.json with new hashes

### 4.3 Epic Compilation Step

Triggered when epic status transitions to `completed`. A separate pipeline job:

```typescript
{
  id: 'epic-compile',
  steps: [
    {
      id: 'consolidate',
      stepType: 'agent',
      agentId: 'COMPILER',
      prompt: `You are the Knowledge Compiler performing an EPIC-LEVEL compilation.

      Epic: {{EPIC_TITLE}}
      Stories completed: {{STORY_COUNT}}
      Project knowledge index: {{INDEX_CONTENT}}

      Tasks:
      1. Read all knowledge/code/ articles created/modified by this epic's stories
      2. Write a CROSS-STORY SYNTHESIS: knowledge/planning/epic-{{epicId}}-synthesis.md
         - What was built across all stories
         - How the stories connected
         - What patterns emerged
      3. SUPERSESSION SCAN: find articles where a later story overwrote an earlier story's work
         - Mark older versions as status: superseded
         - Add [[supersedes]] links
      4. MATURITY UPDATE: for each requirement/decision node related to this epic,
         reassess maturity based on what was actually implemented
      5. LINT: check for contradictions between articles, orphan nodes with
         no edges, stale cross-references to renamed/deleted files
      6. Update knowledge/system/pending-work.md — what remains incomplete
      7. Update index.md and log.md`,
    },
    {
      id: 'graph-resync',
      stepType: 'shell',
      command: 'node /home/ubuntu/scripts/graph-sync.mjs --project {{projectId}} --full-resync ...',
    },
  ],
}
```

### 4.4 Deployment Compilation Step

Triggered after the deploy pipeline completes (S3 sync + CloudFront invalidation):

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

      1. Create knowledge/release/deploy-{{date}}.md with:
         - What was deployed (epic title, story count)
         - Deploy URL: {{DEPLOY_URL}}
         - All code articles included in this deploy
      2. Mark all code articles with status: deployed where
         their epic status is completed
      3. PRUNE SCAN:
         - Find all articles with status: superseded
         - Check if any active article has a dependency on them
         - If no active dependents: move to knowledge/archive/
         - Update index.md to remove archived articles
      4. Update knowledge/system/deployment-manifest.md
      5. Update log.md`,
    },
    {
      id: 'prune-sync',
      stepType: 'shell',
      command: `node /home/ubuntu/scripts/graph-sync.mjs --project {{projectId}} --full-resync --prune ...`,
    },
  ],
}
```

### 4.5 Pre-Development Phase Compilation

During discovery, planning, and solutioning phases, the user interacts with agents (PM, Analyst, Architect, UX) through the Labs interface. These conversations generate documents — PRDs, architecture specs, tech specs, brainstorm summaries.

Each document generation endpoint already creates a pipeline job. The compilation step is appended:

```
PM generates PRD → COMPILE:
  - Decompose PRD into requirement nodes (knowledge/requirements/)
  - Create planning nodes (knowledge/planning/)
  - Link requirements → discovery nodes (DERIVED_FROM)
  - Assess maturity per requirement
  - Flag solutioning nodes that need review if requirements changed
  - Embed + sync to Memgraph

Architect generates tech spec → COMPILE:
  - Extract decision nodes (knowledge/decisions/)
  - Create solutioning nodes (knowledge/solutioning/)
  - Link decisions → requirements (DERIVED_FROM)
  - Link decisions → future code articles (INFORMS) — placeholder edges
  - Embed + sync
```

The key behavior: **when a planning document changes, the compiler traverses the graph and flags all downstream nodes.** If you revise the PRD after development has started, every requirement node that changed gets a `SUPERSEDES` edge to the old version, and every code node downstream of that requirement gets `status: flagged` with a review indicator.

This is Mycelium's impact analysis expressed as a compilation step:

```cypher
-- Impact propagation after a requirement node update
MATCH (updated:Node {nodeId: $updatedNodeId})
MATCH (updated)-[:INFORMS|ENABLES|DERIVED_FROM*1..4]->(downstream:Node)
WHERE downstream.status = 'active'
SET downstream.status = 'flagged',
    downstream.flagReason = 'Upstream node ' + $updatedNodeId + ' was modified'
RETURN downstream.nodeId, downstream.type, downstream.title;
```

---

## 5. Search Architecture

### 5.1 The Four-Layer Search Cascade

When an agent needs to understand the codebase, it uses a cascading search strategy:

```
Query: "Add OAuth support to the login flow"
│
├──► Layer 1: GraphRAG (Memgraph) — Semantic + Structural
│    ┌─────────────────────────────────────────────────┐
│    │ CALL vector_search.search(                      │
│    │   'knowledge_index', 10,                        │
│    │   voyage_embed("OAuth login authentication")    │
│    │ ) YIELD node, similarity                        │
│    │ WHERE similarity > 0.6                          │
│    │ MATCH (node)-[*1..3]-(affected)                 │
│    │ RETURN node, affected, similarity               │
│    └─────────────────────────────────────────────────┘
│    Result: auth.tsx, jwt-utils.ts, session-store.ts,
│            decisions/auth-pattern-jwt.md,
│            requirements/user-authentication.md,
│            + their dependents (app.tsx, dashboard.tsx, etc.)
│
├──► Layer 2: Wiki Articles — Compiled Knowledge
│    Read wiki articles for top-ranked nodes.
│    Get: purpose, decisions WHY, dependencies, missing signals.
│    Result: full compiled context for each relevant artifact.
│
├──► Layer 3: Grep (ripgrep) — Precision Code Search
│    Now that the agent KNOWS which files matter:
│    grep for exact patterns, function signatures, imports.
│    Result: precise code-level details.
│    (This is the standard Claude Code Grep tool —
│     regex pattern, file type filter, content/files/count modes)
│
└──► Layer 4: Raw File Read — Full Source
     Read complete source files for the specific code
     the agent needs to modify.
     Result: exact current code for editing.
```

**Why this order matters:**

- GraphRAG first → finds conceptually related nodes even without keyword overlap. "OAuth" finds `session-store.ts` which never contains the word "OAuth"
- Wiki articles second → gives the agent COMPILED understanding (purpose, decisions, dependencies) not raw code
- Grep third → precise lookup within the already-identified relevant files
- Read last → only the specific files being changed

### 5.2 GraphRAG Query Patterns

**Impact analysis — "What breaks if I change X?"**

```cypher
MATCH (target:Node {nodeId: $targetNode})
MATCH path = (target)<-[:DEPENDS_ON|VALIDATES*1..5]-(affected)
RETURN affected.nodeId, affected.type, affected.title,
       length(path) AS hops
ORDER BY hops ASC;
```

**Semantic discovery — "Everything related to authentication"**

```cypher
CALL vector_search.search('knowledge_index', 15, $queryEmbedding)
YIELD node, similarity
WHERE similarity > 0.6
RETURN node.nodeId, node.type, node.phase, node.title,
       node.maturity, similarity
ORDER BY similarity DESC;
```

**Combined semantic + structural — "What needs work in the auth system?"**

```cypher
CALL vector_search.search('knowledge_index', 10, $authEmbedding)
YIELD node, similarity
WHERE similarity > 0.65
MATCH (node)-[*0..2]-(related)
WHERE related.status IN ['active', 'flagged']
  AND related.maturity < 0.6
RETURN DISTINCT related.nodeId, related.type, related.title,
       related.maturity, related.missingSignals
ORDER BY related.maturity ASC;
```

**Pending work — "What's next across the whole project?"**

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

**Pruning candidates — "What's dead?"**

```cypher
MATCH (n:Node)
WHERE n.status = 'superseded'
  AND n.projectId = $projectId
  AND NOT (n)<-[:DEPENDS_ON]-(:Node {status: 'active'})
RETURN n.nodeId, n.title, n.type
ORDER BY n.updated ASC;
```

### 5.3 Search Tool for Agents

The daemon exposes GraphRAG as a tool available to all agents. Implemented as a shell step that calls a local script:

```javascript
// In daemon pipeline step definitions, agents can request graph search
// via a shell tool wrapper:

// graph-search.mjs — callable from agent shell tools
// Usage: node graph-search.mjs --project spyhunter --query "authentication flow"
// Returns: JSON array of {nodeId, type, phase, title, similarity, relationships[]}

import { Driver } from 'neo4j-driver'; // Memgraph is Neo4j-compatible
import fetch from 'node-fetch';

async function graphSearch(projectId, queryText, opts = {}) {
  const { topK = 10, hops = 2, minSimilarity = 0.6 } = opts;

  // 1. Embed query via Voyage AI
  const embResponse = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-3-large',
      input: [queryText],
      input_type: 'query',
    }),
  });
  const { data } = await embResponse.json();
  const queryVector = data[0].embedding;

  // 2. GraphRAG query: vector search + graph traversal
  const session = driver.session();
  const result = await session.run(
    `
    CALL vector_search.search('knowledge_index', $topK, $queryVector)
    YIELD node, similarity
    WHERE similarity > $minSimilarity AND node.projectId = $projectId
    OPTIONAL MATCH (node)-[r*1..${hops}]-(related)
    WHERE related.status IN ['active', 'flagged']
    RETURN node, similarity,
           collect(DISTINCT {
             nodeId: related.nodeId,
             type: related.type,
             title: related.title,
             relationship: type(r[0])
           }) AS related
    ORDER BY similarity DESC
  `,
    { topK, queryVector, minSimilarity, projectId },
  );

  session.close();
  return result.records;
}
```

---

## 6. Pruning & Lifecycle Management

### 6.1 Node Status Lifecycle

```
                    ┌─────────┐
       created ───► │ active  │ ◄── refined / updated
                    └────┬────┘
                         │
              upstream change detected
                         │
                    ┌────▼────┐
                    │ flagged │ ──── reviewed ───► active (updated)
                    └────┬────┘
                         │
              newer version created
                         │
                    ┌────▼──────┐
                    │superseded │
                    └────┬──────┘
                         │
              no active dependents + deployment passed
                         │
                    ┌────▼────┐
                    │ pruned  │ ──── moved to knowledge/archive/
                    └────┬────┘
                         │
                    removed from Memgraph
                    removed from index.md
                    S3 archive retains content
```

### 6.2 Impact Propagation

When any node is updated, the compilation step traverses the graph:

```
Impact score = edge_weight / (hops ^ 1.5)

Edge weights:
  DEPENDS_ON:     1.0    (strongest — direct dependency)
  CONFLICTS_WITH: 0.9    (contradiction — must review)
  SUPERSEDES:     0.8    (replacement — must review)
  DERIVED_FROM:   0.7    (lineage — should review)
  VALIDATES:      0.6    (test coverage — should review)
  REFINES:        0.5    (detail — may review)
  ENABLES:        0.5    (enablement — may review)
  INFORMS:        0.3    (context — may review)

Thresholds:
  score >= 0.5  → status: flagged, flagSeverity: critical
  score >= 0.1  → status: flagged, flagSeverity: moderate
  score <  0.1  → no flag
```

### 6.3 Maturity Scoring

Each node carries a maturity score (0.0–1.0) with signals:

| Score   | Label   | Gate Implications                                      |
| ------- | ------- | ------------------------------------------------------ |
| 0.0–0.2 | Raw     | Concept exists, key aspects undefined                  |
| 0.2–0.4 | Early   | Basic outline, many gaps                               |
| 0.4–0.6 | Partial | Core defined, some gaps — minimum for phase gate       |
| 0.6–0.8 | Solid   | Well-defined, minor refinements — ready for downstream |
| 0.8–1.0 | Ready   | Fully specified, production-grade                      |

**Phase gates** (from Mycelium, adapted for Labs):

| Transition                   | Gate Requirement                                     |
| ---------------------------- | ---------------------------------------------------- |
| Discovery → Planning         | At least 1 brainstorm/brief node at maturity >= 0.4  |
| Planning → Solutioning       | PRD node at maturity >= 0.6, requirements at >= 0.4  |
| Solutioning → Implementation | Architecture at >= 0.6, tech spec at >= 0.4          |
| Implementation → QA          | All epic stories completed, code nodes at >= 0.6 avg |
| QA → Release                 | Test plan at >= 0.6, all critical tests passing      |
| Release → Support            | Deployment successful, release notes generated       |

The compilation step updates maturity scores based on signals present in the article content. The LLM assesses: "given what's written in this article, what maturity signals are confirmed and what's still missing?"

---

## 7. "Talk to Your App" — Conversational Agent

A new pipeline type for interactive codebase conversations. Not build-oriented — discovery and analysis.

### 7.1 Conversation Pipeline

```typescript
{
  id: 'conversation',
  agents: {
    ASSISTANT: {
      name: 'Project Assistant',
      allowedTools: 'Read,Grep,Glob,Bash',
      model: 'opus',
    },
  },
  steps: [
    // 1. Gather context (shell, ~3s, $0)
    {
      id: 'gather-context',
      stepType: 'shell',
      command: `cd {{workingDir}} && \
        cat knowledge/index.md && \
        echo "---PENDING---" && \
        cat knowledge/system/pending-work.md 2>/dev/null && \
        echo "---TREE---" && \
        find . -type f -not -path './node_modules/*' -not -path './.git/*' | head -200`,
      captureAs: 'PROJECT_CONTEXT',
    },
    // 2. GraphRAG search for query topic (shell, ~1s, ~$0.001)
    {
      id: 'graph-search',
      stepType: 'shell',
      command: `node /home/ubuntu/scripts/graph-search.mjs \
        --project {{projectId}} \
        --query "{{USER_QUERY}}" \
        --top-k 15 --hops 3`,
      captureAs: 'GRAPH_RESULTS',
    },
    // 3. Conversational agent with full context
    {
      id: 'respond',
      agentId: 'ASSISTANT',
      prompt: `You are the Project Assistant for {{PROJECT_NAME}}.
You have access to the project's full knowledge graph.

PROJECT CONTEXT (index + pending work + file tree):
{{PROJECT_CONTEXT}}

GRAPH SEARCH RESULTS (nodes related to user's query):
{{GRAPH_RESULTS}}

USER'S MESSAGE:
{{USER_QUERY}}

Respond helpfully. You can:
- Read any wiki article in knowledge/ for compiled context
- Grep the source code for precise details
- Read source files directly
- Reference decisions, requirements, architecture by their wiki links

If the conversation produces NEW KNOWLEDGE (decisions, insights, revised
understanding), note it at the end in a structured block:

---NEW_KNOWLEDGE---
- type: decision | insight | requirement | risk
  title: ...
  content: ...
  links: [related wiki articles]
---END_NEW_KNOWLEDGE---

This will be compiled into the wiki after the conversation.`,
    },
    // 4. Compile new knowledge from conversation (conditional)
    {
      id: 'compile-conversation',
      stepType: 'agent',
      agentId: 'COMPILER',
      prompt: `Extract and compile knowledge from this conversation.

New knowledge to integrate:
{{NEW_KNOWLEDGE}}

Update relevant wiki articles. Create new articles if needed.
Update index.md and log.md.`,
      // Only runs if NEW_KNOWLEDGE was extracted
    },
    // 5. Embed and sync (shell)
    {
      id: 'sync',
      stepType: 'shell',
      command: 'node /home/ubuntu/scripts/graph-sync.mjs --project {{projectId}} ...',
    },
  ],
}
```

### 7.2 Self-Reflection Mode

A specialized conversation variant where the agent analyzes its own codebase:

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

---

## 8. Infrastructure

### 8.1 EC2 Instance (Existing)

| Property    | Value                                               |
| ----------- | --------------------------------------------------- |
| Instance ID | `i-0826d68c316ae97dd`                               |
| Type        | `t4g.small` (2 vCPU, 2GB RAM)                       |
| OS          | Ubuntu 24.04 ARM64                                  |
| Elastic IP  | `54.86.226.233`                                     |
| IAM Role    | `develope-it-ec2-ssm`                               |
| Storage     | EBS (size TBD — needs evaluation for Memgraph data) |

**Memory budget with Memgraph:**

| Component                         | RAM                                 |
| --------------------------------- | ----------------------------------- |
| Ubuntu OS                         | ~200MB                              |
| Agent daemon (Node.js)            | ~100MB                              |
| Memgraph (512MB limit)            | ~512MB                              |
| Claude CLI processes (concurrent) | ~200MB per process, max 5 = ~1000MB |
| **Total peak**                    | **~1.8GB**                          |

t4g.small has 2GB. This is tight. **Recommendation: upgrade to t4g.medium (4GB, ~$12/mo additional) for headroom.** Alternatively, set `MAX_CONCURRENT=3` and Memgraph `--memory-limit=256` to fit in 2GB.

### 8.2 Memgraph Deployment

```yaml
# docker-compose.yml on EC2
version: '3.8'
services:
  memgraph:
    image: memgraph/memgraph:latest
    container_name: futurator-memgraph
    ports:
      - '7687:7687' # Bolt protocol (Cypher queries)
      - '7444:7444' # Monitoring (optional)
    volumes:
      - memgraph-data:/var/lib/memgraph
    restart: unless-stopped
    command: >
      --memory-limit=512
      --storage-parallel-schema-recovery=true
      --log-level=WARNING
    deploy:
      resources:
        limits:
          memory: 600M

volumes:
  memgraph-data:
```

### 8.3 Voyage AI Integration

```javascript
// Embedding helper — used by graph-sync.mjs
const VOYAGE_CONFIG = {
  model: 'voyage-3-large',
  dimensions: 1024,
  batchSize: 128, // Voyage AI supports batch embedding
  inputTypes: {
    article: 'document', // wiki articles embedded as documents
    query: 'query', // search queries embedded as queries
  },
};

// Cost at scale:
// voyage-3-large: $0.06 per 1M tokens
// Average wiki article: ~500 tokens
// 2000 articles = 1M tokens = $0.06 to embed entire project
// Re-embedding after compilation: ~10-50 articles = < $0.003
```

### 8.4 S3 Storage

| Path                                                                     | Content                                          | Lifecycle               |
| ------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------- |
| `s3://futurator-ai-website/apps/{name}/`                                 | Deployed app static files                        | Overwritten each deploy |
| `s3://futurator-ai-website/knowledge-archives/{projectId}/{date}.tar.gz` | Wiki snapshots per deployment                    | Retained indefinitely   |
| `s3://futurator-ai-website/knowledge-live/{projectId}/`                  | Live wiki backup (synced after each compilation) | Overwritten each sync   |

---

## 9. Decisions Log

| #   | Decision                  | Chosen                                                                   | Rejected                              | Rationale                                                                                                                       |
| --- | ------------------------- | ------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Knowledge persistence     | Wiki markdown files (Karpathy pattern)                                   | DynamoDB tables for nodes             | Wiki is human-readable, LLM-maintainable, portable, git-friendly. DynamoDB only for pipeline state                              |
| D2  | Graph database            | Memgraph on same EC2                                                     | No graph DB (DynamoDB-only adjacency) | Ricardo requires semantic + structural search combined. Memgraph supports native vector index + Cypher traversal in one query   |
| D3  | Embedding model           | Voyage AI voyage-3-large (1024-dim)                                      | OpenAI embeddings / local model       | Already used in Mycelium. Superior code retrieval. Cost negligible at scale                                                     |
| D4  | Memgraph deployment       | Docker on same EC2                                                       | Separate instance / managed service   | Zero additional cost. Single EC2 simplicity. Memory fits within t4g.medium budget                                               |
| D5  | Compilation trigger       | Multi-phase (story, epic, deployment, conversation, document generation) | Only post-story                       | The system covers the full lifecycle — discovery through support. Every phase produces knowledge                                |
| D6  | Search strategy           | 4-layer cascade (GraphRAG → wiki → grep → read)                          | Pure grep / Pure RAG                  | GraphRAG finds semantic + structural connections. Grep handles precision. Wiki provides compiled context. Read gives raw source |
| D7  | Wiki structure            | Phase-organized directories with typed articles                          | Flat directory / DB-only              | Phase directories mirror Mycelium's 7 phases. Types enable filtered queries. [[wikilinks]] encode edges                         |
| D8  | Pruning strategy          | Automatic post-deployment with graph traversal                           | Manual cleanup / No pruning           | Pruning is core to Mycelium philosophy. Graph traversal identifies safe-to-prune nodes with no active dependents                |
| D9  | Source of truth           | Wiki files (Memgraph rebuilt from wiki)                                  | Memgraph as source of truth           | Wiki survives infra failures. Memgraph can be reconstructed from markdown in seconds. Always recoverable                        |
| D10 | Pre-dev phase compilation | Same compilation pattern as implementation                               | Separate document management system   | Documents ARE the graph. PRD changes must propagate to downstream nodes. Unified compilation pipeline                           |

---

## 10. Implementation Phases

Building on top of the existing Labs Testing Pipeline Plan (Phases 1–4, all implemented).

### Phase 5 — Knowledge Wiki Foundation

**Goal:** Establish the compiled wiki pattern. After each story pipeline, a compilation step generates/updates wiki articles for changed code files.

**Scope:**

- `graph-sync.mjs` script (embed + Memgraph upsert)
- Modify `generateStoryPipeline()` to append COMPILE step
- Wiki article format and directory structure
- `index.md` and `log.md` generation
- S3 backup of knowledge directory after compilation
- Memgraph Docker setup on EC2

**Does NOT include:** Pre-dev phases, epic/deploy compilation, conversation agent, pruning.

### Phase 6 — Epic & Deployment Compilation

**Goal:** Add consolidation passes after epic completion and deployment. Introduce supersession detection and pruning.

**Scope:**

- Epic compilation pipeline (cross-story synthesis, maturity updates, lint)
- Deployment compilation pipeline (snapshot, deploy marking, pruning)
- `pending-work.md` and `deployment-manifest.md` system articles
- `debt-registry.md` generation
- Pruning scan with graph traversal

### Phase 7 — Pre-Development Phase Compilation

**Goal:** Extend compilation to discovery, planning, and solutioning phases. Document generation sessions produce wiki nodes. Impact propagation flags downstream nodes when upstream changes.

**Scope:**

- Compilation step appended to PM, Architect, Analyst agent sessions
- Requirement decomposition from PRDs
- Decision extraction from architecture sessions
- Impact propagation via Memgraph traversal
- Phase gate enforcement via maturity checks

### Phase 8 — Conversational Agent ("Talk to Your App")

**Goal:** Enable interactive codebase conversations with full knowledge graph context. The agent searches semantically, reads compiled wiki, greps code, and compiles new knowledge from conversations.

**Scope:**

- Conversation pipeline type
- GraphRAG search tool for agents
- Self-reflection mode
- Conversation-to-knowledge compilation
- Labs UI: chat interface for project conversations

### Phase 9 — Bootstrap Pipeline (Brownfield)

**Goal:** One-time pipeline that reads an existing codebase and generates the initial wiki + graph. Enables "talk to your app" on projects built before this system existed.

**Scope:**

- Codebase scan agent (file tree → code articles)
- Dependency extraction (import analysis → edges)
- Decision inference (package.json, configs → decision articles)
- Full Memgraph population from generated wiki
- Run on existing deployed projects (SpyHunter, etc.)

---

## 11. Open Questions

| #   | Question                                                      | Impact                            | Notes                                                                                                         |
| --- | ------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Q1  | Should the knowledge wiki be committed to git alongside code? | Version tracking vs. repo bloat   | Karpathy says yes (git = version history for free). But auto-generated articles on every story could be noisy |
| Q2  | EC2 upgrade to t4g.medium needed?                             | $12/mo additional cost            | Current t4g.small (2GB) is tight with Memgraph. Medium (4GB) gives headroom                                   |
| Q3  | Cross-project graph?                                          | Discovery of shared patterns      | If SpyHunter and another game share a component, should the graph connect them?                               |
| Q4  | How does the Labs UI surface the knowledge graph?             | UX design needed                  | Graph visualization? Article browser? Integrated into existing panels?                                        |
| Q5  | Structural embeddings (Node2Vec) — Phase 2 optimization?      | Find structurally similar modules | Content embeddings first. Structural adds "find things with same graph shape"                                 |

---

_This document is the product of a Party Mode deliberation session. It captures architectural decisions, not implementation code. Each implementation phase should be developed as a separate epic with stories, following the established Labs pipeline pattern._
