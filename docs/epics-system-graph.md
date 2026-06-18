# Pipeline v3 — System Graph & Cross-Project Propagation — Epic Breakdown

**Author:** Richie
**Date:** 2026-06-15
**Project Level:** Brownfield enhancement — multi-epic initiative (Level 3)
**Target Scale:** Internal pipeline tooling — the Mycelium system-graph layer
**Source PRD:** [system-graph-prd.md](./concepts/pipeline-v3/system-graph-prd.md) (v0.2)
**Validated by:** [test-bench-rubric.md](./concepts/pipeline-v3/test-bench-rubric.md) (run later, not part of scope)

---

## Overview

This document decomposes the System Graph PRD (v0.2) into implementable epics and stories, each sized for a single dev-agent session. It extends the existing **Mycelium** knowledge-graph system (`ast-extract.mjs`, `graph-sync.mjs`, the Knowledge Compiler, `search-cascade.mjs`) — it does **not** rebuild it. Every extractor added here is deterministic and zero-LLM.

> Separate from the existing `docs/epics.md` (the Futurator-Admin Hub product breakdown, Epics 0–8). This file covers only the Pipeline-v3 system-graph layer.

### Epic Summary

| #   | Epic                                            | Band   | Stories | Depends On | PRD Phase   |
| --- | ----------------------------------------------- | ------ | ------- | ---------- | ----------- |
| 1   | System Graph Foundation: Code↔Infra↔Service Map | MVP    | 6       | —          | P1, P1b, P2 |
| 2   | "No Alone Dots": Honest Graph Integrity         | MVP    | 4       | Epic 1     | P3          |
| 3   | Architectural X-Ray: Centrality & Communities   | MVP    | 4       | Epic 1     | P4          |
| 4   | Agent Graph Access & Measured Token Savings     | MVP    | 4       | Epic 1 (3) | P5, P6      |
| 5   | Cross-Project Contract Spine                    | Growth | 4       | Epic 1     | P7          |
| 6   | PROPAGATOR: Auto-Briefing the Siblings          | Growth | 5       | Epic 5     | P8, P9      |
| 7   | Graph-Ready Boilerplate                         | Scale  | 3       | Epic 1, 2  | P10         |

**Total: 30 stories across 7 epics.**

### Why this grouping

Epics are named by **value delivered**, not technical layer. Each is independently valuable and demoable:

- **Epic 1** is the foundation — the three deterministic extractors (infra, route, service) + graph-sync wiring that turn a code-only graph into a _system_ graph. It is the keystone the PRD calls out: it unlocks **both** the blast-radius track (Epics 3–4) and the propagation track (Epics 5–6). Nothing else can start without it.
- **Epic 2** makes the graph _honest_ — no silent orphans, dead code surfaced as a finding. It's the PRD's headline integrity promise ("no alone dots").
- **Epic 3** gives humans the architectural overview (god-nodes, communities) — the borrowed-from-graphify idea, richer because the graph now spans infra.
- **Epic 4** is the **token lever**: agents query the graph as an MCP tool, blast-radius is injected before edits, and — critically — adoption + savings are _measured_, not assumed (closes PRD weakness W3).
- **Epic 5** federates the graph across projects so a shared backend contract becomes a spine linking Labs / Mobile / Office.
- **Epic 6** is the **PROPAGATOR** — the novel capability: contract drift auto-drafts substrate-targeted port-briefs, consent-gated.
- **Epic 7** bakes the extractors into boilerplate so every new app ships graph-ready.

### Sequencing

```
Epic 1 ─┬─> Epic 2 ──> Epic 7
        ├─> Epic 3 ─┐
        ├─> Epic 4 <┘   (Epic 4 uses Epic 3's centrality in results, but only hard-depends on Epic 1)
        └─> Epic 5 ──> Epic 6
```

- **MVP cut (the token lever):** Epics 1 → 2 → 4 deliver a trustworthy, honestly-complete graph that agents query to save tokens — provably. Epic 3 enriches the human view alongside.
- **Growth (the differentiator):** Epics 5 → 6 deliver cross-project propagation — the reason this is v3.
- **Scale:** Epic 7 propagates the capability to every boilerplate repo.

### Scope guards carried from the PRD (every epic must respect)

- Deterministic / zero-LLM extraction; `INFERRED` only for unknown `fetch()` hosts + capability suggestions, always marked.
- Zero-cost-serverless; Memgraph stays on the existing EC2 daemon host (no new always-on cost).
- DynamoDB multi-table; never single-table.
- Dual-bucket safety is **modeled** as `bucketPath` nodes — never violated.
- Autonomy (auto-filed sibling stories) is **always consent-gated**; briefs auto-draft, humans approve.

---

<!-- Story-level detail is filled per-epic in Step 3 (one elicitation pass per epic). -->

## Epic 1: System Graph Foundation — the Code↔Infra↔Service Map

**Goal:** Extend Mycelium's code-only graph into a _system_ graph by adding three deterministic, zero-LLM extractors (infrastructure, API routes, external services) and wiring them into `graph-sync` so blast-radius and the contract spine can span the full stack. This epic is the keystone — it unlocks every later epic. No graph schema rewrite: new `kind` values flow through the existing `:Node{kind}` model and the additive `MERGE (n:Node{nodeId})` path.

### Story 1.1: Extractor harness & graph-sync ingest contract (foundation)

As a pipeline engineer,
I want a shared extractor scaffold, a defined output-envelope contract, and a single graph-sync ingest entrypoint,
So that each new extractor (infra/route/service) plugs into the same wave-gate step and sync path without bespoke wiring.

**Acceptance Criteria:**

