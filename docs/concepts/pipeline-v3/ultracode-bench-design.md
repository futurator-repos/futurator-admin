# Ultracode Reverse-Engineering Bench — Detailed Design

> **Status:** DESIGN (implementation-ready). Follows `ultracode-bench-strategy.md` (context + build-vs-reuse
> + locked decisions) and the two founding specs (`~/Futurator/ultracode-pipeline-spec.md`,
> `~/Futurator/futurator-ultracode-module-spec.md`). This doc fixes the three net-new pieces the strategy
> deferred: the **`DecisionPlan` IR**, the **two `*ToDecision` projectors**, and the **three-scorer math** —
> grounded in the exact in-repo shapes (existence-checked 2026-06-23, `claude 2.1.186`, branch `ultra-reverse`
> @ `e0cf6c2` after the pipeline-v3 fast-forward).
> **Owner:** Richie · **Date:** 2026-06-23

---

## 0. Scope & non-goals

**In scope (the genuine net-new, strategy §4):**

1. `DecisionPlan` IR — the normalization target both engines reduce to (§2).
2. `case1ToDecision` — AST parser over the captured ultracode `.js` (§3).
3. `case2ToDecision` — projector from `planOutputSchema` → IR (§4).
4. Three scorers — structural diff (§6), blind-paired judge panel (§7), guardrail uplift (§8).
5. The persistence + N-rep shell that wraps them (§9), landing in `spikes/` per locked §8.4.

**Out of scope (reuse as-is / already decided):** the Case-2 planner itself (the existing concept chain,
locked §8.1), the Plan SPEC (reuse `planOutputSchema`, locked §8.2), the store (DynamoDB+S3, locked §8.3),
M0 capture mechanics (proven; strategy §5), and any Next.js dual-pty UI (descoped, strategy §7 M5).

