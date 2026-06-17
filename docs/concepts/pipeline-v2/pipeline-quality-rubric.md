# Pipeline Quality Rubric (v0 draft)

> **Status:** DRAFT (open for multi-agent contribution)
> **Owner of this draft:** Claude (forensic analysis pass #1)
> **Created:** 2026-06-17
> **Companion to:** [`pipeline-v2.5-fixes-plan.md`](./pipeline-v2.5-fixes-plan.md)
> **Calibration baseline:** `plan_pacman3_mqi8x64w` (mvp) — the "v0" reference run.

A standing scoring instrument applied to **every future plan run** to grade the quality
of the pipeline, its agents, and its outputs — and to surface inefficiencies for
continuous improvement. It is designed to be **machine-applied**: each criterion names
its evidence source and a measurement, so a scoring agent can emit a comparable scorecard
without subjective drift.

---

## 0. How to use this rubric (read first)

### 0.1 Three things we score (don't conflate them)

Every criterion is tagged with one of:

- **`[AGENT]`** — quality of an LLM agent's work (the PRD John wrote, the code DEV wrote,
  the verdict a JUDGE returned). _Is the intelligence good?_
- **`[MECH]`** — quality of the orchestration/harness around the agent (gating, merging,
  retry, budget, event capture). _Is the machine good?_
- **`[OUTPUT]`** — quality of the artifact delivered to the next stage or the user (the
  built app, the deploy, the published site). _Is the product good?_

A stage can score well on `[AGENT]` and badly on `[MECH]` (smart agents, leaky harness) —
that distinction is the whole point. Keep them separate.

### 0.2 Scoring scale (every criterion uses this)

| Score | Band              | Meaning                                                                   |
| ----- | ----------------- | ------------------------------------------------------------------------- |
| **4** | Exemplary         | Best-in-class; sets the baseline others should match.                     |
| **3** | **Good (TARGET)** | Meets intent reliably; minor nits only.                                   |
| **2** | Acceptable        | Works, but with notable inefficiency/gaps; improvement clearly warranted. |
| **1** | Poor              | Frequently misses intent or wastes significant resources; needs rework.   |
| **0** | Broken/Absent     | Does not function, produces wrong/lost output, or is missing entirely.    |

For **quantitative** criteria, the numeric thresholds map: 🟢 green = 3–4, 🟡 yellow = 2,
🔴 red = 0–1. Each quantitative criterion states its own cut points, calibrated to the
pacman3 baseline (§8). The question a scorer answers is always: **"better, equal, or
worse than the v0 baseline?"**

### 0.3 Weights & aggregation

Each criterion carries a weight **W ∈ {1 (minor), 2 (normal), 3 (critical)}**.

- **Substage score** = Σ(score × W) / Σ(W × 4) → normalized 0–1.
- **Stage score** = weighted mean of its substage scores (substage weights in the stage
  header).
- **Pipeline health** = weighted mean of the 5 stage scores + the Overview score (§7),
  per §9 weights.
- **Any `[MECH]` criterion scoring 0 caps its stage at "Acceptable" (≤2 equivalent)** —
  a broken harness can't be hidden by good agents.

### 0.4 Evidence sources (where a scorer looks)

| Source                                 | What it gives                                                                                                                                                                                                                                                                        | Access                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **Forensic JSON**                      | `GET /plans/:id/timing/forensic` → `slices[]`, `aggregate.byCategory`, `narrative`, `skills`, `plan`                                                                                                                                                                                 | API                                      |
| **Daemon log**                         | `/var/log/futurator-daemon.log` on EC2 — gate verdicts, fix rounds, reflector result, IAM/errors                                                                                                                                                                                     | SSH/SSM                                  |
| **DDB: plan**                          | `totalCostUsd`, `costCeilingUsd`, `totalStories`, `doneStories`, `status` + stage timestamps (`startedAt`, `reviewAt`, `qaContractDecidedAt`, …)                                                                                                                                     | repo                                     |
| **DDB: epic.stories[]**                | per-story `jobId`, `status`, `origin`, `wave`, `fixesWave`                                                                                                                                                                                                                           | repo                                     |
| **DDB: agent-jobs / agent-events**     | per-step `cost`, `inputTokens`, `outputTokens`, `durationMs`, event stream                                                                                                                                                                                                           | repo (7-day TTL on events)               |
| **Stage reports**                      | QA report (`qa-report-aggregator`), deploy report (`deploy-report-aggregator`), `inbox/reflections.md`                                                                                                                                                                               | repo / disk                              |
| **Git graph**                          | merge commits, `--no-ff` topology, commit-metadata trailers (`Agent:`, `Plan-Id:`, `Wave:`, `Story:`)                                                                                                                                                                                | worktree                                 |
| **System-graph snapshot** `[graphify]` | `_graph/graph-snapshot.json` (per project) + daemon `AST grounding` / `Orphan invariant` / `Graph analytics` log lines — node/edge counts by type, orphan list, knowledge coverage %, god-nodes, Leiden communities. A **deterministic, drift-free integrity signal** (see §13, Q9). | S3 (`knowledge-live/<id>/_graph/`) / SSH |

> ⚠️ **Known evidence gap (track in §7-OV4):** the forensic only walks the _current_
> `story.jobId`, so retried/superseded jobs are invisible. Until fix `F2/F3` lands, a
> scorer must treat forensic cost/time as a **lower bound** and cross-check against
> `plan.totalCostUsd` for the truth.

### 0.5 Output format (every scorer emits this)

```jsonc
{
  "planId": "plan_xxx",
  "rigor": "mvp|production|prototype",
  "scoredBy": "<agent-name>",
  "scoredAt": "<iso>",
  "baseline": "plan_pacman3_mqi8x64w",
  "stages": {
    "concept":     { "score": 0.0-1.0, "substages": { "...": {"score": 0-4, "evidence": "...", "note": "..."} } },
    "development": { ... }, "qa": { ... }, "deployment": { ... }, "publish": { ... }
  },
  "overview": { "timing": {...}, "cost": {...}, "integrity": {...}, "learning": {...} },
  "inefficiencies": [ { "id": "IE1", "verdict": "🟢|🟡|🔴", "value": <n>, "evidence": "..." } ],
  "pipelineHealth": 0.0-1.0,
  "topRegressions": ["..."],
  "topWins": ["..."]
}
```

---

## 1. Cross-cutting dimensions (the axes)

Every per-stage criterion belongs to one of these axes. Specialized agents may report
per-axis rollups across the whole pipeline.

| Axis                                  | What it asks                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| **D1 — Output quality / correctness** | Did the stage produce a correct, complete artifact for its intent?                          |
| **D2 — Efficiency**                   | Token + wall-time cost relative to value delivered. No thrash, no wasted loops.             |
| **D3 — Grounding / context**          | Did agents actually _use_ the inputs available to them (prior specs, AC, prior diffs)?      |
| **D4 — Integrity / observability**    | Are counts correct, logs complete start-to-finish, costs reconciled, nothing silently lost? |
| **D5 — Autonomy / resilience**        | Does it recover from failure without a human, without burning tokens in loops?              |
| **D6 — Handoff**                      | Does stage/substage N's output cleanly feed N+1 (no re-derivation, no dropped context)?     |

---

## 2. STAGE — CONCEPT

**Intent:** turn operator intent into approved, grounded specs and a plan ready to build.
**Substage weights:** route 1 · prd 2 · ux 2 · arch 2 · plan/decompose 3 · gate 2.
**Agents:** Mary (Analyst/route), John (PM/PRD), Sally (UX), Winston (Architect),
pm-plan (decompose), Murat (gate).

### 2.1 Route (`conceptRouteJobId`) — `[AGENT][MECH]`

| ID   | Criterion                                                | Axis | Evidence                               | Anchor / metric                                               | W   |
| ---- | -------------------------------------------------------- | ---- | -------------------------------------- | ------------------------------------------------------------- | --- |
| C-R1 | Route classification correct (UI vs non-UI, kind, rigor) | D1   | conceptPlan DAG vs intent              | 4=DAG matches intent exactly; 0=wrong kind/missing docs       | 2   |
| C-R2 | Routing latency & discipline                             | D2   | forensic route job dur; tool_use count | 🟢 ≤60s & no broad ToolSearch; 🔴 >180s or exploratory thrash | 1   |

### 2.2 PRD / UX / Architecture generation — `[AGENT]`

| ID   | Criterion                                                                               | Axis | Evidence                            | Anchor / metric                                                | W   |
| ---- | --------------------------------------------------------------------------------------- | ---- | ----------------------------------- | -------------------------------------------------------------- | --- |
| C-D1 | Doc completeness (covers all required sections for its kind)                            | D1   | `concept/<kind>.md` + sections.json | 4=all sections substantive; 2=present but thin; 0=missing/stub | 3   |
| C-D2 | Persona adherence (John/Sally/Winston voice & scope)                                    | D1   | doc content                         | 4=on-role, no scope bleed; 0=generic/off-role                  | 1   |
| C-D3 | **Handoff grounding** — each doc demonstrably builds on upstream (`loadPriorArtifacts`) | D6   | doc cross-refs to prior kind        | 4=explicit refs to PRD/UX in arch; 0=independently re-derived  | 3   |
| C-D4 | Citable structure (stable section IDs for downstream citation)                          | D4   | `<kind>.sections.json`              | 4=clean IDs; 0=missing                                         | 1   |
| C-D5 | Generation efficiency                                                                   | D2   | forensic per-gen-job dur/cost       | 🟢 within rigor budget; 🔴 architect-style exploratory blowup  | 2   |

### 2.3 Plan / decompose (`conceptPmPlanJobId`) — `[AGENT][MECH]` ⭐ highest-leverage

| ID   | Criterion                                                                                      | Axis  | Evidence                               | Anchor / metric                                             | W   |
| ---- | ---------------------------------------------------------------------------------------------- | ----- | -------------------------------------- | ----------------------------------------------------------- | --- |
| C-P1 | **PLANS FROM the approved specs** (receives `{{PRIOR_ARTIFACTS}}` content, not just citations) | D3    | pm-plan prompt vars; plan vs PRD scope | 4=epics trace to PRD/UX/arch; 0=re-derived from bare intent | 3   |
| C-P2 | Spec coverage (every major PRD requirement maps to ≥1 story)                                   | D1    | plan stories vs PRD reqs               | 🟢 ≥90% covered; 🔴 <60%                                    | 3   |
| C-P3 | Decomposition sanity (epics→waves→stories; parallelizable waves where independent)             | D1/D2 | epic/story tree                        | 4=balanced, wide waves; 1=all single-story serial waves     | 2   |
| C-P4 | No dangling references (cited sections resolve)                                                | D4    | `validateReferenceSections`            | 4=all resolve; 0=dangling                                   | 1   |
| C-P5 | Plan not presented instantly after arch (grounding actually happened)                          | D3    | timing gap arch→plan; prompt size      | 🔴 if plan emitted with no PRIOR_ARTIFACTS payload          | 2   |

### 2.4 Gate (Murat) + approval flow — `[MECH]`

| ID   | Criterion                                                                           | Axis | Evidence                                 | Anchor / metric                                           | W   |
| ---- | ----------------------------------------------------------------------------------- | ---- | ---------------------------------------- | --------------------------------------------------------- | --- |
| C-G1 | Gate decision quality (level/epic/story counts correct; specs complete before pass) | D1   | gate card vs plan; `specsComplete`       | 4=accurate; 0=passes incomplete specs                     | 2   |
| C-G2 | Approval-mode correctness (YOLO→autopilot auto-approve; interactive pauses)         | D5   | `conceptInteraction`, status transitions | 4=mode honored; 0=stalls on dead job (legacy convergence) | 2   |
| C-G3 | Chain visible & read-only after dev starts                                          | D4   | UI / plan rows                           | 4=full chain preserved; 0=disappears                      | 1   |

