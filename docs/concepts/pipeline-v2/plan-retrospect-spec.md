# Feature Spec — Plan Retrospect

> **Status:** DRAFT (revised, implementation-ready) — supersedes the working draft [`pipeline-scorecard-spec.md`](./pipeline-scorecard-spec.md) (kept as historical draft; "Scorecard" was the prior working name).
> **Author:** Claude (concept-develop synthesis pass — folds the rubric §12–15 contributor sections into one canonical spec).
> **Created:** 2026-06-18
> **Consumes:** [`pipeline-quality-rubric.md`](./pipeline-quality-rubric.md) (the clarified rubric: §0 framework + §0.5 output schema, §1 axes D1–D6, §2–§7 stage tables, §8 IE→F detector catalog, §9 aggregation + hard caps) + the forensic JSON (`GET /plans/:id/timing/forensic`) + plan/epic/story DDB rows + the graph reports under `knowledge/_graph/`.
> **Companion to:** [`pipeline-v2.5-fixes-plan.md`](./pipeline-v2.5-fixes-plan.md) (findings F1–F28, tracks A–I).
> **Opens / depends on:** a separate [`pipeline-versioning-spec.md`](./pipeline-versioning-spec.md) (§9 here).

> **Calibration caveat (read first).** Every numeric threshold this spec inherits from the rubric is **v0, single-run calibration against `plan_pacman3_mqi8x64w` (pacman3, mvp rigor)** — **not yet validated across runs.** Plan Retrospect is the instrument that _gathers_ the multi-run evidence to re-calibrate them; until ≥5 comparable runs exist, every threshold is provisional and the Reality Check must label it so. **Nothing in this feature is hardcoded for pacman3 or any specific plan** — pacman3 is only the first data point that seeds the thresholds. The detectors read fields, never plan names.

---

## 1. Names (locked)

The operator has named all three layers. **These are final** for this feature — do not reintroduce "Scorecard" as the feature name. It survives only as a historical note **and in internal identifiers** (the module path `functions/shared/scorecard/`, repo `scorecard-repository.ts`, table `futurator-scorecards`, jobType `scorecard-assess`, API segment `/scorecard/`), kept to avoid a needless rename of in-flight code.

> **User-facing surface rule:** every operator-visible string says **"Plan Retrospect" / "Reality Check" / "The Assessor"**. "Scorecard" survives ONLY in internal code identifiers (module paths, table name, jobType, repo function names). The API route segment `/scorecard/` is an internal identifier (visible only in network calls, not UI copy) — acceptable, but the frontend hook and UI never render the word.

| Layer                           | **Locked name**     | What it is                                                                                                                                            |
| ------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System / feature**            | **Plan Retrospect** | The mechanism: takes a completed plan's forensic + the rubric, runs analysis stage-by-stage from the UI, emits the report.                            |
| **The report (per-run output)** | **Reality Check**   | The rubric-against-reality match for one plan: every stage/substage scored, every problem named + linked to its fix, every red turned into an action. |
| **The grading LLM persona**     | **The Assessor**    | The agent that grades the `[LLM]` criteria that require reading artifacts and judging. Fits the BMAD cast — Murat _gates_, **the Assessor _grades_.** |

UI copy reads naturally: _"Run Plan Retrospect on Development → read the Reality Check → the Assessor flagged 4 reds."_

---

## 2. Intent & where it fits

The pipeline already has a **Reflector** — an automatic, advisory learning pass at wave/plan close that writes prose to `inbox/reflections.md`, currently **IAM-blocked → `written=0`** (rubric OV8, fix F5). Plan Retrospect is its **deliberate, operator-driven, rubric-anchored** counterpart, and the **honest closure of OV8** the Reflector cannot currently complete: a durable, comparable, operator-visible verdict.

|             | Reflector (exists, F5-blocked) | **Plan Retrospect (new)**                                                       |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Trigger     | automatic at scope-close       | **operator, per-stage, from the UI**                                            |
| Input       | git-log slice + inbox cursor   | **forensic JSON + rubric + plan/epic/story DDB + `_graph` reports + artifacts** |
| Output      | free-form prose proposals      | **structured scorecard (rubric §0.5 schema) → Reality Check**                   |
| Anchored to | nothing fixed                  | **the versioned rubric** (comparable run-over-run)                              |
| Closes      | —                              | **OV8 learning-loop** + feeds the fixes-plan backlog / Reflector inbox          |

They are complementary: the Reflector notices things continuously; Plan Retrospect **grades the run against a standard and produces a comparable, durable verdict.** Across many runs it answers the question that _is_ self-improvement: _"did the v2.5 fixes actually make the pipeline better?"_

The forensic builder already does the deterministic heavy lifting (slices, `aggregate.byCategory`, the `skills` block) with **no LLM calls** — Plan Retrospect's deterministic scorer reuses those primitives directly (`sliceForPlan`, `aggregateByCategory`, `buildSkillsBlock`).

