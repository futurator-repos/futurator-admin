# Refactoring Scan Engine v2 — Hybrid Deterministic + Swarm

> **Scope.** Design for a "upload any codebase / GitHub repo → optimized architectural + safety +
> compliance scan + a phased, dependency-ordered refactoring plan" engine. This is an _assessment
> and plan_ design, not an implementation spec. Every claim below is anchored to a concrete file in
> `daemon/scripts/refactor-recon/`, `daemon/pipelines/`, `functions/shared/`, or
> `src/components/labs/app-detail/assess/`. The target _output_ contract it must reproduce is the
> shape of Mycelium's `docs/refactoring-scan.md`.

---

## 1. Thesis & Why Hybrid

The v1 refactoring pipeline already ships a **cheap deterministic recon** (`recon.mjs` →
`graphify-out/`) and a heavyweight **L3 adjudication** (`assess-codebase.workflow.js`,
`refactor-audit-job-runner.mjs`). v1's gap, confirmed in the report/plan audit, is the _middle and
the end_: there is **no Executive-themes layer, no Severity×Effort matrix, and no global
dependency-ordered Phase 0..N plan** — sequencing exists only per-hotspot (Strangler-Fig
`dependsOn`) and at the LLM judge's discretion. v2 closes that gap with a hybrid swarm that is
**seeded and grounded** by the recon we already compute.

**What the deterministic layer gives us (cheap structural truth, ~0 LLM tokens, < 3 min):**

- A **trustworthy** file-level import graph. `alias-resolve.mjs` recomputes fan-in through tsconfig
  path-aliases + extension + index resolution (the key correctness fix: naive AST puts `Button`
  in-degree at ~1 when ~115 files import it). This is the substrate the LLM must **never re-derive**.
- A ranked, role-aware **hotspot list** (`hotspot-detect.mjs`): `god-object`,
  `duplicate-subsystem`, `design-system-consolidation`, `low-cohesion-split`, `dead-code`, each with
  `score 0-100`, `severity`, structured `evidence` (counts/copies/cohesion — never a code dump), and
  a role-tailored `suggestedAction`.
- **Leiden communities + cohesion** per file (from `graphify`), and **architecture/privacy role
  tags** (`privacy-detectors.mjs`: infra/db/ai/thirdParty + provider + residency).
- A **fully production-complete compliance dimension** (`privacy-scan-internal.mjs`): GDPR + EU AI
  Act findings, ~0 LLM, source never leaves the box.

**What the deterministic layer is structurally blind to** (from the recon audit's own `blindSpots`,
quoted because these are exactly what the swarm must cover):

- **Cross-file contract drift** — it sees the import edge between a Zod schema and the DynamoDB item
  it writes, but not whether the shapes _agree_.
- **Inconsistent error/response envelopes** — it counts imports and methods; it never reads what a
  handler returns. Envelope drift is invisible.
- **Fragile parsing / missing `res.ok` / unguarded `JSON.parse`** — no dataflow or call-result
  analysis. A `fetch().json()` without `res.ok` is invisible.
- **Magic numbers / divergent thresholds** — no literal analysis at all.
- **Semantic duplication** — dedup is _basename + path-marker string matching_, not behavioral/AST
  similarity. Two functions doing the same thing under different names are invisible.
- **God-object by method COUNT only** — a 6-method class with 2000 tangled lines in one method is
  invisible (no LOC / cyclomatic signal).
- **Naming** — it can label a community only from its top-fan-in file's basename; it cannot say what
  the subsystem _does_.
- **Security/correctness semantics** — auth-bypass, injection, N+1, pagination/boundary bugs are out
  of scope.

