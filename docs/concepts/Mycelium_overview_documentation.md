# Mycelium — Feature Documentation

## What is Mycelium?

Mycelium is an AI-powered knowledge graph orchestrator that transforms raw project ideas into a structured, self-growing intelligence system. Named after the underground fungal networks that connect trees in a forest, Mycelium mirrors nature's most efficient information architecture: a living mesh that decomposes, distributes, and continuously strengthens knowledge across every dimension of a project.

Where traditional project tools are static containers — documents you write, boards you update, specs you forget — Mycelium is a **living organism**. You feed it an idea. It breaks that idea into independently evolving knowledge nodes, connects them through typed relationships, tracks their maturity, identifies gaps, and suggests what to grow next. Every interaction makes the graph smarter. Every document generated is grounded in what you've already built. Nothing exists in isolation; everything is connected.

The result is a project intelligence layer that knows what you know, remembers what you've decided, detects when a change upstream ripples downstream, and guides you through seven phases of development — from first brainstorm to production support — with the discipline of a seasoned team and the memory of a perfect record-keeper.

---

## The Organism Metaphor

Mycelium behaves like a biological network in three fundamental ways:

### 1. Decomposition

Just as mycelium in nature breaks down organic matter into nutrients, Mycelium decomposes your raw input — brainstorms, PDFs, URLs, meeting transcripts, pasted notes — into discrete, typed knowledge nodes. A brainstorm is never stored as one blob. It's broken into requirements, decisions, risks, evidence, and research nodes, each placed in the correct phase of development, each with its own maturity score and growth trajectory.

### 2. Interconnection

In a forest, mycelium connects trees through underground networks, allowing them to share resources and signal danger. In Mycelium, every knowledge node is linked to others through eight relationship types — `depends_on`, `derived_from`, `informs`, `refines`, `validates`, `supersedes`, `conflicts_with`, and `enables`. When you change an architecture decision, the system traverses these connections to flag every downstream node that needs review: the technical spec that implements it, the test plan that validates it, the API docs that describe it. Nothing falls through the cracks because the network remembers what depends on what.

### 3. Continuous Growth

A mycelium network never stops growing. It extends into new territory, strengthens existing connections, and adapts to its environment. Mycelium the app works the same way. Every user interaction — uploading a document, asking a question, refining a node, generating a spec — adds new chunks to the vector store, new events to the timeline, new edges to the graph, and new context for the AI. The system's intelligence is cumulative. A question you answer today improves the document the AI generates tomorrow. A competitive analysis uploaded in discovery grounds the architecture decisions made in solutioning. The organism learns, remembers, and gets smarter with every feeding.

---

## The Seven Phases of Development

Mycelium enforces a phased approach to project development, preventing premature jumps while encouraging natural progression. Each phase has its own node types, and gates between phases ensure prerequisites are met before moving forward.

### Phase 1 — Discovery

**Purpose:** Understand the problem space.

You begin by feeding Mycelium raw material: brainstorms, market research, competitive analyses, meeting notes, evidence, and intent statements. The AI decomposes these inputs into discovery-phase nodes, each scored for maturity based on how well-defined its content is.

**Node types:** brainstorm, brief, research, competitive_analysis, intent, evidence, meeting_notes

**Gate to Planning:** At least one brainstorm or brief node must reach 40% maturity (basic outline with defined aspects).

---

### Phase 2 — Planning

**Purpose:** Define what to build and why.

With discovery grounded, Mycelium shifts to strategic planning. The AI suggests PRDs, requirements, roadmaps, epics, stories, and architectural decision records. Each planning node is connected back to its discovery origins through `derived_from` edges, ensuring traceability from requirement to raw insight.

**Node types:** prd, requirements, roadmap, epic, story, decision, raci, risk_matrix

**Gate to Solutioning:** PRD at 60% maturity + requirements at 40% maturity.

---

### Phase 3 — Solutioning

**Purpose:** Design how to build it.

Architecture, technical specs, UX flows, API contracts, data models, and security plans emerge here. The AI generates these documents using specialized personas (Solution Architect, UX Designer) grounded in everything from prior phases. Every design decision is linked to the requirements it addresses and the constraints it respects.

**Node types:** architecture, technical_spec, adr, api_spec, data_model, security_plan, feasibility, ux_spec, design, user_journey

**Gate to Implementation:** Architecture at 60% maturity + technical spec at 40% maturity.

---

### Phase 4 — Implementation

**Purpose:** Build it.

Sprint planning, code structure, and development workflow nodes live here. Mycelium can ingest a linked GitHub repository, creating nodes for every file and directory, chunking and embedding code for semantic search. Sprint status and code reviews are tracked as living nodes in the graph.

