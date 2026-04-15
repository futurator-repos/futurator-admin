# Mycelium Devs - Epic Breakdown

**Author:** Richie
**Date:** 2026-04-14
**Source:** [Mycelium-Labs Architecture](./concepts/mycelium-labs-architecture.md)
**Module:** Mycelium Devs

---

## Overview

This document decomposes the Mycelium-Labs integration architecture into implementable epics and stories, building on top of the existing Labs Testing Pipeline (Phases 1-4, all implemented). The goal is to create a living development system where every code file, decision, and document exists as a node in an interconnected knowledge graph — compiled automatically by the pipeline, searchable via GraphRAG, and self-maintaining through pruning and impact propagation.

### Epic Summary

| #   | Epic                                           | Stories | Depends On      |
| --- | ---------------------------------------------- | ------- | --------------- |
| 1   | Knowledge Foundation & Memgraph Infrastructure | 6       | Labs Phases 1-4 |
| 2   | Story Compilation Pipeline                     | 5       | Epic 1          |
| 3   | Epic & Deployment Lifecycle                    | 5       | Epic 2          |
| 4   | Pre-Development Phase Compilation              | 4       | Epic 1, 3       |
| 5   | Conversational Agent ("Talk to Your App")      | 5       | Epic 1, 2       |
| 6   | Brownfield Bootstrap                           | 4       | Epic 1, 5       |

**Total: 29 stories across 6 epics**

### Sequencing

```
Epic 1 (Foundation) → Epic 2 (Story Compile) → Epic 3 (Epic/Deploy Lifecycle)
                                                        ↓
                                               Epic 4 (Pre-Dev Compile)
                                                        ↓
                                               Epic 5 (Conversational Agent)
                                                        ↓
                                               Epic 6 (Brownfield Bootstrap)
```

---

## Epic 1: Knowledge Foundation & Memgraph Infrastructure

**Goal:** Establish the core infrastructure that everything else builds on — Memgraph running on EC2, wiki directory structure defined, and the embed+sync pipeline operational.

### Story 1.1: Memgraph Docker Deployment on EC2

As a **developer**,
I want **Memgraph running as a Docker container on the existing EC2 instance**,
So that **I have a graph database with native vector index support available for the knowledge graph**.

**Acceptance Criteria:**

**Given** the EC2 instance i-0826d68c316ae97dd is running Ubuntu 24.04 ARM64
**When** Docker and docker-compose are installed and the Memgraph service is started
**Then** Memgraph is accessible on port 7687 (Bolt protocol)
**And** Memgraph is configured with `--memory-limit=512` and restart policy `unless-stopped`
**And** data is persisted via a Docker volume `memgraph-data`
**And** the container starts automatically on EC2 reboot

**Prerequisites:** None (first story)

**Technical Notes:**

- Use `docker-compose.yml` as specified in architecture doc section 8.2
- ARM64 image: `memgraph/memgraph:latest` (supports aarch64)
- Port 7687 for Bolt, optionally 7444 for monitoring
- Memory limit 600M on container, 512MB Memgraph internal
- Verify with `cypher-shell` or `neo4j-driver` connection test
- Consider EC2 memory: t4g.small has 2GB — monitor usage after deployment

---

### Story 1.2: Memgraph Schema & Vector Index Setup

As a **developer**,
I want **the Memgraph schema (constraints, vector index) initialized and validated**,
So that **knowledge nodes can be stored with embeddings and queried via Cypher + vector search**.

**Acceptance Criteria:**

**Given** Memgraph is running and accessible on port 7687
**When** the schema initialization script runs
**Then** a uniqueness constraint exists on `Node.nodeId`
**And** a vector index `knowledge_index` is created on `:Node(embedding)` with config: dimension 1024, capacity 50000, metric cosine, scalar f16
**And** all 8 edge types are usable (DEPENDS_ON, DERIVED_FROM, INFORMS, REFINES, VALIDATES, SUPERSEDES, CONFLICTS_WITH, ENABLES)
**And** a test node with a dummy 1024-dim embedding can be inserted and retrieved via vector search

**Prerequisites:** Story 1.1

**Technical Notes:**

- Schema DDL from architecture doc section 3.2
- Script should be idempotent (safe to re-run)
- Use `neo4j-driver` (Memgraph is Neo4j Bolt-compatible)
- Store schema script at `/home/ubuntu/scripts/init-memgraph.mjs`
- Run automatically after Memgraph container starts (or via a startup script)

---

### Story 1.3: Wiki Directory Structure & Article Format

As a **developer**,
I want **the wiki directory structure created in each project workspace with a defined article format**,
So that **compiled knowledge has a consistent, organized home following the Karpathy wiki pattern**.

**Acceptance Criteria:**

**Given** a project workspace exists at `/home/ubuntu/projects/{name}/`
**When** the wiki initialization runs for that project
**Then** the following directory structure is created:

```
knowledge/
  index.md           (master catalog)
  log.md             (append-only operations log)
  code/              (one article per source file)
  decisions/         (architecture choices)
  requirements/      (PRD-derived requirements)
  discovery/         (brainstorms, research)
  planning/          (epics, stories, roadmap)
  solutioning/       (arch, tech spec, API)
  qa/                (test plans, results)
  system/            (cross-cutting synthesis)
    dependency-map.md
    deployment-manifest.md
    debt-registry.md
    pending-work.md
  archive/           (pruned nodes)
```

**And** `index.md` is initialized with the project name and empty catalog structure
**And** `log.md` is initialized with a creation entry
**And** `.mycelium/compile-state.json` is created with empty state
**And** `.mycelium/embeddings-queue.json` is created

**Prerequisites:** None (can run in parallel with 1.1)

**Technical Notes:**

- Create as a shell script: `/home/ubuntu/scripts/init-wiki.sh`
- Takes `projectId` and `workingDir` as arguments
- Article format follows architecture doc section 3.1 (frontmatter with title, type, phase, status, maturity, dates, tags, wikilinks)
- File naming: `knowledge/{phase}/{slug}.md`, code files use `--` for path separators
- Integrate with existing project setup in daemon or call manually

---

### Story 1.4: Voyage AI Embedding Helper Module

As a **developer**,
I want **a reusable module that embeds text via the Voyage AI API and returns 1024-dim vectors**,
So that **wiki articles can be embedded for vector search in Memgraph**.

**Acceptance Criteria:**

**Given** a `VOYAGE_API_KEY` environment variable is set on the EC2 instance
**When** the embedding module is called with a text string
**Then** it returns a 1024-dimensional float array from `voyage-3-large`
**And** it supports batch embedding (up to 128 inputs per call)
**And** it distinguishes between `document` input type (for articles) and `query` input type (for searches)
**And** it handles API errors with retries (max 3, exponential backoff)
**And** it logs token usage for cost tracking

**Prerequisites:** None (can run in parallel with 1.1)

**Technical Notes:**

- Module at `/home/ubuntu/scripts/lib/voyage-embed.mjs`
- Voyage AI API: `POST https://api.voyageai.com/v1/embeddings`
- Model: `voyage-3-large`, dimensions: 1024
- Cost: $0.06 per 1M tokens — average article ~500 tokens
- Batch embedding reduces API calls: 128 articles per request
- Export: `embedText(text, inputType)` and `embedBatch(texts, inputType)`

---

### Story 1.5: Graph Sync Script (Embed + Memgraph Upsert)

As a **developer**,
I want **a script that reads wiki articles, embeds them via Voyage AI, and upserts nodes+edges into Memgraph**,
So that **the knowledge graph in Memgraph stays synchronized with the wiki files**.

**Acceptance Criteria:**

**Given** wiki articles exist in `knowledge/` with valid frontmatter
**When** `graph-sync.mjs` runs with `--project` and `--knowledge-dir` flags
**Then** it reads `.mycelium/compile-state.json` for content hashes of last sync
**And** it identifies new or changed articles by comparing current content hashes
**And** for each changed article: embeds via Voyage AI → upserts node in Memgraph with all frontmatter properties + embedding vector
**And** it parses `[[wikilinks]]` from article sections (Dependencies, Dependents, etc.) and creates/updates typed edges in Memgraph
**And** it updates `compile-state.json` with new hashes
**And** it supports `--full-resync` flag that re-processes all articles regardless of hash

**Prerequisites:** Story 1.2, 1.3, 1.4

**Technical Notes:**

- Script at `/home/ubuntu/scripts/graph-sync.mjs`
- Uses `neo4j-driver` for Memgraph, `lib/voyage-embed.mjs` for embeddings
- Wikilink parsing: `[[section/slug]]` maps to edge types per architecture doc section 3.2 table
- Content hash: MD5 of article body (excluding frontmatter dates)
- Edge direction determined by which section the wikilink appears in (Dependencies → outgoing DEPENDS_ON, etc.)
- Log sync results to stdout for daemon capture

---

### Story 1.6: S3 Wiki Backup Integration

As a **developer**,
I want **the wiki directory backed up to S3 after each sync operation**,
So that **knowledge is durably stored and recoverable if the EC2 instance fails**.

**Acceptance Criteria:**

**Given** a compilation or sync has completed for a project
**When** the S3 backup step runs
**Then** the entire `knowledge/` directory is synced to `s3://futurator-ai-website/knowledge-live/{projectId}/`
**And** only changed files are uploaded (using `aws s3 sync`)
**And** the sync completes in under 10 seconds for typical incremental changes
**And** errors are logged but do not fail the pipeline (backup is best-effort)

**Prerequisites:** Story 1.3

**Technical Notes:**