**Why grounding makes the swarm both cheaper and hallucination-resistant.** The single biggest token
sink in a naive multi-agent scan is N agents each re-discovering the repo's shape. We already paid
for that shape deterministically. So every analyzer agent is handed (a) the **exact file list** to
Read (a subsystem's `members[]`), (b) the **focus angle** synthesized from that subsystem's
hotspots + top hubs, and (c) the instruction to **VERIFY-not-rediscover**. An agent told "the impact
cutoff is `0.5`, find every place it is hard-coded" returns `file:line` hits; an agent told "review
impact analysis" returns vibes. Every LLM claim is cross-checkable against the recon JSON
("12 methods, 115 importers, community 7"), so the swarm cites ground truth instead of inventing
metrics. This is the **deterministic-first token law**: cheap recon does all structural work; LLM
spend goes only to semantic judgment and adjudication.

---

## 2. Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ (a) INGEST            GitHub URL | tarball upload                                  │
│     git-clone.mjs  →  EC2 clone (source never leaves the box)                      │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────────────────────────┐
│ (b) DETERMINISTIC RECON   recon.mjs  (~0 LLM, <3min, REUSED AS-IS)                   │
│   graphify-build.py → graph.json            (AST symbol graph, communities)         │
│   alias-resolve.mjs → resolved-imports.json (authoritative fan-in + hubs[])         │
│   knip --reporter json → knip.json          (TS-resolver dead code)                 │
│   hotspot-detect.mjs → hotspots.json        (5 kinds, score+severity+evidence)      │
│   graph-project.mjs → graph-ui.json         (file-level, role+provider tags)        │
│   privacy-scan-internal.mjs → privacy.json  (GDPR + EU AI Act, FULLY done)          │
│   exit codes: 2=graphify-missing 3=degenerate-build  → trust gate                   │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │  toolStatus + exit code = "is the substrate trustworthy enough to ground an LLM?"
┌───────────────▼───────────────────────────────────────────────────────────────────┐
│ (c) SUBSYSTEM DECOMPOSITION   subsystem-extract.mjs  ← KEY NEW ARTIFACT             │
│   communities + role tags + parent-dir → docShards:                                 │
│     { shardKey:'§sys:<dir>', members:[paths], depends:['§sys:*'], focus }           │
│   focus synthesized deterministically: this shard's hotspots.json titles +          │
│   its resolved-imports.json top hubs.  REPLACES Mycelium's hand-authored SPECS[].   │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │  fan-out  (deterministic-first: only hot/large shards get an agent; rest sampled)
┌───────────────▼───────────────────────────────────────────────────────────────────┐
│ (d) LLM SWARM   parallel() agent fan-out, each with a JSON schema                   │
│   Layer 1  per-subsystem analyzers   → ANALYSIS_SCHEMA (local smells)               │
│   Layer 2  cross-cutting passes (whole-repo breadth), each seeded by recon:         │
│        • error-handling / contract-drift  (seed: graph-ui edges + role='route')     │
│        • magic-numbers / config-drift     (seed: hub constants files)               │
│        • type-safety / res.ok / parse     (seed: route nodes, hub fan-in)           │
│        • ui-centralization                (seed: design-system-consolidation kind)  │
│        • safety-security                  (seed: role tags route/db/ai + PII-logs)  │
│   compliance: NO agent — privacy.json already final, unioned in at merge            │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │  all returns validated against schema; non-conforming rows repaired/dropped
┌───────────────▼───────────────────────────────────────────────────────────────────┐
│ (e) ADJUDICATION / DEDUP   version-adjudicator + independent refuter (REUSED)        │
│   confirm/reject each finding from code (default-skeptic); refuter must fail to      │
│   refute a 'confirmed'.  Drop unanchored (file:line not in graph.resolved.json).    │
│   UNION LLM findings with deterministic hotspots into ONE sortable pool.            │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────────────────────────┐
│ (f) AGGREGATOR   single report-writer (assess-codebase as the writer)               │
│   Executive themes (4-6) · Severity×Effort matrix · dimension sections              │
│   semantic dedupe + (overlaps …) back-refs; pin required-section list               │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────────────────────────┐
│ (g) PHASED PLAN GENERATOR   topo-sort over dependsOn → Phase 0..N (§5)               │
│   findCharacterizationGateViolations() as deterministic safety check on the SEQUENCE │
│   → docs/refactoring-scan.md  +  planOutputSchema persisted to RefactorAuditRecord   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Stage notes.**

- **(a) Ingest** reuses `git-clone.mjs`. The whole run is one daemon job on EC2; the clone is the
  read-set. For compliance/privacy, source **never leaves the box** (audited via
  `privacy.transfer` boundary events).
- **(b) Recon** is reused unchanged. Its exit-code contract (`2=graphify-missing`,
  `3=degenerate-build`) is the **trust gate**: a degenerate build means the structural substrate is
  not reliable enough to ground a swarm, and the orchestrator falls back to a pure-LLM recon or
  aborts with a clear status rather than grounding agents on garbage.
- **(c) Subsystem decomposition** is the pivotal new piece. Mycelium hand-authored a ~14-entry
  `SPECS[]` list (its admitted soft spot — boundaries drift from reality). We instead derive
  boundaries from the AST graph: `subsystem-extract.mjs` already emits one `docShard` per module
  boundary off `.mycelium/ast-facts.json`. Each shard's `members[]` **is** the scoped file list, its
  parent-dir **is** the subsystem name, its `depends[]` **is** the cross-module edge set for free.
  The `focus` line is synthesized deterministically from that shard's `hotspots.json` titles + its
  `resolved-imports.json` hubs, so each agent is steered at the actually-hot files. This removes the
  drift risk entirely.
- **(d) Swarm** keeps Mycelium's two-layer model: Layer-1 local smells (caught for free during spec
  analysis) + Layer-2 dedicated whole-repo cross-cutting passes (the only ones with breadth to see
  "27 copies of try/catch-to-500 across 22 routes"). Crucially, the cross-cutting passes are seeded
  with deterministic candidate lists ("here are the suspicious sites, confirm and characterize"),
  never "go find smells". Empty-agent protection: passes fall back to each other's evidence so an
  empty `ui-centralization` return never zeroes the UI section (Mycelium's UI agent returned nothing
  and the report recovered from the code-smell pass).