**Node types:** sprint_status, code_review, retrospective

**Gate to QA:** Epics at 60% maturity + stories at 40% maturity.

---

### Phase 5 — QA & Testing

**Purpose:** Verify it works.

Test plans, test case designs, non-functional requirement assessments, and traceability matrices are generated by the QA Lead persona. Each test artifact traces back to the requirements and architecture it validates through `validates` edges — complete traceability from test to requirement to raw insight.

**Node types:** test_plan, test_design, test_case, nfr_assessment, traceability_matrix

**Gate to Release:** Test plan at 60% maturity.

---

### Phase 6 — Release

**Purpose:** Ship it.

Release notes, runbooks, and operational documentation are generated grounded in everything built before. The AI draws from architecture, implementation, and QA phases to produce accurate, comprehensive release artifacts.

**Node types:** release_notes, runbook

---

### Phase 7 — Support

**Purpose:** Maintain and evolve it.

User guides, FAQs, API documentation, and onboarding guides form the long-tail support layer. These documents are grounded in the full project graph, ensuring consistency with what was actually built.

**Node types:** user_guide, api_docs, faq, onboarding_guide

---

## Core Features

### Knowledge Graph Visualization

The graph canvas renders all project knowledge as an interactive network across seven horizontal swimlanes, one per phase. Each node appears as a colored circle with:

- **Type-specific color** — 35+ node types, each with a unique color for instant visual recognition
- **Maturity arc** — a progress ring (0-360°) showing how developed the node is, color-coded from red (raw) through orange, yellow, blue, to green (ready)
- **Status indicator** — solid (exists), dashed (draft), or sparse-dashed (suggested) outlines
- **Document badge** — "D" marker when the node has generated content
- **Review flags** — red (critical) or yellow (moderate) indicators when upstream changes require review

Edges between nodes are rendered as curved Bezier paths with relationship labels, showing the web of dependencies, derivations, and validations that connect every piece of project knowledge.

Phase gate indicators appear between swimlanes showing prerequisites — green checkmarks for passed gates, orange warnings for partially met, red locks for blocked transitions.

---

### AI Orchestrator

The orchestrator is the brain of Mycelium. It classifies every user input into one of three intents and routes accordingly:

**Content Intent** — When you paste a brainstorm, upload a PDF, or provide project material, the orchestrator decomposes it into 4-10 typed nodes with relationships, maturity scores, signals, and missing signals. It examines every existing node for connections to the new material, creating a web of relationships that captures how concepts inform, depend on, and sometimes conflict with each other.

**Question Intent** — When you ask a question ("What does our architecture say about auth?"), the orchestrator searches the project's vector store and graph, then answers with citations linking every claim back to source material.

**Command Intent** — When you trigger document generation or node refinement, the orchestrator delegates to one of eight specialized personas.

Key orchestrator behaviors:

- **Decomposition discipline** — never creates a single node from rich input; always breaks into independently evolving elements
- **Phase discipline** — never suggests documents from two or more phases ahead of the current state
- **Edge intelligence** — examines all existing nodes when creating new ones, asking: does this reference, resolve, or contradict something already in the graph?
- **Conflict detection** — flags contradictory information with `conflicts_with` edges
- **Suggestion quality** — provides 3-5 prioritized next steps with reasoning after every interaction

---

### Eight Specialized Personas

Document generation is handled by domain-specific AI personas, each bringing the voice and expertise of a seasoned professional:

| Persona                | Domain                                                 | Phase Focus         |
| ---------------------- | ------------------------------------------------------ | ------------------- |
| **Business Analyst**   | Stakeholder mapping, discovery analysis                | Discovery, Planning |
| **Product Manager**    | PRDs, requirements, prioritization                     | Planning            |
| **UX Designer**        | User flows, interaction specs, accessibility           | Design              |
| **Solution Architect** | Architecture docs, system design, ADRs, API contracts  | Solutioning         |
| **Scrum Master**       | Sprint planning, story breakdown, dependencies         | Implementation      |
| **Senior Developer**   | Technical specs, implementation guides, code structure | Implementation      |
| **QA Lead**            | Test plans, test cases, traceability matrices          | QA                  |
| **Technical Writer**   | User guides, API docs, FAQs, runbooks                  | Release, Support    |

Each persona generates content grounded in the project's existing knowledge base, producing documents with inline citation markers that trace every claim back to its source.

---

### Maturity Tracking

Every node carries a maturity score from 0.0 to 1.0, representing how well-defined and complete its content is:

| Score   | Label       | Meaning                                  |
| ------- | ----------- | ---------------------------------------- |
| 0.0–0.2 | **Raw**     | Concept mentioned, key aspects undefined |
| 0.2–0.4 | **Early**   | Basic outline, many gaps remain          |
| 0.4–0.6 | **Partial** | Core aspects defined, some gaps          |
| 0.6–0.8 | **Solid**   | Well-defined, minor refinements needed   |
| 0.8–1.0 | **Ready**   | Fully specified, ready for next phase    |

Each node also carries two signal lists:

- **Maturity signals** (3-6 items) — what's already defined ("target users identified", "API endpoints specified")
- **Missing signals** (2-5 items) — what gaps remain ("security model undefined", "error handling not addressed")

The maturity system drives phase gates, suggestion priority, and refinement targeting. When you refine a node, the AI addresses its specific missing signals, advancing the maturity score and unlocking downstream progression.

---

### Hybrid Retrieval Pipeline

Mycelium uses a three-stage retrieval system that combines semantic understanding, graph structure, and temporal context to find the most relevant project knowledge for any query or generation task:

**Stage 1 — Semantic Discovery**
Embeds the query using Voyage AI (1024 dimensions) and searches two vector indexes in parallel: one over content chunks, one over node summaries. Over-fetches 5x and post-filters by project, phase, and content type.

**Stage 2 — Structural Traversal**
From the nodes discovered semantically, traverses the knowledge graph up to 3 hops to find structurally related nodes. A requirement node connects to its architecture, which connects to its test plan — all brought into context even if they didn't match the query text.

**Stage 3 — Temporal Context**
Queries the event timeline for each discovered node, retrieving recent activity (refinements, reviews, user messages). This captures the living state of the project — not just what was written, but what was recently changed, discussed, or flagged.

The three stages are merged using a weighted formula: **50% semantic + 30% structural + 20% temporal**. This ensures the AI has broad, deep, and current context for every response.

---

### Citation System

Every piece of knowledge in Mycelium is traceable to its source. The citation system operates at multiple levels:

**Ingestion citations** — When you upload a PDF, paste text, or provide a URL, the content is chunked and each chunk stores its provenance: source type (upload, user_input, url, github_file), source reference (file ID, URL, message ID), phase, and node type.

**Generation citations** — When the AI generates a document, it includes inline citation markers `[source: N]` linking claims to the project knowledge that grounds them. The post-generation pipeline stores these as structured provenance records.

**UI citations** — In the document modal, citation badges appear as numbered blue markers. Hovering or clicking reveals the source details: what type of content was cited, where it came from, and the specific text that was referenced.

This creates an unbroken chain of provenance: from raw brainstorm to requirement to architecture decision to test plan — every claim is traceable.

---

### Impact Analysis & Review Flags

When a node is modified, Mycelium traverses the knowledge graph to identify every downstream node affected by the change. The impact score is calculated as:

```
score = edge_weight / (hops ^ 1.5)
```

Where edge weights vary by relationship type (DEPENDS_ON: 1.0, INFORMS: 0.3, CONFLICTS_WITH: 0.9) and decay with distance. Nodes scoring above the threshold (0.1) are flagged for review:

- **Critical** (score >= 0.5) — red badge, strong dependency, must review
- **Moderate** (score >= 0.1) — yellow badge, should review

The graph canvas highlights flagged nodes visually, and the node inspector shows the impact details with a "Mark as Reviewed" action. This ensures that changing an architecture decision doesn't silently invalidate the test plan three hops away.

---

### File System & Document Management

Every knowledge node maps to a file path following the convention `docs/{phase}/{slug}.md`. The file tree provides a familiar hierarchical view of all project documentation:

- **Active files** — documents that have been generated, with maturity dots indicating completeness
- **Ghost files** — placeholder entries for suggested nodes that don't have content yet, showing what the project could grow next
- **Version tracking** — each file stores its version count and content hash, with snapshots saved to S3

The file preview panel renders markdown with full citation support, letting you read generated documents with source attribution inline.

---

### GitHub Integration

Mycelium can connect to a GitHub repository, providing:

- **Repository browsing** — explore repos, branches, and files without leaving the app
- **Repository ingestion** — analyze an entire codebase by fetching the file tree, filtering by relevant file types (.ts, .py, .md, etc.), chunking and embedding text content, and creating graph nodes for the repository structure
- **Code-aware context** — ingested code becomes part of the RAG pipeline, so the AI can reference actual implementation when generating docs or answering questions

---

### Project Management

Mycelium supports multiple concurrent projects, each with its own knowledge graph, file system, event timeline, and chat history:

- **Project tabs** — switch between projects with one click
- **Inline rename** — edit project names directly
- **Project-scoped state** — nodes, edges, suggestions, and chat isolated per project
- **Snapshot saving** — one-click persistence of current project state to S3
- **Database status** — real-time indicator showing DynamoDB connectivity

---

### Node Inspector

Selecting any node opens a detailed inspector panel with three sections:

**Details** — label, type, phase, status, maturity score with visual bar, maturity signals (confirmed aspects), missing signals (gaps to fill), and action buttons for refinement or document viewing.

**Timeline** — chronological event history for this specific node: when it was created, refined, generated, discussed, flagged for review, or marked as reviewed. Each event shows relative timestamps and metadata.

**Relationships** — incoming and outgoing edges showing what this node depends on, what depends on it, what it informs, validates, or conflicts with. The full dependency web visible at a glance.

**Node Chat** — a scoped input that lets you add context or ask questions specifically about this node. Responses are grounded in the node's content and relationships.

---

### Conductor Bar

During active AI operations (orchestration, generation, refinement), a progress bar appears showing:

- Current action and persona
- Step progress
- Cancel button
- Celebration effect on first document generation — because milestones matter

---

## The Always-Updated Intelligence Loop

The fundamental insight behind Mycelium is that project knowledge is not static. It grows, evolves, and compounds. The system maintains this through a continuous intelligence loop:

```
User Input
    ↓
Intent Classification → Question / Content / Command
    ↓
AI Orchestration ← Graph Context + Vector Search + Event History
    ↓
    → Graph Changes (nodes + edges + maturity updates)
    → Answers (with citations)
    → Suggestions (prioritized next steps)
    → Documents (persona-specialized, grounded)
    ↓
Event Recording → Audit trail (who, what, when)
Chunk Embedding → Semantic index (vector store)
Graph Sync → Structural index (Memgraph)
File Persistence → Document archive (DynamoDB + S3)
    ↓
Enhanced context for next interaction
```

Every cycle through this loop makes the organism smarter:

- New chunks improve semantic search accuracy
- New edges improve structural traversal depth
- New events improve temporal context relevance
- New maturity scores improve suggestion targeting
- New documents improve generation grounding

The system never forgets, never loses context, and never stops growing. It is, in the truest sense, a living knowledge network — decomposing raw ideas into nutrients, distributing them through an interconnected web, and growing stronger with every interaction.

---

## Technical Architecture Summary

| Layer                | Technology                                    | Purpose                               |
| -------------------- | --------------------------------------------- | ------------------------------------- |
| **Frontend**         | Next.js 15, React 19, Tailwind CSS, shadcn/ui | Responsive 3-panel interface          |
| **API**              | Next.js API Routes                            | RESTful endpoints for all operations  |
| **LLM**              | Anthropic Claude (via AI SDK v6)              | Orchestration, generation, Q&A        |
| **Embeddings**       | Voyage AI voyage-3-large (1024-dim)           | Semantic search vectors               |
| **Graph DB**         | Memgraph (Neo4j-compatible)                   | Knowledge graph + vector indexes      |
| **Document Store**   | AWS DynamoDB                                  | Projects, nodes, edges, files, events |
| **File Storage**     | AWS S3                                        | Versioned snapshots and uploads       |
| **State Management** | Zustand (client)                              | UI state and project context          |

---

## Data Model

### Core Entities

**Node** — A knowledge unit with type, phase, maturity, content, and provenance. 35+ types across 7 phases.

**Edge** — A typed relationship between nodes. 8 relationship types capturing dependencies, derivations, validations, and conflicts.

**Chunk** — A vector-embedded text segment (~500 tokens) with source provenance. Powers semantic search.

**Event** — An audit record capturing every action (creation, refinement, generation, review) with timestamp, actor, and metadata.

**File** — A versioned document mapped to a knowledge node, stored at `docs/{phase}/{slug}.md`.

**Project** — A container for a complete knowledge graph with its own nodes, edges, files, events, and optional GitHub repository link.

### Relationship Types

| Type             | Meaning                        | Weight |
| ---------------- | ------------------------------ | ------ |
| `depends_on`     | B needs A to be complete       | 1.0    |
| `derived_from`   | B was extracted/created from A | 0.7    |
| `informs`        | A provides context for B       | 0.3    |
| `refines`        | B adds detail to A             | 0.5    |
| `validates`      | B verifies/tests A             | 0.6    |
| `supersedes`     | B replaces A                   | 0.8    |
| `conflicts_with` | A and B contradict             | 0.9    |
| `enables`        | A makes B possible             | 0.5    |

---

_Mycelium — Growing project intelligence, one node at a time._