- Use `aws s3 sync` (IAM role `develope-it-ec2-ssm` already has S3 access)
- Path: `s3://futurator-ai-website/knowledge-live/{projectId}/`
- Separate from versioned archives (those happen at deployment time in Epic 3)
- Add as a final shell step in the graph-sync script or as a separate callable script
- `--delete` flag to remove archived articles from S3 too

---

## Epic 2: Story Compilation Pipeline

**Goal:** After every story pipeline completes, automatically compile code changes into the knowledge graph. The pipeline IS the compiler.

### Story 2.1: Extend Story Pipeline with COMPILE Step

As a **developer**,
I want **the existing story pipeline extended to include a COMPILE step after the REVIEWER step**,
So that **every completed story automatically triggers knowledge compilation**.

**Acceptance Criteria:**

**Given** the existing story pipeline: DEV → build-check → server-check → REVIEWER
**When** the REVIEWER step passes
**Then** a new COMPILE phase begins with three sequential sub-steps: diff-extract (shell), compile-knowledge (agent), embed-sync (shell)
**And** the pipeline definition in `generateStoryPipeline()` includes the new steps
**And** pipeline status events are emitted for each compilation sub-step
**And** compilation failure does NOT fail the overall story pipeline (knowledge compilation is non-blocking)

**Prerequisites:** Epic 1 complete

**Technical Notes:**

- Modify `generateStoryPipeline()` in the daemon or pipeline generator
- Three new steps appended after reviewer: `compile-diff`, `compile-knowledge`, `compile-sync`
- Each step captures output for the next step via `captureAs` pattern
- Add `compilation` status field to story/epic workflow tracking
- Non-blocking: wrap in try/catch, log errors, mark compilation as `failed` but story as `completed`

---

### Story 2.2: Diff Extraction Shell Step

As a **developer**,
I want **a shell step that extracts the list of changed files after a story completes**,
So that **the Knowledge Compiler knows exactly which files to process**.

**Acceptance Criteria:**

**Given** a story has been completed in the project workspace
**When** the diff extraction step runs
**Then** it outputs a `DIFF_MANIFEST` listing all created, modified, and deleted files
**And** it uses `git diff --name-status HEAD~1 HEAD` when git history is available
**And** it falls back to `find . -newer .mycelium/last-compile-marker` when git is not available
**And** it excludes `node_modules/`, `.git/`, and `knowledge/` directories
**And** it updates `.mycelium/last-compile-marker` timestamp after extraction

**Prerequisites:** Story 2.1

**Technical Notes:**

- Shell command from architecture doc section 4.2 Step A
- Output format: one line per file, `STATUS\tFILENAME` (A=added, M=modified, D=deleted)
- Capture output as `DIFF_MANIFEST` for the next step
- Execution time: ~2 seconds, $0 cost

---

### Story 2.3: Knowledge Compiler Agent Step

As a **developer**,
I want **an agent step that reads the diff manifest and creates/updates wiki articles for each changed file**,
So that **code changes are automatically decomposed into structured knowledge nodes**.

**Acceptance Criteria:**

**Given** a `DIFF_MANIFEST` of changed files and the story's `WORK_SUMMARY`
**When** the Knowledge Compiler agent runs
**Then** for each new file: a wiki article is created in `knowledge/code/` with full frontmatter and sections (Purpose, Key Exports, Dependencies, Dependents, Signals, Missing Signals, Notes)
**And** for each modified file: the existing article is updated with revised content and `lastMutatedByStory` updated
**And** for deleted files: the article status is set to `superseded`
**And** architectural decisions from `WORK_SUMMARY` are extracted and saved to `knowledge/decisions/`
**And** `knowledge/system/dependency-map.md` is updated with new import relationships
**And** `knowledge/index.md` is updated with new/changed article entries
**And** `knowledge/log.md` gets a compilation record appended
**And** all cross-references use `[[wikilinks]]` format

**Prerequisites:** Story 2.2

**Technical Notes:**

- Agent prompt from architecture doc section 4.2 Step B
- Allowed tools: `Read, Write, Edit, Glob, Grep`
- Agent reads actual source files to understand purpose, exports, imports
- Wikilink format: `[[code/src--components--auth.tsx]]`
- File naming: `--` replaces `/` in paths for flat filenames
- Cost: ~$0.03-0.08 per compilation depending on diff size
- Story context (acceptance criteria, epic title) injected in prompt for traceability

---

### Story 2.4: Embed & Sync Shell Step

As a **developer**,
I want **a shell step that embeds new/changed wiki articles and syncs them to Memgraph after compilation**,
So that **the GraphRAG index stays current with the latest compiled knowledge**.

**Acceptance Criteria:**

**Given** the Knowledge Compiler has created or updated wiki articles
**When** the embed-sync step runs `graph-sync.mjs`
**Then** all new/changed articles are detected via content hash comparison
**And** changed articles are embedded via Voyage AI and upserted into Memgraph
**And** edges from `[[wikilinks]]` are created/updated in Memgraph
**And** `.mycelium/compile-state.json` is updated with new hashes
**And** wiki is backed up to S3 (`knowledge-live/{projectId}/`)

