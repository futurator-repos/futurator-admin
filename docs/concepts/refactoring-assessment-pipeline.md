# Refactoring Assessment Pipeline

> **Status:** Concept — crystallized 2026-06-18 from a party-mode design session.
> **Scope:** Journey B — _cure_. Take a brownfield app migrated into Futurator and
> assess it up to a quality standard. **Report-only → Create plan.** No auto-fix.
> **Companion docs:** [`anatomy-of-a-healthy-codebase (1).md`](./anatomy-of-a-healthy-codebase%20%281%29.md)
> (the _standard_), [`refactoring-security-agent-briefing.md`](./refactoring-security-agent-briefing.md)
> (the _mechanism thesis_), [`brownfield-migration-runner-plan.md`](./brownfield-migration-runner-plan.md)
> (the migration substrate this rides on).

---

## 1. The one-paragraph version

A migrated brownfield app (e.g. `applicator` — no tests, no eslint, legacy versions
of features still wired in, no design system, scattered components) is assessed by a
**layered pipeline** that runs cheapest-and-deterministic first and expensive-and-agentic
last. Each layer shrinks the surface the next layer pays for. The output is a
**severity-ranked report plus a plan draft** that flows into the _existing_ epic/story dev
pipeline — which is the only thing in the company allowed to mutate code, behind test
gates. There is **exactly one** official Claude Code **dynamic workflow** in the pipeline,
fired at one precise spot (L3) where fan-out across graph-pinned hotspots is justified.

**Core principle (from the Anatomy doc):** _convert quality from something people remember
to do into something the system guarantees._ You cannot review every line an agent writes,
so machine-checkable gates become the supervisory layer.

**Token law:** _You only pay an LLM for a judgment a deterministic tool cannot make._

---

## 2. It rides existing substrate (do not rebuild)

Migration into Futurator already exists (Story 15.4 + the migration runner plan). The
assessment is **a new job `kind` (`refactor-audit`)**, not a new system.

| Capability                                                                                                                                                           | Status        | Reused for                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------- |
| Brownfield clone-via-PAT, mirror to EC2, DDB registration (`kind='brownfield'`)                                                                                      | exists (15.4) | intake                        |
| Daemon polls agent-jobs, spawns `claude -p` in worktrees, reports to disk                                                                                            | exists        | the runner                    |
| `/api/agent-jobs/:id/events` event stream                                                                                                                            | exists        | live UI progress              |
| Mycelium MCP — 7 read-only graph tools (`god_nodes`, `orphans`, `blast_radius`, `neighbors`, `shortest_path`, `get_node`, `query_graph`), gated by `MYCELIUM_MCP=on` | ~85% built    | graph-as-lens                 |
| `ast-extract.mjs` (tree-sitter), `graph-analytics.mjs` (Leiden + betweenness)                                                                                        | production    | structural recon graph        |
| graphify skill (cold codebase → god-nodes/communities/orphans + MCP: `query_graph`/`explain`/`path`)                                                                 | production    | recon X-ray + oracle          |
| Voyage embeddings (Mycelium durable graph)                                                                                                                           | partial       | duplicate-component detection |
| epic/story dev pipeline (writes tests, runs `npm run ci`)                                                                                                            | exists        | **the fixer**                 |

The assessment **finds**; it never fixes. The fix is a plan executed by the trusted pipeline.

---

## 3. The layered model

Cheapest at the bottom. Each layer's job is to shrink what the layer above pays for.

| Layer                           | Tool class                                        | LLM cost               | Job                                                                                                                                         |
| ------------------------------- | ------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0 — Tooling census**         | deterministic, seconds                            | ~0                     | Do eslint/prettier/knip/strict-tsconfig exist? `applicator` started with none → install/configure. Can't measure mess without instruments.  |
| **L0.5 — File-role map**        | deterministic (path + content)                    | ~0                     | Tag every file: `source` / `test` / `config` / `generated` / `fixture` / `mock` / `story`. Drives lint overrides AND graph node attributes. |
| **L1 — Clutter classification** | deterministic (knip, ts, prettier)                | ~0                     | **Classify and propose, never delete.** Candidate lists of unreferenced files, unused exports, unused deps.                                 |
| **L2 — Graph build**            | graphify + structural Memgraph + infra extractors | bounded (AST/math)     | Build the code↔infra graph on the cleaner tree → god-nodes, communities-vs-folders, blast-radius, duplicate-version clusters.               |
| **L3 — Agentic adjudication**   | **dynamic workflow**, N parallel agents           | **the only big spend** | Fan out _only_ at graph-flagged hotspots. Type-B verdicts, design-system gaps, extract-and-repoint planning.                                |
| **L4 — Judge → plan**           | single agent                                      | small                  | Fuse, severity-rank, emit dev-pipeline stories.                                                                                             |