- **(e) Adjudication** reuses the `version-adjudicator` confirm/reject + independent-refuter pattern
  already in `assess-codebase.workflow.js`. Default-to-skeptic; the canonical baked-in false positive
  (a `primitives/` dir flagged as duplicate design-system that was actually a CV-export layer) stays
  in-prompt. Only confirmed findings reach the aggregator.
- **(f) Aggregator** is a single writer owning the merge so the same root (UI "ImpactBadge 0.5" +
  impact-analysis "0.5 hard-coded" + cross-cutting "magic numbers") collapses to **one** row with
  `(overlaps …)` links. JS pre-shapes inputs (tag area, exact-location dedupe); the writer only does
  semantic dedupe + prioritize + sequence.
- **(g) Plan generator** — §5.

---

## 3. Finding & Output Contract

### 3.1 Canonical finding schema (ONE shape for deterministic + LLM findings)

Both the deterministic detectors and the LLM analyzers emit (or are mapped, on the way in, to) the
same record, mirrored onto our `extractor-envelope.mjs` convention so a `knip` dead-code row and an
LLM `res.ok` finding **union into one sortable pool**:

```ts
interface ScanFinding {
  id: string; // stable, location-keyed
  dimension:
    | 'architecture'
    | 'safety-security'
    | 'compliance'
    | 'code-quality-refactoring'
    | 'correctness';
  area: string; // a §sys:<dir> shardKey | 'cross-cutting' | 'UI' | 'A / B' overlap
  severity: 'High' | 'Medium' | 'Low' | 'Low–Med';
  effort: 'Trivial' | 'Small' | 'Medium' | 'Large' | string; // compound: "Small (delete) / Medium (wire)"
  location: string; // REAL relative path + ':line' — schema-required, post-checked
  issue: string; // <12 words for the matrix cell; longer prose allowed
  suggestion: string; // names exactly ONE centralized artifact (apiFetch<T>, batchPut, withErrorHandling)
  evidence: Record<string, unknown>; // structured pointer (methods/importers/community/copies/cohesion); NEVER a code dump
  source: 'deterministic' | 'llm'; // provenance for cross-check
  confidence?: number; // adjudicated findings only
  dependsOn: string[]; // other finding ids this remediation must follow (foundations-first)
  overlaps?: string[]; // dedupe back-refs to the same root finding
}
```