**Prerequisites:** Story 2.3, Story 1.5

**Technical Notes:**

- Calls `graph-sync.mjs` from Story 1.5 + S3 backup from Story 1.6
- This is the "Step C" from architecture doc section 4.2
- Execution time: ~3 seconds + API call time
- Cost: ~$0.001 for typical 10-50 article re-embeds

---

### Story 2.5: Compilation Status Tracking & Error Handling

As a **developer**,
I want **compilation status tracked per story and surfaced in the pipeline events**,
So that **I can monitor compilation health and debug failures without affecting story delivery**.

**Acceptance Criteria:**

**Given** a story pipeline runs with the COMPILE phase
**When** compilation completes (success or failure)
**Then** the story's workflow record includes `compilationStatus: 'success' | 'failed' | 'skipped'`
**And** compilation timing and article counts are recorded in the pipeline events
**And** compilation errors are logged with full stack traces in agent events
**And** a failed compilation emits a warning event but the story is still marked as completed
**And** `knowledge/log.md` records both successful and failed compilation attempts

**Prerequisites:** Story 2.1

**Technical Notes:**

- Extend `EpicWorkflow` or `StoryStatus` types to include compilation metadata
- Add to `futurator-agent-events` for real-time UI streaming
- Non-blocking error handling is critical — compilation is enhancement, not gate
- Consider adding compilation summary to `WORK_SUMMARY` output

---

## Epic 3: Epic & Deployment Lifecycle

**Goal:** Add consolidation passes after epic completion and deployment. Introduce supersession detection, pruning, and system-level knowledge articles.

### Story 3.1: Epic Compilation Pipeline

As a **developer**,
I want **a compilation pipeline triggered when an epic transitions to `completed` status**,
So that **cross-story knowledge is synthesized, superseded nodes are detected, and maturity scores are updated**.

**Acceptance Criteria:**

**Given** an epic's status transitions to `completed` in the workflow
**When** the epic compilation pipeline is triggered
**Then** a COMPILER agent reads all code articles created/modified by this epic's stories
**And** it creates a cross-story synthesis article at `knowledge/planning/epic-{epicId}-synthesis.md`
**And** it performs a supersession scan: finds articles where a later story overwrote an earlier story's work, marks older versions as `status: superseded`, adds `[[supersedes]]` links
**And** it updates maturity scores for requirement/decision nodes related to this epic
**And** it runs a lint pass: checks for contradictions, orphan nodes, stale cross-references
**And** it updates `knowledge/system/pending-work.md` with remaining incomplete items
**And** a full Memgraph resync runs after the agent completes

**Prerequisites:** Epic 2 complete

**Technical Notes:**

- Pipeline definition from architecture doc section 4.3
- Triggered by epic status state machine transition → `completed`
- Two steps: agent (consolidate) + shell (graph-resync with `--full-resync`)
- Epic compilation is heavier than story compilation (~$0.10-0.20)
- Lint output format: warnings in `knowledge/log.md`, critical issues flagged in `pending-work.md`

---

### Story 3.2: System Knowledge Articles

As a **developer**,
I want **system-level knowledge articles automatically maintained by the compilation pipeline**,
So that **cross-cutting concerns (pending work, deployment state, tech debt) are always visible**.

**Acceptance Criteria:**

**Given** any compilation runs (story, epic, or deployment level)
**When** the compilation completes
**Then** `knowledge/system/pending-work.md` lists all nodes with maturity < 0.6 or status `flagged`, grouped by phase
**And** `knowledge/system/dependency-map.md` shows the top-level import graph across all code articles
**And** `knowledge/system/debt-registry.md` lists items flagged as tech debt with severity and origin story
**And** `knowledge/system/deployment-manifest.md` tracks which code articles are deployed vs. pending deployment
**And** each system article has valid frontmatter with type `system` and phase `system`

**Prerequisites:** Story 3.1

**Technical Notes:**

- System articles are regenerated (not incrementally updated) on each epic compilation
- Story compilation only updates `dependency-map.md` incrementally
- These articles serve as the "dashboard" for the project state
- `pending-work.md` is especially important — it drives "what's next?" queries

---

### Story 3.3: Deployment Compilation Pipeline

As a **developer**,
I want **a compilation pipeline triggered after successful deployment**,
So that **wiki snapshots are archived, deployed code is marked, and dead nodes are pruned**.

**Acceptance Criteria:**

**Given** a deployment pipeline completes successfully (S3 sync + CloudFront invalidation)
**When** the deployment compilation pipeline runs
**Then** the wiki directory is archived to `s3://futurator-ai-website/knowledge-archives/{projectId}/{date}.tar.gz`
**And** a deployment record article is created at `knowledge/release/deploy-{date}.md`
**And** all code articles whose epic status is `completed` are marked `status: deployed`
**And** `knowledge/system/deployment-manifest.md` is updated with the deployment details
**And** `knowledge/log.md` records the deployment event