**The one accepted confound** (strategy §8.1 / risk #3): Case 2 is the cost-tiered multi-step concept chain,
not a single-shot xhigh-Opus challenger. Stamped on every scorecard, not silently ignored.

---

## 1. The core problem this design solves

Case 1 and Case 2 emit **different kinds of artifact**:

- **Case 1** = an **orchestration call-graph** — a JS script of `agent()/parallel()/pipeline()` calls
  grouped under `meta.phases`. It describes *how subagents fan out and recombine*.
- **Case 2** = a **work-breakdown DAG** — `epics → stories` with `dependsOn`, acceptance criteria,
  touchPoints. It describes *what units of work exist and how they depend*.

Scoring these head-to-head is apples-to-oranges unless we pick a normalization target where both project
**without lying**. The `DecisionPlan` IR is that target. The design principle:

> **Normalize to the shared substructure — "phased fan-out with dependency edges" — and record everything
> that doesn't project as an explicit asymmetry, never as a silent zero.**

Both artifacts *are* phased, dependency-bearing fan-outs. What Case 1 has and Case 2 lacks (per-agent
`schema`/`model`/`isolation`, barrier reasons) and what Case 2 has and Case 1 lacks (acceptance criteria,
skill/role bindings, test tiers) are the **scored asymmetries** — the first feeds structural diff, the
second feeds guardrail uplift.

---

## 2. The `DecisionPlan` IR

Refines module-spec §6, grounded in the real script shapes (recon: `spikes/v3-hybrid/workflows/*.js`,
`probes/E1-plan-swarm/*.workflow.js`, `probes/C1-fixswarm/fixswarm.workflow.js`) and `planOutputSchema`.

```ts
// packages/ultracode-core/src/decisionSchema.ts  (zod)
interface DecisionPlan {
  // ── classification ──────────────────────────────────────────────────────────
  pattern:
    | 'build-verify-fix'        // phases: Build → Review → Fix
    | 'plan-synthesis-critique' // phases: Design-Dimensions → Synthesize → Critique
    | 'greenfield-build'        // Design → Scaffold → Implement → Integrate → ...
    | 'brownfield-harden'       // Scout/Map → Plan → ... (grounding phase present)
    | 'research'                // fan-out finders → reduce → synthesize, no build
    | 'other';
  qualityPatterns: QualityPattern[]; // sub-structures detected (may be >1); see §2.1

  // ── the phased fan-out (the shared substructure) ─────────────────────────────
  phases: Phase[];

  // ── plan-level rollups (cheap to diff) ───────────────────────────────────────
  verify: { present: boolean; kind: VerifyKind };
  reduceSteps: number;   // count of plain-JS reductions between agent stages
  earlyExit: boolean;    // any guarded short-circuit (if (!x.length) return ...)
  edges: Array<[string, string]>; // phase/wave dependency edges (from→to)

  // ── provenance (never scored; for audit + asymmetry honesty) ─────────────────
  source: 'case1-script' | 'case2-planspec';
  extraction: { lossy: string[]; }; // fields that could not project (e.g. runtime-only fan width)
}

interface Phase {
  name: string;
  mode: 'sequential' | 'parallel-barrier' | 'streaming';
  fanOut: { axis: string; width: number | 'dynamic' } | null; // axis e.g. 'review-dimensions'
  agents: Agent[];
  barrierReason?: string; // why a barrier (cross-set dedup/merge/early-exit) when mode=parallel-barrier
}

interface Agent {
  role: string;                          // label/agentType/inferred from prompt
  hasSchema: boolean;                    // structured output enforced?
  model: string | 'default';
  isolation: 'none' | 'worktree';
  // guardrail-bearing (Case 2 only; null/false for Case 1) — see §8
  agentType?: string | null;             // from approved roster
  testTier?: 'L0' | 'L1' | 'L2' | null;
  skillBindings?: string[];
}

type QualityPattern =
  | 'fan-out-and-synthesize' | 'adversarial-verification' | 'perspective-diverse-verify'
  | 'tournament' | 'generate-and-filter' | 'loop-until-done' | 'classify-and-act';
type VerifyKind = 'adversarial' | 'perspective-diverse' | 'judge-panel' | 'none';
```

### 2.1 Pattern vs quality-pattern (two axes, kept separate)

The bench compares **two independent things** and conflating them was the trap the strategy warned about:

- **`pattern`** = the task-type skeleton of the *whole* plan (module-spec §6 enum). This is the
  `pattern_match` structural metric.
- **`qualityPatterns`** = named orchestration sub-structures present *inside* the plan. Reconciled
  vocabulary across the three sources (canonical name · synonyms · structural signature in a script):

  | Canonical (`QualityPattern`) | Synonyms (pipeline-spec §4 / strategy §6.1 / concept.md §4) | Detected in a script when… |
  | --- | --- | --- |
  | `fan-out-and-synthesize` | fan-out→reduce→synthesize | `parallel()` fan-out → JS reduce → 1 sequential `agent()` |
  | `adversarial-verification` | adversarial verify / WF-2 fix-swarm | N agents w/ verdict-enum schema (`ACCEPT`/`REJECT`) refuting one claim; vote reduce |
  | `perspective-diverse-verify` | perspective-diverse verify | N verifiers w/ *distinct* lens prompts (not N identical) |
  | `tournament` | judge panel | K candidate agents → judge agents score → synthesize-from-winner |
  | `generate-and-filter` | generate-and-filter | many candidates → `.filter/.sort` rank reduce |
  | `loop-until-done` | loop-until-dry | `while`/recursion spawning finders until K empty rounds |
  | `classify-and-act` | classify→pattern (WF-3 adaptive router) | one cheap classifier `agent()` → branch into per-class chains |

`reduce` is deliberately **not** a quality pattern — it is free plain-JS glue (pipeline-spec §3), represented
only as the `reduceSteps` count and never as an agent node.

---

## 3. `case1ToDecision` — AST parser over the captured `.js`

**Library:** the repo already ships `typescript` ^5 and `@typescript-eslint/parser` ^8 — **no new dep**.
Use the **TypeScript compiler API** (`ts.createSourceFile(name, src, ESNext, /*setParentNodes*/ true)` then
`ts.forEachChild`) because it parses the workflow's modern JS cleanly and gives typed `CallExpression` nodes.
(Recon confirmed `workflow-lint.mjs` is **regex-only** and *not* reusable for call-graph extraction — its
C0–C9 *post-hoc invariant* idea is reusable as a sanity layer, its parser is not.)

### 3.1 Extraction walk

1. **`meta.phases`** → ordered `Phase.name[]`. Find the `export const meta = {…}` `VariableStatement`,
   read the `phases` array-literal of `{ title }` objects. (Recon: every real script carries this literal —
   the spec's `phasesFromCard` needs **no** AST beyond this, and `wf_<id>.json` also exposes it verbatim,
   strategy §5.1 — cross-check the two.)
2. **Primitive calls** → walk every `CallExpression`; classify by callee identifier:
   - `agent(promptArg, optsObj?)` → one `Agent`. From `optsObj` read `label`→`role`, `schema`→
     `hasSchema:true`, `model`, `isolation`, `agentType`. If no `label`/`agentType`, infer `role` from the
     first ~6 words of the prompt string literal.
   - `parallel(arrArg)` → the enclosing phase is `mode:'parallel-barrier'`. **Fan-out axis** = the source
     of the `.map(...)` feeding it (the callee/member text, e.g. `breakdown.epics` → axis `epics`,
     `DIMENSIONS` → axis `review-dimensions`); **width** = array literal length if static, else `'dynamic'`
     (push the field name to `extraction.lossy`). The agents are the `agent()` calls inside the map thunk.
   - `pipeline(itemsArg, ...stageFns)` → `mode:'streaming'`; one `Phase` per stage fn; axis = `itemsArg`.
   - `workflow(name)` → a composed sub-plan node; record as an `Agent` with `role:'workflow:'+name`.
   - `phase(titleArg)` → confirms/labels phase boundaries (cross-check vs `meta.phases`).
3. **Reduce steps** → count `CallExpression`s on array methods (`.filter/.map/.flatMap/.sort/.reduce`) and
   named helper calls that sit *between* two agent-bearing stages → `reduceSteps`.
4. **Early exit** → any `ReturnStatement` guarded by an `IfStatement` testing a `.length`/empty condition
   before the final synthesize → `earlyExit:true`.
5. **Verify classification** (`verify.kind`) — heuristic over agent schemas + labels:
   - agents with a 2-value verdict enum (`ACCEPT|REJECT`, `PASS|FAIL`) refuting a shared input, ≥2 in
     parallel + a vote reduce → `adversarial`.
   - N verifiers whose prompts name *distinct lenses* → `perspective-diverse`.
   - K candidates + scoring agents + synthesize-from-winner → `judge-panel`.
   - else `none`.
6. **Edges** → sequential phase order gives the spine; data passed from an earlier phase's result var into a
   later phase's prompt (closure reference) adds an explicit `from→to` edge.

### 3.2 Acceptance (round-trip, module-spec §6)

The captured pacman-style scripts must extract to their known shapes:
`spikes/v3-hybrid/workflows/{plan,dev,review}.workflow.js` → `build-verify-fix`-family;
`probes/E1-plan-swarm/epic-elicitation*.workflow.js` → `plan-synthesis`-family (Breakdown→Decompose,
parallel-barrier on `epics`); `probes/C1-fixswarm/fixswarm.workflow.js` → `verify.kind:'adversarial'`
(Fix→Refute, `isolation:'worktree'`, opus refuters). These are the unit-test fixtures for the parser.

---

## 4. `case2ToDecision` — project `planOutputSchema` → IR

Pure code, zero model tokens. Map the work-breakdown onto the same `DecisionPlan` shape:

| IR field | Source in `plan-output-schema.ts` / pipeline | Rule |
| --- | --- | --- |
| `pattern` | derived from `target`+presence of grounding | greenfield→`greenfield-build`; brownfield→`brownfield-harden`; plan-only intents→`plan-synthesis-critique` |
| `phases` | the **wave layering** (`computePlanWaves` / `story-waves.ts`) | one `Phase` per wave; `mode:'parallel-barrier'` when a wave has >1 story; `fanOut.axis='stories'`, `width=stories-in-wave` |
| `phases[].agents` | each story → one `Agent` | `role` = the bound `Role` (`buildAgentConfig`); `hasSchema=true` (stories are schema-validated); `model` from `devModel`/role; `isolation` = `worktree` if touchPoints non-`<EPIC_WIDE>` |
| `agentType` | `Role` from `role-policy.ts` (DEV/TEST/REVIEWER/…) | always present → this is the guardrail Case 2 *wins* on |
| `testTier` | `PlanRigor` (`prototype/mvp/production`) → tier map | prototype→L0, mvp→L1, production→L2 |
| `skillBindings` | `buildAgentConfig` Skill allowlist + story `references` | list bound skills/refs |
| `verify` | presence of REVIEWER/QA roles + adversarial wrap (rigor) | production rigor w/ refuter → `adversarial`; else `none` |
| `edges` | `epic.dependsOn` + `story.dependsOn` DAGs | flatten to phase/wave edges |
| `reduceSteps` | n/a for a declarative plan | `0` (record `'no-script-reduce'` in `extraction.lossy`) |

The **asymmetry honesty** rule: Case 2's `reduceSteps`/`barrierReason` are structurally absent (it is not a
script), so they go in `extraction.lossy` and are **excluded from the structural-diff denominator** (§6) —
Case 2 is not penalized for not being a JS program, only compared on what both legitimately express.