---

## 3. STAGE — DEVELOPMENT

**Intent:** implement every story correctly, merge cleanly, gate visually — minimal waste.
**Substage weights:** prework 1 · test-authoring 2 · dev 3 · review 2 · compile-loop 3 ·
merges/git-graph 2 · wave-vqa 3 · knowledge-compile 2 · wave-scheduling 2.
_(knowledge-compile bumped 1→2 by `graphify` — the system graph is the grounding
substrate for every later run AND this rubric's cheapest integrity signal; a silently
broken graph poisons D3 grounding downstream. See §3.8, §13.)_

### 3.1 Prework-gate (`daemon/lib/prework-gate.mjs`) — `[MECH]`

| ID    | Criterion                                                                  | Axis  | Evidence                              | Anchor / metric                                                                          | W   |
| ----- | -------------------------------------------------------------------------- | ----- | ------------------------------------- | ---------------------------------------------------------------------------------------- | --- |
| D-PW1 | Skip-vs-spawn decision correct (3 signals: commits, AC exports, typecheck) | D2/D5 | daemon log gate verdict + actual need | 4=correctly skips already-done work; 0=spawns redundant DEV or wrongly skips needed work | 2   |
| D-PW2 | Gate evidence written for DEV context (no re-discovery)                    | D6    | `.context/wave-N-story.md`            | 4=present; 0=absent                                                                      | 1   |

### 3.2 Test authoring (api-author + TEST) — `[AGENT][MECH]`

| ID    | Criterion                                                                                                                                                            | Axis  | Evidence                                                  | Anchor / metric                                                                                                                                                                   | W   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| D-TA1 | Tests map to ACs (one failing test per verifiable AC)                                                                                                                | D1    | test files vs AC list                                     | 4=full AC coverage; 2=partial; 0=token-burning irrelevant tests                                                                                                                   | 2   |
| D-TA2 | **Authoring cost ratio** (test-author time ÷ dev time)                                                                                                               | D2    | forensic per-job test-author vs dev ms                    | 🟢 ≤0.6; 🟡 0.6–1.0; 🔴 >1.0 (authoring costs more than building)                                                                                                                 | 3   |
| D-TA3 | Red-gate honored (tests fail before DEV; production rigor)                                                                                                           | D1    | `test-gate-red` step                                      | 4=red enforced; 0=skipped where required                                                                                                                                          | 2   |
| D-TA4 | **Visual-probe authoring completeness** — every `state`/`behavior` (L2) AC ships an executable probe (flow/assert/seam read), not a prose expectation + a bare level | D1/D6 | visualTest `flow`/`assert` vs `level`; AC verb            | 4=mechanism authored for every non-appearance AC; 0=L2 set with `flow=null, assert=∅` (pacman3: **AC-S2-2 "position.col increased" / AC-S2-3 "direction UP" → L2, no probe = 0**) | 3   |
| D-TA5 | **Level-assignment honesty** — chosen level matches the classifier's own `resolvedLevel` / the cheapest oracle that can answer                                       | D1/D2 | `CLASSIFIED_TESTS[].classification.{level,resolvedLevel}` | 4=cheapest-correct & consistent; 1=preserves a worse source level over its better resolve (pacman3: AC-S1-1 `resolvedLevel:L0` kept as `L1`; `L0_RESULTS:[]` = **1**)             | 1   |

> **[QAreview-agentic]** D-TA4/D-TA5 extend test-authoring scoring to **visual/probe
> tests** (authored during dev, executed at §3.7 wave-VQA and §4 QA). The pacman3
> wave-gate "unverifiable" disease (§3.7 D-VQ1, ~43%) and the final-QA uncertain/false-FAIL
> share the **same root**: state ACs with no executable probe (D-TA4) + a static-frame
> oracle + capture failure (Q-C6). Fix D-TA4 + Q-C6/Q-C7 and both move together.

### 3.3 Dev implementation — `[AGENT]`

| ID    | Criterion                                                                   | Axis | Evidence                            | Anchor / metric                        | W   |
| ----- | --------------------------------------------------------------------------- | ---- | ----------------------------------- | -------------------------------------- | --- |
| D-DV1 | AC satisfied (tests green, story intent met)                                | D1   | test-verify result; story status    | 4=all AC met; 0=merged red             | 3   |
| D-DV2 | Stays within declared touch-points (no scope creep)                         | D1   | ship-contract / diff vs touchPoints | 4=scoped; 1=broad unrelated edits      | 2   |
| D-DV3 | Context-pack actually used (edits land in cited files / use public exports) | D3   | diff vs context pack                | 4=grounded; 1=ignored provided context | 2   |

### 3.4 Review (REVIEWER) + retry loop — `[AGENT][MECH]`

| ID    | Criterion                                                           | Axis  | Evidence                                  | Anchor / metric                                  | W   |
| ----- | ------------------------------------------------------------------- | ----- | ----------------------------------------- | ------------------------------------------------ | --- |
| D-RV1 | Review catches real defects (not rubber-stamp, not nitpick-only)    | D1    | review events vs subsequent fixes         | 4=substantive; 0=noise or pass-through           | 2   |
| D-RV2 | Retry **resumes** prior session (warm cache) rather than restarting | D2/D5 | daemon `retry-resume: --resume` lines     | 4=resumes & skips complete steps; 0=cold restart | 2   |
| D-RV3 | Review-runtime loop bounded (no runaway iterations)                 | D5    | daemon `LOOP iteration n/2 … attempt n/3` | 🟢 ≤2 iters to green; 🔴 hits cap repeatedly     | 2   |

### 3.5 Compile / typecheck loop — `[MECH]` ⭐ biggest known sink

| ID    | Criterion                                                                       | Axis | Evidence                                    | Anchor / metric                                     | W   |
| ----- | ------------------------------------------------------------------------------- | ---- | ------------------------------------------- | --------------------------------------------------- | --- |
| D-CC1 | **Compiles per story** (in-loop tsc/test invocations)                           | D2   | forensic `compile` slices ÷ dev jobs        | 🟢 ≤15; 🟡 15–40; 🔴 >40 (pacman3: **65–102 = 🔴**) | 3   |
| D-CC2 | Compile caching active (cached-tsc / incremental in the loop, not just prework) | D2   | repeated identical tsc with no input change | 4=cache hits; 0=full recompile every iteration      | 3   |
| D-CC3 | Compile share of stage time                                                     | D2   | `aggregate.byCategory.compile` %            | 🟢 ≤15%; 🔴 >25% (pacman3: **29% = 🔴**)            | 2   |

### 3.6 Merges / git-graph (wave-merge) — `[MECH][OUTPUT]`

| ID    | Criterion                                                                 | Axis | Evidence                           | Anchor / metric                                                       | W   |
| ----- | ------------------------------------------------------------------------- | ---- | ---------------------------------- | --------------------------------------------------------------------- | --- |
| D-MG1 | Clean merges (no conflicts; post-merge tests green)                       | D1   | `classifyWaveMergeOutcome` outcome | 4=all `success`; 2=≥1 fix-forward; 0=conflict/build-failed unresolved | 3   |
| D-MG2 | Git-graph integrity (`--no-ff` per story; correct wave base ref chaining) | D4   | git topology; `waveBaseRef`        | 4=clean wave→wave SHA chain; 0=tangled/lost lineage                   | 2   |
| D-MG3 | Commit-metadata trailers complete (`Agent/Plan-Id/Epic/Wave/Story`)       | D4   | merge commit messages              | 4=all trailers; 0=missing provenance                                  | 1   |
| D-MG4 | Merge-gate latency                                                        | D2   | forensic `merge-gate` ms per wave  | 🟢 ≤60s; 🔴 >120s sustained                                           | 1   |

### 3.7 Wave-VQA gate — `[AGENT][MECH]`

| ID    | Criterion                                                                               | Axis  | Evidence                              | Anchor / metric                                            | W   |
| ----- | --------------------------------------------------------------------------------------- | ----- | ------------------------------------- | ---------------------------------------------------------- | --- |
| D-VQ1 | Verdict reliability — **unverifiable rate**                                             | D1    | daemon `unverifiable=n` tally         | 🟢 ≤15%; 🟡 15–30%; 🔴 >30% (pacman3: 6/14 ≈ **43% = 🔴**) | 3   |
| D-VQ2 | Judge consensus calibration (few false PASS / false FAIL)                               | D1    | judge verdicts vs ground truth        | 4=calibrated; 0=systematic mis-grade                       | 2   |
| D-VQ3 | **No wasted fix rounds** (FIXER not run on non-code-bugs; no "improved nothing→revert") | D2/D5 | daemon `improved nothing — reverting` | 🟢 0 wasted; 🔴 ≥1 (pacman3: **1 = 🔴**)                   | 3   |
| D-VQ4 | Fix-forward handoff preserved (evidence committed, prior diff available)                | D4/D6 | `.context/vqa-handoffs/*.json`        | 4=evidence + prior diff; 2=evidence only; 0=lost           | 2   |
| D-VQ5 | VQA share of stage time                                                                 | D2    | `aggregate.byCategory.vqa-gate` %     | 🟢 ≤15%; 🔴 >25% (pacman3: **23% = 🟡/🔴**)                | 2   |

### 3.8 Knowledge-compile / system-graph — `[MECH][OUTPUT]`

| ID    | Criterion                                                                                                                     | Axis | Tag             | Evidence                                                                               | Anchor / metric                                                                                                                                  | W   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ---- | --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| D-KC1 | Knowledge written per story/wave-close (index stays current)                                                                  | D4   | [MECH]          | `knowledge/index.md` freshness                                                         | 4=current; 0=stale/absent                                                                                                                        | 1   |
| D-KC2 | **AST-facts completeness** — persisted `.mycelium/ast-facts.json` covers the FULL project, not just the last story's worktree | D4   | [MECH]          | ast-facts `fileCount` ÷ source-file count; daemon `Scanned n files`                    | 🟢 ≥0.95; 🟡 0.5–0.95; 🔴 <0.5 (pacman3: persisted **3/51 ≈ 6% = 🔴** — last story's worktree scope shadowed the whole project)                  | 3   |
| D-KC3 | **Graph orphan rate** — code nodes (file/function) with zero edges at snapshot                                                | D4   | [MECH] [OUTPUT] | snapshot "Unconnected nodes"; `Orphan invariant`; `_graph/orphans`                     | 🟢 0; 🟡 1–5; 🔴 >5 (pacman3 at original snapshot: **20 code-function orphans = 🔴**; root = D-KC2 + D-KC5)                                      | 2   |
| D-KC4 | **Orphan-invariant enforced/surfaced** — a FAILED invariant gates or alarms, not exit-3-ignored                               | D5   | [MECH]          | graph-sync exit code handling; wave-gate hook                                          | 4=surfaced/gated; 0=non-blocking & invisible (pacman3: graph-sync `exited 3 (non-blocking)` — the FAIL was invisible until inspected = **0**)    | 2   |
| D-KC5 | **projectId partition integrity** — every node carries the canonical project slug; none stranded in job/plan-UUID partitions  | D4   | [MECH]          | snapshot projectId distribution; nodes whose projectId is a UUID                       | 4=all-slug; 0=UUID-stranded nodes silently drop edges (pacman3: file nodes in partition `353ab84c…`; systemic UUID tail across projects = **0**) | 2   |
| D-KC6 | **Living-doc connectivity** — architecture/decision/index/system docs link to the code they describe (not floating)           | D6   | [OUTPUT]        | snapshot floaters with `type∈{decision,system,index,architecture}`; `REFERENCES` edges | 4=living docs connected; 0=float unconnected (pacman3: **9 floaters = 🔴 → 0** after REFERENCES layer)                                           | 1   |