**Given** the `daemon/scripts` directory and a small fixture SST repo,
**When** a no-op reference extractor runs against the fixture,
**Then** it emits the standard envelope `{ generatedAt, root, nodeCount, edgeCount, nodes[], edges[], ambiguous[] }` matching `ast-extract`'s shape.

**And** `graph-sync` exposes an additive `upsertExtractedFacts(session, projectId, doc, today)` path that ingests that envelope idempotently via `MERGE (n:Node {nodeId})` — re-running produces no duplicate nodes/edges.

**And** the wave-gate step has a declared slot to invoke extractors alongside `ast-extract` on the same diff-manifest (re-run when source files change; cached subgraph persists otherwise).

**Prerequisites:** None (first story of the initiative).

**Touch Points:**

- `daemon/scripts/lib/extractor-envelope.mjs` (new — shared envelope helper)
- `daemon/scripts/graph-sync.mjs` (add `upsertExtractedFacts`)
- `daemon/pipelines/` wave-gate step config (declare extractor slot)
- `daemon/scripts/__fixtures__/mini-sst/` (new — test fixture repo)
- `daemon/scripts/__tests__/extractor-envelope.test.mjs` (new)

**Forbidden Areas:** `ast-extract.mjs` extraction logic (do not refactor); Memgraph node-label/`:Node{kind}` schema (no rename/migration).

**Technical Notes:** Mirror the exact envelope of `ast-extract.mjs`. Keep ingest additive — no deletes in this story. The fixture repo needs one `Dynamo`, one `Function`, one `Cron`, one `Secret`, and one Hono route so downstream extractor tests have a target.

### Story 1.2: `infra-extract.mjs` — core infrastructure nodes & edges

As a pipeline engineer,
I want to extract DynamoDB tables, Lambdas, crons, secrets, buckets, CloudFront, and IAM roles from `sst.config.ts`,
So that code↔infra relationships become first-class graph nodes (PRD Appendix A).

**Acceptance Criteria:**

**Given** the real `sst.config.ts`,
**When** `node infra-extract.mjs --root . --config sst.config.ts` runs,
**Then** it emits `table`/`lambda`/`cron`/`secret`/`bucket`/`bucketPath`/`cloudfront`/`iamRole` nodes via two-pass extraction (pass 1 collects `new sst.*`/`aws.*` + var bindings; pass 2 emits).

**And** it emits `HANDLED_BY` (lambda/cron→file via `handler:`), `USES` (lambda→table/secret via `link:`), `WRITES` (lambda→`bucketPath` from scoped `permissions:` ARNs), and `REPRESENTS` (secret→externalService via name hints).

**And** it returns an `envJoin` map `{ ENV_VAR: { kind, id } }` from the `environment:` block, and `table` nodes carry `fields` + `primaryIndex` (the data contract).

**And** the four scoped bucket paths (`data/*`, `media/*`, `apps/*`, `knowledge-live/*`) become distinct `bucketPath` nodes — modeling the dual-bucket safety rule; unresolved joins go to `ambiguous[]`, never guessed.

**Prerequisites:** Story 1.1.

**Touch Points:**

- `daemon/scripts/infra-extract.mjs` (new — per PRD Appendix A)
- `daemon/scripts/__tests__/infra-extract.test.mjs` (new)

**Forbidden Areas:** `sst.config.ts` (read-only — never mutate infra config).

**Technical Notes:** Reuse `ast-extract`'s `loadParser()` + cursor `walk()`. `kindForConstructor` dispatch on dotted ctor text. `handlerToFile` returns a `.ts` stem; graph-sync probes `.ts|.tsx|.mjs`.

### Story 1.3: Event infra & async edges in `infra-extract` (W5)

As a DEV agent,
I want event-driven wiring (SNS/EventBridge/S3-notification/cron schedules) modeled as nodes + edges,
So that blast-radius can see async chains and never returns a false "all-clear" (PRD §5.1, W5).

**Acceptance Criteria:**

**Given** `sst.config.ts` containing `cwAlarmsTopic.subscribe('CloudWatchToAttention', { … })` (line ~1279),
**When** `infra-extract` runs,
**Then** it emits `topic`/`queue`/`bus`/`eventSource` nodes and a `TRIGGERS` edge (eventSource/topic/cron → lambda) plus `SUBSCRIBES` (lambda → topic/bus).

**And** a `Cron` schedule emits a `cron ─TRIGGERS→ lambda` edge; best-effort publish call-sites emit `EMITS`, with dynamic targets recorded as `ambiguous[]`.

**Prerequisites:** Story 1.2.

**Touch Points:**

- `daemon/scripts/infra-extract.mjs` (extend)
- `daemon/scripts/__tests__/infra-extract.event.test.mjs` (new)

**Forbidden Areas:** `sst.config.ts`.

**Technical Notes:** Match `<obj>.subscribe('Name', { handler })` and `<bucket>.notify(...)` call-expressions in the same `walk`. The first string arg is the logical id; the `handler` pair resolves the lambda.

### Story 1.4: `route-extract.mjs` — endpoint nodes (W1)

As a pipeline engineer,
I want each Hono route extracted as an `endpoint` node,
So that the `component → endpoint → table` contract spine has its missing middle node (PRD Appendix F, W1).

**Acceptance Criteria:**

**Given** `functions/api/index.ts` with `app.get('/api/health', …)`, `app.post('/api/auth/exchange', …)`, `app.get('/api/auth/me', authMiddleware, …)`,
**When** `node route-extract.mjs --root . --app functions/api/index.ts --lambda infra/lambda/Api` runs,
**Then** each route becomes an `endpoint` node with `{ method, path, auth }`, where `auth=true` iff `authMiddleware` is in the middleware chain.

**And** each endpoint emits `ROUTES → infra/lambda/Api`; dynamic/spread routes go to `ambiguous[]`.