**Prerequisites:** Story 3.1

**Technical Notes:**

- Pipeline definition from architecture doc section 4.4
- Three steps: shell (S3 snapshot) → agent (deploy nodes + records) → shell (graph resync)
- Archive is a versioned `.tar.gz`, not overwritten — full history retained
- Deployment record includes: epic title, story count, deploy URL, code articles list

---

### Story 3.4: Pruning Scan & Node Archival

As a **developer**,
I want **superseded nodes with no active dependents automatically identified and archived**,
So that **the knowledge graph stays current and dead knowledge doesn't pollute search results**.

**Acceptance Criteria:**

**Given** a deployment compilation has marked nodes as `deployed`
**When** the pruning scan runs
**Then** it queries Memgraph for all nodes with `status: superseded` that have no incoming `DEPENDS_ON` edges from active nodes
**And** pruning candidates are listed for confirmation (or auto-pruned in `--auto` mode)
**And** pruned articles are moved from `knowledge/{phase}/` to `knowledge/archive/`
**And** pruned nodes are removed from Memgraph
**And** `knowledge/index.md` is updated to remove archived articles
**And** `knowledge/log.md` records each pruned article with reason

**Prerequisites:** Story 3.3

**Technical Notes:**

- Pruning Cypher query from architecture doc section 5.2 "Pruning candidates"
- Pruning only happens after deployment — never during active development
- Archive retains full article content (recoverable)
- S3 backup includes archive directory
- Node lifecycle: active → flagged → superseded → pruned (architecture doc section 6.1)

---

### Story 3.5: Impact Propagation Engine

As a **developer**,
I want **changes to any node to automatically flag downstream nodes for review based on graph traversal**,
So that **upstream changes (e.g., requirement revision) visibly ripple to all affected artifacts**.

**Acceptance Criteria:**

**Given** a node is updated (content change detected by compilation)
**When** the impact propagation runs
**Then** it traverses the graph from the updated node following outgoing edges up to 4 hops
**And** it calculates impact score: `edge_weight / (hops ^ 1.5)` for each downstream node
**And** nodes with score >= 0.5 are flagged as `critical` (status: flagged, flagSeverity: critical)
**And** nodes with score >= 0.1 are flagged as `moderate` (status: flagged, flagSeverity: moderate)
**And** flagged nodes include `flagReason` referencing the updated upstream node
**And** impact results are logged in `knowledge/log.md`

**Prerequisites:** Story 1.5 (graph-sync for Memgraph traversal)

**Technical Notes:**

- Impact propagation Cypher from architecture doc section 4.5
- Edge weights from architecture doc section 6.2
- Runs as part of every compilation step (story, epic, deployment, pre-dev)
- This is the heart of Mycelium's "network intelligence" — changes cascade through the graph
- A flagged node's article frontmatter gets updated with `status: flagged` and `flagReason`

---

## Epic 4: Pre-Development Phase Compilation

**Goal:** Extend compilation to discovery, planning, and solutioning phases. Documents ARE the graph — every PRD, architecture doc, and decision becomes a connected node.

### Story 4.1: Document Generation Compilation Hook

As a **developer**,
I want **a compilation step triggered after any document generation session in pre-dev phases**,
So that **PRDs, architecture specs, and planning documents are automatically decomposed into knowledge nodes**.

**Acceptance Criteria:**

**Given** a PM, Analyst, Architect, or UX agent session generates or revises a document
**When** the document generation pipeline completes
**Then** a COMPILE step runs that creates/updates wiki articles for the generated document
**And** the document is stored as a typed article (prd, architecture, tech-spec, etc.) in the appropriate phase directory
**And** `[[wikilinks]]` are generated linking to related existing nodes
**And** maturity score is assessed based on content completeness
**And** the article is embedded and synced to Memgraph

**Prerequisites:** Epic 1 complete, Story 3.5 (impact propagation)

**Technical Notes:**

- Extends the existing document generation pipeline endpoints
- Each pre-dev agent type maps to article types per architecture doc section 3.1 table
- PM → prd, requirement, epic-plan, story-plan
- Architect → architecture, tech-spec, api-spec, data-model, adr
- The compilation step is the same pattern as story compilation but with different article types

---

### Story 4.2: Requirement Decomposition from PRDs

As a **developer**,
I want **PRD documents automatically decomposed into individual requirement nodes linked by `DERIVED_FROM` edges**,
So that **each requirement is independently trackable with its own maturity score and downstream connections**.

**Acceptance Criteria:**