**L0–L2 run every time (near-free). L3 fires last, narrowly, on coordinates the graph
already pinned.** That is the "right spot, precisely."

---

## 4. Two species of clutter

Only one can be cleaned before the graph. This distinction reorders the pipeline.

- **Type A — orphaned dead code.** Zero incoming edges. knip finds it deterministically in
  L1. Most of "many functions not used." _Safe-to-propose-removal cheaply._
- **Type B — superseded _live_ code.** `profile1`, `onboarding v1`. **Still imported, still
  routed, still reachable** → knip will _not_ flag it; to a deterministic tool it looks
  alive. Identifying it as "the wrong version, fully wired in" requires **the graph +
  semantic judgment** (L2 + L3). You cannot clean Type B before the graph.

**Consequence:** cleaning wraps _around_ the graph, not entirely before it. L1 strips Type A
so the graph isn't polluted by dead noise; the graph then exposes Type B; L3 adjudicates it.

---

## 5. The no-test safety discipline

`applicator` has no tests. Deleting knip "unused" code on a no-test app is roulette
(false-positives on dynamic imports, string registries, route conventions, reflection).

1. **L1 classifies and proposes. It never deletes.** Removal becomes a _story_ the dev
   pipeline executes — and the dev pipeline writes a test + runs CI before it commits.
   Deletion is a test-gated planned action.
2. **One behavioral net under the whole app, not 4,000 unit tests.** A thin Playwright smoke
   walking the main user routes (login, profile, onboarding, the 3–4 flows that matter) is
   the cheap net that goes red if a deletion breaks a route. _Depth scales with impact._
3. **Git branch + workflow resumability = instant rollback.**

---

## 6. File-role classification (L0.5)

Test files tripping the linter is a **classification** problem, not a suppression one.
Every file has a role, deterministic from path + content:

- `test` (`*.test.ts`, `*.spec.ts`, `__tests__/`) → eslint `overrides` relax typing; allow `any`.
- `generated` (`*.generated.ts`, `sst-env.d.ts`, `*.tsbuildinfo`) → **excluded entirely** from lint and graph.
- Roles become **graph node attributes**, so Cartographer reasons "this complexity is in a
  test → ignore" vs "this is a god-node in source → flag."

---

## 7. Design-system / scattered-component detection

A three-depth ladder — only the last needs the smart layer:

1. **Metric (deterministic):** count `style={{…}}` density; count distinct color literals
   (`#3b82f6` × 40 across 30 files); count things rendering a clickable primary action
   (`<button>`, `*Button`). High numbers _are_ the smell, measured, no LLM.
2. **Graph shape:** a healthy design system is a **hub** — one `<Button>` node with many
   `DEPENDS_ON` edges pointing _in_. Its _absence_ (many similar UI leaves, no hub) is the
   signal. "No god-node in the UI layer" = no design system.
   > ⚠️ **VALIDATED-FALSE without alias resolution (2026-06-19).** On applicator, graphify
   > reported `Button` in-degree **1** while it is actually imported by **130** files — because
   > graphify does not resolve `@/…` tsconfig path aliases (~77% of imports). In-degree/fan-in
   > hub detection is a **false-negative trap** on alias-heavy codebases. This metric is only
   > usable after resolving imports through the tsconfig `paths` map (post-process graphify
   > edges, or use ts-morph/knip/madge --ts-config). Out-degree/ownership/cohesion are safe;
   > inbound fan-in is not. See `applicator-editor-unification-plan.md` Tooling finding #3.
   >
   > ✅ **RESOLVED 2026-06-19** by `daemon/scripts/refactor-recon/alias-resolve.mjs` — a deterministic
   > post-processor that recomputes the import graph from source with tsconfig-`paths`
   > resolution, keyed by `source_file`. Validated: `button.tsx` in-degree **1 → 115** (exact
   > ground truth); design-system verdict flipped false→correct. It also revealed applicator has
   > a **duplicated** design system (`profile-editor/components/ui` + its own `lib/utils.ts`
   > `cn()`), so the real task is _consolidate onto canonical `src/components/ui`_, not _build one_.
   > **Rule for the in-house extractor:** resolve tsconfig paths at extraction time, or run this
   > post-processor before any usage/hub/dead-code read.