**And** public routes (`/api/health`, `/api/auth/*`, `/api/public/projects`) are correctly flagged `auth=false` — making the public-route contract queryable.

**Prerequisites:** Story 1.1.

**Touch Points:**

- `daemon/scripts/route-extract.mjs` (new — per PRD Appendix F)
- `daemon/scripts/__tests__/route-extract.test.mjs` (new)

**Forbidden Areas:** `functions/api/index.ts` (read-only).

**Technical Notes:** Match `app.<method>(...)` call-expressions; `HTTP_METHODS` set. CALLS_ENDPOINT (frontend side) is resolved later in Story 1.6, not here.

### Story 1.5: `service-extract.mjs` — external-service nodes (W10)

As a DEV agent,
I want 3rd-party SDK imports and `fetch()` hostnames mapped to `externalService` nodes with a cost model,
So that blast-radius can answer "does this touch a _paid_ API?" (PRD Appendix B, W10).

**Acceptance Criteria:**

**Given** the changed-file list for a sync,
**When** `service-extract` runs,
**Then** known SDK packages (`@anthropic-ai/*`, ElevenLabs, Moises, GoogleMaps, Voyage…) and known hosts (`api.anthropic.com`, `auth.futurator.ai`…) become `externalService` nodes + `CALLS_SERVICE` (file→service) edges.

**And** each `externalService` carries `costModel` (e.g. `{ unit:'token', billable:true }`), and unknown hosts are emitted to `ambiguous[]` for the Compiler to label once (→ `INFERRED`, never silently `EXTRACTED`).

**Prerequisites:** Story 1.1.

**Touch Points:**

- `daemon/scripts/service-extract.mjs` (new — per PRD Appendix B)
- `daemon/scripts/__tests__/service-extract.test.mjs` (new)

**Forbidden Areas:** none beyond read-only source.

**Technical Notes:** Prefer reusing `ast-extract` import data via `--ast-facts` when available; the standalone regex scan is the fallback. `PACKAGE_SERVICE` / `HOST_SERVICE` maps per Appendix B.

### Story 1.6: graph-sync env-join (`READS` W4), `Resource.*` (W7) & `CALLS_ENDPOINT`

As a DEV agent,
I want `File ─READS→ Table` and `component ─CALLS_ENDPOINT→ endpoint` edges resolved accurately,
So that blast-radius reflects real consumers, not a shared-accessor god-node (PRD Appendix C; W4, W7, W1).

**Acceptance Criteria:**

**Given** the `envJoin` map from `infra-extract` and `process.env.X` references collected by `ast-extract`,
**When** graph-sync runs the env-join,
**Then** `READS` is attributed **transitively** to the file that calls the accessor for a given table — not to the shared `functions/shared/dynamo-client.ts` accessor alone (W4).

**And** `Resource.X.value` references (e.g. `functions/shared/github/load-pat.ts:7`) resolve to the same infra node as `process.env.X` (W7).

**And** `CALLS_ENDPOINT` edges are created by matching `api-client` request paths against the extracted `endpoint` set (`:param` ↔ template normalized); unmatched calls → `ambiguous[]`.

**And** `ast-extract` gains a `process.env.IDENT` member-expression scan emitting `envRefsByFile`, with no change to its existing outputs.

**Prerequisites:** Stories 1.2, 1.4, 1.5.

**Touch Points:**

- `daemon/scripts/graph-sync.mjs` (add `upsertEnvReads`, `upsertCallsEndpoint`)
- `daemon/scripts/ast-extract.mjs` (add `process.env` member scan → `envRefsByFile`)
- `daemon/scripts/__tests__/graph-sync.envjoin.test.mjs` (new)

**Forbidden Areas:** `ast-extract.mjs` existing function/class/import/call extraction output shape (additive only — do not alter existing fields).

**Technical Notes:** Accessor-aware resolution: when the env read lives in a shared module, follow inbound `CALLS`/`IMPORTS` one hop to attribute `READS` to the real consumer (record the accessor hop in `r.via`). This story is the integration seam of Epic 1 — keep edits surgical and additive.

---

## Epic 2: "No Alone Dots" — Honest Graph Integrity

**Goal:** Guarantee no orphan nodes by construction, and turn the edges that were previously dropped silently into either an extractor fix or an honest finding. An orphan is never silent again: it's an extractor bug (blocks the wave gate) or genuine dead code (reported in the Graph tab). Implements PRD §4.

### Story 2.1: Containment backbone (`dir ─CONTAINS→ file`)

As a graph maintainer,
I want every file node to carry a structural `CONTAINS` edge from its directory by construction,
So that no code node can ever be degree-0 for purely structural reasons (PRD §4.2.1).

**Acceptance Criteria:**

**Given** a sync of any project,
**When** graph-sync ingests the file set,
**Then** it emits `dir ─CONTAINS→ file` for every file unconditionally (directories materialized as `dir` nodes), and `file ─DEFINES→ symbol` for every extracted symbol.

**And** after sync, every `file`/`function`/`class` node has degree ≥ 1 by construction.

**Prerequisites:** Story 1.1.

**Touch Points:**

- `daemon/scripts/graph-sync.mjs` (containment backbone emission)
- `daemon/scripts/__tests__/graph-sync.backbone.test.mjs` (new)

**Forbidden Areas:** Memgraph schema labels; existing `DEFINES`/`IMPORTS`/`CALLS` emission semantics.

**Technical Notes:** `dir` nodes are cheap and idempotent (`MERGE`). The backbone is what lets the dead-code detector (2.3) use a _different_ query than the orphan invariant (2.2) — they are deliberately not the same query.

### Story 2.2: Orphan invariant tripwire (extractor-bug gate)

As a pipeline operator,
I want a post-sync check that flags any degree-0 node as an extractor bug and blocks the wave gate on non-`file` orphans,
So that silent edge-drops surface immediately instead of rotting (PRD §4.2.3a).