**Given** a PRD document is compiled into the knowledge graph
**When** the requirement decomposition runs
**Then** each functional requirement in the PRD becomes a separate article in `knowledge/requirements/`
**And** each requirement article has `DERIVED_FROM` edge pointing to the PRD article
**And** non-functional requirements are similarly decomposed
**And** requirement articles include: description, acceptance criteria, priority, related user type
**And** maturity is assessed per requirement (not just for the PRD as a whole)

**Prerequisites:** Story 4.1

**Technical Notes:**

- The Knowledge Compiler agent parses the PRD structure to identify discrete requirements
- Requirement nodes are the bridge between planning and solutioning phases
- When architecture decisions are made later, they create `DERIVED_FROM` edges back to these requirements
- This creates the full traceability chain: requirement → architecture → code → test

---

### Story 4.3: Decision Extraction from Architecture Sessions

As a **developer**,
I want **architectural decisions automatically extracted and stored as decision nodes with full lineage**,
So that **every "why" is captured, connected to the requirements it addresses, and traceable to the code that implements it**.

**Acceptance Criteria:**

**Given** an Architect agent session produces or revises technical documents
**When** the compilation step processes the output
**Then** explicit decisions (technology choices, pattern selections, API design choices) are extracted as articles in `knowledge/decisions/`
**And** each decision has `DERIVED_FROM` edges to the requirements it addresses
**And** each decision has `INFORMS` edges to placeholder code articles (created as `status: suggested`)
**And** decision articles include: context, options considered, chosen option, rationale, consequences
**And** if a decision contradicts an existing decision, a `CONFLICTS_WITH` edge is created

**Prerequisites:** Story 4.1, 4.2

**Technical Notes:**

- Decision articles follow ADR (Architecture Decision Record) format
- Placeholder code articles (status: suggested) represent "this code doesn't exist yet but the architecture implies it will"
- These placeholders become real articles when the Dev agent creates the actual files
- Conflict detection compares new decisions against existing ones in the same domain (e.g., two auth decisions)

---

### Story 4.4: Phase Gate Enforcement

As a **developer**,
I want **phase transitions validated against maturity requirements before allowing progression**,
So that **the system prevents premature jumps (e.g., coding before architecture is defined)**.

**Acceptance Criteria:**

**Given** the phase gates defined in the architecture (Discovery→Planning requires brainstorm at 0.4, Planning→Solutioning requires PRD at 0.6 + requirements at 0.4, etc.)
**When** a pipeline or agent session attempts to create nodes in a downstream phase
**Then** the system checks if gate requirements are met by querying node maturity in Memgraph
**And** if gates are not met: a warning is emitted listing what's missing and the pipeline continues (soft gate)
**And** gate status is tracked in `knowledge/system/pending-work.md`
**And** phase gate checks are logged in `knowledge/log.md`

**Prerequisites:** Story 4.1 (needs nodes with maturity scores to evaluate)

**Technical Notes:**

- Phase gates from architecture doc section 6.3
- Soft gates (warnings, not blockers) — the user decides whether to proceed
- Cypher query: find nodes of required type in the prerequisite phase and check maturity
- This is a quality guardrail, not a hard blocker — personal tooling should be flexible
- Gate status could be surfaced in the Labs UI later

---

## Epic 5: Conversational Agent ("Talk to Your App")

**Goal:** Enable interactive codebase conversations where the AI searches semantically, reads compiled wiki, greps code, and learns from every conversation.

### Story 5.1: GraphRAG Search Tool (graph-search.mjs)

As a **developer**,
I want **a command-line tool that performs combined vector search + graph traversal in Memgraph**,
So that **agents can find conceptually related nodes even without keyword overlap, plus their structural neighbors**.

**Acceptance Criteria:**

**Given** a project has nodes in Memgraph with embeddings
**When** `graph-search.mjs` is called with `--project`, `--query`, `--top-k`, and `--hops`
**Then** it embeds the query via Voyage AI (input type: `query`)
**And** it runs a combined Cypher query: vector search for top-K similar nodes → traverse graph N hops from matches
**And** it returns JSON array of `{nodeId, type, phase, title, maturity, similarity, relationships[]}`
**And** results are filtered by `minSimilarity` threshold (default 0.6)
**And** it executes in under 3 seconds for typical queries

**Prerequisites:** Story 1.5 (Memgraph populated with nodes)

**Technical Notes:**

- Implementation from architecture doc section 5.3
- Uses Voyage AI `query` input type for asymmetric search (query vs document embeddings)
- Combined Cypher from architecture doc: vector_search.search() → MATCH traversal
- Script at `/home/ubuntu/scripts/graph-search.mjs`
- Export as both CLI tool and importable module for use in daemon

---

### Story 5.2: 4-Layer Search Cascade Implementation

As a **developer**,
I want **a search cascade that combines GraphRAG, wiki article reading, grep, and raw file read in sequence**,
So that **agents get progressively deeper context: conceptual → compiled → textual → raw**.