---

## 5. Pattern classifier (shared)

A small deterministic classifier maps phase-name sequences + structural features → `pattern`, used by both
projectors so classification is consistent:

```
Build|Implement + Review|Verify + Fix            → build-verify-fix
Design*Dimension|Expert + Synthes* + Critiq*     → plan-synthesis-critique
Design + Scaffold + Implement + Integrate        → greenfield-build
(Scout|Map|Cartograph|Ground) as phase 0         → brownfield-harden
parallel finders + synthesize, no build/merge    → research
else                                             → other
```

Ambiguous intents (module-spec test case #10, "improve the onboarding flow") are exactly where Case 1 and
Case 2 *should* diverge — the classifier records each engine's independent choice; `pattern_match` then
measures agreement (§6), it does not force one.

---

## 6. Scorer 1 — structural diff (objective, primary signal)

Compare the two `DecisionPlan`s, not prose. Per-metric 0–1, weights in `rubric.ts` (module-spec §7.1):

| Metric | Computation |
| --- | --- |
| `pattern_match` | `1` iff `pattern` equal, else `0` |
| `phase_count_delta` | `1 - min(1, |a-b| / max(a,b))` over phase counts |
| `axis_match` | per aligned phase, Jaccard over fan-out axis token sets |
| `fanout_width_delta` | per fan-out phase, `1 - min(1,|wa-wb|/max(wa,wb))`; `'dynamic'` widths excluded + logged |
| `barrier_placement` | agreement on which phases are `parallel-barrier` (F1 over the barrier set) |
| `verify_match` | `1` iff `verify.kind` equal |
| `schema_usage` | agreement on which agents carry schemas (F1) |
| `dag_shape` | normalized graph-edit-distance over `edges` |

`structural_score = weighted_mean(metrics excluding any whose inputs are in either plan's
extraction.lossy)`. **Phase alignment** for the per-phase metrics: order-preserving alignment by phase index
with name-similarity tie-breaks (Needleman–Wunsch over phase names); record the alignment in the scorecard so
a low score is inspectable. Reusable seed: `probes/E1-plan-swarm/acyclic.py` (DAG validity) and
`conformance.py` (token-set drift) already implement the graph + set primitives this leans on.

---

## 7. Scorer 2 — blind-paired judge panel (subjective, secondary)

Reuse the existing assessor backbone (`daemon/pipelines/scorecard-assess-job-runner.mjs`):
`buildAssessorPrompt({stage, criterionIds, rubricSlice, …})` for the `---ASSESSOR---` marker-block prompt,
`parseAssessorOutput(raw, ids)` for the tolerant parser (it already **downgrades a score with no verbatim
evidence to ⚪** — keep that honesty), and `verdictForScore`. **Net-new = the blind-pairing harness:**

1. Present both plans relabeled **A/B in randomized order**, strip every `Case 1/2` / `source` marker.
   (Randomization seed comes via `args` — `Math.random()` is forbidden in scripts and discouraged here for
   reproducibility; the rep index seeds the A/B flip.)
2. Run **3 judges**; each scores 0–10 per axis with a one-line justification on the six module-spec §7.2
   axes: `detail · assertiveness · logic_soundness · completeness · structure_clarity · decomposition_quality`.
3. Average per axis, drop outliers (>1.5·IQR), report `case1` vs `case2` per axis + stdev.
4. **Persist justifications** — they are the ranked observations that drive Case-2 distillation
   (module-spec §7.4 `observations`).

---

## 8. Scorer 3 — guardrail uplift (Case-2-only axis)

Computed on Case 2's `DecisionPlan`/`planOutputSchema` alone (Case 1 has no guardrails by design — this is
**uplift, not a head-to-head loss for Case 1**). Each sub-score 0–1, then a single `guardrailUplift` number:

| Guardrail | Source (recon) | Present when… |
| --- | --- | --- |
| `agentType` routing | `role-policy.ts` `Role` per story | every `Agent.agentType` non-null |
| test-tier assignment | `PlanRigor` → L0/L1/L2 | every `Agent.testTier` set |
| worktree isolation | story `touchPoints` + hygiene | parallel-write stories carry `isolation:'worktree'` |
| acceptance criteria | `StoryOutput.criteria[]` (min 1) | every story has ≥1 AC; bonus for `verify` intent set |
| validator-conformance | `runSolutioningGate` + `computePlanWaves` (throws on cycle) | plan passes the gate + DAG acyclic |
| capability scoping | `resolveRolePolicy` allow/deny + `maxTurns` | per-role tool lockdown present |

**Schema gap to close (strategy risk #4):** `testTier`/`skillBindings`/per-story `agentType` live in
`applyPlanOutput`/`role-policy`, **not** in `planOutputSchema` itself. `case2ToDecision` must therefore run
the projection *through* `buildAgentConfig`/`resolveRolePolicy` (not read the raw schema) to surface them —
or extend the emitted schema. Documented here so the implementer doesn't expect these on the raw plan object.

---

## 9. Persistence, telemetry, reps, module layout

- **Scorecard** → `functions/shared/scorecard/types.ts` `ScorecardSlice` (reuse-as-is): one slice per metric
  with `{criterionId, stage, score, verdict, value, evidence:EvidenceRef, engine}`. `engine:'deterministic'`
  for structural+guardrail, `engine:'assessor'` for the judge panel. Verdict via `verdictForScore`.
- **Store** → DynamoDB (run + scorecard rows) + S3 (raw `scriptJs`, `planSpec`, per-rep `DecisionPlan`),
  locked §8.3. No Postgres.
- **Telemetry** → reuse `probes/B1-harvester/harvest.mjs` path-munge (`~/.claude/projects/<dashed-cwd>`) and
  token/model/duration scrape for Case-1 *post-hoc* (it does **not** halt — M3/M4 only, not M0).
- **N reps** → adapt `probes/A3-stat/run-n.sh` (CSV, `claude --version` stamped per run); report mean ± stdev
  across reps, distributions not single runs (module-spec §1).
- **Home** → `spikes/v3-hybrid`-adjacent (e.g. `spikes/ultra-reverse/`) bash+node harness, locked §8.4.
  Promote to `packages/ultracode-core` + `apps/` only after the slice is green.

### 9.1 The smallest vertical slice (build first — strategy §7)

> ONE frozen intent → **M0** capture Case-1 `.js` via `fs.watch` on
> `…/<session>/workflows/scripts/*.js` + cancel (prove `agentCount:0`) → **M1** Case-2 via the wrapped
> existing chain → **M2** both → `DecisionPlan` → **one** structural metric only (`pattern_match` +
> `dag_shape`) → **one** `ScorecardSlice` row persisted.

No judge panel, no reps, no UI in the slice. Prove `capture → normalize → score → persist` once, then layer
on the judge panel (§7), guardrail uplift (§8), N-reps, and a minimal results view.

---

## 10. Open questions carried into implementation

> **Implementation status (2026-06-23, `spikes/ultra-reverse/`, 30/30 tests green on node v26.3.1).**
> All buildable items are built; the one genuinely-open item (#1) needs a human at an interactive terminal.

1. **[OPEN — needs a human] Live cancel keystroke** that provably yields `agentCount:0` on 2.1.186 — the last
   M0 [VERIFY] (strategy §5.4). Capture + verify tooling is built (`capture/script-capture.mjs`,
   `capture/verify-capture.mjs`); a person must run one `ultracode` session, cancel, and confirm PASS.
   Candidates: backspace right after the keyword, `alt+w`, `Esc`, approval-card **No**.
2. **[RESOLVED] IR fidelity** — both projectors land in the IR and the structural diff discriminates
   (unrelated plans score ~0 on `pattern_match`; identical plans 1.0). `extraction.lossy` exclusion works;
   the real-services projector + drift guard (`case2-to-decision-real.mjs`, `test/case2-real.test.mjs`)
   prove the wave layering matches deployed behavior. Validate further on the first *real* Case-1 pair.
3. **[high — stamped] Case-2 fairness confound** — recorded per scorecard (§0); unchanged. Revisit only if
   it visibly pollutes scores (strategy §8.1).
4. **[RESOLVED] Width `'dynamic'`** — the parser logs runtime-decided widths to `extraction.lossy` and
   `fanout_width_delta` excludes them (verified: `dev.workflow.js` fan-out over `stories` → `'dynamic'`).
5. **[RESOLVED in harness] Judge variance / blind integrity** — `judge-panel.mjs` does seeded A/B relabel
   (provenance stripped in `renderPlanForJudge`), 3-judge averaging with single-outlier rejection, and the
   no-justification→null honesty downgrade; tests cover un-mapping + outlier drop. Live-model variance (stdev
   across reps) is measured once the live judge is activated.
6. **[low] Preview drift** — re-confirm primitive signatures + capture layout after each `claude update`;
   record `claude --version` on every run (currently 2.1.186).

---

## 11. Sources

Founding: `ultracode-pipeline-spec.md` (§3 primitives, §4 patterns), `futurator-ultracode-module-spec.md`
(§6 DecisionPlan, §7 scoring, §10 test cases), `ultracode-bench-strategy.md` (locked decisions, §5 M0 proof,
reuse map). In-repo (existence-checked): `functions/shared/schemas/{plan-output,concept-plan}-schema.ts`,
`functions/shared/types/plan.ts`, `functions/shared/pipelines/role-policy.ts`,
`functions/shared/services/{solutioning-gate,plan-waves,story-waves}.ts`,
`functions/shared/scorecard/{types,criteria-meta}.ts`,
`daemon/pipelines/scorecard-assess-job-runner.mjs`,
`spikes/v3-hybrid/{workflows/*.js, probes/E1-plan-swarm/*, probes/C1-fixswarm/*, probes/B1-harvester/harvest.mjs, probes/A3-stat/run-n.sh}`,
`docs/concepts/dynamic_workflows/{workflow-lint.mjs, workflow-authoring-SKILL.md}`,
`docs/concepts/pipeline-v3/dynamic-workflow-orchestration-concept.md`.