**Acceptance Criteria:**

**Given** a completed sync,
**When** the orphan invariant runs (`MATCH (n) WHERE NOT (n)--() AND status<>'pruned'`),
**Then** results are written to `knowledge/_graph/orphans.json` grouped by kind.

**And** any orphan of kind ∈ {function,class,table,lambda,endpoint,externalService} is a **hard failure** that blocks the wave gate (it means an extractor dropped an edge).

**And** a clean Futurator-Admin sync produces **zero** non-`file` orphans (the PRD acceptance bar).

**Prerequisites:** Stories 1.2, 1.4, 1.5, 2.1.

**Touch Points:**

- `daemon/scripts/graph-sync.mjs` (add `reportOrphans` per PRD Appendix C)
- `daemon/pipelines/` wave-gate gating hook
- `daemon/scripts/__tests__/graph-sync.orphan.test.mjs` (new)

**Forbidden Areas:** none beyond schema.

**Technical Notes:** This is the tripwire, not the dead-code report. A survivor here always means "fix the extractor," never "dead code."

### Story 2.3: Dead-code detector (the distinct query — W2)

As a developer,
I want files whose _only_ edge is `CONTAINS` flagged as dead-code candidates,
So that genuine dead code is surfaced as a finding without the containment backbone hiding it (PRD §4.2.3b, W2).

**Acceptance Criteria:**

**Given** the containment backbone exists (2.1),
**When** the dead-code query runs (a file with no `IMPORTS/CALLS/READS/WRITES/CALLS_SERVICE/CALLS_ENDPOINT/HANDLED_BY/ROUTES` in or out, and no `DEFINES`→called symbol),
**Then** matches are written to `knowledge/_graph/dead-code.json` as a **non-blocking** report (not a wave-gate failure).

**And** the query is demonstrably different from the orphan invariant: a dead file (degree-1 via `CONTAINS`) appears here and **not** in `orphans.json`.

**Prerequisites:** Story 2.1, 2.2.

**Touch Points:**

- `daemon/scripts/graph-sync.mjs` (dead-code query)
- `daemon/scripts/__tests__/graph-sync.deadcode.test.mjs` (new)

**Forbidden Areas:** none.

**Technical Notes:** Exact Cypher in PRD §4.2.3b. Keep it advisory — dead-code is a human decision, never an auto-prune.

### Story 2.4: Graph tab — "Dead code / unreferenced" panel

As an operator browsing the graph,
I want a panel listing dead-code candidates from the latest sync,
So that the "no alone dots" guarantee is visible and actionable in the admin UI.

**Acceptance Criteria:**

**Given** `knowledge/_graph/dead-code.json` from a sync,
**When** I open the development Graph tab,
**Then** a "Dead code / unreferenced" panel lists candidate files with their last-updated timestamp and a link to the node.

**And** the panel shows an empty-state ("no dead code detected") and the orphan-invariant status (pass/fail) for the latest sync.

**Prerequisites:** Story 2.3.

**Touch Points:**

- `src/app/development/graph/page.tsx`
- `src/components/development/graph-viewer.tsx`
- `src/lib/graph-insights.ts`
- `src/components/development/__tests__/` (panel test)

**Forbidden Areas:** existing graph-viewer rendering of the main graph (additive panel only — do not alter the canvas/graph render path).

**Technical Notes:** Read the JSON via the existing graph data path. Reuse shadcn primitives + semantic theme tokens; keep it a side panel, not a modal.

---

## Epic 3: Architectural X-Ray — Centrality & Communities

**Goal:** Give humans an at-a-glance architectural overview by computing god-nodes (centrality), communities (Louvain), and surprising connections in Memgraph via MAGE, and rendering them in the Graph tab. Because the graph now spans infra, communities are _architectural_ ("feature + its table + its lambda + its API"), not syntactic. Borrowed-from-graphify idea (PRD §1.4, §5.4, Appendix D).

### Story 3.1: God-nodes via betweenness centrality (MAGE)

As an architect,
I want betweenness centrality computed and stored per node,
So that the most structurally critical nodes (god-nodes) are queryable.

**Acceptance Criteria:**

**Given** MAGE is available on the Memgraph instance,
**When** the analytics pass runs `CALL betweenness_centrality.get()`,
**Then** each node gets `n.centrality` set, and a top-N god-nodes list is written to `knowledge/_graph/insights.json`.

**And** if MAGE is unavailable, the pass degrades gracefully (logs + skips, never crashes the sync).

**Prerequisites:** Epic 1 complete (graph must span infra for centrality to be meaningful).

**Touch Points:**

- `daemon/scripts/graph-analytics.mjs` (new)
- `daemon/scripts/__tests__/graph-analytics.test.mjs` (new)

**Forbidden Areas:** sync write-path (analytics is a separate, post-sync read+annotate pass).

**Technical Notes:** Run as a distinct step after sync so it never blocks ingest. Confirm MAGE install on the EC2 Memgraph (Risk: PRD §9.6 footprint).

### Story 3.2: Communities via Louvain

As an architect,
I want Louvain community detection stored per node,
So that the graph groups into architectural clusters.

**Acceptance Criteria:**

**Given** the analytics pass,
**When** it runs `CALL community_detection.get()`,
**Then** each node gets `n.community`, and community membership counts are added to `insights.json`.

**Prerequisites:** Story 3.1 (same analytics pass/host).

**Touch Points:**

- `daemon/scripts/graph-analytics.mjs` (extend)
- `daemon/scripts/__tests__/graph-analytics.community.test.mjs` (new)

**Forbidden Areas:** sync write-path.

**Technical Notes:** Store community ids stably enough for the UI to color consistently across runs where possible.

### Story 3.3: Surprising-connections query