**Acceptance Criteria:**

**Given** an agent needs to understand a part of the codebase
**When** a search cascade is initiated with a query
**Then** Layer 1 (GraphRAG): returns top semantically + structurally related nodes from Memgraph
**And** Layer 2 (Wiki): reads the wiki articles for top-ranked nodes, extracting purpose, decisions, dependencies
**And** Layer 3 (Grep): runs ripgrep on source files for exact pattern matches within the relevant files
**And** Layer 4 (Read): provides full source code for the specific files to be modified
**And** each layer's results feed into the next layer's targeting
**And** the cascade is callable as a function from daemon pipeline steps

**Prerequisites:** Story 5.1

**Technical Notes:**

- Search cascade from architecture doc section 5.1
- Layer 1 returns nodeIds → Layer 2 reads `knowledge/{nodeId}.md` → Layer 3 greps actual source files → Layer 4 reads them
- This is the agent's "knowledge acquisition" protocol
- Can be exposed as an MCP tool or injected into agent prompts as a pre-step
- The cascade is what makes "Talk to Your App" intelligent rather than just a grep wrapper

---

### Story 5.3: Conversation Pipeline Type

As a **developer**,
I want **a new pipeline type for interactive codebase conversations (not build-oriented)**,
So that **I can ask questions, brainstorm, and analyze my project with full knowledge graph context**.

**Acceptance Criteria:**

**Given** a user initiates a conversation for a specific project
**When** the conversation pipeline starts
**Then** Step 1: gathers project context (index.md, pending-work.md, file tree) via shell
**And** Step 2: runs GraphRAG search for the user's query topic
**And** Step 3: a conversational agent responds with full project context + graph search results
**And** the agent has access to Read, Grep, Glob, Bash tools for live code exploration
**And** the agent references wiki articles and decisions by their wikilinks
**And** if the conversation produces new knowledge, it's captured in a `---NEW_KNOWLEDGE---` block

**Prerequisites:** Story 5.1, 5.2

**Technical Notes:**

- Pipeline definition from architecture doc section 7.1
- New pipeline type alongside existing `story` and `epic` pipelines
- Agent model: opus (for complex reasoning about codebase)
- The conversation agent is stateless per pipeline run — context comes from the graph, not memory
- NEW_KNOWLEDGE extraction enables conversations to feed back into the graph

---

### Story 5.4: Conversation-to-Knowledge Compilation

As a **developer**,
I want **new knowledge generated during conversations automatically compiled into the wiki and graph**,
So that **insights, decisions, and discoveries from conversations don't get lost**.

**Acceptance Criteria:**

**Given** a conversation pipeline has completed and the agent produced a `---NEW_KNOWLEDGE---` block
**When** the conversation compilation step runs
**Then** each knowledge item is created as a wiki article in the appropriate phase directory
**And** the article type matches the knowledge type (decision, insight, requirement, risk)
**And** `[[wikilinks]]` are created to the related articles mentioned in the `links` field
**And** the article is embedded and synced to Memgraph
**And** `knowledge/log.md` records the conversation-derived compilation

**Prerequisites:** Story 5.3

**Technical Notes:**

- Conditional step — only runs if NEW_KNOWLEDGE was extracted
- Same compilation pattern as Story 2.3 but for conversation outputs instead of code diffs
- Conversations about the codebase often surface decisions, risks, and insights that should be persisted
- This closes the loop: conversation → knowledge → better future conversations

---

### Story 5.5: Self-Reflection Mode

As a **developer**,
I want **a specialized conversation variant where the agent analyzes the project's overall health**,
So that **I can ask "what's the current state?" and get a comprehensive, graph-informed assessment**.

**Acceptance Criteria:**

**Given** a user requests project reflection (e.g., "Reflect on the current state of SpyHunter")
**When** the self-reflection pipeline runs
**Then** the agent queries all nodes with maturity < 0.6 from Memgraph
**And** it reads `pending-work.md` and `debt-registry.md`
**And** it reads all flagged nodes and their flag reasons
**And** it synthesizes a report including: maturity heatmap by phase, flagged items requiring review, technical debt identified, missing test coverage, suggested next actions (prioritized)
**And** the reflection output is compiled as a `system` type article in `knowledge/system/`

**Prerequisites:** Story 5.3

**Technical Notes:**

- Specialized prompt variant of the conversation pipeline
- Uses Cypher queries from architecture doc section 5.2 ("Pending work" and "What needs work" patterns)
- The reflection is both an answer to the user AND a compiled knowledge artifact
- Useful before sprint planning: "what should I work on next?"

---

## Epic 6: Brownfield Bootstrap

**Goal:** One-time pipeline that reads an existing codebase and generates the initial wiki + graph, enabling "talk to your app" on projects built before this system existed.

### Story 6.1: Codebase Scan Agent