> **[graphify · 2026-06-18]** D-KC2→D-KC6 are one causal chain, and the chain mirrors
> §4's QA story: **a correct app produced a broken graph because the harness leaked, not
> the agents.** Per-story DEV runs against a detached worktree, so the persisted
> `ast-facts.json` ends up being the **last** story's 3-file scope, not the 51-file project
> (D-KC2); functions in files finalized in earlier stories never get their file→function
> `DEFINES` edge and orphan (D-KC3); the `Orphan invariant` graph-sync computes this and
> **FAILS — but exits 3, non-blocking, so nobody saw it** (D-KC4); compounding it, early
> ingestion stamped some file nodes with the **job/plan UUID as `projectId`**, stranding
> them outside the project partition so their edges silently dropped (D-KC5). **Status:**
> D-KC5 and D-KC6 are **fixed in code this session** (projectId now normalized to the slug
> on every sync, self-healing across all projects; `REFERENCES` edges connect living docs).
> D-KC2's pipeline mechanism (persist a **full-project** ast-facts at wave-close, not the
> worktree scope) and D-KC4 (enforce/surface the invariant) are **not yet fixed → F14 / F16**.
> Net effect on pacman3 after this session: orphans **20 → 0**, snapshot **177/290 → 212/526**.

### 3.9 Wave scheduling / parallelism — `[MECH]`

| ID    | Criterion                                                                    | Axis | Evidence                            | Anchor / metric                                                       | W   |
| ----- | ---------------------------------------------------------------------------- | ---- | ----------------------------------- | --------------------------------------------------------------------- | --- |
| D-WS1 | **Parallelism factor** (cumulative attributed ÷ wall)                        | D2   | forensic `aggregate.totalMs` ÷ wall | 🟢 ≥1.5×; 🟡 1.2–1.5×; 🔴 <1.2× (pacman3: **1.03× = 🔴**)             | 2   |
| D-WS2 | Parallelism not throttled to mask host saturation (root-cause fixed instead) | D2   | concurrency config vs host metrics  | 4=full concurrency, host healthy; 0=concurrency lowered as a band-aid | 2   |

### 3.10 Skill grounding, discovery & trust — `[MECH][AGENT][OUTPUT]` `[skills-module]`

**Substage weight: medium.** The rubric (v0) scored skills only as _cost overhead_ (OV7/IE10) and
the _learning loop_ (OV8). That's incomplete and subtly mis-framed: the pacman3 lesson is **not**
"the catalog is too big, prune it" — it's that skills are **loaded but unused, not ranked by
relevance, and never discovered for the plan's actual domain.** This substage scores the skill
subsystem as a first-class quality axis. **Don't let a healthy `[MECH]` loader (SK1) hide a dead
`[AGENT]` activation (SK2).** All anchors calibrated to the pacman3 baseline.