> **Reuse note — `buildForensicPayload` signature (reviewer fix #8).** The real signature is `buildForensicPayload(planId, cohortFetcher)` (`forensic-builder.ts:478`); **`cohortFetcher` is required** and the call does a full event scan + cohort fetch. For deterministic stages that do **not** need the cohort baseline, the scorer calls the underlying primitives **directly** — `sliceForPlan(planId)` + `aggregateByCategory(slices)` + `buildSkillsBlock(...)` — avoiding the cohort I/O. The scorer calls full `buildForensicPayload` **only** when it needs `cohort`/`narrative` (Phase 3 trend work), passing a real `cohortFetcher`. Phase 1 uses the primitives path (cheaper, no 404-prone cohort fetch).

> **Safety posture (reviewer fix #11).** Plan Retrospect is **read-only against the public bucket** (`futurator-ai-website`): it only **reads** `knowledge/_graph/*.json` and reads DDB/forensic; it **writes exclusively to its own DDB table** `futurator-scorecards`. It never calls `aws s3 sync`, never touches `out/`, never writes the public bucket. The feature therefore _satisfies_ the DP-S1/P-S1 scoped-path safety criteria it grades. (Per the CLAUDE.md 2026-04-15 incident guardrail.)

---

## 3. The output: a Reality Check

For a plan + stage, the Reality Check answers three questions.

1. **Score** — every rubric criterion graded 0–4 with 🟢/🟡/🔴, rolled up substage → stage → pipeline-health (rubric §0.3 aggregation + §9 weights), **with the rubric's hard caps applied** (verbatim from rubric §0.3 / §9 — see §3.6 below).
2. **Rubric-against-reality match** — for each criterion: the **evidence quote/anchor** that justifies the score (a forensic metric, a daemon-log anchor, a diff, a `_graph` report field), and whether this run **reproduced a known anti-pattern** — every detected IE auto-linked to its F-finding(s) via the rubric §8 IE→F map, **each finding rendered with its own shipped/open state** (never collapsed to a single F). The operator sees _"this run hit IE1 compile thrash = 87/story (🔴) → F1 (open)."_
3. **So-what** — `topRegressions` / `topWins` and a generated **improvement-action list**: each 🔴/🟡 → a proposed action (link an existing F-finding, or draft a new candidate `F<n>`) → pushable to the fixes-plan backlog / Reflector inbox.

> **Baseline scope (reviewer fix #12).** In **Phase 1–2**, `topRegressions`/`topWins` are computed **vs the v0 pacman3 baseline only** (a single stored reference scorecard) — there is **no cohort/version-aware diffing**, because honest cohorts require pipeline-versioning (§9, Phase 3). The ▲/▼ trend and sparkline are **explicitly stubbed** ("trend available in Phase 3 once pipeline-versioning lands") until §9 ships. The implementer must NOT build run-over-run comparison in Phase 1; it would silently average pre-fix and post-fix runs and lie.

### Example (abridged) Reality Check — **Development** stage on a future run

```
DEVELOPMENT — 0.58 (C)   [thresholds: v0/pacman3, unvalidated]   [trend: Phase 3]
  compile-loop        🔴  D-CC1 compiles/story = 71            → IE1 / F1 (open)
  wave-vqa            🔴  D-VQ1 unverifiable 38%               → IE9 / F8 (open)
  skills/activation   🔴  SK2 activation 5.2% (IE25)          → F24 (open)
  skills/scout        🔴  SK4 scout 0 runs (IE26)             → F25 (open)
  skills/loadout      🔴  SK3 embeddings write-only (IE27)    → F27 (open)
  knowledge-graph     🔴  D-KC3 orphans 14 (orphans.json)     → IE17 / F14 (open) · F15 (open) · F17 (shipped 0d5dd6a)
  merges/git-graph    🟢  D-MG1 all waves clean; trailers complete
  test-authoring      🟡  D-TA2 author/dev ratio 0.82         → IE7 / F7 (open)
  parallelism         🔴  D-WS1 factor 1.04× (IE11)           → F10 (open)
  ACTIONS: ship F1 (compile cache) ▸ ship F25→F27→F24 (scout→rank→push skills) ▸ ship F14+F15 (full-project ast-facts + prune; verify F17 held) ▸ ship F16 (surface orphan invariant) ▸ widen waves (F10)
```

Note: the graph row renders **all three** IE17 findings with per-finding state (matching the §8 map `F14+F15+F17`), and the orphan-_surfacing_ fix **F16** appears in the action line (it is the cheap "make the FAIL visible" fix, distinct from the AST-facts and prune fixes). `ie-to-f-map.ts` is the single source of truth; the card never invents or omits a mapped finding.

---

## 4. Architecture — hybrid engine (deterministic + Assessor)

Grading splits so we never pay an LLM for arithmetic and never ask a deterministic function to judge prose. Two engines + a composer.

```
forensic JSON ───┐
plan/epic/story  ─┼─▶ [4a Deterministic scorer]──┐
  DDB rows        │   (Lambda, no LLM)            │
knowledge/_graph ─┘                               ├─▶ [4c Composer]─▶ Reality Check + actions ─▶ futurator-scorecards
  reports (S3)                                    │                                              (DDB)
artifacts (docs/ ─▶ [4b The Assessor]─────────────┘
 diffs/reports)      (daemon agent job, per stage)
                     receives 4a scores as ground-truth context
```

### 4a. Deterministic scorer — `functions/shared/scorecard/` `[no LLM]`

A pure-function module that computes **every `[DET]` criterion + all IE/OV/SK detectors** directly from data. Runs **in the API Lambda on request** — fast, free, reproducible, unit-testable. Resolves **inline** in the `POST …/run` response (no daemon round-trip for deterministic stages).

**Inputs (all already available; no new instrumentation required for Phase 1 — except the one graph prerequisite called out below):**

- `ForensicPayload` primitives — `sliceForPlan`, `aggregateByCategory(slices)`, `buildSkillsBlock(...)` (see §2 reuse note). Provides `slices`, `aggregate.byCategory`, `skills`, `plan`, and `events[]`.
- Plan + epic/story DDB rows (`getPlanById`, `getEpicById`) — counts, costs, timestamps, **`story.origin === 'wave-vqa-fix'`** (the real field; **there is no `story.fixesWave`** — reviewer fix #9), **`epic.waveBuildJobs`** (wave→buildJobId map), `qaContractStatus`, **`plan.deployJobIds`** _and_ **`app.deployJobIds`** (both exist — prefer `plan.deployJobIds`, fall back to the app's, mirroring `deploy-report-aggregator.ts:191-193`), `deployEnvironment`.
- Stage reports: `qa-report-aggregator`, `deploy-report-aggregator` (incl. `environments[].smokeStatus`/`activeJobId` from F21), `reflections-repository`.
- **Graph reports under `knowledge/_graph/` (S3)** — see the corrected graph-read contract below.

#### Graph-read contract (reviewer fixes #1, #2 — corrected)

The earlier draft claimed the scorer reads `orphanCount` from `graph-snapshot.json`. **That is wrong.** The actual artifacts (`daemon/scripts/graph-sync.mjs`):

- **`knowledge/_graph/graph-snapshot.json`** — written by `writeGraphSnapshot()` (line ~1541). Fields are **only** `{ projectId, generatedAt, nodeCount, edgeCount, nodes[], edges[] }`. It has **no `orphanCount`, no `fileCount`, no floaters, no projectId-distribution field.**
- **`knowledge/_graph/orphans.json`** — written by the orphan invariant (`writeReport('orphans.json', …)`, line ~1020). Fields: `{ projectId, generatedAt, status: 'pass'|'fail', orphanCount, hardFailCount, byKind, orphans[], hardFail[] }`. **This is where the orphan FAIL signal already lives, at zero added cost.**
- **`knowledge/_graph/dead-code.json`** — dead/zombie nodes (line ~1033), for D-KC3 zombies / IE19.

**Read path & access.** All reports live under **`knowledge/_graph/`** in the **project's knowledge prefix**. `graph-sync.mjs` writes them to `config.knowledgeDir/_graph/` locally; the existing S3 sync mirrors `knowledge/_graph/` to the public bucket for the Graph tab, and the daemon's `s3-backup.mjs` separately mirrors to `knowledge-live/<projectId>/_graph/`. **The scorer reads the canonical authored path** — `knowledge/_graph/<report>.json` under the project's knowledge prefix — and must NOT assume the `knowledge-live/<projectId>/` backup mirror (that is a separate, possibly-lagging copy). The Lambda needs **read** access to that bucket/prefix (an S3 `GetObject` IAM grant on the knowledge prefix — add to the API Lambda role in `sst.config.ts`).

**Detector consumption (corrected):**

- **D-KC3 / IE17 (orphan accumulation)** → read **`orphans.json`** `orphanCount` + `status` **directly** (graphify directive holds — the FAIL signal exists; we just read the right file). Zero log-parsing.
- **D-KC2 / IE16 (AST-facts truncation)** → `orphans.json` does not carry `fileCount`; read **`ast-facts.json`** `fileCount` ÷ project source-file count (rubric §3.8 D-KC2 anchor). If `ast-facts.json` is worktree-scoped (the IE16 defect itself), the low ratio _is_ the red.
- **D-KC3 zombies / IE19** → `dead-code.json`.
- **D-KC5 / IE18 (projectId drift)** → derive from `graph-snapshot.json` `nodes[]` projectId field distribution (now self-healing post-F17; scorer confirms it stayed healed).
- **D-KC6 floaters / orphan derivation fallback** → if a future run lacks `orphans.json`, the scorer **derives degree-0 nodes itself** from `graph-snapshot.json`: a `code/*` node (`file`/`function`) whose `id` appears in **no** `edges[].source` and **no** `edges[].target`. This fallback makes the detector robust even if the report file is absent.

> **F16 nuance (reviewer fixes #1, #4, #5).** The orphan invariant _computes and writes_ `orphans.json` today, but **F16 is the fix that makes the FAIL `status` SURFACE** instead of being swallowed (`exit 3`). So Plan Retrospect reading `orphans.json.status === 'fail'` is precisely the value-add **F16 hasn't shipped to the gate**: the retrospect makes the already-computed-but-swallowed signal operator-visible. Frame it as "the report exists; F16 surfaces it at the gate; the retrospect surfaces it in the verdict." **There is NO "graphify F13 placeholder" — that was a fabricated collision; drop it.** The real graph chain is **IE16→F14, IE17→F14+F15+F17, IE19→F15, orphan-surfacing→F16** (rubric §8 + §13). F13 belongs entirely to QA's Track F (state/behavior-AC-no-probe) — no collision exists.

**Module shape:**

```
functions/shared/scorecard/
  index.ts                 // scoreDeterministic(planId): Promise<DeterministicSlice[]>
  detectors/
    development.ts         // D-CC1..3, D-TA2, D-MG*, D-VQ1/3/5, D-WS1, D-PW*
    skills.ts              // SK1..SK6 from forensic.skills + registry state   ← §6 SKILLS
    knowledge-graph.ts     // D-KC1..D-KC6 from orphans.json / ast-facts.json / dead-code.json / snapshot
    qa.ts                  // Q-C5 cost, Q-C6 capture-rate, Q-C9 isolation (window overlap)
    deployment.ts          // DP-T1, DP-U1 (URL resolves), DP-L2 (copy vs rebuild), DP-O1
    overview.ts            // OV1..OV8, OV10, OV11
  ie-catalog.ts            // IE1..IE29 tripwires → {verdict, value, evidence, fixIds[]}
  ie-to-f-map.ts           // rubric §8 static IE→F map (single source of truth)
  rollup.ts                // §0.3 weighting + §9 aggregation + hard caps
  types.ts                 // ScorecardSlice, Verdict, EvidenceRef, ImprovementAction
```

Each detector returns a `ScorecardSlice` (schema in §4d). A detector's `value`, `verdict`, and `evidence` are deterministic functions of the inputs.

#### Exact computations for the previously-fuzzy criteria (reviewer fix #9)

- **D-CC1 (compile thrash per story)** = `aggregate.byCategory.compile.count ÷ devJobCount`, where **`devJobCount` = number of distinct daemon jobs with `jobType === 'epic-dev'` for the plan** (the unit that owns story implementation; resolved from epic/story DDB + job history). State this in code as `devJobCount`; do not say "÷ dev jobs" without defining it.
- **D-WS1 (parallelism factor)** = `aggregate.totalMs ÷ wallMs`, where **`wallMs = max(event.timestamp) − min(event.timestamp)` across the plan's collected events** (the observed wall-clock span). Do **not** use plan `createdAt→completedAt` (which includes idle/paused gaps that aren't agent work). Pin: `wallMs` is the event-span; a factor near 1.0× means no real overlap.
- **D-CC1-as-time / cost-derived criteria** — see the honesty guard below; these degrade when OV4 doesn't reconcile.

#### Honesty guard (resolves SQ4 — see §8; reviewer fix #10)

**Cost is not on forensic events.** Verified: `AgentEvent` carries **no per-event `costUsd`**; cost is materialized by the daemon as `walltimeSec × AGENT_COST_PER_SEC` in agent-spend rows (`agent-daemon.mjs` `writeAgentSpendRow`, `classifyAgentForSpend`). Therefore:

- **OV4 reconciliation** compares **the sum of the plan's agent-spend rows** (the daemon's walltime-derived cost, bucketed `pipeline-v2`) against **`plan.totalCostUsd`** (`plan.ts:221`) ±5% — **NOT** a non-existent "event-cost sum." The scorer must source cost from the agent-spend table, and the spec/implementer must wire that read (or reuse whatever the forensic builder already aggregates for cost; if the forensic builder does not expose a reconciled cost, the scorer reads agent-spend rows directly).
- When OV4 does **not** reconcile (the F2/F3 retry-orphan gap, where orphaned-log jobs are invisible so spend rows undercount), the scorer **does not emit a falsely-precise cost number.** It marks all cost-derived criteria (`OV2`, `OV3`, `Q-C5`, etc.) `value: "<lower-bound>", confidence: "unreconciled"` and the UI renders a caveat chip. It **still** scores _count/ratio_ criteria (compile counts, capture %, parallelism factor) that don't depend on absolute cost.

### 4b. The Assessor — daemon agent job, one per stage `[LLM]`

A Claude CLI agent job on the daemon that grades the `[LLM]` criteria — those that require _reading artifacts and judging_:

| Stage           | Assessor grades (`[LLM]` criteria)                                                                                                             | Artifacts it reads                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Concept**     | C-D1 doc completeness, C-D2 persona, C-D3/C-P1 **grounding** (does the doc build on upstream?), C-P2 spec coverage, C-G1 gate-decision quality | `concept/<kind>.md` + `<kind>.sections.json`, the plan's PRD/UX/arch, the epic/story tree, gate card                                 |
| **Development** | D-DV1 AC-satisfaction, D-DV2 scope/touch-points, D-DV3 context-pack use, D-RV1 review efficacy, D-TA1/D-TA4 AC↔test mapping & probe authoring  | story diffs (git), review event notes, authored `visualTests` (`flow`/`assert`/`level`), ship-contract `touchPoints`                 |
| **QA Review**   | Q-C1 claims extraction, Q-C2 contract decision, Q-C3 verdict calibration, Q-C4 remediation routing, Q-C8 oracle-hallucination guard            | `qa-report` (claims table, per-test rationale), verdict strip, remediation decisions; **the VQA PNGs only if SQ3 = depth mode** (§8) |
| **Deployment**  | DP-B2 framework-detect judgment, DP-I1 stage-isolation judgment, DP-S1 **safety judgment** (scoped-path), release/rollback sanity              | deploy report, DEPLOY agent log (config edits), `deploy-targets` resolution                                                          |
| **Publish**     | P-S1 **scoped-path safety judgment**, P-X1 projects.json integrity judgment                                                                    | publish log, S3 write paths vs the 4-path allowlist (CLAUDE.md)                                                                      |

**Key contract: the Assessor does NOT re-derive numbers.** It receives the **deterministic slice for its stage as ground-truth context** (the computed IE/OV/SK verdicts + values) and is instructed to _treat those as authoritative_ and only add the judgment layer. This prevents the LLM from hallucinating metrics — the exact failure class Q-C8 guards against in VQA, applied reflexively to the Assessor itself.

**Prompt structure** (per stage, templated):

1. **Role** — "You are The Assessor. You grade a completed pipeline stage against a fixed rubric. You never invent metrics; the deterministic scores below are authoritative."
2. **Rubric slice** — only this stage's `[LLM]` criteria, with anchors + the 0–4 scale + AGENT/MECH/OUTPUT tags.
3. **Deterministic context** — the `DeterministicSlice[]` for this stage (computed numbers + verdicts).
4. **Artifacts** — the stage's read-set (above), chunked.
5. **Output contract** — emit one object per `[LLM]` criterion in the schema of §4d. **Evidence must be a verbatim quote/anchor** from an artifact; an Assessor score without a citable quote is itself a `[needs-instrumentation]` red.

**Daemon wiring (reviewer fix #3 — corrected to real routing).** The daemon routes on **`job.jobType`** strings (e.g. `'wave-merge'`, `'epic-dev'`, `'skill-scout'`, `'skill-install'`, `'reflector'`, `'free-agent-session'`, `'party-turn'`, `'app-bootstrap'`). It does **not** have a `concept-gen` jobType — concept jobs are a `conceptAutopilotGen: true` flag — and `dev`/`qa`/`deploy` are pipeline _step ids_, not job types. So:

- Add a new **`jobType: 'scorecard-assess'`**. Model it on the **`reflector`**/**`skill-scout`** analogs — both are single-shot _read → grade → emit-JSON_ jobs (`runReflectorJob`/`runSkillScoutJob`), exactly the Assessor's shape — **not** the concept-gen autopilot pipeline.
- Route it at the same poll-loop dispatch site that branches on `job.jobType` (alongside the `reflector`/`skill-scout` branches). Implement `runScorecardAssessJob(job)` in `daemon/pipelines/scorecard-assess-job-runner.mjs`, mirroring `reflector-job-runner.mjs`.
- **Add `'scorecard-assess'` to `classifyAgentForSpend(job)` (`agent-daemon.mjs:6121`)** so its cost buckets as `pipeline-v2` (or a new `retrospect` bucket): extend the existing `if (t === 'wave-merge' || … || t === 'reflector')` clause.
- The API `POST …/scorecard/:stage/run` (for a stage with `[LLM]` criteria) computes the deterministic half inline, **stores it first**, then enqueues `{ jobType: 'scorecard-assess', planId, stage, rubricVersion, pipelineVersion, deterministicSliceRef }`. The job runner reads the stored deterministic slice, spawns the Claude CLI with the templated prompt, **streams events via the existing `StoryLiveOutput`** (the Assessor reads as a normal agent — same look as concept/dev), and on completion writes the Assessor slices + triggers the composer (4c).
- Gate it behind the same `agent.paused` flag the daemon already honors.

### 4c. Composer

Merges deterministic + Assessor slices → the full per-stage scorecard → rolls up via `rollup.ts` (§0.3 + §9 + hard caps) → renders the **Reality Check** with `topRegressions`/`topWins`/`pipelineHealth` (vs the v0 baseline only in Phase 1–2, §3) → generates **improvement actions** by:

1. Collecting every 🔴 / 🟡 slice.
2. Mapping each to its F-finding(s) via `ie-to-f-map.ts` (rubric §8), **rendering every mapped finding with its own shipped/open state**. A _shipped_ fix renders as _"fixed in `0d5dd6a` — verify it held"_; an _open_ fix as _"reproduces IE17 → ship F14/F15."_
3. **Three map cases** (reviewer fixes #4, #7): an IE may map to (a) one-or-more **F-findings** (most cases), (b) **a Story, not an F** (e.g. **IE28 → Story 4.2 (SK5)**, with **F26 as its enabling dependency**) — `ie-to-f-map.ts` represents this as `{ kind: 'story', ref: '4.2', dependsOn: ['F26'] }` so the composer does **not** fire its "draft a new F" path on IE28, or (c) **no mapping** → the composer drafts a **new candidate `F<n>`** the operator can ratify into the fixes plan.

Composer is pure + deterministic (no LLM): given slices, it always produces the same actions.

### 4d. The `ScorecardSlice` schema vs rubric §0.5 (reviewer fix #13)

The rubric §0.5 emits a stage object `{ score, substages: { <name>: { score 0-4, evidence, note } } }` plus a top-level `inefficiencies: [{ id, verdict, value, evidence }]`. Plan Retrospect **extends** that schema (it does not contradict it). The internal working unit is `ScorecardSlice`; the **stored/emitted §0.5 view is derived from it**:

```ts
// internal working unit
type ScorecardSlice = {
  criterionId: string; // e.g. "D-CC1", "SK2", "OV11"
  score: 0 | 1 | 2 | 3 | 4;
  verdict: '🟢' | '🟡' | '🔴';
  value: number | string; // string when unreconciled / N/A
  evidence: EvidenceRef; // a ref/anchor, NOT a dump (§5)
  note?: string;
  ieIds: string[]; // detected IEs this criterion reproduces
  fixIds: FixRef[]; // FixRef = {id, kind:'F'|'story', status:'open'|'shipped', sha?}
  confidence?: 'reconciled' | 'unreconciled';
};
```

**Mapping `ScorecardSlice[]` → rubric §0.5 (composer does this for storage/emit):**

- Each criterion's `{score, evidence, note}` becomes a `substages[<criterionId>]` entry (the rubric's substage view).
- Stage `score` (0–1) = the `rollup.ts` weighted mean.
- The union of all `ieIds` (with `{verdict, value, evidence}`) becomes the top-level `inefficiencies[]` — exactly the rubric §0.5 shape (`{id, verdict, value, evidence}`).
- `ieIds`/`fixIds`/`criterionId`/`confidence` are **Plan-Retrospect extensions** carried alongside; a consumer that only knows §0.5 ignores them. The Assessor is asked to emit the **§0.5 substage shape** (`{score, evidence, note}`); the composer attaches `criterionId`/`ieIds`/`fixIds`.

This makes "emit in the rubric §0.5 schema" literally true while preserving the IE/F linkage the feature needs.

---

## 5. Storage — `futurator-scorecards` DynamoDB table

Per the multi-table convention (CLAUDE.md / MEMORY: **one table per concern, never single-table**). New table `futurator-scorecards` (PAY_PER_REQUEST, PITR on — verdicts are durable history), declared in `sst.config.ts`, repo `functions/shared/repositories/scorecard-repository.ts`.

- **PK** `planId`
- **SK** `<stage>#<rubricVersion>` — e.g. `development#v0`, `overview#v0`.

**Why `rubricVersion` in the SK:** re-scoring a stage under a **newer rubric writes a NEW row** (different SK), **preserving the prior verdict.** Never silently overwrite a verdict under a changed ruler — that would corrupt the trend (§9). The latest row per stage is a query on `planId` + `begins_with(SK, '<stage>#')` ordered descending.

**Item fields:**

| Field                   | Type                               | Notes                                                                                                                                  |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `scores`                | `Record<criterionId, 0-4>`         | every graded criterion                                                                                                                 |
| `verdicts`              | `Record<criterionId, 🟢\|🟡\|🔴>`  |                                                                                                                                        |
| `evidenceRefs`          | `Record<criterionId, EvidenceRef>` | **jobIds / log-anchors / forensic-paths / `_graph` report fields — NOT full dumps.** Keeps items small; the UI dereferences on expand. |
| `pipelineHealth`        | `number 0-1`                       | only on the `overview#` row (the rollup)                                                                                               |
| `gradeBand`             | `'A'..'F'`                         | §9 bands                                                                                                                               |
| `topRegressions`        | `string[]`                         | vs v0 baseline (Phase 1–2)                                                                                                             |
| `topWins`               | `string[]`                         | vs v0 baseline (Phase 1–2)                                                                                                             |
| `actions`               | `ImprovementAction[]`              | `{redCriterion, ieIds[], fixIds[], status:'open'\|'pushed', target?:'fixes-plan'\|'reflector-inbox', draftFinding?}`                   |
| `rubricVersion`         | `string`                           | the ruler used                                                                                                                         |
| `pipelineVersion`       | `string`                           | daemon+prompts SHA stamped on the plan (§9 V1)                                                                                         |
| `forensicSchemaVersion` | `string`                           | from `ForensicPayload.schemaVersion` (§9 V3)                                                                                           |
| `confidence`            | `'reconciled'\|'unreconciled'`     | OV4 honesty flag (§8 SQ4)                                                                                                              |
| `scoredBy`              | `string`                           | `'deterministic'` or the Assessor job id (+model)                                                                                      |
| `scoredAt`              | ISO                                |                                                                                                                                        |

---

## 6. Cross-cutting agent warnings — addressed (de-biased & reconciled)

The rubric's §12–15 were authored by four single-stage agents (QAreview-agentic, graphify, deployment, skills-module) and may be over-anchored to pacman3. Folded into the canonical stage detectors here, with **collisions reconciled against `ie-to-f-map.ts` / the fixes-plan registry** and **all thresholds flagged v0/pacman3 unvalidated**.

### 6a. SKILLS (rubric §3.10 SK1–SK6, §8 IE25–IE29, §15) — score the _subsystem_, not just catalog cost

The live bottleneck is **activation / discovery / retrieval (SK2/SK3/SK4)** — _not_ "catalog too big, prune it." `detectors/skills.ts` scores **all six SK criteria** from `forensic.skills` (already machine-readable — no log-parsing) + registry state:

- **SK1 availability** — `hasSkillTool`, `availableSkillCount`, `sessionsReportingZeroSkills`.
- **SK2 activation** — `totalSkillToolUseEvents ÷ sessionsReportingAvailability` (+ distinct used ÷ available). Surfaces **activation collapse (IE25 → F24)** — the _dominant_ defect (pacman3: 5.2%).
- **SK3 loadout ranking** — registry check: is `index.embeddings.json` read at load time? (write-only today). **Retrieval-dark / unranked loadout (IE27 → F27).**
- **SK4 scout discovery** — `skillScoutRuns.length` for a plan whose intent has a clear domain. **Scout dormancy (IE26 → F25).**
- **SK5 trust integrity** — every loaded skill `trusted`/from a trusted source. **Unvetted skill loaded (IE28 → Story 4.2 (SK5), NOT an F-finding).** _Detectable only once the Skills-Institution branch ships._ **Dependency note: F26 (scout→inbox trusted-gate bridge) is a PRE-DEPLOY GATE for that branch.** Until institution + F26 ship, SK5 scores `N/A → build target` and the retrospect labels IE28 _"not yet observable (pre-institution); enabling dep = F26."_ `ie-to-f-map.ts` files IE28 as `{kind:'story', ref:'4.2', dependsOn:['F26']}`.
- **SK6 registry self-improvement** — reflector `written > 0` & an app-evolved SKILL.md authored. Tied to **OV8/F5** (IAM).

**Per-criterion granularity is the feature (reviewer fix #6):** do **not** co-locate two SK criteria's detectors on one card row. IE25/F24 → the `skills/activation` line; IE26/F25 → the `skills/scout` line; IE27/F27 → the `skills/loadout` line (see the §3 example). The old IE10/OV7 "66 avail / 1 used → prune" read is reclassified as **SK2 (activation) + SK3 (relevance)**, with pruning (IE29/F28) secondary. **All SK thresholds are v0/pacman3, unvalidated.**

### 6b. GRAPH (rubric §3.8 D-KC\*, §8 IE16–IE19, §13) — consume the right report, directly

`detectors/knowledge-graph.ts` reads the `knowledge/_graph/` reports per the **corrected** graph-read contract in §4a: **`orphans.json` `orphanCount`/`status` directly** for D-KC3/IE17 (zero added cost — the FAIL signal already exists; F16 is what surfaces it at the _gate_, which is why the retrospect surfacing it in the _verdict_ is the value-add); `ast-facts.json` `fileCount` for D-KC2/IE16; `dead-code.json` for zombies/IE19; `graph-snapshot.json` projectId distribution for D-KC5/IE18 (self-healing post-F17) — with a **degree-0 derivation fallback** from `snapshot.nodes[]`/`edges[]` if `orphans.json` is absent.

**Reconciled graph chain (single source of truth = `ie-to-f-map.ts`):** **IE16→F14 · IE17→F14+F15+F17(shipped `0d5dd6a`) · IE18→F17(shipped) · IE19→F15 · orphan-surfacing→F16.** No "F13 placeholder" — that was fabricated; dropped.

**Forward dependency:** F18's `REFERENCES` edges (shipped `0445e6a`) make grounding criteria **C-D3 / C-P1 machine-checkable** — a PRD/arch doc that grounds real code leaves `REFERENCES`/`DEPENDS_ON` edges. _But plan-run docs are deliberately excluded (`isLivingDoc`) until their linking scheme is designed._ So in Phase 1–2, C-D3/C-P1 stay **Assessor-graded** (`[LLM]`); they _upgrade_ to deterministic graph-edge checks **once plan-run doc linking ships** — note as a forward dependency, don't block on it.

### 6c. LEARNING LOOP — Plan Retrospect _is_ OV8's honest closure

The Reflector (F5) is IAM-blocked and prose-only. Plan Retrospect produces the **durable, comparable, operator-visible verdict** OV8 demands. Improvement actions feed the fixes-plan backlog / Reflector inbox — closing the loop the Reflector can't currently complete. (Once F5's IAM grant lands, the two reinforce: the Reflector's `skill_activated==0` signal and Plan Retrospect's SK2 red name the same defect from both sides.)

### 6d. Cross-doc collision reconciliation (de-bias)

- **deployment forward-referenced its fixes as "F14/F15" → canonical IDs are F22/F23** (confirmed `pipeline-v2.5-fixes-plan.md:102-103, 685, 718`). This spec uses **F22** (provision dev/staging subdomains → true build-once) and **F23** (MCP-config self-heal — cross-cutting, halts the whole pipeline; = **OV11**, filed as `Fnew` in rubric §8 line 419 → **canonical F23**). `ie-to-f-map.ts` hardcodes F22/F23 only.
- **graphify "F13 placeholder" — does not exist.** The graphify contributor note files the chain as F14/F15/F16; it never used F13. Claim dropped (reviewer fix #5). **F13 is QAreview-agentic's state/behavior-AC-no-probe finding (Track F)** — no collision.
- **Shipped vs open** stamped per finding so the report never tells the operator to "ship" something already live: **F17, F18 (graphify); F19, F20, F21 + the dual-prod reconcile (deployment) are SHIPPED**; F14, F15, F16, F22, the rest are open. The `ie-to-f-map.ts` `FixRef.status` is the authority; the composer renders per-finding state (reviewer fix #4).

### 6e. OV11 cross-cutting cap

`OV11` (agent-spawn precondition integrity — the missing-MCP-config class, **IE23 → F23**) **caps the whole pipeline**, not one stage (rubric §9 / Q12): a missing injected prereq means _no agent ran at all_. The composer applies this cap globally when `detectors/overview.ts` finds `OV11 == 0` (daemon `step_error "MCP config file not found"` anchor).

---

## 7. API + UI

### 7.1 API (Hono routes in `functions/api/index.ts`)

> **Mount convention (reviewer fix #17).** These routes register under the Hono app's existing **`/api`** mount, exactly like the other plan routes. Per MEMORY (`project_api_client_path_convention`) the api-client base **already ends in `/api`**, so the **frontend hook must NOT double-prefix `/api`** — it calls `apiClient.post('/plans/:id/scorecard/...')` against a base that already includes `/api`. The route strings below are written relative to the `/api` mount.

| Route                                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /plans/:id/scorecard/:stage/run` | Enqueue a stage analysis. **Deterministic-only stages resolve inline** (compute → store → return the slice). **Stages with `[LLM]` criteria** compute the deterministic half inline, **store it**, then **enqueue a `scorecard-assess` daemon job** and return `{status:'assessing', jobId}` for the UI to stream. `:stage ∈ {concept, development, qa, deployment, publish, overview}` or `all`. |
| `GET /plans/:id/scorecard`             | All stored slices for the plan (latest `rubricVersion` per stage) → the full Reality Check + pipeline-health + actions.                                                                                                                                                                                                                                                                           |
| `GET /plans/:id/scorecard/:stage`      | One stage's latest slice.                                                                                                                                                                                                                                                                                                                                                                         |

Auth: same Bearer-JWT middleware as every other plan route. Public-route list unchanged. (Internal route segment `/scorecard/` is acceptable per §1 — never rendered in UI copy.)

### 7.2 UI — the **Plan Retrospect** tab

A new tab in the plan dashboard, **rail mirroring the concept rail** (`src/components/labs/plan-dashboard/views/concept-rail.tsx` is the pattern; add `views/retrospect/retrospect-rail.tsx` + `retrospect-view.tsx` + `reality-check-card.tsx`). One **row per stage**: **Concept · Development · QA Review · Deployment · Publish · Overview.**

Each row:

- **"Run analysis"** button → `POST …/:stage/run`. Deterministic stages snap to a scored card instantly; `[LLM]` stages **stream live via the existing `StoryLiveOutput`** (`src/components/labs/agentic-workflow/story-live-output.tsx`) — the Assessor reads as a normal agent (visual consistency with concept/dev).
- Resolves to a **Reality Check card**: green/yellow/red per criterion, each row **expandable** to (a) the evidence quote/anchor and (b) the matched **F-finding chips** with per-finding **shipped/open** state. A **v0-threshold caveat badge** rides on every quantitative criterion until cohorts validate it.
- **"Analyze all"** runs the lot (fans out per-stage; deterministic resolve immediately, Assessor jobs stream in as they land).
- **Overview row** carries the **pipeline-health number + grade band** (§9). The **trend sparkline / ▲▼ is stubbed** with a "Phase 3 — needs pipeline-versioning" placeholder (reviewer fix #12), NOT a live comparison.
- **Improvement-actions list at the foot** → each action has **"Push to fixes-plan backlog"** and **"Push to Reflector inbox"** buttons (SQ2 — both targets). A pushed action flips to `status:'pushed'` and records its `target`.

---

## 8. Open questions — resolved

|         | Question                                        | **Recommendation**                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SQ1** | Auto-run on plan-close, or stay manual?         | **Manual in Phase 1; auto-deterministic on plan-close in Phase 2; auto-Assessor in Phase 3.** The deterministic half is free and side-effect-free — auto-running it on plan-close (Phase 2) costs nothing and makes every run scored by default. Keep the Assessor operator-triggered until its cost/value is calibrated, then auto-run it.                                                           |
| **SQ2** | Where do improvement actions land?              | **Both, operator's choice per action.** Default target = **fixes-plan backlog** as a draft `F<n>` row (the canonical home for fixes); secondary = **Reflector inbox** (continuous loop). No dedicated backlog table — the fixes plan _is_ the backlog. The action stores `target`.                                                                                                                    |
| **SQ3** | Does the Assessor re-watch the VQA PNGs?        | **No in Phase 2 (artifacts only); optional "depth mode" in Phase 3.** Default: grade QA from `qa-report` + per-test rationales + the deterministic capture-integrity score (Q-C6); do **not** re-run vision over PNGs (cost; would duplicate the VQA judge). A Phase-3 `depth:true` flag samples frames _only_ for **verdict-calibration disputes** (Q-C3/Q-C8), never as default.                    |
| **SQ4** | Refuse to score cost criteria until F2/F3 land? | **Degrade honestly, don't refuse.** While OV4 doesn't reconcile (F2/F3 retry-orphan gap, where orphaned-log jobs undercount agent-spend rows), mark cost-derived criteria `value:"<lower-bound>", confidence:"unreconciled"` + a caveat chip, rather than emit a falsely-precise number. Still score count/ratio criteria. The Reality Check shows _"cost = lower bound, unreconciled (F2/F3 open)."_ |

---

## 9. Versioning (warrants its own spec)

Plan Retrospect is only meaningful run-over-run if we can answer _"same compared to what?"_ That requires versioning **three independent things**, each stamped on every run + every scorecard row:

| #      | Thing                | Source                                                                                                                                                                                                                                       | Stored in                                            |
| ------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **V1** | **Pipeline version** | git SHA of daemon + prompts at run time, stamped on the plan at start. **Extends the commit-identity work** (`project_multihost_dispatch_identity` already stamps machine + model/provider into commit trailers — add the pipeline version). | `plan.pipelineVersion` → scorecard `pipelineVersion` |
| **V2** | **Rubric version**   | the rubric header semver (currently `v0`).                                                                                                                                                                                                   | scorecard SK + `rubricVersion`                       |
| **V3** | **Schema versions**  | forensic `schemaVersion`; scorecard gets its own.                                                                                                                                                                                            | `forensicSchemaVersion`                              |

**What versioning unlocks:**

- **A/B pipeline comparison** — run the _same spec_ on pipeline `vN` vs `vN+1`; the Reality Check diff shows exactly which criteria moved. The bench apps become **regression fixtures**.
- **Correct cohorts** — the forensic `cohort` (null today) is honest _only_ when grouped by pipeline version; otherwise pre-fix and post-fix runs average together and the baseline lies. **This is exactly why §3/§5/§7 compare only to the v0 baseline until Phase 3** — cohort diffing is not honest before this lands.
- **Regression gating** — _"pipeline `vN+1` dropped D-CC1 vs `vN`"_ becomes a blockable signal.
- **Provenance** — every Reality Check carries the exact pipeline + rubric it was graded against → reproducible, auditable.

**Migration discipline:** never silently re-score an old run under a new rubric — re-score writes a **new** scorecard row (different SK), preserving the original verdict.

**Phase-3 trend/A-B is blocked on this.** Recommend a separate **`pipeline-versioning-spec.md`** (pipeline manifest `{pipelineVersion, daemonSha, promptsSha, model, createdAt}` stamped per plan; semver bump on any prompt/orchestration change). Design them together; ship in sequence.

---

## 10. Phasing

- **Phase 1 — Deterministic MVP (Overview + Development first).** §4a scorer + §5 table + §7.1 API + §7.2 UI, **no Assessor.** Compute every quantitative criterion + IE/OV/SK detectors + the corrected `_graph` report reads. Render the Reality Check for **Overview + Development** (where the numbers live). Reproduces every 🔴 from the pacman3 analysis at ~0 LLM cost. Includes the SQ4 honesty guard (agent-spend-sourced OV4), the SK/graph detectors, and the **v0-baseline-only comparison** (no cohort diffing). **Prerequisite tasks for Phase 1:** (a) add the S3 `GetObject` IAM grant on the knowledge prefix to the API Lambda role; (b) confirm the cost source for OV4 (agent-spend rows) is readable from the Lambda.
- **Phase 2 — The Assessor, full coverage.** §4b agent job + daemon wiring (`scorecard-assess` jobType modeled on `reflector`, added to `classifyAgentForSpend`) + `StoryLiveOutput` streaming for Concept grounding, dev AC-satisfaction/scope, review efficacy, VQA/QA calibration & oracle-hallucination guard, deploy/publish safety judgment. Auto-deterministic on plan-close (SQ1).
- **Phase 3 — Trend & versioning.** §9 — stamp pipeline/rubric/schema versions, build correct cohorts, enable run-over-run ▲/▼ + sparkline (un-stub the UI), A/B + regression gating, optional Assessor depth-mode (SQ3). Blocked on `pipeline-versioning-spec.md`.

Phase 1 is genuinely useful alone: the deterministic _"did this run hit the known anti-patterns?"_ check — ~80% of the value for ~0 cost — and **plan-agnostic by construction** (reads fields, not plan names).

---

## 11. Dependencies & links

- **Rubric** (the ruler): `pipeline-quality-rubric.md` — §0.5 schema, §8 IE→F map (canonical IDs), §9 aggregation + hard caps (quoted verbatim in §3.6).
- **Fixes** (where actions land): `pipeline-v2.5-fixes-plan.md` — F1–F28, tracks A–I.
- **Honesty gate:** cost/time accuracy depends on **F2/F3** (forensic completeness) — SQ4; OV4 sources cost from agent-spend rows, not events.
- **Learning loop:** completes **OV8** the Reflector (F5, IAM-blocked) can't.
- **Graph (corrected):** read `knowledge/_graph/orphans.json` / `ast-facts.json` / `dead-code.json` (NOT `orphanCount` on `graph-snapshot.json`); **F16** surfaces the swallowed orphan FAIL at the gate; **F18** `REFERENCES` edges upgrade C-D3/C-P1 to deterministic _once plan-run doc linking ships_.
- **Skills (forward):** **F26** scout→inbox bridge is a **pre-deploy gate** for SK5/IE28 observability; **IE28 maps to Story 4.2, not an F.**
- **Spawn integrity:** **OV11 = IE23 → F23** caps the whole pipeline.
- **Versioning:** warrants `pipeline-versioning-spec.md`; ties to `project_multihost_dispatch_identity`.

---

### §3.6 — Hard caps (quoted verbatim from rubric §0.3 / §9; reviewer fix #14)

These are the **exact** rubric cap rules; the composer's `rollup.ts` implements them as written (do not paraphrase three caps into one):

1. **`[MECH]`-at-0 cap (rubric §0.3, line 57; §9, line 515):** _"Any `[MECH]` criterion scoring 0 caps its stage at 'Acceptable' (≤2 equivalent)"_ — i.e. the stage's normalized score is capped at **0.5** (2 on the 0–4 scale).
2. **QA capture/isolation cap (rubric §3.9 note, line 325-326):** Q-C6 / Q-C7 / Q-C9 at 0 (IE13/IE14/IE15) **hold the QA substage at ≤0.5 ("Acceptable")** — this is the same ≤2 cap applied to the QA substage specifically (it is the `[MECH]`-at-0 rule instantiated for QA evidence integrity, not a different threshold).
3. **Deploy/Publish safety cap (rubric §9, line 516):** _"any deploy/publish safety criterion (DP-S1, P-S1) at 0 forces overall **F**."_
4. **OV11 whole-pipeline cap (rubric §9 / Q12, line 603):** `OV11 == 0` caps **the whole pipeline** (every agent job died at spawn → nothing ran).
5. **Grade bands (rubric §9, line 514):** `≥0.85 A · 0.70–0.84 B · 0.55–0.69 C · 0.40–0.54 D · <0.40 F`.

---

## Changelog

| Date       | Author                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-17 | Claude (forensics #1)    | Initial draft as `pipeline-scorecard-spec.md` (working name "Scorecard").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-06-18 | Claude (concept-develop) | Revised + renamed to **Plan Retrospect** / **Reality Check** / **The Assessor** (locked; "scorecard" survives only in internal identifiers). Folded rubric §12–15 contributor sections into canonical detectors; reconciled cross-doc collisions (deployment "F14/F15"→**F22/F23**; dropped the fabricated graphify "F13 placeholder"; OV11 `Fnew`→**F23**); flagged all thresholds **v0/pacman3 unvalidated**. **Corrected against the codebase:** graph reads `knowledge/_graph/orphans.json`/`ast-facts.json`/`dead-code.json` (NOT a non-existent `orphanCount` on `graph-snapshot.json`), with a degree-0 derivation fallback; daemon `scorecard-assess` jobType modeled on the real `reflector`/`skill-scout` runners + added to `classifyAgentForSpend`; OV4 cost sourced from **agent-spend rows** (events carry no cost); `buildForensicPayload(planId, cohortFetcher)` reuse clarified (primitives path for deterministic stages); real fields `story.origin==='wave-vqa-fix'` + `epic.waveBuildJobs` (no `fixesWave`); D-CC1/D-WS1 computations pinned; IE17→F14+F15+F17(shipped) rendered per-finding; IE28→Story 4.2 (not an F); ScorecardSlice⇄§0.5 mapping; hard caps quoted verbatim (§3.6); read-only safety posture; Phase-1–2 compares to v0 baseline only (cohort diffing deferred to Phase 3). Resolved SQ1–SQ4; versioning V1–V3 → `pipeline-versioning-spec.md`. |

---

**Files this spec creates / touches:**

- **New:** `functions/shared/scorecard/` (`index.ts`, `detectors/{development,skills,knowledge-graph,qa,deployment,overview}.ts`, `ie-catalog.ts`, `ie-to-f-map.ts`, `rollup.ts`, `types.ts`), `functions/shared/repositories/scorecard-repository.ts`, `daemon/pipelines/scorecard-assess-job-runner.mjs`, `src/components/labs/plan-dashboard/views/retrospect/{retrospect-rail.tsx,retrospect-view.tsx,reality-check-card.tsx}`, `docs/concepts/pipeline-v2/pipeline-versioning-spec.md` (separate).
- **Touch:** `sst.config.ts` (table `futurator-scorecards` + S3 `GetObject` grant on the knowledge prefix to the API Lambda role), `functions/api/index.ts` (3 routes under `/api`), `daemon/agent-daemon.mjs` (`scorecard-assess` dispatch branch beside `reflector`/`skill-scout`; extend `classifyAgentForSpend` line ~6125).
- **Reuses:** `functions/shared/timer/forensic-builder.ts` (`sliceForPlan`, `aggregateByCategory`, `buildSkillsBlock`; `buildForensicPayload` only when cohort needed), `qa-report-aggregator.ts`, `deploy-report-aggregator.ts`, `reflections-repository.ts`, the agent-spend table (OV4 cost), `knowledge/_graph/*.json` (read-only), `src/components/labs/agentic-workflow/story-live-output.tsx`, `views/concept-rail.tsx` (UI pattern).
