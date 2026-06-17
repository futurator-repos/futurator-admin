# Feature Spec — Pipeline Scorecard ("Reality Check")

> **Status:** DRAFT proposal (for operator + multi-agent review)
> **Author:** Claude (forensic analysis pass #1)
> **Created:** 2026-06-17
> **Consumes:** [`pipeline-quality-rubric.md`](./pipeline-quality-rubric.md) +
> the forensic JSON (`GET /plans/:id/timing/forensic`)
> **Companion to:** [`pipeline-v2.5-fixes-plan.md`](./pipeline-v2.5-fixes-plan.md)
> **Opens:** the **Versioning** discussion (§9)

A new feature that takes a completed plan's **forensic JSON** and the **quality rubric**,
lets the operator **run an analysis stage-by-stage from the UI**, and emits a
**Reality Check** — a rubric-against-reality match that scores every stage/substage,
names every problem the run actually hit, and turns each red into a concrete improvement
action. This is the mechanism that lets the pipeline **measure and improve itself**.

---

## 1. Naming (proposals — operator picks)

The thing being asked for is layered: a **system** (the feature), the **report** it
produces, and the **agent** that does the qualitative grading. Clean naming keeps them
distinct:

| Layer                           | Working name      | Alternatives                                                                            |
| ------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| **System / feature**            | **Scorecard**     | Retrospect · Reckoning · The Tribunal · Plan Autopsy · Post-Run Review                  |
| **The report (output)**         | **Reality Check** | Verdict · Report Card · The Reckoning                                                   |
| **The grading agent (persona)** | **The Assessor**  | The Critic · The Auditor · Aria (Assessor) · Judge (overloaded — avoid; VQA uses JUDGE) |

**Recommendation:** ship as **"Scorecard"** (the feature) producing a **"Reality Check"**
(the per-run report), graded by **"The Assessor"** (the persona, fitting the BMAD cast —
Murat _gates_, the Assessor _grades_). This trio reads naturally in the UI: _"Run the
Scorecard → read the Reality Check → the Assessor flagged 4 reds."_

> The rest of this doc uses **Scorecard** for the feature and **Reality Check** for the
> report. Swap freely once the operator decides.

---

## 2. Intent & where it fits

The pipeline already has a **Reflector** — an _automatic, advisory_ learning pass that
fires at wave/plan close and writes prose proposals to `inbox/reflections.md` (and which,
per the forensic, is currently IAM-blocked → `written=0`; see fix F5). The Scorecard is
its **deliberate, operator-driven, rubric-anchored** counterpart:

|             | Reflector (exists)           | **Scorecard (new)**                                                            |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Trigger     | automatic at scope-close     | **operator, per-stage, from the UI**                                           |
| Input       | git log slice + inbox cursor | **forensic JSON + rubric + DDB rows + artifacts**                              |
| Output      | free-form prose proposals    | **structured scorecard (§0.5 schema) + Reality Check**                         |
| Anchored to | nothing fixed                | **the versioned rubric** (comparable run-over-run)                             |
| Closes      | —                            | **OV8 learning-loop-closed** (the loop the Reflector can't currently complete) |

They're complementary: the Reflector notices things continuously; the Scorecard
**grades the run against a standard and produces a comparable, durable verdict.** Over
many runs, the Scorecard is what tells you _"did the v2.5 fixes actually make the pipeline
better?"_ — which is the whole point of self-improvement.

---

## 3. The output: a "Reality Check"

For a given plan + stage, the Reality Check answers three questions:

1. **Score** — every rubric criterion graded 0–4 with 🟢/🟡/🔴, rolled up to the
   substage/stage/pipeline-health number (per rubric §0.3 + §9).
2. **Rubric-against-reality match** — for each criterion, _the evidence quote_ that
   justifies the score (a forensic metric, a daemon-log line, a diff), and — crucially —
   whether this run **reproduced a known problem**: every detected anti-pattern (rubric
   IE1–IE12) is auto-linked to its fix in the fixes plan (F1–F10). The operator sees
   _"this run hit IE1 compile thrash = 87/story (🔴) → F1 not yet shipped."_
3. **So-what** — `topRegressions` / `topWins` vs the baseline, and a generated
   **improvement action list**: each 🔴 → a proposed action (link an existing F-finding or
   draft a new one) → pushed to the Reflector inbox / fixes-plan backlog.

Example (abridged) Reality Check for the **Development** stage on a future run:

```
DEVELOPMENT — 0.58 (C)   ▼ vs baseline 0.61
  compile-loop      🔴  D-CC1 compiles/story = 71  (baseline 65–102)  → reproduces IE1/F1
  wave-vqa          🔴  D-VQ1 unverifiable 38%      → reproduces IE9/F8
  merges/git-graph  🟢  D-MG1 all waves clean; trailers complete
  test-authoring    🟡  D-TA2 author/dev ratio 0.82 → IE7/F7
  parallelism       🔴  D-WS1 factor 1.04×          → reproduces IE11/F10
  ACTIONS: ship F1 (compile cache) ▸ ship F8 (fixer gating) ▸ widen waves (F10)
```

---

## 4. Architecture (hybrid: deterministic + agent)

The grading splits cleanly into two engines so we don't pay an LLM for arithmetic:

### 4.1 Deterministic scorer — `[no LLM]`

A pure-function module (`functions/shared/scorecard/`) computes **every quantitative
criterion + all IE detectors + OV metrics** directly from the forensic JSON + plan/story
DDB rows. This is most of the inefficiency detection (IE1–IE12, OV1–OV10, latency/cost
criteria). Fast, free, reproducible, testable. Reuses the forensic builder's slice
aggregation. No daemon, no agent — runs in the Lambda on request.

### 4.2 Qualitative scorer — **The Assessor** `[AGENT]`

An agent job (one per stage, on the daemon — same infra as concept-gen) grades the
**`[AGENT]` / judgment criteria** that need to read artifacts: doc completeness &
grounding (concept), AC-satisfaction & scope (dev), review efficacy, VQA verdict
calibration, QA remediation routing. It receives the deterministic scores as context (so
it doesn't re-derive numbers) plus the relevant artifacts (concept docs, story diffs,
review notes, judge verdicts). It emits scores + evidence quotes in the §0.5 schema.

### 4.3 Merge + report

A composer joins deterministic + Assessor slices → full scorecard → renders the Reality
Check + improvement actions. Auto-matches detected anti-patterns to F-findings via a
static `IE→F` map (already in rubric §8).

### 4.4 Storage (multi-table, per project convention)

New DynamoDB table **`futurator-scorecards`** (one table per concern — never single-table):

- **PK** `planId` · **SK** `<stage>#<rubricVersion>` (e.g. `development#v0.3`).
- Fields: `scores{}`, `verdicts{}`, `evidenceRefs{}` (jobIds/log-anchors, **not** full
  dumps), `pipelineHealth`, `topRegressions[]`, `topWins[]`, `actions[]`,
  `rubricVersion`, `pipelineVersion`, `forensicSchemaVersion`, `scoredBy`, `scoredAt`.
- Lets a stage be re-scored under a newer rubric without losing the old verdict
  (→ versioning, §9).

### 4.5 API + UI surface

- **API:** `POST /plans/:id/scorecard/:stage/run` (enqueue stage analysis),
  `GET /plans/:id/scorecard` (read all slices), `GET /plans/:id/scorecard/:stage`.
- **UI:** a new **Scorecard tab** in the plan dashboard with a **rail mirroring the
  concept rail** — one row per stage (Concept · Development · QA · Deployment · Publish ·
  Overview). Each row: **"Run analysis"** button → streams via the existing
  `StoryLiveOutput` component (consistency with concept/dev) → resolves to a scored card
  with 🟢/🟡/🔴 per criterion, expandable to the evidence quote, and the matched
  F-finding chips. An **"Analyze all"** button runs the lot. The Overview row carries the
  pipeline-health number + grade band + trend sparkline (once ≥N runs exist).

---

## 5. UX flow (operator's path)

1. Plan reaches `review`/`done` → **Scorecard tab** becomes available.
2. Operator clicks **Run analysis** on **Development** (or **Analyze all**).
3. Deterministic metrics resolve instantly; the Assessor streams its qualitative grading
   live (same look as watching a dev agent).
4. The **Reality Check** card renders: stage score + per-criterion 🟢/🟡/🔴, each
   expandable to its evidence quote and (if red) the linked F-finding.
5. **Improvement actions** list at the foot → operator can push any to the fixes-plan
   backlog / Reflector inbox with one click.
6. Re-run later (e.g. after shipping F1) → the card shows **▲/▼ vs the prior run** so the
   operator _sees the fix working_ (or not).

---

## 6. The self-improvement mechanism (why this matters)

This is the closed loop the pipeline is missing today:

```
run plan ─▶ forensic JSON ─▶ [Scorecard: rubric × evidence] ─▶ Reality Check
                                                                    │
        ┌───────────────────────────────────────────────────────────┘
        ▼
  reds → improvement actions → fixes-plan backlog → ship fix → next run scored again
        │
        └─▶ trend across runs answers: "is the pipeline getting better?"
```

- **Per-run:** every 🔴 becomes a tracked action linked to a fix.
- **Across runs (needs §9 versioning):** scorecards grouped by **pipeline version** show
  whether a shipped fix actually moved its criterion — the forensic's `cohort` field
  (currently null: _"need 5+ similar plans"_) gets populated _correctly_ (grouped by
  version, not lumping pre/post-fix runs together).
- **Regression guard:** a pipeline change that drops a criterion's score below the prior
  version is a regression the operator can catch before it compounds.

This is also the honest fix for OV8: instead of the Reflector firing prose into a
(currently IAM-blocked) void, the Scorecard produces a **durable, comparable, actionable**
verdict the operator actually sees.

---

## 7. Phasing (ship MVP, add complexity later)

- **Phase 1 — Deterministic Scorecard (MVP):** §4.1 + §4.4 + §4.5 UI, **no Assessor
  agent.** Compute all quantitative criteria + IE detectors + OV metrics from the forensic
  - DDB; render the Reality Check for the **Overview + Development** stages (where the
    numbers live). This alone reproduces every 🔴 from this analysis, costs ~nothing (no
    LLM), and ships fast.
- **Phase 2 — The Assessor:** add the qualitative agent (§4.2) for Concept grounding, dev
  AC-satisfaction, VQA/QA calibration, deploy/publish safety judgment. Full stage
  coverage.
- **Phase 3 — Trend & versioning:** §9 — stamp pipeline/rubric versions, build cohorts,
  show ▲/▼ trends, enable A/B and regression guards.

> Phase 1 is genuinely useful on its own: it's the deterministic "did this run hit the
> known anti-patterns?" check, which is 80% of the value for ~0 cost.

---

## 8. Open questions (Scorecard)

- **SQ1:** Should the Scorecard run **automatically** on plan-close (like the Reflector)
  in addition to operator-triggered, or stay manual to start? (Lean: manual in Phase 1,
  auto in Phase 3.)
- **SQ2:** Where do improvement actions land — straight into `pipeline-v2.5-fixes-plan.md`
  as new `F<n>` rows, into the Reflector inbox, or a dedicated backlog table?
- **SQ3:** Does the Assessor grade against the _artifacts_ (diffs/docs) or also re-watch
  the _evidence screenshots_ (VQA PNGs) for calibration? (Cost vs depth.)
- **SQ4:** Forensic completeness (OV4/F3) gates the Scorecard's own honesty — should the
  Scorecard **refuse to score cost criteria** until F2/F3 land, rather than score on a
  known-incomplete forensic? (Lean: yes — show "cost = lower bound, unreconciled" rather
  than a falsely-precise number.)

---

## 9. NEW FEATURE DISCUSSION — Versioning

The Scorecard is only meaningful run-over-run if we can answer _"same compared to what?"_
That requires versioning **three independent things**, each stamped on every run:

### 9.1 What to version

| #      | Thing                | Why                                                                                                         | Source of the version                                                                                                                                                                                    |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1** | **Pipeline version** | the prompts + orchestration + daemon code evolve; a score is only comparable to runs on the _same_ pipeline | git SHA of daemon + prompts at run time, stamped on the plan (extends the commit-identity work in `project_multihost_dispatch_identity` — already stamps machine + model/provider; add pipeline version) |
| **V2** | **Rubric version**   | criteria & thresholds evolve (this rubric is v0); a score means nothing without knowing the ruler           | `rubricVersion` field, recorded in each scorecard SK                                                                                                                                                     |
| **V3** | **Schema versions**  | forensic + scorecard output shapes evolve                                                                   | forensic already has `schemaVersion: timer-intel-v1.0`; scorecard gets its own                                                                                                                           |

### 9.2 What versioning unlocks

- **A/B pipeline comparison:** run the _same spec_ on pipeline `vN` vs `vN+1`; the
  Scorecard diff shows exactly which criteria moved. The **bench apps** from
  `pipeline-v3/test-bench-rubric.md` (Chomp/Jester/…) become the **regression fixtures** —
  re-run them on every pipeline version, score, and gate.
- **Correct cohorts:** the forensic `cohort` (null today) can only be honest if it groups
  by pipeline version — otherwise pre-fix and post-fix runs get averaged together and the
  baseline lies.
- **Regression gating:** "pipeline `vN+1` dropped D-CC1 vs `vN`" is a blockable signal.
- **Provenance:** every Reality Check carries the exact pipeline + rubric it was graded
  against, so a verdict is reproducible and auditable.

### 9.3 Versioning sketch (for its own spec)

- A **pipeline manifest**: `{ pipelineVersion, daemonSha, promptsSha, model, createdAt }`
  stamped on each plan at start (and into commit trailers, per the dispatch-identity
  model). Bump `pipelineVersion` (semver) on any prompt/orchestration change.
- **Rubric** carries a semver in its header (this doc's rubric = `v0`); scorecards record
  which one graded them.
- **Migration discipline:** never silently re-score old runs under a new rubric — re-score
  produces a _new_ scorecard row (different SK), preserving the original verdict.

> This deserves its **own spec** (`pipeline-versioning-spec.md`). Flagged here because the
> Scorecard's trend/A/B/regression value (§6, Phase 3) is **blocked on it** — they should
> be designed together even if shipped in sequence.

---

## 10. Dependencies & links

- **Rubric** (the ruler): [`pipeline-quality-rubric.md`](./pipeline-quality-rubric.md) —
  §0.5 scorecard schema, §8 IE→F map, §9 aggregation.
- **Fixes** (where actions land): [`pipeline-v2.5-fixes-plan.md`](./pipeline-v2.5-fixes-plan.md).
- **Honesty gate:** Scorecard cost/time accuracy depends on fixes **F2/F3** (forensic
  completeness) — see SQ4.
- **Learning loop:** completes rubric **OV8** that the Reflector (F5) currently can't.
- **Versioning** (§9): warrants `pipeline-versioning-spec.md`; ties to
  `project_multihost_dispatch_identity` (commit-stamped provenance).

---

## Changelog

| Date       | Author                | Change                                                                                                                                                                                |
| ---------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-17 | Claude (forensics #1) | Initial spec: naming proposals, hybrid deterministic+Assessor engine, per-stage UI run model, Reality Check output, multi-table storage, 3-phase plan, versioning discussion (V1–V3). |