| ID  | Criterion                                                                                   | Axis  | Evidence                                                                                    | Anchor / metric                                                                                                                                            | W   |
| --- | ------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| SK1 | **Skill availability** (loadout present, tool exposed, no zero-skill sessions)              | D6    | `skills.hasSkillTool`, `availableSkillCount`, `sessionsReportingZeroSkills`                 | 🟢 tool present & 0 zero-skill sessions; 🔴 sessions with no skills (pacman3: 66 avail / 0 zero / tool=true → **🟢** — loading is healthy)                 | 2   |
| SK2 | **Activation when relevant** (agents actually invoke skills they're given)                  | D3    | `skills.totalSkillToolUseEvents` ÷ `sessionsReportingAvailability`; distinct used ÷ avail   | 🟢 ≥30% sessions activate; 🟡 10–30%; 🔴 <10% (pacman3: **5.2% / 1.5% distinct = 🔴** — the dominant skill defect, F24)                                    | 3   |
| SK3 | **Loadout relevance / ranking** (offered skills ranked to the task, not flat readdir order) | D3    | `skills-prompt.mjs` ordering; is `index.embeddings.json` read at load time?                 | 4=relevance-ranked (vector/keyword); 0=flat pins-then-readdir, embeddings write-only (pacman3: **0**, F27)                                                 | 2   |
| SK4 | **Discovery (scout) fired for the plan's need** (domain skills surfaced for this intent)    | D1/D6 | `skills.skillScoutRuns`; scout disposition; was a domain skill proposed for the plan intent | 🟢 scout ran & surfaced ≥1 relevant skill; 🔴 dormant or no domain match (pacman3: `skillScoutRuns:[]` for a game plan → **🔴**, F25)                      | 2   |
| SK5 | **Trust integrity of what loads** (every installed/loaded skill is vetted; none unvetted)   | D4    | index `trustTier` / source `auto-trust`; vendor "BLOCKED" log; no community-source bypass   | 🟢 all loaded skills `trusted` or from a trusted source; 🔴 an unvetted skill reached the app (pacman3: pre-institution, **unlabeled = N/A→build target**) | 3   |
| SK6 | **Registry self-improvement** (the plan left the registry better than it found it)          | D5/D4 | reflector `project-skill` proposals written; app-evolved SKILL.md authored & loadable next  | 🟢 ≥1 app-evolved/registry skill authored & consumable next run; 🔴 none / write-lost (pacman3: reflector `written=0` → **🔴**, OV8/F5)                    | 2   |

> **[skills-module] How SK\* relates to the existing OV7/IE10/OV8.** SK1 = the _healthy_ half OV7
> conflates with cost (loading works — credit it). SK2/SK3 are the _new_ axis OV7 misses: low
> activation is an **activation+relevance** problem, not a "shrink the catalog to save tokens"
> problem — the fix is push the _right_ skill bodies (SK3→SK2), not inject fewer. SK6 is OV8
> from the registry's side (does the loop _produce_ a reusable skill, not just write a note).
> SK5 is net-new — the rubric had no "is what loads actually vetted?" criterion.

---

## 4. STAGE — QA (contract gate)

**Intent:** independently verify the delivered build against claims/ACs and route
remediation correctly. **Substage weights:** claims 2 · contract-gate 3 · verdict 2 ·
remediation 2. _(Note: in pacman3 the standalone `qa` category logged 0ms — QA ran via
wave-VQA inside development. This stage scores the dedicated QA/contract layer:
`qaJobId`, `qaContractStatus`, `qaAggregateJobId`.)_

> **[QAreview-agentic · 2026-06-17] Correction — the QA job DID run, and it FAILED.**
> The dedicated qa-execute job ran on pacman3 (`qaJobId 3c99fd51…`, COMPLETED): 10 tests
> → **6 fail / 4 uncertain / 0 pass, OVERALL FAIL, BLOCKING**. The forensic logged
> `qa`=0ms only because that job runs _after_ `review` and the forensic doesn't walk it
> (an OV4/IE2 instance — not an absence of QA). So the pacman3 QA stage is a **measured
> 🔴**, not "N/A". Critically, **every blocking FAIL is an infra artifact, not an app
> defect** — `overview.png` shows a correct, fully-assembled Pac-Man. Full root cause in
> §12; the new criteria Q-C6–Q-C9 below score the failure class that produced it.

| ID   | Criterion                                                                                                         | Axis  | Tag     | Evidence                                                                                    | Anchor / metric                                                                                                                                                           | W   |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Q-C1 | Claims/ACs extracted completely                                                                                   | D1    | [AGENT] | qa-report claims-table                                                                      | 4=full; 0=missing claims                                                                                                                                                  | 2   |
| Q-C2 | Contract-gate decision correct (`qaContractStatus` matches evidence)                                              | D1    | [MECH]  | qa report + `qaContractDecidedBy/At`                                                        | 4=correct; 0=passes failing contract                                                                                                                                      | 3   |
| Q-C3 | Verdict calibration (false-positive / false-negative rate)                                                        | D1    | [AGENT] | verdict-strip vs reality                                                                    | 🟢 ≤10% error; 🔴 >25%                                                                                                                                                    | 2   |
| Q-C4 | **Remediation routing** — send-back for render bugs, Accept for interaction-gated VQA false-negatives             | D1/D5 | [MECH]  | remediation decisions                                                                       | 4=routes per model; 0=mis-routes (auto-bypass instead of building UI fix)                                                                                                 | 2   |
| Q-C5 | QA latency/cost proportional to risk                                                                              | D2    | [MECH]  | forensic qa job cost                                                                        | 🟢 within rigor budget; 🔴 disproportionate                                                                                                                               | 1   |
| Q-C6 | **Evidence-capture integrity** — per-test screenshots actually captured & uploaded (not 0/N), visually distinct   | D4    | [MECH]  | `PREPARE_OUTPUT: SCREENSHOTS_CAPTURED n/m`; S3 file count; image byte-diversity             | 🟢 ≥95% captured & distinct; 🔴 <50% or all-identical (pacman3: **0/10; only `overview.png` usable = 🔴**)                                                                | 3   |
| Q-C7 | **Honest verdict under broken evidence** — missing/404/blank frames scored `errored`→retry, NEVER blocking `fail` | D1/D5 | [MECH]  | `qa-report` overall logic (`overall = fail>0 ? FAIL`); per-test rationale vs file existence | 4=infra failure never blocks; 0=missing frame → blocking FAIL (pacman3: **6 broken frames scored FAIL = 0**)                                                              | 3   |
| Q-C8 | **Oracle hallucination guard** — judge never fabricates observations of a frame it could not read                 | D1    | [AGENT] | judge rationale vs file md5/existence                                                       | 4=missing→"file not found"; 0=fabricated detail + FAIL on absent/identical frame (pacman3: judges split — 3 honest UNCERTAIN, ≥1 fabricated "404 page" FAIL = **0**)      | 2   |
| Q-C9 | **Stage isolation** — QA's dev server/worktree not mutated by a concurrent stage (deploy/build) mid-run           | D4/D5 | [MECH]  | devserver.log "Found a change…/Restarting"; overlapping job windows on same `workingDir`    | 4=isolated checkout/URL; 0=concurrent writer restarts the server mid-capture (pacman3: deploy `d777f835` + QA `3c99fd51` same dir, same tick → 2 restarts → 404s = **0**) | 3   |

> **[QAreview-agentic]** Q-C6/Q-C7/Q-C9 are `[MECH]` and, on pacman3, all 0 → by §0.3 the
> QA stage caps at "Acceptable" and pipeline health takes the hit. The lesson: **a clean
> agent (correct app) was buried by a leaky harness (deploy raced QA, broke the evidence,
> and the verdict math blocked on the breakage).** Q-C6 should arguably be a _precondition
> gate_ that aborts+retries before any judge spends tokens (see §11 Q6).

---

## 5. STAGE — DEPLOYMENT

**Intent:** build the export **once** and **promote the same artifact** safely up the
environment ladder (dev → staging → production), with smoke verification, rollback, and
zero blast-radius to the public homepage. **Substage weights:** build 2 · framework-detect 2 ·
build-once-promotion 2 · environment-ladder 2 · smoke 2 · release/rollback 2 ·
per-env observability 2 · **stage-isolation 3** · **deploy-safety 3**.
Evidence: `devDeployJobId`, `stagingDeployJobId`, `deployJobIds[]`, `deploy-report-aggregator`,
`deploy-stage-view`, `release-strip`, `environment-ladder`, `deploy-history`, `deploy-logs`;
the DEPLOY agent step events + `DEPLOY_URL`/`DEPLOY_STATUS`/`SMOKE_STATUS` extractors;
`build-deploy-pipeline.ts` / `build-promote-pipeline.ts` prompts + `deploy-targets.ts`
resolution. Design + field findings: [`deployment-v2.5.md`](../deployment-v2.5.md) §1–§15.

> **[deployment · 2026-06-18] Reframe — "Deploy" is a promotion ladder, not a push.**
> The original §5 ("push to S3") predates the v2.5 control panel. Deployment is an **agentic
> job** (Claude CLI on EC2: detect framework → build → `aws s3 sync` → CloudFront invalidate
> → smoke), driven dev → staging → production by the operator. **Build-once-promote-many** is
> the intent; the daemon's `postDeployWriteback` routes by `deployEnvironment` so ONLY a
> production publish advances `main` (dev/staging record a preview URL; rollback sets
> `skipTrunkAdvance`). Same lesson as §4/§13: the agents were fine; the **harness leaked** —
> the artifact URL was truncated, deploy raced QA, and "build-once" wasn't actually happening.
> Calibration anchors: pacman3 + brick1 (the first real end-to-end promotion to prod).

| ID    | Criterion                                                                                                                                                                       | Axis  | Tag             | Evidence                                                                                          | Anchor / metric                                                                                                                                                                                                         | W   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| DP-B1 | Build reproducible & green (static export succeeds)                                                                                                                             | D1    | [MECH]          | deploy report build step                                                                          | 4=clean; 0=fails/non-reproducible                                                                                                                                                                                       | 2   |
| DP-L1 | Environment-ladder progression honored (preview → … → prod, no skips)                                                                                                           | D5    | [MECH]          | environment-ladder state                                                                          | 4=ordered promotion; 0=jumps straight to prod                                                                                                                                                                           | 2   |
| DP-R1 | Release recorded with rollback handle                                                                                                                                           | D4/D5 | [MECH]          | release-strip / deploy-history                                                                    | 4=versioned + rollbackable; 0=no record                                                                                                                                                                                 | 2   |
| DP-S1 | **Deploy safety** — admin `out/` NEVER synced to `futurator-ai-website`; only scoped paths written; `sst deploy` path used                                                      | D4    | [MECH]          | deploy target vs scoped-path allowlist                                                            | 4=scoped & SST-only; **0=any root sync to public bucket (catastrophic)**                                                                                                                                                | 3   |
| DP-D1 | Deploy report complete (artifacts, URLs, timings)                                                                                                                               | D4    | [OUTPUT]        | deploy-report-aggregator                                                                          | 4=full; 0=opaque                                                                                                                                                                                                        | 1   |
| DP-T1 | Deploy latency                                                                                                                                                                  | D2    | [MECH]          | forensic deploy job dur                                                                           | 🟢 within budget; 🔴 stalls                                                                                                                                                                                             | 1   |
| DP-B2 | **Framework-detection correctness** — deploy patches the RIGHT config (Next.js `basePath` no-slash + `output:'export'` + `out/`; Vite `base` + `dist/`), not improvised/guessed | D1    | [MECH]          | DEPLOY logs config edit vs detected framework                                                     | 4=detected & correct; 🟡 agent improvises correctly under a framework-blind prompt; 0=wrong base/dir (brick1/pacman3: Vite-only prompt, Next app → improvised = 🟡; **fixed `1755365`**)                                | 2   |
| DP-U1 | **Published-URL integrity** — recorded `devUrl`/`stagingUrl`/`deployUrl` is the full, resolvable target (the `DEPLOY_URL` extractor doesn't truncate)                           | D1/D4 | [MECH] [OUTPUT] | extractor capture vs `target.publicUrl`; rendered link 200                                        | 4=full URL, resolves; 0=truncated/dead (pacman3: stored `https://futurator.ai/apps/` — the URL capture class excluded `_`, eating the `_dev`/`_staging` segment = **0**; **fixed `1755365`**)                           | 3   |
| DP-L2 | **Build-once promotion** — promote copies the SAME artifact bytes (no rebuild); the primary CTA never bypasses the ladder with a fresh prod build                               | D1/D2 | [MECH] [OUTPUT] | promote mode (copy vs rebuild); release-strip CTA path                                            | 4=byte-copy promote, single ladder CTA; 🟡 rebuild-per-rung (fallback); 0=staging-bypassing fresh prod build as primary (fallback rebuilds = 🟡; dual prod path removed this session → warning-gated escape hatch only) | 2   |
| DP-S2 | **Smoke verification** — post-deploy `curl`+parse asserts a real page; `SMOKE_STATUS` surfaced per rung; a failed staging smoke warns before prod promote (soft gate)           | D1/D4 | [MECH]          | `SMOKE_STATUS` extractor; smoke badge; prod-confirm warning                                       | 4=ran + surfaced + soft-gates; 0=absent/silent (added this session)                                                                                                                                                     | 2   |
| DP-I1 | **Deploy stage isolation** — the DEPLOY agent does NOT mutate a worktree/config shared with a concurrent stage (the deploy side of Q-C9/IE13)                                   | D4/D5 | [MECH]          | deploy `workingDir` vs QA `workingDir`; `next.config.ts` rewrites mid-QA; overlapping job windows | 4=isolated build dir / env-injected base; 0=rewrites shared tree mid-run (pacman3: deploy `d777f835` rewrote `next.config.ts` in QA's live worktree → Turbopack restart → 404 = **0**; **OPEN → Q10/F11**)              | 3   |
| DP-E1 | **Environment provisioning isolation** — dev/staging run on their own bucket+domain (true isolation) vs shared public-bucket reserved prefixes (fallback)                       | D4    | [MECH]          | `deploy-targets` `provisioned` flag; URL host                                                     | 4=own subdomain+bucket; 🟡 shared bucket `apps/_dev/`,`apps/_staging/` prefixes; 0=collides with prod path (current: **fallback = 🟡**; subdomains = 🟢 target → F22)                                                   | 2   |
| DP-O1 | **Per-environment deploy observability** — logs + step tracker stream for EVERY env deploy (dev/staging/prod), not production-only                                              | D4    | [MECH]          | `deploy-stage-view` active-env job binding; `deploy-logs`                                         | 4=all envs stream; 0=non-prod deploys dark (pre-fix: dev/staging bound to `report.current` only = 🔴; **fixed this session** — QA-stage + Deploy-stage stream the active env job)                                       | 2   |

> **[deployment · 2026-06-18]** DP-B2/DP-U1/DP-S2/DP-O1 are **fixed this session** (commit
> `1755365`, live on prod via `c937de7`): the URL-truncation regex, the framework-aware
> deploy/promote prompts, dev/staging log streaming, and smoke surfacing + the prod soft-gate.
> **DP-I1 and DP-E1 remain OPEN.** DP-I1 is the **deploy side of §12's Q-C9/IE13** — my
> framework-aware prompt made the `next.config.ts` patch _correct_ but it still **mutates a
> shared worktree**, so the deploy×QA race is unremoved (the root fix is Q10: patch base via
> env/isolated dir, never edit a shared tracked file). DP-E1 is fallback reality: dev/staging
> live under `apps/_dev/`/`apps/_staging/` on the public bucket, so promotion **rebuilds**
> (DP-L2 = 🟡) instead of byte-copying — provisioning the `dev.`/`staging.futurator.ai`
> subdomains (deployment-v2.5.md §14) is what flips DP-E1→🟢 and DP-L2→🟢 (F22).

---

## 6. STAGE — PUBLISH

**Intent:** publish the user app + update public surfaces, without corrupting the
homepage. **Substage weights:** artifact-publish 2 · public-index 2 · media 1 ·
**scoped-path-safety 3**. Evidence: `apps/<appName>/`, `data/projects.json`,
`media/<projectId>/`, `devUrl`.

| ID   | Criterion                                                                                        | Axis | Tag      | Evidence                        | Anchor / metric                                                         | W   |
| ---- | ------------------------------------------------------------------------------------------------ | ---- | -------- | ------------------------------- | ----------------------------------------------------------------------- | --- |
| P-A1 | App artifact published to `apps/<appName>/` correctly; `devUrl` resolves                         | D1   | [OUTPUT] | published URL 200 + correct app | 4=live & correct; 0=404/wrong app                                       | 2   |
| P-X1 | `data/projects.json` updated atomically & valid (no homepage corruption)                         | D4   | [MECH]   | projects.json integrity         | 4=valid & scoped; 0=overwrites/corrupts                                 | 2   |
| P-S1 | **Scoped-path safety** (writes confined to the 4 allowed paths; homepage `index.html` untouched) | D4   | [MECH]   | S3 write paths vs allowlist     | 4=confined; **0=touches homepage root (the 2026-04-15 incident class)** | 3   |
| P-M1 | Media uploads land under `media/<projectId>/` only                                               | D4   | [MECH]   | upload paths                    | 4=scoped; 0=stray writes                                                | 1   |
| P-I1 | Publish idempotent & re-runnable                                                                 | D5   | [MECH]   | re-publish behavior             | 4=idempotent; 0=duplicates/breaks                                       | 1   |

---

## 7. OVERVIEW — cross-cutting (timing, forensic, integrity, learning)

**Stage weight in pipeline health: high (see §9).** This is where "forensic →
inefficiencies" lives.

| ID   | Criterion                                                                                                                                                                                                                 | Axis  | Evidence                                                                                                              | Anchor / metric                                                                                                                                                                                                                                                                                                                                            | W   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| OV1  | **Wall-clock vs value** (total wall per story)                                                                                                                                                                            | D2    | wall ÷ doneStories                                                                                                    | 🟢 ≤8 min/story; 🟡 8–15; 🔴 >15 (pacman3: 177/15 ≈ **11.8 = 🟡**)                                                                                                                                                                                                                                                                                         | 2   |
| OV2  | **Cost vs ceiling** (overrun)                                                                                                                                                                                             | D2    | `totalCostUsd` ÷ `costCeilingUsd`                                                                                     | 🟢 ≤1.0; 🟡 1.0–1.1; 🔴 >1.1 (pacman3: **1.05 = 🟡**)                                                                                                                                                                                                                                                                                                      | 3   |
| OV3  | **Cost per story**                                                                                                                                                                                                        | D2    | `totalCostUsd` ÷ doneStories                                                                                          | 🟢 ≤$1.0; 🟡 $1–$1.5; 🔴 >$1.5 (pacman3: **$1.40 = 🟡**)                                                                                                                                                                                                                                                                                                   | 2   |
| OV4  | **Forensic completeness** (captures ALL jobs incl. retries; cost reconciles to `plan.totalCostUsd`)                                                                                                                       | D4    | forensic event-cost sum vs plan cost                                                                                  | 🟢 reconciles ±5%; 🔴 gap = invisible retry spend (pacman3: **🔴**, F3)                                                                                                                                                                                                                                                                                    | 3   |
| OV5  | **Count integrity** (`doneStories ≤ totalStories`; fix-forward stories accounted)                                                                                                                                         | D4    | plan counters vs story tree                                                                                           | 🟢 consistent; 🔴 `done>total` (pacman3: **15>14 = 🔴**, F4)                                                                                                                                                                                                                                                                                               | 2   |
| OV6  | **Log retention across retries** (no orphaned, unreachable job logs)                                                                                                                                                      | D4    | jobs in agent-events vs referenced by stories                                                                         | 🟢 all reachable; 🔴 orphans exist (pacman3: **🔴**, F2)                                                                                                                                                                                                                                                                                                   | 2   |
| OV7  | **Per-session boilerplate overhead** (skills catalog injected vs used)                                                                                                                                                    | D2    | skills `availableSkillCount` vs `activatedSkills`; `claude_md_loaded` count                                           | 🟢 catalog scoped to need; 🔴 large unused catalog × every session (pacman3: 66 avail / 1 used × 77 = **🔴**)                                                                                                                                                                                                                                              | 1   |
| OV8  | **Learning loop closed** — reflector fired AND written AND surfaced                                                                                                                                                       | D4/D5 | daemon `reflector … written=n`; `inbox/reflections.md`                                                                | 🟢 proposals written & visible; 🔴 `written=0` / IAM-blocked (pacman3: **proposals=3, written=0 = 🔴**, F5)                                                                                                                                                                                                                                                | 3   |
| OV9  | **Reflector signal quality** (proposals are specific & actionable, not generic)                                                                                                                                           | D1    | reflections content                                                                                                   | 4=actionable; 0=platitudes (N/A if OV8 red — couldn't read them)                                                                                                                                                                                                                                                                                           | 1   |
| OV10 | **Stage-time attribution correctness** (categories map to real work; no mis-attribution)                                                                                                                                  | D4    | `aggregate.byCategory` sanity                                                                                         | 🔴 if a real category logs ~0 (pacman3: `fix`=0.2s while fixes happened = mis-attributed)                                                                                                                                                                                                                                                                  | 1   |
| OV11 | **Agent-spawn precondition integrity** `[deployment]` — every prerequisite the daemon injects into a Claude CLI spawn (MCP config, env, allowlist) exists or self-heals; a missing _generated_ file never fails the spawn | D5/D4 | daemon `step_error` "MCP config file not found"; `mcp-config.mjs` `existsSync`/`mkdirSync` guard; `MYCELIUM_MCP` flag | 🟢 spawn preconditions always satisfied/self-healing; 🔴 any agent job dies at spawn for a missing injected prereq (pacman3 deploy: `--mcp-config /opt/futurator-daemon/mcp/mcp-config.generated.json` absent → `step_error` exit 1; the `configWritten` latch + redeploy-deletes-file + no `existsSync` re-check → **ALL agent jobs blocked = 🔴**, Fnew) | 3   |

---

## 8. Inefficiency / anti-pattern detector catalog

Quantitative tripwires a scorer runs every plan. Each maps to a fix in
`pipeline-v2.5-fixes-plan.md`. **Calibrated to pacman3 (v0).**

| ID   | Anti-pattern                                                | Signal / metric                                                                | 🟢     | 🟡       | 🔴           | pacman3                                         | Fix                     |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ | -------- | ------------ | ----------------------------------------------- | ----------------------- |
| IE1  | Compile thrash                                              | tsc/test invocations per dev story                                             | ≤15    | 15–40    | >40          | **65–102**                                      | F1                      |
| IE2  | Retry log orphaning                                         | jobs in agent-events not referenced by any story.jobId                         | 0      | 1–2      | >2           | **>0**                                          | F2                      |
| IE3  | Forensic cost gap                                           | \|plan.totalCostUsd − Σforensic event cost\| / plan cost                       | ≤5%    | 5–15%    | >15%         | **🔴**                                          | F3                      |
| IE4  | Count drift                                                 | doneStories − totalStories                                                     | 0      | —        | >0           | **+1**                                          | F4                      |
| IE5  | Reflector write-loss                                        | reflector proposals produced but `written=0`                                   | never  | —        | any          | **3→0**                                         | F5                      |
| IE6  | Cost-ceiling overrun                                        | totalCostUsd / costCeilingUsd                                                  | ≤1.0   | 1.0–1.1  | >1.1         | **1.05**                                        | F6                      |
| IE7  | Test-author cost inversion                                  | Σ test-author ms / Σ dev ms                                                    | ≤0.6   | 0.6–1.0  | >1.0         | **~1.0**                                        | F7                      |
| IE8  | Wasted fix rounds                                           | count of `improved nothing → revert`                                           | 0      | —        | ≥1           | **1**                                           | F8                      |
| IE9  | VQA unverifiable rate                                       | unverifiable verdicts / total VQA verdicts                                     | ≤15%   | 15–30%   | >30%         | **~43%**                                        | F8                      |
| IE10 | Skills catalog overhead                                     | availableSkillCount with ≤1 activation × sessions                              | scoped | —        | large&unused | **66/1×77**                                     | F9                      |
| IE11 | Low parallelism                                             | cumulative attributed ÷ wall (multi-story plans)                               | ≥1.5×  | 1.2–1.5× | <1.2×        | **1.03×**                                       | F10                     |
| IE12 | Context rebuild waste                                       | per-story context rebuilt with no cross-story/wave cache                       | cached | —        | full rebuild | **rebuild**                                     | §5(fixes)               |
| IE13 | **Stage-isolation breach** (concurrent worktree mutation)   | dev-server restarts during QA / overlapping job windows on same `workingDir`   | 0      | —        | ≥1           | **2 restarts (deploy×QA, same tick, same dir)** | F11 (new)               |
| IE14 | **QA evidence-capture failure**                             | per-test screenshots captured ÷ authored                                       | ≥95%   | 50–95%   | <50%         | **0/10**                                        | F12 (new)               |
| IE15 | **Infra failure scored as defect**                          | blocking FAILs whose rationale is a missing/404/blank frame                    | 0      | —        | ≥1           | **6**                                           | F12 (new)               |
| IE16 | **AST-facts truncation** `[graphify]`                       | persisted `ast-facts.json` fileCount ÷ project source files                    | ≥0.95  | 0.5–0.95 | <0.5         | **3/51 ≈ 6%**                                   | F14                     |
| IE17 | **Graph orphan accumulation** `[graphify]`                  | code nodes (file/function) with zero edges at snapshot                         | 0      | 1–5      | >5           | **20 → 0 (fixed)**                              | F14+F15+F17             |
| IE18 | **projectId partition drift** `[graphify]`                  | nodes stamped with a job/plan UUID instead of the project slug                 | 0      | —        | ≥1           | **UUID tail, many projects (now self-healing)** | F17 (shipped `0d5dd6a`) |
| IE19 | **Knowledge-graph zombies** `[graphify]`                    | nodes whose source file/article was deleted, never pruned                      | 0      | 1–3      | >3           | **6 (5 deleted-feature fns + 1 decision)**      | F15                     |
| IE20 | **Published-URL truncation** `[deployment]`                 | recorded deploy URL ≠ resolvable target (e.g. capture stops at `_`)            | 0      | —        | ≥1           | **`…/apps/` (dev+staging)**                     | done (`1755365`)        |
| IE21 | **Deploy config improvisation** `[deployment]`              | deploy agent must infer framework config because the prompt is framework-blind | scoped | —        | improvised   | **Vite-only prompt, Next app**                  | done (`1755365`)        |
| IE22 | **Rebuild-on-promote** (build-once violated) `[deployment]` | promotion rebuilds instead of byte-copying the tested artifact                 | copy   | —        | rebuild      | **rebuild/rung (fallback)**                     | F22 (new)               |
| IE23 | **Agent-spawn precondition missing** `[deployment]`         | agent jobs fail at spawn for a missing injected prereq (MCP config / env)      | 0      | —        | ≥1           | **MCP config absent → all spawns blocked**      | F23 (new)               |
| IE24 | **Non-prod deploy unobservable** `[deployment]`             | dev/staging deploys with no streamed logs/step tracker                         | 0      | —        | ≥1           | **dev+staging dark (pre-fix)**                  | done (`1755365`)        |
| IE25 | **Skill activation collapse** `[skills-module]`             | skill tool-uses ÷ sessions (and distinct skills used ÷ available)              | ≥30%   | 10–30%   | <10%         | **5.2% / 1.5% distinct**                        | F24                     |
| IE26 | **Scout dormancy** `[skills-module]`                        | `skillScoutRuns` count for a plan whose intent has a clear domain              | ≥1     | —        | 0            | **0 (game plan, no search)**                    | F25                     |
| IE27 | **Loadout unranked / retrieval dark** `[skills-module]`     | `index.embeddings.json` read at load time? loadout ordered by relevance?       | ranked | —        | flat         | **flat; sidecar write-only**                    | F27                     |
| IE28 | **Unvetted skill reaches app** `[skills-module]`            | loaded skills not `trusted`/not from a trusted source (post-institution)       | 0      | —        | ≥1           | **N/A pre-institution (build target)**          | 4.2 (SK5)               |
| IE29 | **Dead-skill accumulation** `[skills-module]`               | skills with 0 activations across N plans still in the loadout, never pruned    | pruned | —        | accumulating | **65/66 unused, no prune path**                 | F28                     |

> **[QAreview-agentic]** IE13–IE15 are a single causal chain: a concurrent `next.config.ts`
> rewrite (deploy) restarted Turbopack mid-QA → 404/missing frames (IE14) → the
> `overall = fail>0` math blocked a correct app (IE15). F11/F12 are **not yet in
> `pipeline-v2.5-fixes-plan.md`** — they need entries (see §12 fix list).

> **[graphify]** IE16–IE19 are also one chain: a truncated `ast-facts.json` (IE16) →
> orphaned functions (IE17), made permanent by additive-only ingest that never prunes
> deleted-source nodes (IE19) and by UUID-stranded `projectId` partitions (IE18). IE18 is
> **fixed** (`graph-sync` normalizes projectId to the slug on every sync — commit
> `0d5dd6a`). IE16/IE17/IE19 are now filed as **F14/F15/F16** (Track G) in
> `pipeline-v2.5-fixes-plan.md`: persist a **full-project** ast-facts at wave-close (F14),
> prune nodes whose source is gone (F15), and make the `Orphan invariant` FAIL **surface**
> instead of `exit 3` (F16). Note: IE17 is also a cheap,
> deterministic health metric the scorer can read straight from `_graph/graph-snapshot.json`
> — no log-parsing (see §13, Q9).

> **[deployment]** IE20–IE24 split into "fixed" and "open." **Fixed this session** (`1755365`,
> live via `c937de7`): IE20 (URL truncation — the regex now allows `_`), IE21 (framework-aware
> deploy/promote prompts), IE24 (dev/staging streaming). **Open:** IE22 (build-once is only
> real once dev/staging get their own buckets — fallback rebuilds; **F22** = provision the
> `dev.`/`staging.futurator.ai` subdomains, deployment-v2.5.md §14) and IE23 (the MCP-config
> spawn failure — a cross-cutting **OV11** blocker; cheapest fix is an `existsSync`+`mkdirSync`
> self-heal in `daemon/lib/mcp-config.mjs`, owned by the `graphify`/graph agent — **F23**).
> Note IE23 is **not** a deployment-only failure: it blocks _every_ agent spawn (QA, dev,
> fix) while `MYCELIUM_MCP=on` and the generated file is absent — it merely surfaced first on
> a deploy job. Immediate unblock: daemon **Restart** (resets the latch) or `MYCELIUM_MCP=off`.

> **[skills-module]** IE25–IE29 are one causal chain, and it **re-frames the v0 IE10/OV7** read
> of pacman3. IE10 logged "66 avail / 1 used × 77 sessions" as _catalog overhead_ → "prune."
> That's the wrong lever. The chain is: the **scout never ran** for a game plan (IE26) → no
> domain skill was discovered → the loadout stayed generic and **unranked** (IE27, embeddings
> are written but never read) → so agents **didn't activate** what little was relevant (IE25,
> the dominant defect) → and nothing **prunes** the 65 dead skills (IE29). Pruning (IE29/IE10)
> is real but secondary; the primary fixes are **discover the right skills** (F25), **rank +
> push them per-story** (F27→F24), and only then prune the rest. IE28 is net-new and
> **forward-looking**: the Skills-Institution branch makes "is what loads vetted?" answerable
> (trusted-only install, Story 4.2) — but it must ship **with** the scout→inbox bridge (F26),
> or it silently blocks the scout's community installs. The learning side (OV8/IE5/SK6) is the
> multiplier: once F5's IAM write-loss is fixed, the now-built reflector-apply loop authors
> **app-evolved** skills that close exactly this relevance gap, per plan.

---

## 9. Pipeline health aggregation

| Component   | Weight | Notes                                              |
| ----------- | ------ | -------------------------------------------------- |
| Concept     | 15%    | front-loaded quality multiplies downstream         |
| Development | 35%    | the bulk of cost & risk                            |
| QA          | 15%    | independent verification                           |
| Deployment  | 10%    | + hard cap: DP-S1=0 → pipeline health capped at 🔴 |
| Publish     | 10%    | + hard cap: P-S1=0 → pipeline health capped at 🔴  |
| Overview    | 15%    | timing/cost/integrity/learning                     |

**Grade bands (pipeline health 0–1):** `≥0.85 A` · `0.70–0.84 B` · `0.55–0.69 C` ·
`0.40–0.54 D` · `<0.40 F`. **Hard caps:** any `[MECH]` criterion at 0 caps its stage at
0.5; any deploy/publish safety criterion (DP-S1, P-S1) at 0 forces overall **F**
(safety incidents are non-negotiable).

**pacman3 (v0) indicative score:** _not computed here_ — left for the first scoring pass
to establish the reference. Expected band ≈ **C** (functional, but 🔴 on IE1/IE2/IE3/
IE4/IE5/IE8/IE9/IE11 + OV8 learning loop dark). Use it as the floor every future run must
beat.

> **[QAreview-agentic] QA-stage addendum to the baseline:** the QA stage is now a measured
> **🔴** — Q-C6/Q-C7/Q-C9 all 0 (IE13/IE14/IE15 all red). By the §0.3 cap, that holds the
> QA substage at ≤0.5. The pacman3 run is the calibration anchor for **"false-blocking a
> correct app on broken evidence"**; a future run that captures clean per-test frames and
> never blocks on infra failure is the 🟢 target.

---

## 10. For the specialized agents (division of labor)

This rubric is deliberately broad. Specialized agents should **deep-dive one stage/axis
and return a scorecard slice** in the §0.5 format, plus:

- **Refine thresholds** — the green/yellow/red cuts are first-guess, calibrated to one
  run (pacman3). Propose better cuts with evidence; record in §11.
- **Add criteria** — append new rows with stable IDs (continue the per-stage prefix:
  `C-`, `D-`, `Q-`, `DP-`, `P-`, `OV`, `IE`). Don't renumber existing rows.
- **Flag un-measurable criteria** — if a criterion can't be computed from available
  evidence, mark it `[needs-instrumentation]` and note what telemetry is missing (this
  feeds the observability backlog).
- **Keep AGENT/MECH/OUTPUT tags honest** — the most useful output is separating "the
  model did badly" from "the harness wasted the model's good work."

Suggested specialization split: **(1) Concept grounding & handoff**, **(2) Development
efficiency (compile/test/parallelism)**, **(3) VQA/QA verdict reliability**,
**(4) Integrity & observability (counts/logs/cost/forensic)**, **(5) Deploy/publish
safety**, **(6) Learning loop (reflector)**.

---

## 11. Open calibration questions

- **Q1:** Are the per-story budgets (OV1 ≤8min, OV3 ≤$1) right for `mvp` vs `production`?
  Thresholds should likely be **rigor-scaled** (separate green/red per rigor).
- **Q2:** Should parallelism (D-WS1/IE11) be scored only when the plan _had_ parallel
  opportunity? (A genuinely serial dependency chain shouldn't be penalized.) → propose
  a "parallelizable-waves" denominator.
- **Q3:** What is the ground-truth source for verdict calibration (D-VQ2/Q-C3)? Needs an
  answer key — possibly the operator's send-back/accept decisions become labels over time.
- **Q4:** Should the rubric emit a **trend** (this run vs last N runs) once ≥5 plans
  exist, mirroring the forensic `cohort` baseline (currently null — "need 5+ similar
  plans")?
- **Q5:** Do deploy/publish safety hard-caps belong in the _quality_ score, or as a
  separate **gate** (pass/fail) reported alongside? (Leaning: separate gate.)
- **Q6 [QAreview-agentic]:** Should evidence-integrity (Q-C6) be a **precondition gate**
  that aborts + retries the QA run when capture is degraded (`SCREENSHOTS_CAPTURED <
threshold`, or all frames identical/blank) — _before_ any judge spends a token — rather
  than a criterion scored after the fact? A 0/10 capture should never reach the judges.
- **Q7 [QAreview-agentic]:** Where should **stage isolation** (Q-C9) be enforced? Strongest
  option: QA against the already-published **dev-deploy URL** (immutable) instead of the
  live `projects/<appId>` worktree — removes the deploy×QA race at the root. Alternatives:
  a per-run isolated checkout, or a `workingDir` mutex. Needs an owner decision (overlaps
  `boilerplate-runtime-contract.md` and `multi-host-dispatch-readiness.md`).
- **Q8 [graphify]:** Should knowledge-graph integrity (D-KC3/D-KC4/D-KC5) be a **wave-gate**?
  The `Orphan invariant` is **already computed** by `graph-sync` but exits non-blocking
  (`exited 3`), so a broken graph is invisible to the pipeline and the operator. Cheapest
  enforcement: fail (or loudly surface) the wave-close knowledge-compile step when the
  invariant FAILs above a threshold — distinguishing genuine orphans from legitimate
  floaters (test files, deleted-source zombies) so it doesn't false-alarm.
- **Q9 [graphify]:** Should the **system-graph snapshot be a first-class scoring evidence
  source** (§0.4)? `_graph/graph-snapshot.json` already encodes knowledge-coverage %, orphan
  rate, edge density by type, god-nodes and Leiden communities — a **deterministic,
  drift-free** integrity signal that's cheaper and more reliable than log-parsing for many
  D4 criteria across stages (D-KC\*, OV4/OV5 count-integrity, even C-D3/C-P1 grounding could
  be checked via doc→code `REFERENCES`/`DEPENDS_ON` edges). Proposal: have the scorer fetch
  the snapshot once per run and derive the graph criteria directly from it.
- **Q10 [deployment]:** Should the DEPLOY agent be **forbidden from mutating tracked config**
  (`next.config.ts`) in a shared worktree? Patching the base via an env var
  (`NEXT_BASE_PATH`/Vite `--base`) or an isolated build dir removes **both** the deploy×QA
  race (Q-C9 / DP-I1 / IE13) **and** the improvisation (DP-B2) at the root — one change kills
  two criteria. Overlaps `boilerplate-runtime-contract.md §1` and Q7 (QA against the immutable
  dev-deploy URL). Needs an owner decision on where the base path is injected.
- **Q11 [deployment]:** Once subdomains are provisioned, should **build-once (DP-L2)** be a
  **hard gate** — a promotion that would rebuild instead of byte-copy is _blocked_ — or stay
  advisory while fallback prefix-mode exists? Today fallback always rebuilds (DP-L2 = 🟡); the
  rubric should score the **gap from byte-identical promotion**, and the answer-key is whether
  the promoted bytes' hash equals the source environment's.
- **Q12 [deployment]:** Is **agent-spawn precondition integrity (OV11)** an Overview criterion
  (placed there because it blocks _all_ stages) or should each stage also carry a local
  spawn-health check? Leaning Overview + a hard cap: any OV11=0 should cap the _whole pipeline_
  (not just one stage), since a missing injected prereq means no agent ran at all. Confirm the
  cap placement in §9.

---

## 12. Contributor findings — QAreview-agentic (2026-06-17): QA-evidence forensic on pacman3

**Session:** `QAreview-agentic` · **Method:** read-only forensic on `plan_pacman3_mqi8x64w`
(QA job `3c99fd51`, aggregate `309ba59a`, dev-deploy `d777f835`) cross-checked against the
S3 snapshot prefix, the captured dev-server log, and the epics' authored `visualTests`.

**Headline (reframes the baseline).** pacman3's app is **correct** — `overview.png` is a
fully-assembled, playable Pac-Man (blue maze, 4 ghosts in the house, dots + 4 power
pellets, HUD `0` / `STAGE 1`, three lives). QA still returned **VQA 0/10, OVERALL FAIL,
BLOCKING**. **Every blocking verdict is an infrastructure artifact, not a product defect.**
This makes pacman3 the calibration anchor for _false-blocking_.

**Root cause — deploy×QA same-worktree race (new failure class → Q-C9 / IE13).**

- `wave-completion-check` auto-approved the QA contract **and** launched dev-deploy
  (`d777f835`) on the **same tick** (18:57:49) — both against `workingDir
/home/ubuntu/projects/pacman3`, the _same_ git worktree QA had checked out detached.
- The deploy step rewrites `next.config.ts` (basePath + `output:'export'`, exactly the
  "deploy improvises config" behaviour in `boilerplate-runtime-contract.md §1`). Each
  rewrite tripped Turbopack: _"Found a change in next.config.ts. Restarting the server…"_ —
  **twice**, mid-QA.
- During each restart `/` served the Next 404 page for ~25 s/request
  (`GET / 404 in 27.4s …`, ×5).

**Evidence-capture collapse (→ Q-C6 / IE14).**

- `PREPARE_OUTPUT: SCREENSHOTS_CAPTURED 0/10`. Only `overview.png` (caught in the one
  healthy `GET / 200` window before the first restart) is usable.
- The 5 per-test PNGs that landed are **byte-identical** (`md5 1d931e7f…`) — all the same
  404 page. Plain L1 captures (`npx playwright screenshot`, 20 s spawn timeout) lost the
  race against the 25 s server → SIGKILL → **no file written**.
- UI effect: `claims-table.tsx` `<img onError>` hides 404/missing thumbnails → the empty
  "·" cells the operator reported as "no screenshots."

**Verdict math converts broken evidence into blocks (→ Q-C7 / IE15).** `qa-report` uses
`overall = fail>0 ? 'FAIL'`. All 6 FAILs trace to missing/404 frames. A missing / 404 /
blank / sub-2KB frame must be `errored`→retry, never a blocking `fail`.

**Oracle hallucination (→ Q-C8).** Under the identical "no usable frame" condition the
judges split — 3 honestly returned UNCERTAIN ("Screenshot file not found"), but others
returned **FAIL with fabricated observations** ("404 error page displayed instead of game
canvas; no ghosts or maze visible"; "cannot verify direction value… VERDICT: FAIL"). The
oracle does not reliably distinguish "evidence broken" from "app wrong."

**Decoupled authoring, caught live (→ D-TA4).** The two L2 tests — `AC-S2-2 "position.col
has increased"` and `AC-S2-3 "direction changes to UP"` — describe **internal entity
state**, yet were authored with `url=null, flow=null, assert=∅`. No screenshot can show
them and no `window.__harness` assert was emitted to read them. The classifier set the
_level_ but nothing authored the _mechanism_. (The seam/assert executor already exists in
`visual-qa-pipeline.ts`; the tests simply don't use it.) Same root as the §3.7 wave-gate
"unverifiable" disease.

**Classifier self-override (→ D-TA5).** `CLASSIFIED_TESTS` shows `AC-S1-1` with
`resolvedLevel:"L0"` but kept `level:"L1"` ("level set in source — preserved");
`L0_RESULTS:[]`. A deterministic check ran as a probabilistic vision judge — costlier and
less reliable.

**Secondary.** `plan.devUrl = "https://futurator.ai/apps/"` — appId (`pacman3`) not
interpolated (same deploy job; bears on **P-A1**). And the §4 "qa=0ms" note is itself a
forensic-completeness artifact (**OV4 / IE2**): the QA job ran; the forensic doesn't walk
post-`review` jobs.

**Cheapest high-leverage fixes (not yet in `pipeline-v2.5-fixes-plan.md` — need F11/F12).**

1. **Stage isolation (the origin):** point QA at the already-published **dev-deploy URL**
   (immutable) instead of the live worktree — or use a per-run isolated checkout + a
   `workingDir` mutex. Removes the race entirely. _(Q-C9 / IE13 → F11)_
2. **Pre-judge evidence gate:** abort + retry the QA run when `SCREENSHOTS_CAPTURED <
threshold` or frames are identical/blank — _before_ any judge spends a token; and make
   missing/404 frames `errored`, never blocking `fail`. _(Q-C6 / Q-C7 / IE14 / IE15 → F12)_
3. **Probe-author requirement:** no `verify:state|behavior` AC may merge without an
   executable flow/assert. _(D-TA4)_

> **Hand-off note to other sessions:** the **concept-develop** owner may want to thread
> Q-C9 (stage isolation) into the deploy/QA orchestration design, and D-TA4 into the
> concept→plan authoring contract (it overlaps the VQA v3 redesign PRD under
> `docs/concepts/pipeline-v3/`). F11/F12 need homes in `pipeline-v2.5-fixes-plan.md`.

---

## 13. Contributor findings — graphify (2026-06-18): system-graph forensic on pacman3

**Session:** `graphify` · **Method:** live forensic on `plan_pacman3_mqi8x64w` — read the
persisted `.mycelium/ast-facts.json`, queried Memgraph directly (orphans, projectId
distribution, edge degrees), cross-checked the `_graph/graph-snapshot.json` on S3, and
inspected the daemon `graph-sync` log lines. Several root causes were fixed in code this
session; the rest are filed as **F14–F16** (Track G) in `pipeline-v2.5-fixes-plan.md`.

**Headline (same shape as §12).** pacman3's code is **correct and fully merged** (51
files, 120 functions, all reducers/entities/components present on disk), yet the knowledge
graph the operator saw was **broken: 177 nodes / 290 edges with 29 unconnected nodes and
`Orphan invariant: FAIL (20)`.** Every disconnection was a **harness/ingest artifact, not
missing code.** This makes pacman3 the calibration anchor for **knowledge-graph integrity**
the way §12 anchors QA false-blocking.

**Root cause 1 — truncated AST facts (→ D-KC2 / IE16).** The persisted
`.mycelium/ast-facts.json` held **3 files**, not 51 — it was the _last_ story's detached
worktree scope (the HUD/Overlay visual-fix story `a085aa07`). Per-story DEV compiles
incrementally and the partial scan is what survives between stories. A
`--full-resync` against that partial file would have **pruned the rest of the project**.
Fix for the snapshot: a full-project `bootstrap-ast --project pacman3 --root
/home/ubuntu/projects/pacman3` (re-scanned 51 files / 120 functions). The **pipeline
mechanism still persists the worktree-scoped facts** → F14 (persist full-project ast-facts
at wave-close).

**Root cause 2 — `projectId` partition drift (→ D-KC5 / IE18) [FIXED].** The `DEFINES`
edge `MATCH`es the file node on `projectId`. Early ingestion stamped some file nodes with
the **job/plan UUID** (`353ab84c-…`) instead of the slug `pacman3`, stranding them in a
phantom partition where the `MATCH` silently missed and the function orphaned **forever**
(the old `coalesce()` MERGE preserved the bad stamp on every resync). Verified the UUID tail
spans many projects (dino, snake, etc.). **Fixed** (`graph-sync.mjs`, commit `0d5dd6a`):
`code/*` nodeIds are project-unique (zero cross-project collisions, verified), so the
file-node MERGE now **overwrites** `projectId` to the canonical slug — self-healing on every
project's next sync.

**Root cause 3 — additive ingest never prunes deleted-source nodes (→ D-KC3 / IE19).** The
last story consolidated three `*.feature.tsx` files into one and **deleted them from disk**;
their function nodes lingered as degree-0 zombies (MERGE is additive). Same for a renamed
decision article. Pruned manually here; the pipeline needs a **delete-aware prune** → F15.

**Root cause 4 — the invariant is computed but ignored (→ D-KC4 / Q8).** `graph-sync`
**already emits** `ERROR: Orphan invariant FAILED — N non-file orphan(s)` and exits 3 — but
the caller treats it as **non-blocking** (`graph-sync exited 3 (non-blocking)`). The single
highest-leverage cheap fix: **surface or gate on this existing signal.**

**New feature shipped — living-doc connectivity (→ D-KC6) [FIXED].** Architecture / decision
/ index / system docs carry `[[wikilinks]]` to the code they describe, but those links sat
in prose sections (`## Implementation`) or under H1s the section→edge map ignored, so the
docs floated (9 floaters). Added a **`REFERENCES`** edge layer (`lib/doc-references.mjs`,
commit `0445e6a`): for **living docs only**, any `[[link]]` not claimed by a structured
section becomes a `REFERENCES` edge — **controlled by construction** (the MERGE binds only
when both nodes exist, so a doc connects only when it _actually_ references a real node).
**Plan-run docs** (a plan's PRD/epics/stories) are **deliberately excluded** (`isLivingDoc`)
— their linking is owner-defined later, which bears on the §2 concept→plan authoring
contract.

**Net effect on pacman3 after this session:** unconnected nodes **29 → 0**; orphan invariant
**FAIL(20) → PASS**; snapshot **177/290 → 212/526** (+82 `REFERENCES`, +cross-file CALLS,
Leiden communities 21→11, `index` became a 29-edge hub). The graph is now a faithful map of
the build — which is the precondition for using it as evidence (Q9).

> **Hand-off note to other sessions:**
>
> - **concept-develop / pipeline owner:** F14/F15/F16 are now filed under **Track G** in
>   `pipeline-v2.5-fixes-plan.md` (full-project ast-facts at wave-close · delete-aware prune ·
>   surface the orphan invariant). D-KC4 / F16 is the cheapest win — the FAIL signal already
>   exists, it's just swallowed (`exit 3`).
> - **The plan→authoring contract (§2):** living-vs-plan-run doc classification
>   (`isLivingDoc`) is now a real seam — when plan PRDs/epics get ingested they must NOT be
>   auto-linked; decide their linking scheme deliberately. Overlaps the VQA v3 PRD under
>   `docs/concepts/pipeline-v3/`.
> - **The scoring-agent author (Q9):** consider deriving the §13 graph criteria (and
>   OV4/OV5 count-integrity) directly from `_graph/graph-snapshot.json` — a free,
>   deterministic alternative to log-parsing.

---

## 14. Contributor findings — deployment (2026-06-18): the v2.5 deployment control panel

**Session:** `deployment` · **Method:** hands-on, not read-only — designed + built the v2.5
deployment control panel (promotion ladder, smoke, rollback), drove **brick1** end-to-end
dev → staging → production (playable live at `futurator.ai/apps/brick1/`), then hit + diagnosed
the **pacman3** re-deploy-dev failure live. Cross-checked the live API `buildHash`
(`/api/health`), the streamed DEPLOY agent logs, `deploy-targets.ts` / the pipeline builders,
and `daemon/lib/mcp-config.mjs`. Full design + field log: [`deployment-v2.5.md`](../deployment-v2.5.md).

**Headline (same shape as §12/§13).** The deployment **stage works end-to-end** — brick1 was
the first plan promoted through all three environments to a live, correct, playable app, and
the new streaming UI surfaced every failure faithfully. Yet the **harness leaked in five
distinct ways**, none of them an agent-intelligence defect:

1. **Published-URL truncation (DP-U1 / IE20) — FIXED `1755365`.** The `DEPLOY_URL` extractor
   regex excluded `_` from the URL character class, so the fallback URLs `…/apps/_dev/<slug>/` and
   `…/apps/_staging/<slug>/` were captured as `https://futurator.ai/apps/` — a dead link.
   Production (`apps/<slug>/`, no underscore) was unaffected, which is why brick1's prod link
   worked but every dev/staging link died. This is the root of §12's "secondary" `devUrl`
   observation. Fix: drop `_` from the excluded class.
2. **Framework improvisation (DP-B2 / IE21) — FIXED `1755365`.** The deploy/promote prompts
   were Vite-only (`vite.config.ts`, `base`, `dist/`), but the apps are Next.js
   (`next.config.ts`, `basePath`, `output:'export'`, `out/`). The agent _improvised_ correctly
   (smart agent, blind prompt) — fragile. Fix: framework-aware prompt (detect next/vite, set
   the correctly-shaped base + output dir).
3. **Build-once not actually happening (DP-L2 / DP-E1 / IE22) — OPEN (F22).** Because the
   `dev.`/`staging.futurator.ai` subdomains aren't provisioned, dev/staging live under
   reserved prefixes (`apps/_dev/`, `apps/_staging/`) on the **shared public bucket**, so each
   environment has a _different_ base path → promotion **rebuilds** at the destination instead
   of byte-copying the tested artifact. "Build-once-promote-many" is real in code (copy mode)
   but only activates once each env has its own bucket (same base path everywhere). Also
   reconciled this session: the release-strip used to offer a **second** production path (a
   fresh build that bypassed staging) — collapsed into one ladder-advancing CTA with the
   bypass demoted to a warning-gated "Force rebuild" escape hatch.
4. **Non-prod deploys unobservable (DP-O1 / IE24) — FIXED `1755365`.** `deploy-logs` /
   `deploy-steps` bound only to `report.current` (production `deployJobIds`), so dev/staging
   deploys streamed nothing — the operator couldn't watch or share them. Fix: stream the
   active environment's job on both the QA stage (dev preview) and the Deploy stage.
5. **Agent-spawn precondition failure (OV11 / IE23) — OPEN (F23), cross-cutting.** pacman3's
   re-deploy-dev died _before the agent ran_: `step_error … MCP config file not found:
/opt/futurator-daemon/mcp/mcp-config.generated.json`. The Mycelium MCP integration
   (`daemon/lib/mcp-config.mjs`, commit `ceea33e`) passes `--mcp-config <path>` to **every**
   spawn when `MYCELIUM_MCP=on`, but `ensureConfig()` writes the file once behind a
   `configWritten` latch with **no `existsSync` re-check and no `mkdirSync`** — so after a
   daemon redeploy deletes the (untracked) generated file, a still-latched process passes a
   path to a file that's gone. This blocks **all** agent jobs (QA, dev, fix, deploy), not just
   deploy. Diagnosed only (it's the graph agent's file). Fix: self-heal (`existsSync` +
   `mkdirSync`) → **F23**. Immediate unblock: daemon **Restart** (resets the latch) or
   `MYCELIUM_MCP=off`.

**Deploy×QA race — the deploy side of Q-C9 / IE13 / DP-I1 (still OPEN).** §12 root-caused
pacman3's QA false-blocking to deploy rewriting `next.config.ts` in QA's live worktree
(Turbopack restart → 404 frames). This session's framework-aware fix made that rewrite
_correct_ but it **still mutates a shared tracked file** — the race is unremoved. The real
fix is **Q10**: inject the base path via env / an isolated build dir and never edit a shared
config file. One change closes DP-I1 **and** DP-B2.

**Meta note (platform deploy, not a plan-run criterion).** Shipping the control plane itself
(`sst deploy --stage production`) hit a transient **Pulumi AWS provider crash** mid-apply
(`pulumi-resource-aws exited prematurely`) _after_ the functional updates landed; the
idempotent re-run converged cleanly (`✓ Complete`, live `buildHash c937de7`). Not scored here
(it's deploying the admin app, not a user plan), but worth a resilience note for whoever
automates platform deploys: treat a provider crash as retry-and-reconcile, and verify
`/api/health` `buildHash` as the source of truth, not the CLI exit code.

> **Hand-off note to other sessions:**
>
> - **concept-develop / pipeline owner:** both fixes are now filed under **Track H** in
>   `pipeline-v2.5-fixes-plan.md` — **F22** (provision `dev.`/`staging.futurator.ai` subdomains
>   so promotion byte-copies; the SST recipe + EC2-IAM prereq is in deployment-v2.5.md §14) and
>   **F23** (MCP-config self-heal in `daemon/lib/mcp-config.mjs`). F23 is the highest-leverage —
>   a one-file, two-line robustness fix that unblocks every agent spawn.
> - **The graph/`graphify` agent:** OV11/IE23/F23 is your `mcp-config.mjs` — the `configWritten`
>   latch needs an `existsSync` re-check + `mkdirSync(dirname, {recursive})` so a redeploy that
>   deletes the generated file self-heals on the next spawn.
> - **The deploy/QA orchestration owner:** Q10 (don't mutate shared config; inject base via
>   env/isolated dir) closes DP-I1 **and** DP-B2 and removes the deploy×QA race at the root —
>   it overlaps §12's Q7 (QA against the immutable dev-deploy URL) and
>   `boilerplate-runtime-contract.md §1`. Pick one base-injection seam for both stages.
> - **The scoring-agent author:** the deploy stage now has rich, machine-readable evidence —
>   the `DEPLOY_URL`/`SMOKE_STATUS` extractor outputs (DP-U1/DP-S2), `deploy-report.environments[]`
>   with per-rung `status`/`activeJobId`/`smokeStatus` (DP-O1/DP-L1), and `deployEnvironment`
>   on each job (build-once routing). DP-U1 is checkable deterministically: does the stored URL
>   `GET` 200 and equal `target.publicUrl`?

---

## 15. Contributor findings — skills-module (2026-06-18): the skill subsystem through a plan run

**Session:** `skills-module` · **Method:** hands-on, not read-only — built the **Skills-Institution**
branch (the one-gate scanner + curation inbox + trust-tier model + the reflector-apply
author-from-experience loop + retro-scan), then analyzed the **pacman3** `skills` forensic block
against it. Cross-checked `daemon/lib/skills-prompt.mjs`, `skill-scout-triggers.mjs`,
`skill-scout-job-runner.mjs`, `app-bootstrap-steps/vendor-skills.mjs`, `scripts/ingest-skills.mjs`,
and the new branch code. Full findings + fixes: **Track I (F24–F28)** in
[`pipeline-v2.5-fixes-plan.md`](./pipeline-v2.5-fixes-plan.md).

**Headline (same shape as §12/§13/§14): clean agents, leaky harness — but here the leak is one of
_omission_.** The skill **loading infra is healthy** (SK1 🟢: 66 available, tool exposed, 0
zero-skill sessions, CLAUDE.md loaded in all 77). What's broken is everything _downstream_ of
loading, and none of it is an agent-intelligence defect:

1. **Activation collapsed (SK2 / IE25 / F24) — the dominant defect.** `totalSkillToolUseEvents: 4`
   across 77 sessions = **5.2%**; `activatedSkills` = **one** skill (`frontend-design`, ×2) of 66 =
   **1.5%**. A Canvas2D game activated **zero** game-domain skills. The loadout is offered as a flat
   name+description list (`skills-prompt.mjs:140-155`); a skill is never _pushed_ as a body for the
   story at hand. **This is the single highest-leverage skill fix and nothing in our branch touches
   it** — curation/security/authoring don't move activation.
2. **Scout was dormant (SK4 / IE26 / F25).** `skillScoutRuns: []` — for a plan whose intent literally
   says "pacman … ghost types … eat the dots," **no skill search fired.** The scout's in-plan triggers
   are mechanical only (new-dep T4/T5, reviewer-cluster T6 — `skill-scout-triggers.mjs:38/71/110`); a
   canvas scaffold trips none. There is **no intent-aware trigger**, so plan _meaning_ never drives
   discovery.
3. **Retrieval is dark (SK3 / IE27 / F27).** `index.embeddings.json` is generated (voyage-3, 1024-dim,
   `ingest-skills.mjs:226`) and its own header calls it "the retrieval sidecar SKILL-SCOUT queries" —
   but **no reader exists**. The loadout is ranked pins-then-readdir, never by task relevance.
   (Truncation was _not_ the issue — 66 < the 80-skill cap — every skill was visible and still ignored.)
4. **Self-improvement didn't close (SK6 / OV8 / F5).** The reflector fired at plan-close but
   `written=0` (IAM). Our branch **built the missing consumer** — `reflector-apply.mjs:209-213` authors
   an app-evolved SKILL.md from a confirmed reflection, and `reflection-apply-poller.mjs` consumes
   `confirmed` rows — so the loop is now code-complete, **but still dead until F5's IAM write is granted**
   (and, at mvp rigor, story-scope reflection is allowed to fire). Fix F5 first.
5. **⚠️ One pre-deploy regression (SK5 / IE28 / F26).** The branch's trusted-only vendor gate (Story
   4.2, `vendor-skills.mjs:195-200`) sits in the scout's install path — it would **silently block the
   scout's community-source installs even after the operator approves the scout card**, because the
   scout-card "approve" and the inbox "ratify" are two disconnected trust authorities. Security-correct,
   but the scout→inbox bridge is missing. **Ship 4.2 _with_ that bridge, not before.**

**What the branch _does_ fix (so the scorecard credits it):** SK5's _mechanism_ (trusted-only install,
retro-scan labels the 245 incumbents), the curation inbox (a vetting path that didn't exist), and SK6's
_machinery_ (the author-from-experience loop). These are necessary foundations — they're just not the
live bottleneck pacman3 exposed.

> **Hand-off notes to other sessions:**
>
> - **The scoring-agent author:** §3.10 (SK1–SK6) is fully machine-readable from the forensic `skills`
>   block — no log-parsing. SK2 = `totalSkillToolUseEvents ÷ sessionsReportingAvailability`; SK4 =
>   `skillScoutRuns.length`; SK6 = reflector `written>0`. **Reclassify the v0 read of pacman3:** OV7/IE10
>   ("prune the catalog") should be scored as SK2+SK3 (activation+relevance), not just D2 cost — see the
>   `[skills-module]` note under §8.
> - **concept-develop / pipeline owner:** F24–F28 are filed under **Track I** in the fixes plan; **F26 is
>   marked a pre-deploy gate for the Skills-Institution branch.** The highest-leverage pair is F25
>   (intent-aware scout trigger) → F27/F24 (read the embeddings, push top-K bodies per story) — that's
>   what would have made pacman3 pull and use a game skill.
> - **qa-review / graphify:** skills don't bear on your stages directly, but **F5 (the IAM write-loss
>   you both also depend on for the learning loop)** is now the single unblock that makes the reflector
>   → app-evolved-skill loop real. Same lesson as F11/F14/F23: the agents are fine; the harness drops the
>   output.

---

## Changelog

| Date       | Agent                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-17 | Claude (forensics #1) | Initial v0 rubric: 5 stages + substages, 6 axes, AGENT/MECH/OUTPUT tags, 12 inefficiency detectors, pacman3 calibration, scorecard schema, aggregation + safety hard-caps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-06-17 | QAreview-agentic      | QA-evidence forensic on pacman3. Corrected §4 (the QA job ran and FAILED on corrupted evidence — not 0ms/N-A). Added Q-C6–Q-C9 (evidence-capture integrity, honest-verdict-under-broken-evidence, oracle-hallucination guard, stage isolation), D-TA4/D-TA5 (visual-probe authoring completeness + level-assignment honesty), IE13–IE15 (stage-isolation breach, capture failure, infra-scored-as-defect), open Q6/Q7, §12 root-cause narrative (deploy×QA same-tick/same-worktree race → `next.config.ts` restart → 404/missing frames → false-blocking a correct app). Flagged F11/F12 as missing from the fixes plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-06-18 | graphify              | System-graph forensic on pacman3 (correct code → broken graph). Added system-graph snapshot as an evidence source (§0.4); expanded §3.8 into knowledge-compile/system-graph with D-KC2–D-KC6 (AST-facts completeness, orphan rate, orphan-invariant enforcement, projectId partition integrity, living-doc connectivity) and bumped the substage weight 1→2; added IE16–IE19 (ast-facts truncation, orphan accumulation, projectId drift, graph zombies); open Q8/Q9 (gate the orphan invariant; use the snapshot as deterministic scoring evidence); §13 root-cause narrative. Fixes landed this session: projectId normalization (`0d5dd6a`, IE18/D-KC5/F17) and the `REFERENCES` living-doc layer (`0445e6a`, D-KC6/F18); the rest filed as **F14–F16** (Track G) in `pipeline-v2.5-fixes-plan.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-06-18 | deployment            | Hands-on deployment-stage pass (built + shipped the v2.5 control panel; brick1 promoted dev→staging→prod live). Reframed §5 from "push to S3" to a build-once promotion ladder; added DP-B2/DP-U1/DP-L2/DP-S2/DP-I1/DP-E1/DP-O1 (framework-detect, published-URL integrity, build-once promotion, smoke verification + soft-gate, deploy stage-isolation, env-provisioning isolation, per-env observability) and bumped substage weights (stage-isolation 3). Added cross-cutting OV11 (agent-spawn precondition integrity — the MCP-config class that blocks ALL spawns); IE20–IE24 (URL truncation, config improvisation, rebuild-on-promote, spawn-precondition missing, non-prod unobservable); open Q10–Q12 (don't mutate shared config / hard-gate build-once / OV11 cap placement); §14 root-cause narrative. **Fixed this session** (`1755365`, live `c937de7`): DP-U1/IE20 (URL-truncation regex), DP-B2/IE21 (framework-aware prompts), DP-O1/IE24 (dev/staging streaming), DP-S2 (smoke surfacing + prod soft-gate), DP-L2 dual-prod-path reconcile. Filed **F22** (provision dev/staging subdomains → true build-once; deployment-v2.5.md §14) and **F23** (MCP-config self-heal in `daemon/lib/mcp-config.mjs`) in the fixes plan (Track H). Confirmed DP-I1 = the deploy side of §12's Q-C9/IE13 (still open → Q10). |
| 2026-06-18 | skills-module         | Skill-subsystem pass on pacman3, hands-on (built the Skills-Institution branch). Added **§3.10 Skill grounding, discovery & trust** (SK1–SK6: availability, activation-when-relevant, loadout ranking, scout discovery, trust integrity, registry self-improvement) — the dev-stage skill-quality lens the v0 rubric lacked. Added IE25–IE29 (activation collapse, scout dormancy, retrieval-dark, unvetted-skill-loaded, dead-skill accumulation) + a `[skills-module]` note **re-framing the v0 IE10/OV7 read** ("66/1×77 → prune" is the wrong lever; the chain is dormant-scout → unranked-loadout → no-activation → no-prune; fix discovery+ranking first). §15 contributor findings: loading is healthy (SK1 🟢) but activation (5.2%), discovery (`skillScoutRuns:[]`), and retrieval (embeddings write-only) are the live bottlenecks — none touched by the curation/security/authoring branch; one ⚠️ pre-deploy regression (F26: trusted-only gate blocks scout community installs, scout↔inbox unbridged). Cross-refs Track I (F24–F28) in the fixes plan; flagged F5's IAM write-loss as the single unblock for the now-built reflector→app-evolved-skill loop.                                                                                                                                                        |