This is additive over the existing `AuditHotspot { kind, score, severity, title, files[], evidence,
suggestedAction }` — `effort`, `dimension`, `dependsOn` are the net-new fields (exactly the missing
axes the report/plan audit names). Severity seeds from `hotspot-detect`'s calibrated
`severity/score`; **`effort` is the one axis recon cannot compute** and is assigned by the
adjudicator/aggregator (heuristic floor from `files.length` + `evidence.methods/importers/copies` +
hub fan-in, refined by the LLM). Controlled vocabularies for `severity`/`effort` are enforced in the
schema so the matrix is machine-sortable.

### 3.2 Report contract (`docs/refactoring-scan.md`) — fixed section order

Reproduces the Mycelium exemplar exactly:

1. `# <Project> — Refactoring & System-Design Scan` (H1)
2. One `> blockquote` contract banner: scope + discipline rules (assessment not spec, no
   implementation code, no `[[wiki-links]]`, every finding anchored to a real path).
3. `## Executive Summary` — exactly **4–6 numbered themes**, each a **bold lead clause** naming the
   smell-class + 1–3 sentences citing concrete `file:line` exemplars, closing with one trailing
   paragraph of "correctness risks that sit on top" (the few High-severity bugs, distinct from debt).
4. `## Priority Matrix` — single table, columns **exactly** `Finding | Severity | Effort | Area`,
   sorted High→Low. The machine-sortable index; every finding appears here **once**.
5. `## UI Centralization & Design System` — lead paragraph (healthy primitive layer vs missing domain
   tier), then numbered `### N. <Component> — <role>` subsections with the fixed 4-bullet shape
   **Problem / Adopt in (every `file:line`) / Centralized component (signature) / Win**; closing
   `> design-system note` blockquote.
6. `## Cross-Cutting Concerns` — `###` sub-buckets in fixed order: Error handling, Data-access
   duplication, Type safety, God files. Each bullet = **bold title** + `(Severity)` + `file:line`
   evidence + bold **Plan:** naming one helper/HOF/type.
7. `## Per-Subsystem Notes` — one `### <subsystem> (\`paths\`)`block per shard; High-severity bullets
lead with **High:**, many carry`(overlaps X)` back-refs.
8. `## Recommended Sequencing` — lead sentence stating the ordering principle, then **Phase 0..N**
   entries (§5).

**Invariants** (deterministically post-checked): no implementation code; no `[[wiki-links]]`; every
finding traces to a path that exists in `graph.resolved.json`'s node set; each finding appears once
in the matrix and once in its home section, cross-linked by `(overlaps …)` not duplicated.

### 3.3 Machine contract (persistence)

