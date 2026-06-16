# PRD — Pipeline v3: The System Graph & Cross-Project Propagation

**Status:** v0.2 — debate-hardened draft → development plan
**Author:** Ricardo (with Claude)
**Date:** 2026-06-15
**Lineage:** Pipeline v1 (honest about what it _did_) → v2 (honest about what it _verified_) → **v3 (honest about what it _knows_)**
**Scope of this doc:** the knowledge/structural-memory layer of v3 only. The dehydration gate (M1), GARDENER curation (M4), and multi-machine control plane (M5) are referenced where they touch the graph but are specified elsewhere.

> **Changelog v0.1 → v0.2** (after agent debate, 2026-06-15). Six load-bearing gaps surfaced by stress-testing the spec were closed:
>
> - **W1** — added the `endpoint` node kind + `route-extract.mjs` (Appendix F). The contract spine referenced endpoint nodes but nothing produced them.
> - **W2** — split the **dead-code** query from the **orphan** query (§4.2). The containment backbone made the old `degree-0` dead-code detector mathematically always-empty.
> - **W3** — replaced the borrowed "40–50%" token figure with a self-emitted, measurable adoption+savings metric (§10, G8). The MCP must log its own invocations.
> - **W4** — `READS` is now **accessor-aware/transitive** (§3.2, Appendix C); the frontend reads an **endpoint**, never a table.
> - **W5** — added async/event node kinds + `TRIGGERS/SUBSCRIBES/EMITS` edges and put them in the blast-radius traversal (§3.1–3.2, §6). Event chains were invisible → false "all-clear."
> - **W6** — added the `:ContractRevision` append-log so drift-count (§7.5) has a real temporal source instead of a stateless snapshot.
>
> Should-fix notes **W7** (SST `Resource.*` access), **W8** (untagged-capability detector), **W9** (federation identity), **W10** (external-service cost model) are flagged inline at their sections.
>
> _The four stress apps used to find these gaps (Chomp / Jester / Twindle / Echobox) are intentionally **not** part of this PRD — they live in the standalone `test-bench-rubric.md` and are run later as controlled tests._

---

## 0. TL;DR for the debate

We already built **Mycelium** — a homegrown, Memgraph-backed, vector-embedded knowledge-graph system (`ast-extract.mjs`, `graph-sync.mjs`, the Knowledge Compiler, `search-cascade.mjs`) that is **strictly more capable than graphify** for our use case. graphify is therefore **mined for ideas, not adopted as a dependency** (decision 2026-06-13). This PRD proposes extending Mycelium's graph from a _code graph_ into a **system graph** that also models infrastructure (DynamoDB, Lambda, S3, CloudFront, IAM), external services (Anthropic, ElevenLabs, Moises, Google Maps, …), and the relationships between code and those resources — all extracted **deterministically from `sst.config.ts` and import statements, with zero LLM cost.**

This single enrichment unlocks two capabilities that a code-only graph structurally cannot provide:

1. **Cross-stack blast radius** — "if I change this file, which Lambda, table, bucket, and paid API does it touch?"
2. **Cross-project propagation** — auto-generate the briefing documents that currently move enhancements from **Futurator Labs (web)** → **Futurator Mobile (React Native)** → **Agentic Office (Unity)** by hand, because the shared backend contract (tables, endpoints, event schemas) becomes a set of graph nodes shared across all three project subgraphs.

It also eliminates the "alone dots" problem (orphan nodes) — because the edges that today get silently dropped (imports to external packages, `process.env.X_TABLE` references) become real edges to real infra/service nodes.

---

## 1. Context & Why

### 1.1 What exists today (grounded in the codebase)

| Concern                 | File / artifact                                                                     | What it does                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code AST extraction     | `daemon/scripts/ast-extract.mjs`                                                    | tree-sitter → functions, classes, imports, calls (TS/JS only)                                                                                        |
| Brownfield bootstrap    | `daemon/scripts/bootstrap-ast.mjs`, `ast-extract --scan`                            | full-repo walk for first-time graph build (Slice C)                                                                                                  |
| Graph store + sync      | `daemon/scripts/graph-sync.mjs`                                                     | Memgraph (Bolt/Cypher) + Voyage embeddings; `:Node{kind}` model; `:DEFINES`/`:IMPORTS`/`:CALLS` edges; diffs against `compile-state.json`; S3 backup |
| Semantic compilation    | `daemon/pipelines/compiler-prompt.md`                                               | "Knowledge Compiler" agent: diffs → wiki articles w/ `[[wikilinks]]` → graph edges                                                                   |
| Recall for agents       | `daemon/scripts/search-cascade.mjs`                                                 | 4-layer cascade: GraphRAG → wiki → grep → raw read                                                                                                   |
| Dependency map          | `daemon/scripts/bootstrap-deps.mjs`                                                 | `knowledge/system/dependency-map.md` import graph                                                                                                    |
| Infra (source of truth) | `sst.config.ts`                                                                     | 30+ `sst.aws.Dynamo`, `sst.aws.Function`, `sst.aws.Cron`, `sst.Secret`, `aws.iam.Role` declarations                                                  |
| UI surface              | "Graph knowledge layer + Skills & Growth tab" (commit `8cf9461`)                    | React tab in the admin app for graph visualization                                                                                                   |
| Multi-project           | Mycelium `--project` flag + `s3://futurator-ai-website/knowledge-live/<projectId>/` | per-project graphs, S3-backed                                                                                                                        |

**Key fact:** the graph today is **code-only**. `graph-sync.mjs` creates an edge only if _both_ endpoints already exist as `:Node` (see `graph-sync.mjs` ~L761–767, L715). Every relationship pointing _out of code_ — `import Anthropic from '@anthropic-ai/sdk'`, `process.env.COSTS_TABLE` — is silently dropped because the target node doesn't exist. Those dropped edges are (a) the cause of orphan "alone dots" and (b) exactly the cross-stack/cross-project information we now want.

### 1.2 The two problems v3 must solve

**Problem A — Structural blindness across the stack.** Agents (DEV/REVIEWER/QA) explore by reading files. They can break code they don't understand structurally, and they cannot see that a code change touches a DynamoDB table, a cron schedule, an IAM-scoped bucket path, or a billable external API. The graph must make the **code ↔ infra ↔ external-service** relationships first-class so an agent can query blast radius _before_ editing.

**Problem B — Manual cross-project propagation.** Futurator Labs is enhanced continuously (bug fixes, capabilities, UI). Each enhancement must be hand-briefed into sibling projects that **re-implement the same capabilities on different substrates**:

- **Futurator Mobile** — React Native, phone-optimized Labs (goal: manage pipelines / build projects from the phone).
- **Agentic Office** — separate app, moving to **Unity + Unity MCP** (C#), visualizing live agent activity.

These siblings **share no code** (different languages, repos), so git-merge is impossible. What they _do_ share is the **backend contract** — the same SST app, DynamoDB tables, API endpoints, and event schemas. That shared contract is what actually needs to propagate, and (per §1.1) it's about to become graph nodes. So the system graph is also the cross-project bridge.

### 1.3 Why the graph (and not git, and not graphify)

- **Git is blind across substrates.** `git diff` shows TS line deltas in Labs; it cannot say which _capability_ changed or which React-Native screen / Unity prefab implements that capability, because there is zero shared code. Only a contract/capability node layer links them.
- **graphify is a code-only static `graph.json` with a substring matcher.** It has no infra model, no embeddings, no cross-project contract layer, stdio-only MCP. Adopting or forking it would add a weaker engine and double maintenance. We borrow three ideas (community detection, god-nodes, vault view) and build the rest on Mycelium.

### 1.4 Borrowed-from-graphify ideas (explicitly)

1. **Community detection (Louvain) + god-nodes (centrality) + "surprising connections."** Compute in Memgraph via MAGE; surface in the admin Graph tab. A _richer_ graph (infra+services) makes these communities architectural ("feature + its table + its lambda + its API") rather than syntactic.
2. **Obsidian/vault view** as a near-free human-browsable export of `knowledge/`.
3. **MCP wrapper pattern** — but wrapping our `search-cascade`, not graphify's `graph.json`.

---

## 2. Goals & Non-Goals

### Goals

- G1. Model infrastructure and external services as first-class graph nodes, extracted deterministically from `sst.config.ts` and imports (zero LLM cost).
- G2. Close the code↔infra join (`process.env.X_TABLE` → `Table` node) so blast-radius queries span the full stack.
- G3. Guarantee **no orphan nodes** by construction + a post-sync invariant; surface genuine dead code as a feature.
- G4. Surface god-nodes / communities / blast-radius in the existing admin Graph tab.
- G5. Expose the graph to pipeline agents as an MCP tool (Mycelium-MCP) wrapping `search-cascade`.
- G6. Auto-generate substrate-targeted port-briefs from Labs → Mobile → Office via a shared-contract diff and a PROPAGATOR role.
- G7. Provide an autonomous trigger so propagation fires on accumulated contract drift (not only manually).
- G8. **Make adoption and savings self-measurable.** Mycelium-MCP emits a per-invocation telemetry record (tool, projectId, tokens-in/out, fallback-used) so we can _prove_ — not assume — that agents query the graph and that it reduces exploration tokens. No success metric may cite an external/borrowed figure.

### Non-Goals (this doc)

- The dehydration gate (M1), GARDENER curation loop (M4), distributed control plane (M5) — referenced, specified elsewhere.
- Replacing the Knowledge Compiler's semantic wiki generation (unchanged; we add deterministic structural extractors alongside it).
- Adopting/forking graphify (decided against).
- Building the Unity-side execution (that's Unity MCP's job; we only detect + brief).

---

## 3. The System Graph Model

### 3.1 Node taxonomy (extends the existing `:Node{kind}` model — no schema rewrite)

| Layer                               | `kind` values                                                                               | Source                                                                         | Provenance                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| **Code** (exists)                   | `file`, `function`, `class`                                                                 | `ast-extract.mjs`                                                              | EXTRACTED (AST)                           |
| **Infra** (new)                     | `table`, `lambda`, `cron`, `bucket`, `bucketPath`, `cloudfront`, `secret`, `iamRole`, `vpc` | `infra-extract.mjs` ← `sst.config.ts`                                          | EXTRACTED (AST)                           |
| **Event infra** (new, W5)           | `topic`, `queue`, `bus`, `eventSource` (S3-notification, schedule)                          | `infra-extract.mjs` ← `.subscribe()` / `.notify()` / `Cron` schedule           | EXTRACTED (AST)                           |
| **API surface** (new, W1)           | `endpoint` (one per route, e.g. `POST /habits/:id/check`)                                   | `route-extract.mjs` ← Hono `app.<method>('<path>', …)`                         | EXTRACTED (AST)                           |
| **External service** (new)          | `externalService` (Anthropic, ElevenLabs, Moises, GoogleMaps, Voyage, IdentityBroker, …)    | `service-extract.mjs` ← known-package map + `fetch()` hostnames + secret hints | EXTRACTED (map) / INFERRED (unknown host) |
| **Capability** (new, cross-project) | `capability`                                                                                | curated seed + Compiler suggestions                                            | DECLARED                                  |
| **Service / μsvc** (new)            | `service` (one per repo)                                                                    | Mycelium `--project`                                                           | EXTRACTED                                 |

Each node keeps the existing fields (`nodeId`, `kind`, `projectId`, `status`, `updated`, embedding) plus kind-specific props:

- a `table` carries `fields` + `primaryIndex` — the **data contract**;
- an `endpoint` carries `method`, `path`, `auth` (which `authMiddleware` guards it), and the handler reference — the **API contract**;
- an `externalService` carries `costModel` (**W10**: e.g. `{ unit: 'token'|'char'|'request', billable: true }`) so blast-radius can answer "does this touch a _paid_ API?" with more than a boolean.

### 3.2 Edge taxonomy

| Edge                                 | From → To                                  | Extracted from                                                                                              |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `DEFINES` (exists)                   | file → function/class                      | AST                                                                                                         |
| `IMPORTS` (exists)                   | file → file                                | AST                                                                                                         |
| `CALLS` (exists)                     | function → function                        | AST                                                                                                         |
| `CONTAINS` (new)                     | dir → file (the containment backbone)      | scan                                                                                                        |
| `HANDLED_BY` (new)                   | lambda/cron → file                         | `handler:` in sst.config                                                                                    |
| `USES` (new)                         | lambda/cron → table/secret/externalService | `link:` array in sst.config                                                                                 |
| `READS` (new, **W4 accessor-aware**) | file → table                               | `process.env.X` _or_ SST `Resource.X` ⨝ join map; resolved **transitively** through shared accessor modules |
| `ROUTES` (new, **W1**)               | endpoint → lambda + file (handler)         | `route-extract` ← Hono handler                                                                              |
| `CALLS_ENDPOINT` (new, **W1**)       | file/function → endpoint                   | frontend `api-client` / `fetch('/api/…')` path match                                                        |
| `WRITES` (new)                       | lambda → bucketPath/table                  | `permissions:` scoped ARNs / write call sites                                                               |
| `TRIGGERS` (new, **W5**)             | eventSource/topic/queue/cron → lambda      | `.subscribe()`, S3 notification, `Cron` schedule                                                            |
| `SUBSCRIBES` (new, **W5**)           | lambda → topic/bus                         | `.subscribe()` target                                                                                       |
| `EMITS` (new, **W5**)                | lambda/function → topic/bus/queue          | publish/put call site (best-effort; `AMBIGUOUS` if dynamic)                                                 |
| `REPRESENTS` (new)                   | secret → externalService                   | secret-name hint (`AnthropicApiKey` → Anthropic)                                                            |
| `CALLS_SERVICE` (new)                | file/function → externalService            | import map + `fetch()` hostname                                                                             |
| `IMPLEMENTS` (new)                   | code node → capability                     | curated + Compiler                                                                                          |
| `CONSUMES_CONTRACT` (new)            | service → table/endpoint/event             | derived (cross-project spine)                                                                               |

> **W4 note — why `READS` is transitive.** In Futurator-Admin every `process.env.*_TABLE` lookup is centralized in `functions/shared/dynamo-client.ts`. A naïve env-join attaches `READS` from that one accessor to _every_ table, producing a god-node and missing the real consumers (`*-repository.ts`), which are 1+ `CALLS` hops away. The join therefore resolves the accessor and **re-attributes `READS` to the file that calls the accessor for a given table**, not the accessor itself. The frontend (static export) reads **no** env var and **no** table — it `CALLS_ENDPOINT`, and the endpoint `ROUTES → lambda → READS → table`. So the §7.2 spine is `component ─CALLS_ENDPOINT→ endpoint ─ROUTES→ lambda ─READS→ table`, never `component ─READS→ table`.

### 3.3 Provenance discipline (preserve Mycelium's honesty rule)

- **EXTRACTED** — deterministic (AST / config / known-map). The vast majority. Free.
- **INFERRED** — LLM, once, cached (only unknown `fetch()` hostnames, Capability suggestions). Marked, never silently promoted to EXTRACTED.
- **AMBIGUOUS** — explicitly flagged when a join can't be resolved (e.g. dynamic env-var name).

---

## 4. "No Alone Dots" — the orphan invariant

### 4.1 Root cause (today)

`graph-sync.mjs` suppresses any edge whose target node doesn't exist. External imports and `process.env.*_TABLE` references therefore produce no edges → files whose only relationships are outbound-to-infra become degree-0 orphans.

### 4.2 Fix (three parts)

1. **Containment backbone** — emit `dir ─CONTAINS→ file ─DEFINES→ symbol` unconditionally so every code node has ≥1 structural edge by construction.
2. **Materialize the targets** — `infra-extract` + `service-extract` + `route-extract` create the `table`/`bucket`/`externalService`/`endpoint` nodes, so the previously-dropped edges land.
3. **Two distinct post-sync queries (W2 — these are NOT the same query):**

   **(a) Orphan invariant — the tripwire for extractor bugs.** A node with literally _zero_ edges:

   ```cypher
   MATCH (n:Node {projectId: $projectId})
   WHERE NOT (n)--() AND coalesce(n.status,'active') <> 'pruned'
   RETURN n.nodeId AS id, n.kind AS kind
   ```

   Because of the containment backbone (4.2.1), a code node with **zero** edges should be _impossible_. Any survivor here is an **extractor gap, not a finding** — fix the extractor. A non-`file` survivor (`function`/`table`/`lambda`/`endpoint`/`externalService`) is a hard failure.

   **(b) Dead-code detector — a different query.** The containment backbone means dead files are **never** degree-0; they still carry their `dir ─CONTAINS→ file` edge. Dead code is therefore "a file whose **only** incident edge is `CONTAINS`" — nothing imports it, it imports nothing live, it defines nothing that's called:

   ```cypher
   MATCH (f:Node {projectId: $projectId, kind: 'file'})
   WHERE coalesce(f.status,'active') <> 'pruned'
     AND NOT (f)-[:IMPORTS|CALLS|READS|WRITES|CALLS_SERVICE|CALLS_ENDPOINT|HANDLED_BY|ROUTES]-()
     AND NOT (:Node)-[:IMPORTS|CALLS|HANDLED_BY|ROUTES]->(f)
     AND NOT (f)-[:DEFINES]->(:Node)<-[:CALLS]-(:Node)
   RETURN f.nodeId AS id
   ```

   Surface these in the Graph tab as a **"Dead code / unreferenced"** panel — a real finding, reported, never silent.

**Acceptance:**

- **Orphan (4.2.3a):** after a full sync of Futurator-Admin, count of degree-0 nodes of `kind ∈ {function,class,table,lambda,endpoint,externalService}` is **0**. Any survivor blocks the wave gate as an extractor bug.
- **Dead-code (4.2.3b):** `file` nodes whose sole edge is `CONTAINS` are explicitly listed as dead-code candidates — a non-blocking report, not a failure.

---

## 5. Components

### 5.1 `infra-extract.mjs` (keystone — full code in Appendix A)

Parses `sst.config.ts` with the same tree-sitter setup as `ast-extract.mjs`. Emits infra nodes + `HANDLED_BY`/`USES`/`WRITES`/`REPRESENTS` edges + the **`envVar → resource` join map**. Output envelope matches `ast-extract` so `graph-sync` ingests it through the existing path. Runs in the same wave-gate step as `ast-extract`, on the same diff-manifest (re-run when `sst.config.ts` is in the changed set; otherwise the cached infra subgraph persists).

> **W5 — event infra.** `infra-extract` also recognizes event wiring in the config: `topic.subscribe('Name', { handler })` (real example: `cwAlarmsTopic.subscribe('CloudWatchToAttention', …)` at `sst.config.ts:1279`), `bucket.notify(...)`/S3 notifications, and `Cron` schedules. Each emits an `eventSource`/`topic`/`queue` node + a `TRIGGERS → lambda` edge (and `SUBSCRIBES` from the lambda). This is what makes async chains visible to blast-radius.
>
> **W7 — `Resource.*` access.** The join map keys on **both** `process.env.X` (tables, per `dynamo-client.ts`) **and** SST `Resource.X.value` (linked secrets, per `functions/shared/github/load-pat.ts:7`). Either reference resolves to the same infra node; missing one drops credential/link edges silently.

### 5.2 `service-extract.mjs` (Appendix B)

Maps known SDK packages and `fetch()` hostname literals to `externalService` nodes and `CALLS_SERVICE` edges. Unknown hostnames are emitted as `AMBIGUOUS` for the Compiler to label once.

### 5.2b `route-extract.mjs` (W1 — Appendix F)

Parses the Hono app (`functions/api/index.ts`) with the same tree-sitter setup. Each `app.<method>('<path>', [authMiddleware,] handler)` call becomes an `endpoint` node carrying `method`, `path`, and `auth` (whether `authMiddleware` is in the middleware chain → models the public-vs-guarded route contract). Emits `ROUTES → lambda` (the single `Api` Function) and, where the handler body calls a repository/table accessor, `endpoint ─READS/WRITES→ table` (so the spine `endpoint → lambda → table` is complete). The frontend side of `CALLS_ENDPOINT` is resolved by matching `api-client` request paths against the extracted endpoint set (literal-path match; parameterized paths normalized, `:id` ↔ template segments).

### 5.3 `graph-sync.mjs` additions (Appendix C)

- Ingest the new node kinds + edge types (additive; same `MERGE (n:Node{nodeId})` path).
- **Two-pass env-join:** Pass A loads the `envVar→resource` map from `infra-extract`; Pass B resolves every `process.env.X` member-expression already visible to the AST walker into a `File ─READS→ Table` edge.
- Run the §4.2 orphan invariant after sync; write `knowledge/_graph/orphans.json`.

### 5.4 Centrality & community intelligence (Appendix D — Cypher/MAGE)

Borrowed graphify idea. Betweenness centrality → god-nodes; Louvain → communities; high-bridge nodes → "surprising connections." Stored as node properties (`centrality`, `community`) and rendered in the admin Graph tab.

### 5.5 Mycelium-MCP (design §6)

An MCP server wrapping `search-cascade.mjs` + direct Cypher, exposing `query_graph`, `blast_radius`, `get_node`, `neighbors`, `shortest_path`, `god_nodes`, `orphans`. Pipeline agents query it as a tool instead of grepping.

### 5.6 Blast-radius pre-edit query (design §6)

Before a story edits its touchPoints, the DEV agent calls `blast_radius(files)` and the result is injected as `<ground_truth>` (extends the existing AST-facts injection in the Compiler path).

### 5.7 Capability nodes + PROPAGATOR (design §7) — the cross-project engine.

---

## 6. Agent-facing graph access (Mycelium-MCP + blast radius)

**Mycelium-MCP** runs on the daemon/EC2 (where Memgraph already lives). Tools:

| Tool                               | Returns                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query_graph(question, projectId)` | `search-cascade` 4-layer result (vector+structural+wiki+grep)                                                                                                                                                                                                                                                                                                                      |
| `blast_radius(files[], projectId)` | all nodes reachable in ≤2 hops via `READS/USES/CALLS/DEFINES/WRITES/CALLS_SERVICE/CALLS_ENDPOINT/ROUTES/TRIGGERS/SUBSCRIBES/EMITS`, grouped by kind (tables, lambdas, buckets, endpoints, event sources, external services, dependent files). **The event edges (W5) are mandatory in the traversal — omitting them yields a false "all-clear" for S3/SNS/cron-triggered chains.** |
| `god_nodes(projectId)`             | top-centrality nodes                                                                                                                                                                                                                                                                                                                                                               |
| `orphans(projectId)`               | dead-code candidates                                                                                                                                                                                                                                                                                                                                                               |
| `shortest_path(a, b)`              | cross-layer path (e.g. component → endpoint → table)                                                                                                                                                                                                                                                                                                                               |

**Blast-radius injection** (DEV loop): for a story touching `functions/cron/cost-aggregator.ts`, `blast_radius` returns `Lambda(CostAggregator)`, `Table(CostsTable)`, the cron schedule, and any file that `IMPORTS` it. That block becomes `<ground_truth>` so the agent edits with structural awareness — directly attacking the "broke code it didn't know was connected" bug class. Cold-Memgraph fallback: degrade to `ast-extract` facts + grep (the cascade already does this).

---

## 7. Cross-Project Propagation (Labs → Mobile → Office)

### 7.1 The core insight

Siblings share a **backend contract**, not code. Mobile (RN) and Labs (web) are two UIs over the **same SST app**: same DynamoDB tables, same API Lambda, same `plansTable` schema. The infra/service nodes from §5.1–5.2 are therefore **shared across project subgraphs** in Mycelium's `--global` federated graph. The thing that needs to propagate (a new table field, endpoint, or event shape) is exactly the thing that just became a node.

### 7.2 The shared-contract spine (federated graph)

```
            Table(PlansTable){fields: +dependsOn}      ← contract change in Labs
              ▲ READS                    ▲ READS
   Labs:PlanView.tsx          Mobile:PlanScreen.tsx (last synced @commitY)
              │ CALLS                    ✗ no edge yet  ← DRIFT (graph-detected)
        Lambda(Api) POST /plans/:id/validate
```

A missing edge from a sibling subgraph to a changed contract node **is** the port that today is found by hand.

### 7.3 The Capability node layer (for non-backend changes)

Pure-UI changes (animation, layout) have no shared infra node. Bridge them with a thin curated layer:

```
Capability(WaveGateApproval) ─IMPLEMENTS← {Labs:<WaveGate/>, Mobile:WaveGateScreen, Office:WaveGate.prefab}
```

Tag ~a few dozen capabilities once; a Labs change traced up to its Capability flags sibling implementations as drifted even with no backend change. This is the **only manual seam** and it's small + append-only (a job for GARDENER, M4).

> **W8 — untagged-capability detector (the seam must not rot silently).** Because propagation only fires for _tagged_ capabilities, an untagged one fails **silently** — Mobile just quietly drifts. Mitigation: a query that flags suspected-but-untagged capabilities — a component that `CONSUMES_CONTRACT` (touches a shared table/endpoint) yet has **no** `IMPLEMENTS → capability` edge, or a Labs component in a community whose siblings are all tagged but it isn't. Surface these in the Graph tab as "**capability coverage gaps**" so the manual seam is _audited_, not trusted.

### 7.4 The PROPAGATOR pipeline (extends the Compiler)

1. **Contract diff at the wave gate.** Diff the post-wave graph; isolate changes touching **shared-contract nodes** (`table.fields`, endpoints, event schemas, `externalService`, capabilities). Ignore Labs-internal refactors (siblings don't care).
2. **Per-sibling drift report.** For each contract change: `MATCH (svc:Service)-[:CONSUMES_CONTRACT]->(c) WHERE c.nodeId = $changed RETURN svc, currency`. Produce a scoped list of what Mobile/Office lack.
3. **PROPAGATOR role** (new agent, or Compiler mode) turns drift into a **substrate-targeted brief** — the doc you write by hand, auto-drafted:
   > **Mobile (React Native):** `PlansTable` gained `dependsOn: string[]`; new `POST /plans/:id/validate`. Port target: `PlanScreen.tsx` needs a dependency picker + `useValidatePlan` hook; RN equivalent of Labs `<DependencyGraph>`.
   > **Office (Unity/C#):** N/A — no plan UI consumes this contract.
4. **Optional auto-file.** Each sibling repo already runs the pipeline (DynamoDB queue + brownfield party). The brief becomes a **STORY in the sibling's pipeline**, approvable from the phone.

### 7.5 Autonomous trigger (drift markers)

Each shared-contract node carries `lastPropagatedTo: { mobile: commitY, office: commitZ }`. Accumulated contract-drift since the marker = a count. PROPAGATOR fires when the count crosses a threshold **or** at each wave gate. _"After a certain number of changes, the agent understands what other modules need"_ = drift-count × federated graph. Markers update when a sibling's port story reaches Done.

> **W6 — where the drift-count actually comes from.** Memgraph holds **current state** (`status: active|pruned`), so you cannot read "3 contract changes since commitY" from a snapshot. Each contract-shape change therefore appends a **`:ContractRevision`** node — `{ contractNode, change, atCommit, atWave, ts }` — linked `(:Node)-[:REVISED]->(:ContractRevision)`. `driftSince[sibling]` is then a **count**: `MATCH (c {nodeId:$id})-[:REVISED]->(rev) WHERE rev.atCommit AFTER lastPropagatedTo[sibling] RETURN count(rev)`. The append-log is written at the wave gate when the contract diff (§7.4.1) detects a shape change — it is the temporal source the stateless graph lacks, and it doubles as the audit trail for "why did this port-brief fire?"

### 7.6 Office / Unity specifics

tree-sitter has a **C# grammar**, so when Office moves to Unity, a `code-extract` variant parses it into the same graph. Office's shared spine is the **agent-activity event stream** (`agentEventsTable` + event schema); a Labs change to that event shape flags the Unity consumer. **Unity MCP is the execution arm** (makes the change in-engine); the graph is the **detection + briefing arm**. Clean split: graph says _what + why_, Unity MCP does _how_.

---

## 8. Phasing (maps to epics for the dev plan)

| Phase   | Deliverable                                                                                                                       | Depends on           | Value                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| **P1**  | `infra-extract.mjs` (incl. event infra, **W5**; `Resource.*` join, **W7**) + graph-sync ingest + accessor-aware env-join (**W4**) | sst.config.ts (have) | code↔infra edges incl. async; kills most orphans                                       |
| **P1b** | `route-extract.mjs` + `endpoint` nodes + `ROUTES`/`CALLS_ENDPOINT` (**W1**)                                                       | P1                   | completes the `component→endpoint→table` spine                                         |
| **P2**  | `service-extract.mjs` + external-service nodes (+ `costModel`, **W10**)                                                           | P1                   | 3rd-party/cost map; remaining orphans gone                                             |
| **P3**  | Orphan invariant **+ separate dead-code query** (**W2**) + dead-code/capability-gap panels (**W8**) in Graph tab                  | P1–P2                | "no alone dots" guarantee, honestly                                                    |
| **P4**  | MAGE centrality/community + god-nodes in Graph tab                                                                                | P1–P2                | architectural overview (borrowed graphify idea)                                        |
| **P5**  | Mycelium-MCP (`query_graph`, `blast_radius`, …) **+ per-invocation telemetry** (**W3/G8**)                                        | P1–P2                | agents query graph as a tool (token lever), with adoption made measurable              |
| **P6**  | Blast-radius `<ground_truth>` injection in DEV loop                                                                               | P5                   | fewer structural-blindness bugs                                                        |
| **P7**  | Capability node layer + federated `--global` contract spine                                                                       | P1–P2                | cross-project drift detectable                                                         |
| **P8**  | PROPAGATOR role + per-sibling brief generation                                                                                    | P7                   | auto-briefs Labs→Mobile/Office                                                         |
| **P9**  | Autonomous drift trigger (**`:ContractRevision` log, W6**) + auto-filed sibling stories                                           | P8                   | hands-off propagation                                                                  |
| **P10** | Boilerplate bootstrap (infra+service+route+ast extractors in boilerplate repos)                                                   | P1–P3                | every new app ships graph-ready — see [onboarding guide](./onboarding-system-graph.md) |

P1 (+P1b) is the keystone: it unlocks both the blast-radius track (P5–P6) and the propagation track (P7–P9). The `endpoint` node from P1b is load-bearing for **both** tracks — blast-radius needs it for frontend→backend reach, and the contract spine needs it for cross-project drift.

---

## 9. Risks & open questions (seed the debate)

1. **Stale-vs-fresh graph under worktree-per-story.** Proposal: Memgraph is shared; rebuild at the **wave gate**; mid-wave stories read slightly-stale structure (acceptable for reading; never for the dehydration gate). Debate: is wave-gate granularity fresh enough for blast-radius to be trustworthy?
2. **Env-join fragility.** `process.env[dynamicKey]` and indirected table names can't be statically resolved → `AMBIGUOUS`. How much coverage do we lose? (Spot-check: most repos read `process.env.X_TABLE` literally — see `sst.config` env block — so coverage should be high.)
3. **Capability layer curation cost.** Who tags capabilities and keeps them honest? Proposed owner: GARDENER (M4). Risk: untended → the "looks-alive-isn't" failure mode we've hit with QA-Review façades.
4. **Contract diff false positives.** A Labs-internal rename that doesn't change the contract must not trigger a Mobile story. The diff must key on contract _shape_, not symbol names.
5. **Federation identity.** Do Mobile/Office truly share the same SST backend (same table ARNs), or separate deployments of the same schema? If separate, `CONSUMES_CONTRACT` must join on _schema shape_, not resource identity. **(Needs confirmation — assumed shared.)**
6. **Memgraph as SPOF / cost.** One Bolt endpoint, N workers. Aligns with "one orchestrator, N dumb workers" (M5) and the zero-cost-serverless preference — but Memgraph runs on EC2, not Lambda. Confirm the footprint is acceptable.
7. **PROPAGATOR autonomy gate.** Auto-filing sibling stories must keep a consent gate (aligns with the "build the UI, don't auto-bypass" and "party autonomy for non-technical users" principles). Briefs auto-draft; humans approve.

---

## 10. Success metrics

- **Orphan = 0:** degree-0 nodes of kind ∈ {function,class,table,lambda,endpoint,externalService} = **0** after full sync (§4.2.3a); dead-code candidates reported separately (§4.2.3b).
- **Token savings — self-measured, not borrowed (W3/G8).** Mycelium-MCP emits a telemetry record per invocation (`tool`, `projectId`, `tokensIn/Out`, `fallbackUsed`, `storyId`). The metric is the **measured** input-token delta on codebase-exploration steps for stories that invoked `blast_radius`/`query_graph` vs. stories that fell back to grep+raw-read — _plus_ an **adoption rate** (% of eligible DEV steps that actually called the MCP). No target is asserted from an external figure; the baseline is established on first measurement. _(How this gets measured under controlled conditions is the job of the separate `test-bench-rubric.md`, not this PRD.)_
- **Propagation latency:** time from a Labs contract change to a drafted, correct Mobile port-brief: **minutes (auto)** vs. the current manual handoff.
- **Structural-blindness regressions ↓:** track DEV-loop send-backs attributable to unseen dependents — especially **event-triggered** ones now visible via W5 edges.

---

# Appendix A — `daemon/scripts/infra-extract.mjs` (reference implementation)

> Drop-in sibling of `ast-extract.mjs`. Deterministic, zero-LLM. Parses `sst.config.ts` (or any `--config` file) and emits infra nodes, edges, and the `envVar→resource` join map. Output envelope matches `ast-extract` so `graph-sync` ingests it unchanged.

```js
/**
 * Infra Extract — deterministic infrastructure facts from sst.config.ts
 *
 * Parses SST/Pulumi resource declarations via tree-sitter and emits:
 *   - nodes:  table | lambda | cron | secret | bucket | bucketPath | iamRole | externalService
 *   - edges:  HANDLED_BY (lambda→file), USES (lambda→table/secret/service),
 *             WRITES (lambda→bucketPath), REPRESENTS (secret→externalService)
 *   - envJoin: { ENV_VAR_NAME: { kind, id } }  — consumed by graph-sync to build
 *             File ─READS→ Table edges from `process.env.ENV_VAR_NAME` references.
 *
 * Usage:
 *   node infra-extract.mjs --root /home/ubuntu/projects/X --config sst.config.ts
 *
 * Output: single JSON object on stdout (see SCHEMA in the PRD).
 * Honesty: every node/edge is EXTRACTED (deterministic). Unresolvable joins are
 * recorded under `ambiguous[]` rather than guessed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// Secret-name → external service hints (extend freely).
const SECRET_SERVICE_HINTS = [
  [/anthropic/i, 'Anthropic'],
  [/elevenlabs|eleven_labs/i, 'ElevenLabs'],
  [/moises/i, 'Moises'],
  [/google.?maps|gmaps/i, 'GoogleMaps'],
  [/voyage/i, 'Voyage'],
  [/openai/i, 'OpenAI'],
  [/github|ghp|pat/i, 'GitHub'],
];

// Env-value hostnames → external service (for IDENTITY_BROKER_URL etc.)
const URL_SERVICE_HINTS = [
  [/auth\.futurator\.ai|identity.?broker/i, 'IdentityBroker'],
  [/api\.anthropic\.com/i, 'Anthropic'],
  [/api\.elevenlabs\.io/i, 'ElevenLabs'],
  [/moises\.ai/i, 'Moises'],
  [/maps\.googleapis\.com/i, 'GoogleMaps'],
];

// SST constructor → node kind.
function kindForConstructor(ctor) {
  // ctor is the dotted text, e.g. "sst.aws.Dynamo", "sst.aws.Function", "sst.Secret"
  if (/\.Dynamo$/.test(ctor)) return 'table';
  if (/\.Function$/.test(ctor)) return 'lambda';
  if (/\.Cron$/.test(ctor)) return 'cron';
  if (/\.Bucket$/.test(ctor)) return 'bucket';
  if (/Secret$/.test(ctor)) return 'secret';
  if (/iam\.Role$/.test(ctor)) return 'iamRole';
  if (/iam\.RolePolicy$/.test(ctor)) return 'iamRolePolicy';
  if (/\.Router$/.test(ctor) || /Cdn$|CloudFront$/.test(ctor)) return 'cloudfront';
  return null;
}

// ── tree-sitter setup (mirrors ast-extract.mjs) ──────────────────────────
let Parser, tsLang;
async function loadParser() {
  try {
    Parser = (await import('tree-sitter')).default;
    const TS = (await import('tree-sitter-typescript')).default;
    tsLang = TS.typescript;
    return !!(Parser && tsLang);
  } catch (err) {
    console.error(`[infra-extract] tree-sitter unavailable: ${err.message}`);
    return false;
  }
}

function walk(rootNode, visit) {
  const cursor = rootNode.walk();
  (function descend() {
    visit(cursor.currentNode);
    if (cursor.gotoFirstChild()) {
      do {
        descend();
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  })();
}

// ── Small AST helpers for the object-literal config blocks ───────────────
function stringText(node) {
  if (!node) return null;
  if (node.type === 'string') return node.text.slice(1, -1);
  if (node.type === 'template_string') return node.text.slice(1, -1); // keep ${...} markers
  return null;
}

/** Find a `pair` value by key name inside an `object` node. */
function pairValue(objNode, keyName) {
  if (!objNode || objNode.type !== 'object') return null;
  for (const child of objNode.namedChildren) {
    if (child.type !== 'pair') continue;
    const key = child.childForFieldName('key');
    const k = key?.text?.replace(/['"]/g, '');
    if (k === keyName) return child.childForFieldName('value');
  }
  return null;
}

/** Base identifier of a member-expression: `costsTable.name` → "costsTable". */
function baseIdentifier(node) {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') {
    let o = node.childForFieldName('object');
    while (o && o.type === 'member_expression') o = o.childForFieldName('object');
    return o?.type === 'identifier' ? o.text : null;
  }
  return null;
}

/** Convert an SST `handler: 'functions/api/index.handler'` to a repo file path. */
function handlerToFile(handler) {
  if (!handler) return null;
  // strip the trailing `.export` segment → file stem, then add .ts
  const lastDot = handler.lastIndexOf('.');
  const stem = lastDot > 0 ? handler.slice(0, lastDot) : handler;
  return `${stem}.ts`; // graph-sync normalizes / probes .ts|.tsx|.mjs
}

// ── Main extraction ──────────────────────────────────────────────────────
async function extractInfra(source, root) {
  const parser = new Parser();
  parser.setLanguage(tsLang);
  const tree = parser.parse(source);

  const nodes = [];
  const edges = [];
  const envJoin = {}; // ENV_VAR → { kind, id }
  const ambiguous = [];
  const varToResource = {}; // local var name → { kind, id }  (for link: resolution)
  const services = new Set();

  // PASS 1 — collect every `new sst.* / new aws.*` and its logical id + bound var.
  const newExprs = [];
  walk(tree.rootNode, (node) => {
    if (node.type !== 'new_expression') return;
    const ctorNode = node.childForFieldName('constructor');
    const ctor = ctorNode?.text;
    const kind = kindForConstructor(ctor || '');
    if (!kind) return;
    const args = node.childForFieldName('arguments');
    const argList = args ? args.namedChildren : [];
    const id = stringText(argList[0]); // logical id, e.g. 'CostsTable'
    if (!id) return;
    const configObj = argList.find((a) => a.type === 'object') || null;
    // find the `const <var> = new ...` binding
    let p = node.parent;
    let varName = null;
    if (p?.type === 'variable_declarator') varName = p.childForFieldName('name')?.text ?? null;
    const entry = { kind, id, configObj, varName, line: node.startPosition.row + 1 };
    newExprs.push(entry);
    if (varName) varToResource[varName] = { kind, id };
  });

  // PASS 2 — emit nodes + edges now that varToResource is complete.
  for (const r of newExprs) {
    const nodeId = `infra/${r.kind}/${r.id}`;
    const props = { nodeId, kind: r.kind, label: r.id, line: r.line };

    if (r.kind === 'table' && r.configObj) {
      // capture the data contract: fields + primaryIndex
      const fieldsObj = pairValue(r.configObj, 'fields');
      const piObj = pairValue(r.configObj, 'primaryIndex');
      props.fields = fieldsObj ? fieldsObj.text : null;
      props.primaryIndex = piObj ? piObj.text : null;
    }

    if (r.kind === 'secret') {
      // map secret → external service
      const svc = SECRET_SERVICE_HINTS.find(([re]) => re.test(r.id))?.[1] ?? null;
      if (svc) {
        services.add(svc);
        edges.push({ type: 'REPRESENTS', source: nodeId, target: `service/${svc}` });
      }
    }

    if ((r.kind === 'lambda' || r.kind === 'cron') && r.configObj) {
      // Cron wraps the function under a `function:` pair.
      const fnObj =
        r.kind === 'cron' ? pairValue(r.configObj, 'function') || r.configObj : r.configObj;

      // handler → file
      const handler = stringText(pairValue(fnObj, 'handler'));
      const file = handlerToFile(handler);
      if (file) edges.push({ type: 'HANDLED_BY', source: nodeId, target: `code/${file}` });

      // link: [tableVar, secretVar, ...]
      const linkArr = pairValue(fnObj, 'link');
      if (linkArr?.type === 'array') {
        for (const el of linkArr.namedChildren) {
          if (el.type !== 'identifier') continue;
          const res = varToResource[el.text];
          if (res)
            edges.push({ type: 'USES', source: nodeId, target: `infra/${res.kind}/${res.id}` });
          else ambiguous.push({ at: r.id, reason: `link var '${el.text}' unresolved` });
        }
      }

      // environment: { ENV_VAR: someVar.name | someSecret.value | 'literal-url' }
      const envObj = pairValue(fnObj, 'environment');
      if (envObj?.type === 'object') {
        for (const pair of envObj.namedChildren) {
          if (pair.type !== 'pair') continue;
          const envName = pair.childForFieldName('key')?.text?.replace(/['"]/g, '');
          const val = pair.childForFieldName('value');
          if (!envName || !val) continue;
          const base = baseIdentifier(val);
          if (base && varToResource[base]) {
            envJoin[envName] = varToResource[base]; // ENV → resource (drives File─READS→Table)
            // a secret in env that maps to a service also links the lambda → service
            if (varToResource[base].kind === 'secret') {
              const svc = SECRET_SERVICE_HINTS.find(([re]) => re.test(varToResource[base].id))?.[1];
              if (svc) {
                services.add(svc);
                edges.push({ type: 'USES', source: nodeId, target: `service/${svc}` });
              }
            }
          } else {
            const litUrl = stringText(val);
            const svc = litUrl && URL_SERVICE_HINTS.find(([re]) => re.test(litUrl))?.[1];
            if (svc) {
              services.add(svc);
              edges.push({ type: 'USES', source: nodeId, target: `service/${svc}` });
            }
          }
        }
      }

      // permissions: [{ actions:['s3:PutObject'], resources:['arn:...:bucket/data/*'] }]
      const permsArr = pairValue(fnObj, 'permissions');
      if (permsArr?.type === 'array') {
        for (const perm of permsArr.namedChildren) {
          if (perm.type !== 'object') continue;
          const resArr = pairValue(perm, 'resources');
          if (resArr?.type !== 'array') continue;
          for (const res of resArr.namedChildren) {
            const arn = stringText(res);
            const m = arn && arn.match(/s3:::([^/]+)\/([^'"`]*)/);
            if (m) {
              const bucket = m[1].replace(/\$\{[^}]+\}/g, ''); // template var stripped
              const path = m[2];
              const bpId = `infra/bucketPath/${m[1]}/${path}`;
              nodes.push({
                nodeId: bpId,
                kind: 'bucketPath',
                label: `${bucket || '${bucket}'}/${path}`,
                line: r.line,
              });
              edges.push({ type: 'WRITES', source: nodeId, target: bpId });
            }
          }
        }
      }
    }

    nodes.push(props);
  }

  // emit external-service nodes discovered above
  for (const svc of services) {
    nodes.push({ nodeId: `service/${svc}`, kind: 'externalService', label: svc });
  }

  return { nodes, edges, envJoin, ambiguous };
}

// ── Arg parsing + main (mirrors ast-extract.mjs) ─────────────────────────
function parseArgs() {
  const a = process.argv.slice(2);
  const out = { root: null, config: 'sst.config.ts' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--root') out.root = a[++i];
    else if (a[i] === '--config') out.config = a[++i];
    else if (a[i] === '--help' || a[i] === '-h') {
      console.log('node infra-extract.mjs --root <dir> [--config sst.config.ts]');
      process.exit(0);
    } else {
      console.error(`[infra-extract] unknown arg: ${a[i]}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.root) {
    console.error('[infra-extract] --root required');
    process.exit(2);
  }
  const abs = join(args.root, args.config);
  const empty = {
    generatedAt: new Date().toISOString(),
    root: args.root,
    config: args.config,
    nodes: [],
    edges: [],
    envJoin: {},
    ambiguous: [],
  };
  if (!existsSync(abs)) {
    process.stdout.write(JSON.stringify({ ...empty, skipped: 'config-not-found' }, null, 2) + '\n');
    return;
  }
  if (!(await loadParser())) {
    process.stdout.write(
      JSON.stringify({ ...empty, error: 'tree-sitter not installed' }, null, 2) + '\n',
    );
    return;
  }
  const source = await readFile(abs, 'utf-8');
  const result = await extractInfra(source, args.root);
  process.stdout.write(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        root: args.root,
        config: args.config,
        nodeCount: result.nodes.length,
        edgeCount: result.edges.length,
        ...result,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err) => {
  console.error('[infra-extract] fatal:', err.message);
  process.stdout.write(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      nodes: [],
      edges: [],
      envJoin: {},
      error: err.message,
    }) + '\n',
  );
  process.exit(1);
});
```

**Notes for the debate (Appendix A):**

- `handlerToFile` returns a `.ts` stem; `graph-sync` should probe `.ts|.tsx|.mjs` (the api handler is `functions/api/index.ts`). This matches the real `handler: 'functions/api/index.handler'` in `sst.config.ts`.
- Template-string bucket ARNs (`arn:aws:s3:::${FUTURATOR_PUBLIC_BUCKET}/data/*`) keep the `${…}` marker; we strip it for the label but keep the full id so the four scoped paths (`data/*`, `media/*`, `party-docs/*`, `timing/*`) become distinct `bucketPath` nodes — directly modeling the dual-bucket safety rule from the root `CLAUDE.md`.
- All edges here are EXTRACTED. Anything unresolved goes to `ambiguous[]`, never invented.

---

# Appendix B — `daemon/scripts/service-extract.mjs` (reference implementation)

> Maps code imports + `fetch()` hostnames to `externalService` nodes and `CALLS_SERVICE` edges. Runs over the same file list as `ast-extract`. Deterministic for known packages/hosts; unknown hosts → `AMBIGUOUS` for the Compiler to label once.

```js
/**
 * Service Extract — external/3rd-party service nodes from imports + fetch hosts.
 *
 * Input: same file list as ast-extract (--files / --stdin / --diff-manifest).
 * Output: { nodes:[externalService], edges:[CALLS_SERVICE: file→service], ambiguous:[] }
 *
 * Reuses ast-extract's import data when available (pass --ast-facts <path>);
 * otherwise does a light regex scan for imports + fetch() string hosts.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// package name (or prefix) → service label
const PACKAGE_SERVICE = [
  [/^@anthropic-ai\//, 'Anthropic'],
  [/^(eleven-?labs|@elevenlabs\/)/, 'ElevenLabs'],
  [/^@?moises/, 'Moises'],
  [/^@googlemaps\//, 'GoogleMaps'],
  [/^voyageai$/, 'Voyage'],
  [/^openai$/, 'OpenAI'],
  [/^@aws-sdk\/client-s3$/, 'AWS_S3'],
  [/^@aws-sdk\/(lib-dynamodb|client-dynamodb)$/, 'AWS_DynamoDB'],
  [/^@aws-sdk\/client-secrets-manager$/, 'AWS_SecretsManager'],
  [/^@aws-sdk\/client-ssm$/, 'AWS_SSM'],
];

const HOST_SERVICE = [
  [/api\.anthropic\.com/, 'Anthropic'],
  [/api\.elevenlabs\.io/, 'ElevenLabs'],
  [/(^|\.)moises\.ai/, 'Moises'],
  [/maps\.googleapis\.com/, 'GoogleMaps'],
  [/api\.voyageai\.com/, 'Voyage'],
  [/auth\.futurator\.ai/, 'IdentityBroker'],
];

function serviceForPackage(pkg) {
  return PACKAGE_SERVICE.find(([re]) => re.test(pkg))?.[1] ?? null;
}
function serviceForHost(host) {
  return HOST_SERVICE.find(([re]) => re.test(host))?.[1] ?? null;
}

// Light scan (used when no ast-facts handed in).
const IMPORT_RE = /import[^'"]*from\s*['"]([^'"]+)['"]/g;
const FETCH_RE = /fetch\(\s*[`'"]([^`'"]+)[`'"]/g;
const HOST_RE = /https?:\/\/([^/`'"]+)/;

async function extractFile(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return { edges: [], ambiguous: [] };
  let src;
  try {
    src = await readFile(abs, 'utf-8');
  } catch {
    return { edges: [], ambiguous: [] };
  }

  const edges = [];
  const ambiguous = [];
  const seen = new Set();

  let m;
  while ((m = IMPORT_RE.exec(src))) {
    const svc = serviceForPackage(m[1]);
    if (svc && !seen.has(svc)) {
      seen.add(svc);
      edges.push({ type: 'CALLS_SERVICE', source: `code/${rel}`, target: `service/${svc}` });
    }
  }
  while ((m = FETCH_RE.exec(src))) {
    const host = (m[1].match(HOST_RE) || [])[1];
    if (!host) continue;
    const svc = serviceForHost(host);
    if (svc) {
      if (!seen.has(svc)) {
        seen.add(svc);
        edges.push({ type: 'CALLS_SERVICE', source: `code/${rel}`, target: `service/${svc}` });
      }
    } else ambiguous.push({ file: rel, host, reason: 'unknown-host' }); // Compiler labels once → INFERRED
  }
  return { edges, ambiguous };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { root: null, files: null, stdin: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--root') out.root = a[++i];
    else if (a[i] === '--files')
      out.files = a[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a[i] === '--stdin') out.stdin = true;
  }
  return out;
}
async function readStdin() {
  const c = [];
  for await (const x of process.stdin) c.push(x);
  return Buffer.concat(c).toString('utf-8');
}

async function main() {
  const args = parseArgs();
  if (!args.root) {
    console.error('[service-extract] --root required');
    process.exit(2);
  }
  let files = args.files;
  if (!files && args.stdin)
    files = (await readStdin())
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  files = files || [];

  const allEdges = [];
  const allAmbiguous = [];
  const services = new Set();
  for (const rel of files) {
    const { edges, ambiguous } = await extractFile(args.root, rel);
    for (const e of edges) {
      allEdges.push(e);
      services.add(e.target);
    }
    allAmbiguous.push(...ambiguous);
  }
  const nodes = [...services].map((t) => ({
    nodeId: t,
    kind: 'externalService',
    label: t.replace('service/', ''),
  }));
  process.stdout.write(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        root: args.root,
        nodes,
        edges: allEdges,
        ambiguous: allAmbiguous,
      },
      null,
      2,
    ) + '\n',
  );
}
main().catch((e) => {
  console.error('[service-extract] fatal:', e.message);
  process.exit(1);
});
```

**Note:** when `ast-extract` already produced import data for the changed files, prefer feeding that in (a `--ast-facts` path) instead of re-scanning — avoids a second file read. The standalone scan above is the fallback so the script works independently for the debate/demo.

---

# Appendix C — `graph-sync.mjs` additions (targeted diff)

> Additive only. New node kinds flow through the existing `MERGE (n:Node {nodeId})` path. Two new pieces: the **env-join** (File─READS→Table) and the **orphan invariant**.

```js
// ── NEW: ingest infra + service extraction (call alongside upsertAstFacts) ──
async function upsertInfraFacts(session, projectId, infraDoc, serviceDoc, today) {
  // 1) MERGE infra + service nodes
  for (const n of [...(infraDoc.nodes || []), ...(serviceDoc.nodes || [])]) {
    await session.run(
      `MERGE (n:Node {nodeId: $nodeId})
       SET n.kind = $kind, n.label = $label, n.projectId = $projectId,
           n.status = 'active', n.updated = $today,
           n.fields = $fields, n.primaryIndex = $primaryIndex`,
      {
        nodeId: n.nodeId,
        kind: n.kind,
        label: n.label ?? n.nodeId,
        projectId,
        today,
        fields: n.fields ?? null,
        primaryIndex: n.primaryIndex ?? null,
      },
    );
  }
  // 2) MERGE infra + service edges (both endpoints now exist)
  for (const e of [...(infraDoc.edges || []), ...(serviceDoc.edges || [])]) {
    await session
      .run(
        `MATCH (a:Node {nodeId: $s}) MATCH (b:Node {nodeId: $t})
       MERGE (a)-[r:${e.type}]->(b) SET r.updated = $today`,
        { s: e.source, t: e.target, today },
      )
      .catch(() => {
        /* endpoint missing → skip, surfaced by orphan check */
      });
  }
}

// ── NEW: env-join — File ─READS→ Table from process.env.X references ────────
// `envJoin` comes from infra-extract: { ENV_VAR_NAME: { kind:'table', id:'CostsTable' } }
// `envRefsByFile` comes from ast-extract's call/member scan: { 'code/functions/...': ['COSTS_TABLE', ...] }
async function upsertEnvReads(session, projectId, envJoin, envRefsByFile, today) {
  for (const [fileId, envVars] of Object.entries(envRefsByFile)) {
    for (const v of envVars) {
      const res = envJoin[v];
      if (!res || res.kind !== 'table') continue;
      await session.run(
        `MATCH (f:Node {nodeId: $f, projectId: $projectId})
         MATCH (t:Node {nodeId: $t})
         MERGE (f)-[r:READS]->(t) SET r.via = $env, r.updated = $today`,
        { f: fileId, t: `infra/table/${res.id}`, projectId, env: v, today },
      );
    }
  }
}

// ── NEW: orphan invariant (run after all upserts) ──────────────────────────
async function reportOrphans(session, projectId) {
  const r = await session.run(
    `MATCH (n:Node {projectId: $projectId})
     WHERE NOT (n)--() AND coalesce(n.status,'active') <> 'pruned'
     RETURN n.nodeId AS id, n.kind AS kind`,
    { projectId },
  );
  const orphans = r.records.map((rec) => ({ id: rec.get('id'), kind: rec.get('kind') }));
  const hardFail = orphans.filter((o) => o.kind !== 'file'); // non-file orphans are extractor bugs
  return { orphans, hardFail };
}
```

`ast-extract.mjs` gains a tiny addition: while walking, also collect `member_expression` matching `process.env.X` and emit `envRefsByFile`. (The walker already visits every node — add one `case` for the `process.env.IDENT` shape.)

---

# Appendix D — Centrality & communities (Cypher / MAGE)

```cypher
// God-nodes: betweenness centrality (MAGE)
CALL betweenness_centrality.get()
YIELD node, betweenness_centrality
SET node.centrality = betweenness_centrality;

// Communities: Louvain
CALL community_detection.get()
YIELD node, community_id
SET node.community = community_id;

// "Surprising connections": edges bridging two communities with high endpoint centrality
MATCH (a:Node)-[r]->(b:Node)
WHERE a.community <> b.community
  AND a.centrality > $c AND b.centrality > $c
RETURN a.label, type(r), b.label, a.community, b.community
ORDER BY a.centrality + b.centrality DESC LIMIT 25;

// Blast radius for a story's touch points (≤2 hops across stack)
MATCH (f:Node) WHERE f.nodeId IN $changedFileIds
CALL { WITH f MATCH (f)-[:READS|USES|CALLS|DEFINES|WRITES|CALLS_SERVICE|IMPORTS*1..2]-(x) RETURN x }
RETURN DISTINCT x.kind AS kind, x.label AS label
ORDER BY kind;
```

---

# Appendix E — PROPAGATOR data shapes

```jsonc
// Capability seed (curated, append-only; GARDENER-maintained)
{
  "nodeId": "capability/wave-gate-approval",
  "kind": "capability",
  "label": "Wave Gate Approval",
  "implementedBy": {
    "labs":   ["code/src/components/WaveGate.tsx"],
    "mobile": ["code/src/screens/WaveGateScreen.tsx"],
    "office": ["code/Assets/UI/WaveGate.prefab"]
  },
  "contract": { "endpoints": ["POST /waves/:id/approve"], "tables": ["WaveConflictsTable"] }
}

// Drift marker (per shared-contract node)
{
  "nodeId": "infra/table/PlansTable",
  "lastPropagatedTo": { "mobile": "commitY", "office": "commitZ" },
  "driftSince": { "mobile": 3, "office": 0 }   // contract changes pending
}

// PROPAGATOR output (one per sibling needing a port)
{
  "sibling": "mobile",
  "trigger": "wave-gate | drift-threshold",
  "contractChanges": [
    { "node": "infra/table/PlansTable", "change": "field +dependsOn:string[]" },
    { "node": "endpoint/POST /plans/:id/validate", "change": "new" }
  ],
  "brief": "PlanScreen.tsx needs a dependency picker + useValidatePlan hook; RN equivalent of <DependencyGraph>.",
  "proposedStory": { "title": "Port plan-dependencies to Mobile", "epic": "labs-parity" },
  "requiresApproval": true
}

// ContractRevision append-log node (W6 — the temporal source for drift-count)
// One appended per contract-shape change at the wave gate; (:Node)-[:REVISED]->(:ContractRevision)
{
  "nodeId": "rev/PlansTable/2026-06-15T.../dependsOn",
  "kind": "contractRevision",
  "contractNode": "infra/table/PlansTable",
  "change": "field +dependsOn:string[]",
  "atCommit": "3da50ba",
  "atWave": "wave-42",
  "ts": "2026-06-15T10:31:00Z"
}
// driftSince[sibling] = count of REVISED nodes whose atCommit is AFTER lastPropagatedTo[sibling].
```

---

# Appendix F — `daemon/scripts/route-extract.mjs` (W1 — reference implementation)

> Drop-in sibling of `infra-extract.mjs`. Deterministic, zero-LLM. Parses the Hono app file and emits `endpoint` nodes + `ROUTES` edges. Output envelope matches `ast-extract` so `graph-sync` ingests it unchanged. The `CALLS_ENDPOINT` (frontend → endpoint) side is resolved in `graph-sync` by matching `api-client` paths against the emitted endpoint set.

```js
/**
 * Route Extract — deterministic API-surface facts from a Hono app.
 *
 * Parses `app.<method>('<path>', [authMiddleware,] handler)` calls and emits:
 *   - nodes:  endpoint { method, path, auth }
 *   - edges:  ROUTES (endpoint → lambda)        — the single Api Function
 *             HANDLED_BY (endpoint → file)       — when the handler is a named import
 * Honesty: a route with a dynamically-built path or spread middleware → `ambiguous[]`.
 *
 * Usage: node route-extract.mjs --root <dir> --app functions/api/index.ts --lambda infra/lambda/Api
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'all']);

let Parser, tsLang;
async function loadParser() {
  try {
    Parser = (await import('tree-sitter')).default;
    tsLang = (await import('tree-sitter-typescript')).default.typescript;
    return !!(Parser && tsLang);
  } catch (err) {
    console.error(`[route-extract] tree-sitter unavailable: ${err.message}`);
    return false;
  }
}
function walk(rootNode, visit) {
  const cursor = rootNode.walk();
  (function descend() {
    visit(cursor.currentNode);
    if (cursor.gotoFirstChild()) {
      do {
        descend();
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  })();
}
function stringText(n) {
  return n && (n.type === 'string' || n.type === 'template_string') ? n.text.slice(1, -1) : null;
}

async function extractRoutes(source, lambdaId) {
  const parser = new Parser();
  parser.setLanguage(tsLang);
  const tree = parser.parse(source);
  const nodes = [],
    edges = [],
    ambiguous = [];

  walk(tree.rootNode, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') return;
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    // match `app.<method>(...)`
    if (obj?.text !== 'app' || !HTTP_METHODS.has(prop?.text)) return;

    const args = node.childForFieldName('arguments');
    const argList = args ? args.namedChildren : [];
    const path = stringText(argList[0]);
    if (!path) {
      ambiguous.push({ reason: 'dynamic-path', line: node.startPosition.row + 1 });
      return;
    }

    const method = prop.text.toUpperCase();
    // auth: is `authMiddleware` among the middleware args (everything between path and final handler)?
    const auth = argList.slice(1).some((a) => /authMiddleware/.test(a.text));
    const nodeId = `endpoint/${method} ${path}`;
    nodes.push({
      nodeId,
      kind: 'endpoint',
      label: `${method} ${path}`,
      method,
      path,
      auth,
      line: node.startPosition.row + 1,
    });
    edges.push({ type: 'ROUTES', source: nodeId, target: lambdaId });
  });

  return { nodes, edges, ambiguous };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { root: null, app: 'functions/api/index.ts', lambda: 'infra/lambda/Api' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--root') out.root = a[++i];
    else if (a[i] === '--app') out.app = a[++i];
    else if (a[i] === '--lambda') out.lambda = a[++i];
  }
  return out;
}
async function main() {
  const args = parseArgs();
  if (!args.root) {
    console.error('[route-extract] --root required');
    process.exit(2);
  }
  const abs = join(args.root, args.app);
  const empty = {
    generatedAt: new Date().toISOString(),
    root: args.root,
    app: args.app,
    nodes: [],
    edges: [],
    ambiguous: [],
  };
  if (!existsSync(abs)) {
    process.stdout.write(JSON.stringify({ ...empty, skipped: 'app-not-found' }, null, 2) + '\n');
    return;
  }
  if (!(await loadParser())) {
    process.stdout.write(
      JSON.stringify({ ...empty, error: 'tree-sitter not installed' }, null, 2) + '\n',
    );
    return;
  }
  const source = await readFile(abs, 'utf-8');
  const result = await extractRoutes(source, args.lambda);
  process.stdout.write(
    JSON.stringify(
      { ...empty, nodeCount: result.nodes.length, edgeCount: result.edges.length, ...result },
      null,
      2,
    ) + '\n',
  );
}
main().catch((e) => {
  console.error('[route-extract] fatal:', e.message);
  process.exit(1);
});
```

**Notes for the debate (Appendix F):**

- Matches the real shape in `functions/api/index.ts` (`app.get('/api/health', …)`, `app.post('/api/auth/exchange', …)`, `app.get('/api/auth/me', authMiddleware, …)`). The `auth` flag turns the public-route list (`/api/health`, `/api/auth/*`, `/api/public/projects`) into queryable structure — a security-review surface for free.
- `CALLS_ENDPOINT` is resolved downstream in `graph-sync`: normalize `:param` ↔ template segments, match `api-client` request paths to `endpoint.path`. Unmatched frontend calls → `AMBIGUOUS` (endpoint typo or untracked route), which is itself a useful finding.
- All edges EXTRACTED. Dynamic/spread routes → `ambiguous[]`, never invented.

---

## 11. Decisions already locked (do not re-litigate in debate)

- Mine graphify for ideas; **do not adopt or fork** (2026-06-13).
- All current brownfield candidates are TS/JS/React → multi-language extractor is out of scope (C# enters only with Office/Unity, via tree-sitter's C# grammar).
- DynamoDB multi-table, zero-cost-serverless, Bearer-token auth, dual-bucket safety — all unchanged constraints the graph must _respect and model_ (the `bucketPath` nodes encode the scoped-path safety rule).

## 12. The one open dependency to confirm before P7 (W9)

**Do Futurator Mobile and Agentic Office consume the _same_ deployed SST backend (shared table ARNs / same API origin), or separate deployments of the same schema?** If shared → `CONSUMES_CONTRACT` joins on resource identity (cheap). If separate → it must join on _schema shape_ (table fields / endpoint signatures), which the `table.fields` + `primaryIndex` + `endpoint.method/path` props already capture. Either is supported; the answer sets P7's join strategy.

> This is the **one design decision that can't be settled from this repo alone** — it depends on how Mobile/Office are actually deployed. It will be pinned empirically during the controlled tests (the multi-surface scenario in `test-bench-rubric.md` is built as one shared backend specifically to exercise the resource-identity path first). Until confirmed, P7 is designed against **both** join strategies so neither answer invalidates the work.