As a **developer**,
I want **an agent that scans an existing project's file tree and generates wiki articles for every relevant source file**,
So that **existing projects can be brought into the knowledge graph without manual documentation**.

**Acceptance Criteria:**

**Given** an existing project at `/home/ubuntu/projects/{name}/` with source code but no `knowledge/` directory
**When** the codebase scan agent runs
**Then** it initializes the wiki directory structure (Story 1.3)
**And** for each relevant source file (filtered by extension: .ts, .tsx, .js, .jsx, .py, .md, .json, etc.):
creates a wiki article in `knowledge/code/` with Purpose, Key Exports, Dependencies, Dependents, Signals, Missing Signals
**And** articles include correct frontmatter: type `code`, phase `implementation`, status `active`
**And** `[[wikilinks]]` connect files that import each other
**And** `knowledge/index.md` is populated with the complete catalog
**And** progress is emitted as pipeline events for UI tracking

**Prerequisites:** Epic 1 complete

**Technical Notes:**

- Agent uses Read, Glob, Grep tools to analyze the codebase
- Batch processing: process files in groups of 10-20 to manage context window
- File type filter configurable per project (e.g., skip test files, skip generated files)
- Cost: ~$0.50-2.00 depending on codebase size (hundreds of files)
- This is a heavy operation — expected to take 5-30 minutes per project

---

### Story 6.2: Import Dependency Extraction

As a **developer**,
I want **import/require statements automatically analyzed to create `DEPENDS_ON` edges between code articles**,
So that **the dependency graph accurately reflects the actual code structure**.

**Acceptance Criteria:**

**Given** code articles have been generated by the codebase scan
**When** the dependency extraction step runs
**Then** it parses import/require/from statements in each source file
**And** it maps imports to their corresponding wiki article paths
**And** `DEPENDS_ON` edges are created in the wiki articles' Dependencies/Dependents sections
**And** `knowledge/system/dependency-map.md` is generated with the full import graph
**And** circular dependencies are detected and noted

**Prerequisites:** Story 6.1

**Technical Notes:**

- Parse TypeScript/JavaScript imports: `import ... from '...'`, `require('...')`
- Resolve relative paths to actual file paths → wiki article slugs
- Handle barrel exports (index.ts re-exports)
- This could be a shell step using a simple AST parser or regex + an agent step for resolution
- The dependency graph is what makes GraphRAG traversal powerful for code

---

### Story 6.3: Decision & Config Inference

As a **developer**,
I want **architectural decisions automatically inferred from configuration files and package manifests**,
So that **the knowledge graph captures the "why" behind technology choices even for existing projects**.

**Acceptance Criteria:**

**Given** an existing project has `package.json`, `tsconfig.json`, config files, and similar manifests
**When** the decision inference agent runs
**Then** it creates decision articles in `knowledge/decisions/` for major technology choices (framework, database, auth provider, styling, bundler, etc.)
**And** each decision article includes: context (inferred from usage), chosen option, evidence (which files/configs demonstrate the choice)
**And** decision articles have `INFORMS` edges to the code articles that use them
**And** `knowledge/solutioning/` gets a synthesized architecture overview article

**Prerequisites:** Story 6.1

**Technical Notes:**

- Agent reads: package.json (dependencies), tsconfig.json (compiler options), Dockerfile, docker-compose, .env.example, README
- Inferred decisions are marked with lower maturity (0.3-0.5) since they're reverse-engineered, not explicitly documented
- The user can refine these decisions later to increase maturity
- This bridges the gap between "code exists" and "we understand why it was built this way"

---

### Story 6.4: Full Graph Population & Verification

As a **developer**,
I want **all generated wiki articles embedded and synced to Memgraph with a verification step**,
So that **the brownfield project is fully searchable via GraphRAG immediately after bootstrap**.

**Acceptance Criteria:**

**Given** the codebase scan, dependency extraction, and decision inference are complete
**When** the full graph population runs
**Then** `graph-sync.mjs --full-resync` processes all generated articles
**And** all articles are embedded via Voyage AI and upserted into Memgraph
**And** all `[[wikilinks]]` are resolved into typed edges
**And** a verification query confirms: node count matches article count, edge count > 0, vector index contains all embeddings
**And** a sample GraphRAG query returns relevant results
**And** wiki is backed up to S3
**And** project registry is updated with `knowledgeGraph` metadata (nodeCount, edgeCount, etc.)

**Prerequisites:** Story 6.2, 6.3

**Technical Notes:**

- This is the capstone of the bootstrap pipeline
- Uses existing `graph-sync.mjs` with `--full-resync` flag
- Verification queries prevent silent failures (empty graph, missing embeddings)
- After this completes, the user can immediately use the Conversational Agent (Epic 5) on this project
- Update `futurator-project-registry` DynamoDB table with the new `knowledgeGraph` field

---

_For implementation: Use the `create-story` workflow to generate individual story implementation plans from this epic breakdown._