3. **Embedding cluster (already built):** Voyage embeddings cluster UI leaves by similarity.
   A tight cluster of 14 button-ish nodes = "these should be one `<Button>` with variants."
   The embeddings _are_ the duplicate-component detector.

---

## 8. Entangled legacy → extract-and-repoint

The hard case: _profile1 is legacy → delete; profile2 is fine → keep; but profile2 uses some
of profile1's functions._ You cannot `rm -rf profile1/`.

The graph splits profile1 by **edge direction** — _does this node have an incoming edge from
outside profile1?_

- **No external incoming edge** → true legacy → removal candidate.
- **Incoming edge from profile2** → **shared core, misfiled in a legacy folder.** Not legacy
  at all; the real abstraction that was hiding.

The refactor is therefore a **sequenced Strangler-Fig**, each step graph-verified safe:

1. **Extract** the shared-core functions into a proper shared module.
2. **Repoint** profile2's imports at the new home.
3. **Delete** profile1's remainder — graph now confirms zero incoming edges (genuine orphan).

Three ordered stories, each individually safe. The graph turns a terrifying entangled
deletion into a sequence of provably-orphaned removals. **This is where the graph earns its
entire keep.**

---

## 9. The two-graph model (recon vs durable) + triangulation

One substrate, **two depths**, run at different times:

```
intake messy app
  ├─ graphify (structural X-ray, baseline)         ⟂  structural-Memgraph (AST + imports,
  │     query_graph / explain / path                     no embeddings → lights up
  │                                                       blast_radius / neighbors(dir))
  │            └────── diff = confidence signal (oracle) ──────┘
  → L0.5 file-roles · L1 Type-A classification (knip = candidates, not deletes)
  → thin app-level Playwright net
  → L3 dynamic workflow (queries structural-Memgraph for safe extract-and-repoint)
  → L4 severity report + plan
  → dev pipeline executes plan (extract → repoint → delete, test-gated)
  ─────────── app is now structured + tested + adopted ───────────
  → DURABLE graph: full Mycelium (Voyage embeddings + wiki compiler + maturity)
  → ongoing: durable graph feeds the dev pipeline; re-validated vs a fresh graphify run forever
```

- **graphify = recon X-ray + permanent oracle.** Cold, disposable, zero prior knowledge.
  Also the **regression test for the durable graph**: build both on the same commit, diff
  god-nodes/communities. **Agreement → high confidence. Divergence → either a Mycelium
  extractor bug (graphify catches it) or a semantic edge graphify can't see (real insight).**
- **structural Memgraph = directional queries at recon.** Same tree-sitter extraction (being
  built on branch `feat/treesitter-slice-c-brownfield-bootstrap`) minus the expensive
  embedding step. Near-free, and required so L3 can _prove_ an entangled deletion is safe.
- **durable Mycelium = the "true graph."** Expensive (embeddings/wiki/maturity); value is
  _ongoing_. Populated **only after adoption** — embedding dead code on intake pollutes the
  permanent record with the very stuff L1–L3 is about to delete.

> graphify is the triage nurse; the durable graph is the primary-care physician assigned
> _after_ the trauma surgery. Writing the durable graph on intake = writing the permanent
> medical record before cutting out the tumor.

---

## 10. The official dynamic workflow (L3 — and only here)

There is **exactly one** Claude Code dynamic workflow in the pipeline. L0–L2 are
deterministic (math + CLI — wrapping them in agents would be the token bonfire). L4 is a
single agent. **L3 is the workflow**, fired where fan-out across graph-pinned hotspots is
justified. Saved as `/assess-codebase`; invoked headless by the daemon via `claude -p`.