Unchanged transport: denormalized `refactorAuditSummary` on the `futurator-agent-jobs` row + durable
`RefactorAuditRecord { auditId, projectId, jobId, status, counts, hotspots, verdicts?, plan?,
privacy?, graphAvailable }`. New fields (`findings[]` with effort, `executiveThemes[]`, `phases[]`)
ride **additively** so the single `selectAuditReport` / `reportFromRecord` view picks them up without
rewiring (per the report/plan audit's "keep new fields additive" reuse note). Full finding set →
S3 `knowledge-live/<appId>/_refactor/scan.json`; capped rollup on the row.

---

## 4. (covered above — see §3.2 for the report contract)

---

## 5. The Phased Plan Generator (the differentiator)

The user's core ask. v1 has **no global ordering** — only per-hotspot Strangler-Fig and
judge-discretion `epic.dependsOn`. v2 makes Sequencing a **topological sort over the rework
dependency graph**, not a severity sort, because severity-first forces re-touching the same files
3× as later phases re-extract.

### 5.1 Inputs

- The adjudicated `ScanFinding[]` pool (each with `dimension`, `effort`, `severity`, `dependsOn`,
  `area`).
- The real dependency DAG: `subsystem-extract` shard `depends[]` + `resolved-imports.json` fan-in.
  **High-fan-in shards are foundational** (everything lands on them → early phases); leaf shards
  (UI, god-files) are late.

### 5.2 Dependency model (how `dependsOn` edges are derived deterministically before the LLM judges)

Edges come from three rules, layered:

1. **Foundation-before-consumer (fan-in rule).** If finding B's remediation introduces/changes a
   shared artifact in a high-fan-in shard (a constant, an envelope type, a helper), every finding
   that consumes that artifact gets `dependsOn: [B]`. Computed from `resolved-imports.json` hubs:
   a magic-number finding in `graph-canvas.tsx` depends on the "introduce `IMPACT_CRITICAL_THRESHOLD`"
   finding because the constants module is a hub.
2. **Strangler-Fig per item.** For any `duplicate-subsystem` / `design-system-consolidation` /
   dead-code remediation, the **deletion** sub-finding `dependsOn` its **extract** and **repoint**
   sub-findings. Already enforced shape in `planOutputSchema`; v2 lifts it to the cross-hotspot
   graph.
3. **Characterization-net gate.** `findCharacterizationGateViolations(plan)` (Epic E1, already built)
   is reused as the **deterministic safety check on the global sequence**: `DELETION_RE`
   (delete|remove|drop|retire|repoint|consolidat|migrat|extract) flags mutators; `CHAR_NET_RE`
   (characteriz|playwright|test net|e2e|smoke|golden|snapshot|baseline) + `needsBrowser` identify net
   findings; any mutator on an untested route that does not transitively `dependsOn` a net finding is
   a **violation → plan rejected before ship**. Each deletion is additionally gated on
   **grep-zero + a passing test** as an acceptance criterion.

### 5.3 Algorithm

```
1. NORMALIZE   union deterministic + LLM findings; assign effort; key by location.
2. BUILD DAG   nodes = findings; edges = dependsOn from §5.2 rules (1)(2)(3).
3. ASSIGN PHASE BANDS by dimension + role + effort (the canonical 0..6 ladder, §5.4):
      band(f) = f(dimension, area-role, isFoundation, isDeletion, effort)
4. TOPO-SORT within bands; a finding may be PULLED LATER (never earlier) if a dependsOn
   target sits in a later band — preserves "foundations first" without cycles.
5. SAFETY PASS  findCharacterizationGateViolations over the linearized sequence;
                inject a characterization-net finding before any unguarded mutator,
                re-topo-sort.  If still violating → reject (plan:null), surface the violation.
6. EMIT phases[]: each Phase N = { name, tag(effort/clarity), items[findingId], why }.
   'why' states what later phases land ON these — the rework-minimization proof a human gates on.
```

`effort` is the tie-breaker _within_ a band (cheap-high-value wins float up): a High/Trivial dead-code
delete leads Phase 0; a High/Large god-hook split is quarantined to Phase 4.

### 5.4 Canonical phase ladder (worked example, grounded in the scan's Phase 0–6)

| Phase | Name                                       | Why it precedes the next                                       | Members (deterministic source)                                                                                                                                                                                                                           |
| ----- | ------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Stop-the-bleeding (Trivial)                | Free; reduces confusion for every later diff                   | `knip.json` safe-candidate dead code (`suggestions.ts` whole-file dead) + mechanical fixes (`haNode` typo, stale dynamic imports)                                                                                                                        |
| **1** | Shared constants & contracts (foundations) | Every later extraction lands on these                          | Highest-fan-in seams: centralize `IMPACT_CRITICAL_THRESHOLD` (0.5 hard-coded in `graph-canvas.tsx`+`node-inspector.tsx`); define one API envelope + `withErrorHandling`; promote shared types (kills `{error:string}` vs `{error:{code,message}}` drift) |
| **2** | Shared infrastructure helpers              | Build helpers before the UI/decomp that consume them           | `upsertFileVersioned`, `makeEventId`, `batchPut`/`batchDelete`, `apiFetch<T>` — collapses the duplicate versioned-write copy-pasted across orchestrate/graph/generate routes                                                                             |
| **3** | UI centralization                          | Build the domain-component tier on now-settled constants/types | `design-system-consolidation` hotspots → `ImpactBadge({score})`, `MaturityIndicator`, `DeleteProjectDialog`, `InspectorPane`                                                                                                                             |
| **4** | God-file decomposition                     | Cheap once helpers exist                                       | `hotspot-detect` top size/fan-in `god-object` (the 795-line `use-mycelium.ts` hook; thin `page.tsx`)                                                                                                                                                     |
| **5** | Correctness fixes                          | Now isolated behind one shared seam → fix in one place         | `res.ok` gaps; the unbatched `storeChunks` >128 hard-throw; `deleteProject` unpaginated 500-cap orphan rows; chunker non-progress boundary bug                                                                                                           |
| **6** | Scale & quality (Large, optional)          | Largest, lowest-urgency                                        | route auth, pagination programs, perf                                                                                                                                                                                                                    |

Each Phase entry in the report is `**Phase N — <name> (<tag>).**` + a paragraph naming the concrete
items and **why they precede later phases** — that justification _is_ the executable plan, not a
wishlist.

### 5.5 Output

The plan emits as both (a) the `## Recommended Sequencing` prose section in
`docs/refactoring-scan.md`, and (b) `planOutputSchema { plan: { epics[{ id, dependsOn[],
stories[{ dependsOn[], touchPoints[], criteria[{needsBrowser, verify}] }] }] } }` persisted to
`RefactorAuditRecord.plan` — the ready-made hand-off into create-story/dev-story. Phase N maps to an
epic; `dependsOn` carries the topo edges; each deletion story carries a grep-zero + passing-test
criterion.

---

## 6. Reuse Map

| Existing component                    | Path                                      | Role in v2                                                                                          | Net-new to build                                            |
| ------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `recon.mjs` chain                     | `daemon/scripts/refactor-recon/recon.mjs` | Stage (b) verbatim; trust gate via exit codes                                                       | none — reuse                                                |
| `alias-resolve.mjs`                   | same dir                                  | Authoritative fan-in for foundation-rule edges + blast-radius weighting                             | none                                                        |
| `hotspot-detect.mjs`                  | same dir                                  | Seeds 5 architecture finding kinds + severity column                                                | map rows to `ScanFinding` shape on ingest                   |
| `privacy-detectors.mjs`               | same dir                                  | Role/provider tags → dimension routing (db→data-contract, ai→prompt/safety, thirdParty→integration) | none                                                        |
| `privacy-scan-internal.mjs`           | same dir                                  | Compliance dimension — **already complete**, unioned at merge                                       | none (no LLM)                                               |
| `graph-project.mjs` → `graph-ui.json` | same dir                                  | Contract-drift edge pairing; UI graph already rendered                                              | none                                                        |
| `subsystem-extract.mjs`               | `daemon/scripts/extractors/`              | Stage (c) — `members[]`+`depends[]`+`focus` replace hand-authored SPECS                             | **synthesize `focus` from hotspots+hubs**; cap/sample logic |
| `extractor-envelope.mjs`              | `daemon/scripts/lib/`                     | One validated shape for deterministic + LLM findings                                                | extend to `ScanFinding`                                     |
| `assess-codebase.workflow.js`         | `.claude/workflows/`                      | Stages (e)+(f) — adjudicator + single report-writer                                                 | new required-section prompt; add Executive themes + matrix  |
| version-adjudicator + refuter         | in the workflow                           | False-positive guard, default-skeptic                                                               | reuse pattern per analyzer                                  |
| `findCharacterizationGateViolations`  | (Epic E1)                                 | Deterministic safety check on the **global** sequence                                               | apply at plan-level, not just per-epic                      |
| `refactor-audit-job-runner.mjs`       | `daemon/pipelines/`                       | Job substrate; spawns recon already                                                                 | **new job kind** wrapping the swarm + plan                  |
| `parallel()` agent fan-out            | `functions/shared/pipelines/`             | Map-reduce substrate for the swarm                                                                  | analyzer/cross-cutting prompts + schemas                    |
| `ground-truth-injection.mjs`          | `daemon/pipelines/`                       | Closed shardKey vocabulary for `area`/crossRefs; anchor post-check                                  | constrain analyzer outputs                                  |
| assess UI (dashboard/graph/privacy)   | `src/components/labs/app-detail/assess/`  | Render — additive fields (effort, themes, phases) picked up by one view                             | matrix + themes + phase render                              |
| `doc-assembler.mjs`                   | `daemon/scripts/lib/`                     | Precedent: deterministic merge feeding one authored doc                                             | reuse pattern for report assembly                           |

---

## 7. Any-Repo Ingestion

**Flow.** `GitHub URL or upload → git-clone.mjs (EC2 clone) → recon.mjs → subsystem-extract →
swarm → adjudicate → aggregate → plan`. One daemon job, one working directory = the read-set. Source
never leaves the box (compliance/privacy boundary events log host, never the key).

**Language coverage.** Recon walks `.ts/.tsx/.js/.jsx/.mjs/.cjs` only (graphify + alias-resolve +
knip). Non-JS/TS surfaces (YAML/JSON/SQL/IaC) get **path-based provider/compliance tagging** via
`privacy-detectors.mjs` `PATH_DETECTORS` but no structural graph. For a polyglot repo, the
structural skeleton covers the JS/TS surface; everything else is surfaced as
role/provider/compliance findings only, **explicitly logged as "structural analysis skipped: N
non-JS files"** so the report never silently implies full coverage. `recon-calibration.json`
externalizes convention filenames, UI-dir pattern, version markers, exclude dirs and thresholds so a
fresh framework is tuned without code edits.

**Cost & scale guards (deterministic-first):**

- **Trust gate first.** A `degenerate-build` (exit 3) or `graphify-missing` (exit 2) skips the swarm
  entirely or falls back to pure-LLM recon — no tokens spent grounding on a bad substrate.
- **Subsystem cap.** `graph-project.mjs` already caps at 1500 nodes keeping all hotspot files +
  highest-degree. Mirror that for agents: only shards containing a hotspot or above a fan-in
  threshold get a dedicated analyzer; the rest are **sampled** (top-fan-in member read) and the skip
  is logged.
- **Token-bounding.** Analyzers read only `members[]` / `hotspot.files[]` (severity-ranked, `--top`
  capped), never the whole repo. High-cardinality finding sets (privacy ~10k flat) are
  **category-rolled** before reaching any LLM (`summarizePrivacyReport` pattern: full set parked in
  S3, only the rollup + worst-N drill-down samples in context).
- **Blast-radius weighting.** `inDegree` from `resolved-imports.json` is a finding multiplier so the
  swarm prioritizes high-fan-in files (a fragile-parse on a 115-importer hub ≫ on a leaf).

---

## 8. Build Roadmap

A new daemon **dynamic-workflow job kind** (mirroring the dual-agent / `refactor-audit-job-runner`
pattern), built in dependency order so each phase lands on the prior:

| Build phase                               | What                                                                                                                                                                                        | Files / surface                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **B0 — Subsystem decomposer**             | `focus`-synthesis: join `subsystem-extract` shards to `hotspots.json` titles + `resolved-imports.json` hubs; cap/sample logic                                                               | extend `daemon/scripts/extractors/subsystem-extract.mjs`; new `subsystem-focus.mjs`                       |
| **B1 — Finding schema + envelope**        | `ScanFinding` shape; map `hotspot-detect`/`knip`/privacy rows into it; schema validation + anchored-path post-check                                                                         | extend `daemon/scripts/lib/extractor-envelope.mjs`; new `functions/shared/schemas/scan-finding-schema.ts` |
| **B2 — Analyzer + cross-cutting prompts** | per-subsystem ANALYSIS_SCHEMA agent; 5 cross-cutting passes (error/contract, magic-numbers, type-safety/res.ok, ui-centralization, safety-security) each recon-seeded; empty-agent fallback | new prompts under `functions/shared/prompts/`; `parallel()` calls with `{schema}`                         |
| **B3 — Adjudicator + aggregator**         | reuse version-adjudicator + refuter; single report-writer with pinned required sections; semantic dedupe + `(overlaps)`; Executive themes + Severity×Effort matrix                          | extend `.claude/workflows/assess-codebase.workflow.js`                                                    |
| **B4 — Phased plan generator**            | `dependsOn` edge derivation (fan-in + Strangler-Fig); topo-sort into Phase 0..N; reuse `findCharacterizationGateViolations` on the global sequence                                          | new `daemon/pipelines/lib/phase-planner.mjs`                                                              |
| **B5 — Job runner + UI**                  | new `scan-engine-job-runner.mjs`; additive fields on `refactorAuditSummary`/`RefactorAuditRecord`; matrix + themes + phase render in the assess tab                                         | new `daemon/pipelines/scan-engine-job-runner.mjs`; extend `src/components/labs/app-detail/assess/`        |

**Cost discipline (the through-line):** deterministic-first token law — recon (~0 tokens) does all
structural work; LLM spend is bounded to per-subsystem `members[]` reads + cross-cutting confirmation
of pre-flagged candidates + one aggregator pass. Compliance spends **zero** LLM (privacy already
final). Every LLM claim is anchored to a path post-checked against `graph.resolved.json`; unanchored
findings are dropped before the writer, so no tokens are spent narrating hallucinations.

---

## 9. Open Questions & Risks

1. **Community quality on flat / hub-and-spoke graphs.** Leiden communities can be arbitrary on flat
   graphs, so subsystem boundaries (and therefore agent scoping) may be meaningless for some repos.
   Mitigation: fall back to parent-dir grouping when cohesion math is degenerate; flag low-confidence
   decomposition in the report. _Open: what cohesion floor triggers the fallback?_
2. **Effort estimation is the soft axis.** `effort` has no deterministic ground truth; a bad estimate
   mis-sequences phases (a "Small" that's actually "Large" pollutes Phase 0). Mitigation: heuristic
   floor from files/methods/copies/fan-in, LLM refines, human gate before any build spend.
3. **Cross-cutting passes can still hallucinate breadth.** Seeding reduces but does not eliminate
   invented edges. The anchored-path post-check + adjudicator refuter are the guard; _open: do we need
   a deterministic `res.ok`/magic-number AST pass to seed those two passes the way hotspots seed the
   architecture ones?_ (Recon audit lists both as strong deterministic candidates.)
4. **Polyglot coverage gap.** Non-JS/TS logic is structurally invisible; a Python/Go-heavy repo gets a
   thin skeleton. Honest "skipped N files" logging is necessary but the plan's value degrades. _Open:
   per-language graphify adapters, or scope v2 to JS/TS repos explicitly?_
5. **Global plan is still single-app / single-audit.** No cross-app program of work (report/plan audit
   blind spot). v2 closes the _intra_-audit ordering gap; a portfolio-level roll-up is future work.
6. **Dynamic-dispatch dead-code false positives** survive into the plan if the swarm's
   dynamic-dispatch hunt misses a string registry. Mitigation: dead-code deletions are always
   gated on grep-zero + passing test; `needs-review` set is explicitly handed to the LLM, never
   auto-deleted.
7. **Aggregator context limits.** A very large repo may exceed the single report-writer's context even
   after category-rolling. _Open: do we shard the writer by dimension and stitch, risking the loss of
   cross-dimension `(overlaps)` dedupe that the single-writer design exists to provide?_