As an architect,
I want cross-community edges between high-centrality endpoints surfaced,
So that non-obvious architectural couplings ("surprising connections") are visible.

**Acceptance Criteria:**

**Given** centrality + community are populated,
**When** the surprising-connections query runs (edge where `a.community<>b.community` and both endpoints high-centrality),
**Then** the top 25 are written to `insights.json` with both labels, edge type, and communities.

**Prerequisites:** Stories 3.1, 3.2.

**Touch Points:**

- `daemon/scripts/graph-analytics.mjs` (extend)

**Forbidden Areas:** none.

**Technical Notes:** Exact Cypher in PRD Appendix D. Threshold `$c` configurable.

### Story 3.4: Graph tab — god-nodes, communities & surprising connections

As an operator,
I want the Graph tab to render god-nodes (size), communities (color), and a surprising-connections list,
So that I get the architectural overview before editing.

**Acceptance Criteria:**

**Given** `insights.json`,
**When** I open the development Graph tab,
**Then** nodes are sized by `centrality`, colored by `community`, and a "surprising connections" list is shown with each entry linking to the two nodes.

**And** there's a legend and a toggle to disable the overlay (fall back to the plain graph).

**Prerequisites:** Story 3.3.

**Touch Points:**

- `src/components/development/graph-viewer.tsx`
- `src/lib/graph-insights.ts`
- `src/app/development/graph/page.tsx`