```js
export const meta = {
  name: 'assess-codebase',
  description: 'Adjudicate graph-flagged refactoring hotspots in a migrated brownfield app',
  phases: [{ title: 'Adjudicate' }, { title: 'Judge' }],
};

// args = { projectId, hotspots, graphMcp }  ← from the deterministic recon stage
const hotspots = args.hotspots; // duplicate-version clusters, god-nodes, design-system gaps

phase('Adjudicate');
const verdicts = (
  await parallel(
    hotspots.map(
      (h) => () =>
        agent(
          `Hotspot ${h.id} (${h.kind}) in ${args.projectId}. Files: ${h.files.join(', ')}.
     Query the graph MCP to decide: which version is current vs superseded, and which
     functions are shared-core (incoming edges from the kept version). Propose
     extract-and-repoint steps — NEVER a bare delete of reachable code. Return a verdict.`,
          {
            label: `adjudicate:${h.id}`,
            phase: 'Adjudicate',
            schema: VERDICT_SCHEMA,
            agentType: 'version-adjudicator',
          },
        ),
    ),
  )
).filter(Boolean);

phase('Judge');
return agent(
  `Fuse these verdicts into a severity-ranked plan for ${args.projectId}. Sequence so every
   deletion is graph-verified safe (extract → repoint → delete). Emit dev-pipeline stories.
   Verdicts: ${JSON.stringify(verdicts)}`,
  { schema: PLAN_SCHEMA, phase: 'Judge' },
);
```

**Why this is token-disciplined:**

- `N = hotspot count` (~6), **not** file count (~4000). Fan-out width is bounded by a
  deterministic upstream finding.
- Intermediate verdicts live in _script variables_, not a context window → kills
  context-window degradation (briefing Flag #2).
- Resumable: if the daemon dies mid-run, completed agents return cached results.
- Custom subagents are **tool-scoped**: `version-adjudicator` gets read-only + graph MCP,
  **no Write** — "find, don't fix" enforced mechanically.

`VERDICT_SCHEMA` (per hotspot): `{ kind, currentVersion, supersededVersions[],
sharedCore[], steps[ {action: 'extract'|'repoint'|'delete', files[], rationale} ],
confidence, blastRadiusVerified }`.
`PLAN_SCHEMA`: `{ projectId, severityRanked[ {finding, severity, stories[]} ], summary }`.

---

## 11. Rollout

1. **Tune on the easy patient first.** Run L0–L2 + graphify against a _small prototype_
   (20-file repo builds a graph in seconds). Eyeball whether communities-vs-folders tells
   the truth before pointing it at `applicator`'s swamp. _Don't debug the pipeline and
   applicator's mess simultaneously — two unknowns multiply._
2. **Measure the L1 classification.** If knip flags 200 dead files and projected lint errors
   drop 4,000 → 800, the deterministic layer is proven _before_ a token is spent on agents.
3. **Iterate up** to more cluttered apps, then `applicator`.
4. This may graduate into a reusable **module/feature** across the portfolio.

---

## 12. Open decisions

- **(settled, lean yes)** Light up a **structural-only Memgraph at recon** so L3 can prove
  entangled deletes? Near-free (reuses the tree-sitter branch); without it, the
  profile1/profile2 untangle — the most-wanted refactor — punts to the durable phase.
- **Infra graph for Sentinel.** `infra-extract` / `route-extract` / `service-extract` are
  15–30% built (Epic 1). v0 security = deterministic scans (Gitleaks + TruffleHog over git
  history, Checkov/Trivy for IaC); graduate to graph blast-radius when extractors land.
- **Cadence vs batch.** One-time assessment now; per-PR/daily entropy checks (the `hone`
  model) later. Decide which runs when.

---

## 13. Flags carried from the briefing (still binding)

1. LLM refactors ship ~1.75× more logic errors → every refactor verified by tests, not eye.
2. Context degrades with window size → scope agents to one hotspot; workflow holds state.
3. Skill supply-chain risk → read every SKILL.md; prefer TS-native over unaudited imports.
4. Bus-factor → the tooling must make code _more_ legible to a non-expert, not less.
5. No rollback discipline = danger → branch + small batches + resumable workflow.
6. Scanning ≠ security → SAST/agents are a subset; introduce rulesets incrementally.