**Forbidden Areas:** the dead-code panel from Story 2.4 (extend the same page, don't replace).

**Technical Notes:** Reuse the existing canvas/render; overlay is additive. Keep color-blind-safe community palette.

---

## Epic 4: Agent Graph Access & Measured Token Savings

**Goal:** Expose the graph to pipeline agents as an MCP tool wrapping `search-cascade`, inject blast-radius as `<ground_truth>` before edits, and emit per-invocation telemetry so token savings + adoption are _measured_, not assumed. This is the token lever and it closes PRD weakness **W3/G8**. (PRD §5.5–5.6, §6, §10.)

### Story 4.1: Mycelium-MCP server scaffold (wraps `search-cascade`)

As a DEV agent,
I want an MCP server exposing the graph,
So that I can query structure as a tool instead of grepping.

**Acceptance Criteria:**

**Given** the daemon/EC2 where Memgraph lives,
**When** the Mycelium-MCP server starts,
**Then** it exposes `query_graph(question, projectId)` (wrapping `search-cascade.mjs`), `get_node`, and `neighbors`, returning structured results.

**And** it is registered so pipeline agents can invoke it as a tool.

**Prerequisites:** Epic 1 complete.

**Touch Points:**

- `daemon/mcp/mycelium-mcp.mjs` (new)
- `daemon/mcp/__tests__/mycelium-mcp.test.mjs` (new)

**Forbidden Areas:** `search-cascade.mjs` internals (wrap, don't fork — borrowed graphify "MCP wrapper pattern" applied to our cascade).

**Technical Notes:** Reuse `createDriver()` from `lib/memgraph-driver.mjs`. Co-locate with Memgraph to avoid network hops.

### Story 4.2: `blast_radius` + graph tools

As a DEV agent,
I want `blast_radius(files[], projectId)` and the supporting tools,
So that I can see everything a change touches across the stack before editing.

**Acceptance Criteria:**

**Given** a set of changed files,
**When** I call `blast_radius`,
**Then** it returns all nodes reachable in ≤2 hops via `READS/USES/CALLS/DEFINES/WRITES/CALLS_SERVICE/CALLS_ENDPOINT/ROUTES/TRIGGERS/SUBSCRIBES/EMITS`, grouped by kind.

**And** the event edges (`TRIGGERS/SUBSCRIBES/EMITS`) are included — a known S3/SNS/cron-triggered chain is **not** missed (no false all-clear, W5).

**And** `god_nodes`, `orphans`, and `shortest_path` tools are exposed.

**Prerequisites:** Story 4.1; Epics 1–3 for the edges/centrality they traverse.

**Touch Points:**

- `daemon/mcp/mycelium-mcp.mjs` (extend)
- `daemon/mcp/__tests__/blast-radius.test.mjs` (new)

**Forbidden Areas:** none.

**Technical Notes:** Cypher in PRD Appendix D. Cold-Memgraph → degrade to `ast-extract` facts + grep (the cascade already does this).

### Story 4.3: Per-invocation telemetry (W3 / G8)

As a pipeline owner,
I want every MCP invocation to emit a telemetry record,
So that adoption and token savings are provable from data, not self-report.

**Acceptance Criteria:**

**Given** any MCP tool call,
**When** it completes,
**Then** a record `{ tool, projectId, storyId, tokensIn, tokensOut, fallbackUsed, ts }` is appended to a durable sink (`knowledge/_graph/mcp-telemetry.jsonl` and/or a DynamoDB table).

**And** an aggregation query can report adoption rate (% of eligible DEV steps that called the MCP) and token delta vs. grep+raw-read baseline.

**Prerequisites:** Story 4.1.

**Touch Points:**

- `daemon/mcp/mycelium-mcp.mjs` (telemetry hook)
- `daemon/scripts/mcp-telemetry-report.mjs` (new — aggregation)
- `daemon/scripts/__tests__/mcp-telemetry.test.mjs` (new)

**Forbidden Areas:** none.

**Technical Notes:** No success metric may cite a borrowed figure; the baseline is established on first measurement (the `test-bench-rubric.md` A/B is the controlled measurement harness, run separately).

### Story 4.4: Blast-radius `<ground_truth>` injection in the DEV loop

As a DEV agent,
I want blast-radius results injected as `<ground_truth>` before I edit a story's touch points,
So that I edit with structural awareness and stop breaking unseen dependents.

**Acceptance Criteria:**

**Given** a story with declared `touchPoints`,
**When** the DEV loop assembles context,
**Then** it calls `blast_radius(touchPoints)` and injects the grouped result as a `<ground_truth>` block (extending the existing AST-facts injection).

**And** on cold Memgraph it falls back to `ast-extract` facts + grep without failing the story.

**Prerequisites:** Stories 4.2, 4.3.

**Touch Points:**

- `daemon/pipelines/compiler-prompt.md` (or the DEV story-context assembly step)
- `daemon/scripts/` context-assembly module that injects AST facts
- `daemon/scripts/__tests__/ground-truth-injection.test.mjs` (new)

**Forbidden Areas:** the Knowledge Compiler's semantic wiki generation (unchanged — we add structural injection alongside it, PRD Non-Goal).

**Technical Notes:** Mirror the existing AST-facts injection path; this is additive context, not a new gate.

---

## Epic 5: Cross-Project Contract Spine

**Goal:** Federate the graph across projects (`--global`) so infra/endpoint/event nodes become a shared contract spine linking Labs / Mobile / Office, add the curated Capability layer for pure-UI parity, and make cross-project drift detectable. Resolves federation identity (PRD §7.1–7.3, §12, W9). **Growth band.**

### Story 5.1: Federated `--global` graph + `CONSUMES_CONTRACT`

As a multi-project maintainer,
I want sibling project subgraphs joined to shared contract nodes,
So that a change to a shared table/endpoint is visibly consumed by each sibling.

**Acceptance Criteria:**

**Given** ≥2 project subgraphs in the federated graph,
**When** `--global` sync runs,
**Then** each `service` (project) subgraph emits `CONSUMES_CONTRACT → table/endpoint/event` for the contract nodes it uses.

**And** the join supports **both** resource-identity (shared ARNs) and schema-shape (table fields / endpoint signatures) strategies, selectable by config.

**Prerequisites:** Epic 1 complete.

**Touch Points:**

- `daemon/scripts/graph-sync.mjs` (`--global` federation mode)
- `daemon/scripts/__tests__/graph-sync.global.test.mjs` (new)

**Forbidden Areas:** per-project sync behavior (federation is additive — single-project sync unchanged).

**Technical Notes:** Uses `table.fields` + `primaryIndex` + `endpoint.method/path` props already captured in Epic 1.

### Story 5.2: Capability node layer + `IMPLEMENTS`

As a multi-project maintainer,
I want a curated Capability layer linking equivalent implementations across substrates,
So that pure-UI parity (no shared backend) is still trackable.

**Acceptance Criteria:**

**Given** a curated, append-only `knowledge/_graph/capabilities.json` seed,
**When** sync ingests it,
**Then** `capability` nodes are created with `IMPLEMENTS` edges from Labs/Mobile/Office components (per PRD Appendix E shape).

**And** capabilities carry their `contract` (endpoints/tables) and are marked `DECLARED` provenance.

**Prerequisites:** Story 5.1.

**Touch Points:**

- `knowledge/_graph/capabilities.json` (new seed)
- `daemon/scripts/graph-sync.mjs` (capability ingest)
- `daemon/scripts/__tests__/graph-sync.capability.test.mjs` (new)

**Forbidden Areas:** none.

**Technical Notes:** Append-only; owned by GARDENER (M4) later. Keep the seed small (~dozens).

### Story 5.3: Capability-coverage-gap detector (W8) + panel

As a maintainer,
I want components that touch a shared contract but have no `IMPLEMENTS→capability` flagged,
So that the manual capability seam is audited, not silently trusted (W8).

**Acceptance Criteria:**

**Given** capability + `CONSUMES_CONTRACT` edges,
**When** the gap query runs,
**Then** components consuming a contract with no `IMPLEMENTS→capability` are written to `knowledge/_graph/capability-gaps.json` and shown in the Graph tab as "capability coverage gaps."

**Prerequisites:** Stories 5.1, 5.2.

**Touch Points:**

- `daemon/scripts/graph-sync.mjs` (gap query)
- `src/components/development/graph-viewer.tsx`, `src/app/development/graph/page.tsx` (panel)

**Forbidden Areas:** existing Graph-tab panels (additive).

**Technical Notes:** This makes W8's silent-failure mode loud.

### Story 5.4: Federation-identity decision + join-strategy config (§12 / W9)

As an architect,
I want the "shared backend vs. separate deployments" question pinned and encoded,
So that `CONSUMES_CONTRACT` uses the correct join (PRD §12).

**Acceptance Criteria:**

**Given** confirmation of how Mobile/Office are deployed,
**When** the federation config is set,
**Then** the join strategy (resource-identity or schema-shape) is recorded in config and exercised by 5.1.

**And** the decision and its rationale are documented in the PRD §12 / an ADR.

**Prerequisites:** Story 5.1.

**Touch Points:**

- federation config file (e.g. `daemon/config/federation.json`, new)
- `docs/concepts/pipeline-v3/system-graph-prd.md` (§12 update / ADR link)

**Forbidden Areas:** none.

**Technical Notes:** Both strategies are already supported; this story makes the choice explicit and testable. The `Twindle` rubric app is built shared-backend to exercise resource-identity first.

---

## Epic 6: PROPAGATOR — Auto-Briefing the Siblings

**Goal:** Turn detected contract drift into substrate-targeted port-briefs (Labs→Mobile/Office), backed by a `:ContractRevision` append-log for drift counting, an autonomous threshold/wave-gate trigger, and **consent-gated** auto-filed sibling stories. The novel capability of v3 (PRD §7.4–7.6, §9.7, W6). **Growth band.**

### Story 6.1: Contract diff at the wave gate (false-positive guard)

As a propagation engine,
I want to isolate changes that touch shared-contract nodes and ignore internal refactors,
So that a Labs-internal rename never triggers a Mobile story (PRD §7.4.1, Risk 4).

**Acceptance Criteria:**

**Given** a post-wave graph diff,
**When** the contract diff runs,
**Then** it keys on contract **shape** (`table.fields`, endpoint signatures, event schemas, `externalService`, capabilities) — not symbol names.

**And** a Labs-internal rename with no contract-shape change produces **zero** contract changes (the negative test).

**Prerequisites:** Epic 5 complete.

**Touch Points:**

- `daemon/scripts/contract-diff.mjs` (new)
- `daemon/scripts/__tests__/contract-diff.test.mjs` (new)

**Forbidden Areas:** none.

**Technical Notes:** Shape-keyed comparison is the entire defense against false positives — test it both ways (real change fires; rename doesn't).

### Story 6.2: `:ContractRevision` append-log + drift-count (W6)

As a propagation engine,
I want each contract-shape change appended as a revision node,
So that drift-count has a real temporal source instead of a stateless snapshot (W6).

**Acceptance Criteria:**

**Given** a contract change detected by 6.1,
**When** the wave gate completes,
**Then** a `:ContractRevision { contractNode, change, atCommit, atWave, ts }` is appended and linked `(:Node)-[:REVISED]->(:ContractRevision)`.

**And** `driftSince[sibling]` is computed as the count of revisions whose `atCommit` is after `lastPropagatedTo[sibling]`.

**Prerequisites:** Story 6.1.

**Touch Points:**

- `daemon/scripts/graph-sync.mjs` (append revisions; drift-count query)
- `daemon/scripts/__tests__/contract-revision.test.mjs` (new)

**Forbidden Areas:** node `status` semantics (revisions are a new node kind, not a status change).

**Technical Notes:** Shape per PRD Appendix E. Doubles as the audit trail for "why did this brief fire?"

### Story 6.3: Per-sibling drift report

As a maintainer,
I want a scoped list of what each sibling lacks for a given contract change,
So that the brief targets only real gaps.

**Acceptance Criteria:**

**Given** a contract change and the `CONSUMES_CONTRACT` edges,
**When** the drift report runs (`MATCH (svc:Service)-[:CONSUMES_CONTRACT]->(c) …`),
**Then** it produces, per sibling, the list of contract changes that sibling has not yet adopted (with `N/A` where the sibling doesn't consume the contract).

**Prerequisites:** Stories 6.1, 6.2.

**Touch Points:**

- `daemon/scripts/propagator.mjs` (new)
- `daemon/scripts/__tests__/propagator.drift.test.mjs` (new)

**Forbidden Areas:** none.

**Technical Notes:** Office's spine is the agent-activity event stream; Mobile's is the table/endpoint contract.

### Story 6.4: PROPAGATOR brief generation (substrate-targeted)

As a maintainer,
I want drift turned into a substrate-specific port-brief,
So that the doc I write by hand today is auto-drafted.

**Acceptance Criteria:**

**Given** a per-sibling drift report,
**When** the PROPAGATOR runs,
**Then** it emits a brief per sibling translated to that substrate (RN hooks/screens for Mobile; Unity/C# prefabs for Office), naming the concrete port target and the RN/Unity equivalent of the Labs component.

**And** the brief includes `requiresApproval: true` and the contract changes that justify it (per PRD Appendix E output shape).

**Prerequisites:** Story 6.3.

**Touch Points:**

- `daemon/pipelines/propagator-prompt.md` (new — Compiler mode/role)
- `daemon/scripts/propagator.mjs` (extend)
- `daemon/scripts/__tests__/propagator.brief.test.mjs` (new)

**Forbidden Areas:** the Knowledge Compiler's existing semantic generation (PROPAGATOR is a new mode, not a rewrite).

**Technical Notes:** Substrate translation is the value — generic diffs aren't briefs.

### Story 6.5: Autonomous trigger + consent-gated auto-file

As a non-technical operator,
I want briefs to fire automatically on drift threshold or wave gate and be approvable from the phone,
So that propagation is hands-off but never auto-applied without consent.

**Acceptance Criteria:**

**Given** drift-count crossing a threshold **or** a wave gate,
**When** the trigger fires,
**Then** the brief becomes a **proposed STORY** in the sibling's pipeline (DynamoDB queue), with a consent gate — nothing is auto-merged.

**And** the sibling's `lastPropagatedTo` marker updates only when its port story reaches Done.

**And** a human can approve/reject the proposed story (phone-friendly), aligning with the "build the UI, don't auto-bypass" + "party autonomy" principles.

**Prerequisites:** Story 6.4.

**Touch Points:**

- `daemon/scripts/propagator.mjs` (trigger + marker update)
- agent-jobs DynamoDB queue (propose story)
- `src/` approval surface for proposed sibling stories (consent gate UI)

**Forbidden Areas:** any auto-merge / auto-apply path (consent gate is mandatory).

**Technical Notes:** Threshold configurable; wave-gate trigger is the default. Marker update on Done is what prevents re-briefing the same change.

---

## Epic 7: Graph-Ready Boilerplate

**Goal:** Bake the four extractors + graph-sync wiring into the boilerplate repos so every new app ships graph-ready from its first commit. Scales the capability to the brownfield candidates (debatator / applicator / songster / futurator). (PRD §8 P10.) **Scale band.**

### Story 7.1: Package extractors as a reusable wave-gate module

As a platform engineer,
I want the infra/route/service/ast extractors + graph-sync wiring packaged as one reusable module,
So that any repo can adopt the system graph with a single integration point.

**Acceptance Criteria:**

**Given** the four extractors,
**When** they are packaged as a versioned module/step,
**Then** a repo can invoke a single wave-gate step that runs all extractors + sync against its own `sst.config.ts` and Hono app.

**Prerequisites:** Epics 1–2 complete.

**Touch Points:**

- `daemon/scripts/lib/system-graph-step.mjs` (new — orchestrates the extractors)
- `daemon/scripts/__tests__/system-graph-step.test.mjs` (new)

**Forbidden Areas:** none.

**Technical Notes:** Keep config-driven (config path, app path, lambda id) so no per-repo code.

### Story 7.2: Boilerplate integration + bootstrap-on-first-build

As a platform engineer,
I want the boilerplate repos wired so a new app builds its graph on first run,
So that every new app is graph-ready without manual setup.

**Acceptance Criteria:**

**Given** a boilerplate repo with the module,
**When** the first build/wave runs,
**Then** a full-repo bootstrap (`--scan`) builds the initial system graph, and subsequent waves run incrementally.

**Prerequisites:** Story 7.1.

**Touch Points:**

- boilerplate repo template (extractor step + bootstrap hook)
- `daemon/scripts/bootstrap-ast.mjs` integration (reuse existing Slice-C scan)

**Forbidden Areas:** existing `--scan` bootstrap semantics.

**Technical Notes:** Reuse the existing brownfield bootstrap; just add infra/route/service to the first scan.

### Story 7.3: New-app onboarding docs

As a new-app author,
I want a short guide for adopting the system graph,
So that onboarding is self-serve.

**Acceptance Criteria:**

**Given** the module + boilerplate,
**When** I follow the onboarding doc,
**Then** I can stand up the graph for a new app and open its Graph tab without help.

**Prerequisites:** Stories 7.1, 7.2.

**Touch Points:**

- `docs/concepts/pipeline-v3/onboarding-system-graph.md` (new)

**Forbidden Areas:** none.

**Technical Notes:** Link from the PRD; keep it task-oriented.

---

## Epic Breakdown Summary & Validation

**30 stories across 7 epics.** All stories carry BDD acceptance criteria, `Prerequisites` (backward-only), `Touch Points`, and `Forbidden Areas`.

### PRD → Story traceability (every Goal, Phase, and fixed weakness is covered)

| PRD item                                         | Covered by        |
| ------------------------------------------------ | ----------------- |
| **G1** infra/service nodes                       | 1.2, 1.3, 1.5     |
| **G2** code↔infra `READS` join                   | 1.6               |
| **G3** no orphans + dead-code                    | 2.1, 2.2, 2.3     |
| **G4** god-nodes/communities/panels in Graph tab | 2.4, 3.1–3.4, 5.3 |
| **G5** Mycelium-MCP                              | 4.1, 4.2          |
| **G6** auto port-briefs                          | 6.3, 6.4          |
| **G7** autonomous trigger                        | 6.5               |
| **G8** self-measurable adoption/savings          | 4.3               |
| **P1 / P1b / P2**                                | Epic 1 (1.1–1.6)  |
| **P3**                                           | Epic 2            |
| **P4**                                           | Epic 3            |
| **P5 / P6**                                      | Epic 4            |
| **P7**                                           | Epic 5            |
| **P8 / P9**                                      | Epic 6            |
| **P10**                                          | Epic 7            |
| **W1** endpoint nodes                            | 1.4, 1.6          |
| **W2** orphan ≠ dead-code                        | 2.2, 2.3          |
| **W3** measured savings                          | 4.3               |
| **W4** accessor-aware READS                      | 1.6               |
| **W5** async/event edges                         | 1.3, 4.2          |
| **W6** ContractRevision log                      | 6.2               |
| **W7** `Resource.*` access                       | 1.6               |
| **W8** capability-gap detector                   | 5.3               |
| **W9** federation identity                       | 5.4               |
| **W10** external-service cost                    | 1.5               |

### Validation checklist

- ✅ **All PRD requirements covered** — traceability matrix above; no orphaned goal/phase/weakness.
- ✅ **Epic 1 establishes foundation** — Story 1.1 is the extractor harness + ingest contract; everything depends on it.
- ✅ **No forward dependencies** — every `Prerequisites` points only at earlier stories/epics.
- ✅ **Vertically sliced** — extractor stories deliver node+edge+test; UI stories deliver a usable panel; PROPAGATOR stories deliver diff→log→report→brief→trigger end to end.
- ✅ **BDD criteria** — Given/When/Then on all 30.
- ✅ **Touch Points on all 30** — wave-resolver can serialize collisions (flagged below).
- ✅ **Constraints respected** — zero-LLM/deterministic, zero-cost (Memgraph stays on existing EC2), DynamoDB multi-table, dual-bucket modeled as `bucketPath`, autonomy consent-gated.

### Wave-collision notes (for the resolver)

- `infra-extract.mjs`: **1.2 → 1.3** (serialized; same file, build on each other).
- `graph-sync.mjs`: **1.6, 2.1, 2.2, 2.3, 5.1, 5.2, 5.3, 6.2** all touch it → serialized across epics (each additive; order follows prereqs).
- `graph-viewer.tsx` / `graph/page.tsx`: **2.4, 3.4, 5.3** → serialized (additive panels; don't replace the canvas).
- `mycelium-mcp.mjs`: **4.1 → 4.2 → 4.3** serialized.
- `propagator.mjs`: **6.3 → 6.4 → 6.5** serialized.

### Recommended delivery order

1. **MVP token lever:** Epic 1 → Epic 2 → Epic 4 (Epic 3 in parallel where capacity allows).
2. **Growth (the v3 differentiator):** Epic 5 → Epic 6.
3. **Scale:** Epic 7.

### Next step

Use the `create-story` workflow to generate individual implementation plans per story, and run the architecture workflow to flesh out the Memgraph/MAGE footprint (PRD Risk §9.6) and the MCP transport choice before Epic 4.
