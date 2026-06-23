# Ultracode Reverse-Engineering Test Bench — Plan-Overview Strategy

> **Status:** EXPLORATION / PLANNING. This document gathers context (specs + codebase + CLI + web),
> makes the build-vs-reuse call, and re-sequences the spec. Detailed design lands in a later iteration.
> **Date:** 2026-06-23 · **Owner:** Richie
> **Founding docs:** `~/Downloads/futurator-ultracode-module-spec.md` (the module build-spec),
> `~/Downloads/ultracode-pipeline-spec.md` (the pipeline investigation it is founded on).
> **Verified against** installed `claude` **2.1.186** on this Mac; in-repo paths below were existence-checked.
>
> **🔒 Locked decisions (2026-06-23, Richie):** MVP ships in **`spikes/`** (extend `spikes/v3-hybrid`),
> reuse **DynamoDB + S3** (no Postgres), **package the existing concept chain as Case 2** (no separate
> single-shot planner for the MVP), and **reuse `planOutputSchema` as the Plan SPEC** (project down to
> the IR). See §8 for the full rationale and the one confound this accepts.

---

## 0. What this module is

A web/orchestrator bench that runs the **same intent** through two engines and halts both at
"plan produced":

- **Case 1 (ground truth)** — the **real** Claude Code `ultracode` planner. Capture the generated
  `.js` orchestration script **before any agents run** (no fan-out token burn).
- **Case 2 (challenger)** — a **reverse-engineered Futurator planner** that emits a structured plan.

Both are normalized into a common `DecisionPlan` IR, auto-scored (structural diff + judge panel +
guardrail uplift), run **N≥5 reps** for distributions, and accumulated into a distillation corpus that
drives improvement of Case 2.

**Win condition (from the spec):** Case 2 _matches_ Case 1 on planning structure/quality and _beats_
it on guardrail conformance. Not a byte-match.

---

## 1. Executive summary

**The single most important reframe.** The module spec reads as a from-scratch Turborepo build
(`apps/ultracode/`, `services/ultracode-orchestrator/`, Postgres+S3, dual xterm pty UI). **It is not.**
Futurator-Admin already contains ~80% of "Case 2" and most of the surrounding substrate, and the
`spikes/v3-hybrid` work already proved the runtime mechanics (headless invocation, telemetry harvest,
N-rep stats, dual-engine A/B). The genuine experiment apparatus — Case-1 capture, normalization,
comparative scoring, corpus — is the real net-new, and even there the riskiest piece (**M0 capture**)
is now **proven on this machine** (§5).

**Headline verdict — build only four things, reuse the rest:**

1. **Case-1 ultracode script capture** (M0) — _proven path exists; one live-run [VERIFY] remains._
2. **`DecisionPlan` IR + two `*ToDecision` projectors** — the load-bearing design decision.
3. **Comparative scoring** — structural diff + blind-paired judge panel + guardrail-uplift number.
4. **A thin experiment shell** — drive both engines on a frozen intent, persist, run N reps.

Do **not** build a parallel planner, do **not** invent a new Plan SPEC, do **not** stand up Postgres,
and do **not** start with a Next.js dual-pty terminal. Ship a **one-intent vertical slice** first.

---

## 2. What we verified

### 2.1 CLI / runtime facts (web-confirmed against official docs, current 2026-06-23)

| Fact                                                                                                                                                                                                                                                | Confidence               | Note                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| Ultracode = session setting (xhigh + automatic dynamic-workflow orchestration); the dynamic workflow **is** a JS script Claude writes; runtime runs it in the background                                                                            | fact                     | confirmed verbatim                                                                |
| Script written to a file under `~/.claude/projects/<session>/`; path handed to Claude at run start                                                                                                                                                  | fact                     | **this is the M0 capture seam**                                                   |
| Limits: 16 concurrent / 1,000 total agents; no mid-run user input; **the script itself has no fs/shell access** (only spawned agents do); **resumable within the same session only**                                                                | fact                     | confirms B1 spike + D2 resume gap                                                 |
| Primitives `agent/parallel/pipeline/workflow` + helpers `phase/log/args/budget`; opts `schema/label/phase/model/agentType/isolation:"worktree"`; `Date.now`/`Math.random`/argless `new Date()` throw; `meta` must be a pure literal; reduce-is-free | fact (3rd-party-sourced) | research-preview surface — re-verify signatures before linting/generating scripts |
| Workflow subagents **always run `acceptEdits`** and inherit the session allowlist; shell/web/MCP-not-on-allowlist can still prompt mid-run; `claude -p` / bypassPermissions skips the launch approval                                               | fact                     | unattended path must use bypassPermissions (matches spike)                        |
| Workflows available in CLI, Desktop, IDE, `claude -p`, **and the Agent SDK**; same disable settings everywhere                                                                                                                                      | fact                     | relevant to Case-2 engine choice (§8.1)                                           |

### 2.2 Two corrections to the spec's assumptions — call these out

1. **Trigger keyword drift.** The literal trigger keyword changed **`workflow` → `ultracode` in
   v2.1.160**. The spec pins v2.1.154. Any bench logic that types `workflow` to trigger a run
   **silently fails** on this 2.1.186 machine. Natural-language ("use a workflow") still works.
2. **`{role:"system"}` reminder is NOT confirmed model-exclusive.** Mid-conversation system messages
   are a documented Opus-4.8 feature, but **no public source confirms older models reject it** (a
   cited shim claims the opposite). Do **not** build hard model-version gating on this premise.

### 2.3 Provenance correction

The pipeline spec §9 hoped **Piebald-AI/claude-code-system-prompts** held the ultracode authoring
prompt. It does **not** — that repo's closest content is generic "Coordinator Mode" delegation prompts.
The best public proxy for the authoring vocabulary is instead Anthropic's own harness blog (§4).

### 2.4 M0 capture — proven on this machine

The on-disk capture path the spec was reaching for **exists and works today** (full detail in §5).
The one true high-risk unknown is now reduced to a single live-run keystroke confirmation.

---

## 3. Reuse map (module-spec component → in-repo asset → verdict)

| Module-spec component                                                   | Existing in-repo asset                                                                                                                                                                       | Verdict                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Plan SPEC** (Case-2 structured IR)                                    | `functions/shared/schemas/plan-output-schema.ts` — epics→stories, AC w/ BMAD BDD + verify-intent, `dependsOn` DAG, touchPoints, requirementRefs (**richer than the spec's DevelopmentPlan**) | **reuse-as-is** — use it AS the Plan SPEC; do **not** write `planSpec.ts` |
| ConceptEnvelope                                                         | `functions/shared/schemas/concept-plan-schema.ts` (uiBearing/complexity/artifacts DAG/gate + superRefine)                                                                                    | adapt                                                                     |
| Case-2 "Lander" (decompose → deterministic projection)                  | `functions/shared/services/plan-generation-service.ts` (`applyPlanOutput`)                                                                                                                   | reuse-as-is                                                               |
| Case-2 Validator (coverage / AC / DAG / rigor gate)                     | `functions/shared/services/solutioning-gate.ts` (`runSolutioningGate`) + `functions/shared/services/plan-waves.ts` (`computePlanWaves`, throws on cycle)                                     | reuse-as-is                                                               |
| Case-2 decompose prompt                                                 | `functions/shared/prompts/pm-plan-prompt.ts`                                                                                                                                                 | adapt (consolidate into one planner call)                                 |
| agentType roster / capability scoping                                   | `functions/shared/pipelines/role-policy.ts` (`RoleSchema`, `buildAgentConfig`)                                                                                                               | reuse-as-is                                                               |
| **Case-1 ultracode script capture**                                     | — (spike ran only its _own_ `.js`)                                                                                                                                                           | **net-new** (proven path, §5)                                             |
| `case1ToDecision` AST parser                                            | —                                                                                                                                                                                            | **net-new**                                                               |
| `case2ToDecision` projector (PlanSPEC → DecisionPlan)                   | pattern from `spikes/v3-hybrid/probes/E1-plan-swarm/epic-elicitation-heavy.workflow.js`                                                                                                      | net-new (pattern-only)                                                    |
| **`DecisionPlan` IR** (orchestration shape)                             | none — existing plans are work-breakdown DAGs, not call-graphs                                                                                                                               | **net-new** (the key design decision, §4)                                 |
| Structural diff (pattern / phase / fanout / dag-edit-distance)          | DAG check `spikes/v3-hybrid/probes/E1-plan-swarm/acyclic.py`; drift `conformance.py`; combiner `rollup.ts`                                                                                   | net-new (pattern-only)                                                    |
| **Comparative judge panel** (blind A/B, randomized, 3 judges, averaged) | `daemon/pipelines/scorecard-assess-job-runner.mjs` (marker-block prompt + tolerant evidence-clamping parser)                                                                                 | adapt (backbone reuse; blind-pair averaging is net-new)                   |
| Guardrail-uplift score                                                  | concepts in `role-policy.ts` / `solutioning-gate.ts`; no number computed                                                                                                                     | net-new                                                                   |
| Scorecard schema                                                        | `functions/shared/scorecard/types.ts` (ScorecardSlice / Verdict / EvidenceRef) + weighted rollup                                                                                             | reuse-as-is                                                               |
| Reps / N≥5 distributions                                                | `spikes/v3-hybrid/probes/A3-stat/run-n.sh`                                                                                                                                                   | adapt                                                                     |
| Headless invocation / subprocess drive + telemetry                      | `spikes/v3-hybrid/run-spike.sh`; harvester `spikes/v3-hybrid/probes/B1-harvester/harvest.mjs` (path-munge + journal/transcript scrape)                                                       | pattern-only / adapt                                                      |
| Web UI (dual terminal, xterm/pty)                                       | none                                                                                                                                                                                         | net-new — **scope down** (§8.4)                                           |
| Store (Postgres + S3)                                                   | DynamoDB everywhere + scorecard DDB infra                                                                                                                                                    | **reuse DynamoDB + S3; drop Postgres** (§8.3)                             |
| Rubric / axis weights                                                   | `docs/concepts/pipeline-v3/test-bench-rubric.md`                                                                                                                                             | adapt (compare axis-by-axis to module §7)                                 |

---

## 4. The genuine net-new (ranked)

1. **Case-1 ultracode script capture (M0).** Capture the real generated `.js` and halt before agents
   run. Proven path (§5); everything downstream needs a Case-1 artifact.
2. **`DecisionPlan` IR + the two projectors.** Pick a normalization target where a Case-1
   _orchestration call-graph_ and a Case-2 _epic/story work-breakdown_ are actually comparable. **This
   is the load-bearing design decision of the whole module** — get it wrong and scoring is
   apples-to-oranges. The module spec's §6 `DecisionPlan` (pattern / phases / fanOut / verify /
   edges) is the right starting shape; the open question is how faithfully Case 2's work-breakdown
   projects onto it.
3. **Comparative scoring.** Structural diff math, blind-paired 3-judge panel, guardrail-uplift number.
   Judge backbone is reusable; the blind A/B averaging and the structural/guardrail math are new.
4. **Thin experiment shell.** Orchestrator that runs both engines on one frozen intent, stores
   artifacts + scorecard, drives N reps. Keep minimal (§8.4).

Everything else (Case-2 planner, Plan SPEC, validator, stats harness, scorecard schema, headless
drive, store) is **reuse or adapt**.

---

## 5. M0 capture — the critical path (PROVEN on this machine)

**Goal:** obtain the real ultracode-generated `.js` for an intent and stop with **zero agents executed**.

### 5.1 On-disk layout (verified — a live specimen was captured this session)

```
~/.claude/projects/<munged-project>/<session-uuid>/
  workflows/
    wf_<id>.json                      # JOURNAL + METADATA (script inlined byte-identical)
    scripts/
      <workflow-name>-wf_<id>.js      # ← THE GENERATED SCRIPT, readable JS source
  subagents/
    workflows/wf_<id>/
      journal.jsonl                   # started/result events keyed by content-hash → agentId
      agent-<id>.jsonl                # per-agent transcript (model, tokens, timestamps)
```

- The generated script is **readable JS source** at `workflows/scripts/<name>-wf_<id>.js`, and is
  inlined **byte-identically** as the `script` field of `wf_<id>.json`.
- `wf_<id>.json` also exposes `scriptPath`, **`phases`** (`[{title}]` — the spec's `phasesFromCard`,
  no AST needed), `defaultModel`, `totalTokens`, `agentCount` — covering most of `Case1Result`
  without parsing.
- **Timing proof of "zero token burn":** on the captured specimen the script `.js` existed at
  launch (t=0) and agents ran for **~14.5 minutes afterward**. Capturing on the file-write and
  cancelling immediately captures the full plan with **no fan-out tokens**.
- **Detect "real ultracode"** (vs a hand-written harness script like the spike's `dev.workflow.js`)
  by the **presence of the `workflows/scripts/<name>-wf_<id>.js` copy** — pre-authored runs point
  `scriptPath` at the repo file and have no `scripts/` dir.

### 5.2 Recommended strategy

| Strategy                                       | Verdict                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **fs.watch `workflows/scripts/*.js` + cancel** | ✅ **RECOMMENDED (interactive Case 1).** Watch the session's `workflows/scripts/` dir; on first `*.js` create, read it + sibling `wf_*.json`, then cancel. Deterministic; no hook needed.                                                                                                                                |
| PreToolUse-on-Workflow hook (spec "Path A")    | ❌ **REFUTED on 2.1.186.** No workflow-launch hook event exists. Hook events present: `PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, SubagentStart, SubagentStop, Stop, UserPromptSubmit, MessageDisplay, WorktreeCreate, PermissionRequest`. The orchestrator isn't an interceptable pre-launch tool call. |
| Reuse `harvest.mjs`                            | ⚠️ **POST-HOC only — does not halt.** Reads journals/transcripts _after_ a run. Reuse for M3/M4 telemetry, **not** M0. Its path-munging helper is directly reusable.                                                                                                                                                     |
| Read `wf_<id>.json` / `.js` post-hoc           | ✅ for _capture_, ✗ for _halt_. Good for headless batch where you can't cancel, but you pay full token cost. Best used as the artifact reader the watcher calls.                                                                                                                                                         |

### 5.3 Concrete recipe (this machine)

1. Spawn `claude` via node-pty; type the intent containing the trigger keyword **`ultracode`** (not
   `workflow`).
2. Resolve the session dir; `fs.watch` `…/<session>/workflows/scripts/`.
3. On first `*.js` create → read it (+ `wf_*.json` for `phases`/`scriptPath`/`defaultModel`) → that
   is `Case1Result.scriptJs` + `phasesFromCard`. Use a size-stable / `fs.stat` debounce so the
   watcher reads a complete file.
4. Immediately cancel before agents progress.

### 5.4 [VERIFY] status

**Resolved:** script stored as readable JS; exact path layout; script written before fan-out; phase
list available without AST; Path-A hook does not exist; `claude -p`/bypassPermissions skips approval;
`harvest.mjs` is post-hoc; trigger keyword is `ultracode`.

**Still open (needs one live interactive run):**

- Exact cancel keystroke that provably leaves `agentCount: 0` and empty `subagents/workflows/`
  (candidates with changelog support: backspace right after the keyword, `alt+w`, `Esc`, the approval
  card's **No**).
- That the approval card renders the full phase list before any agent spawns (strongly implied).
- fs.watch atomic-read confirmation (specimen looked atomic; add debounce anyway).
- Mycelium MCP reachability from Case-1 ultracode (spec §10) — untested.

**Headless caveat:** with no Path-A hook, there is **no clean zero-token capture headless** on
2.1.186. For batch corpus, either drive Case 1 through interactive pty with watch+cancel, or accept
planning/startup token cost.

---

## 6. Case 2 — the challenger, and its one real fork

The reverse-engineered planner mostly **already exists** as the concept chain
(`pm-plan-prompt` + `applyPlanOutput` + `runSolutioningGate` + `computePlanWaves`). The authoring
vocabulary it should reason with is now sourced first-party.

### 6.1 The authoring meta-prompt structure (for `metaPrompt.md`)

The spec's 3-part inference holds: **(1)** the script API + hard constraints it writes against;
**(2)** a finite repertoire of named quality patterns as vocabulary; **(3)** a meta-instruction:
_classify task → instantiate matching pattern → present phases → emit script_. The exact wording is
unpublished; `classify-and-act` being a first-class named pattern directly corroborates "planning =
classify + pick-axis."

**Named quality patterns (Anthropic-first-party name · spec synonym · trigger):**

| Pattern                  | Spec synonym                                     | Trigger                                                                              |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| classify-and-act         | the §4 classify→pattern decision                 | Same noun, different verb — routes to different skeletons (build vs plan vs audit).  |
| fan-out-and-synthesize   | fan-out → reduce → synthesize                    | Independent sub-steps each wanting clean context, then one merge. The base skeleton. |
| adversarial verification | adversarial verify                               | A finding must be trustworthy — spawn skeptics to refute; keep survivors.            |
| generate-and-filter      | (perspective-diverse verify is its lens-variant) | Many candidates → dedupe/rank/filter by rubric.                                      |
| tournament               | judge panel                                      | One hard problem, N approaches → judges score → synthesize from winner.              |
| loop-until-done          | loop-until-dry                                   | Unknown-size discovery → spawn until K empty rounds (dedupe vs all _seen_).          |

`reduce` is **not** a model pattern — it is free plain-JS glue; the IR should represent it as a
non-agent node. (Source: Anthropic harness blog + workflows docs + alexop.dev.)

### 6.2 The load-bearing fork: how Case 2 _executes_ (open decision — see §8.1)

The four primitives are **NOT a callable SDK surface** — they are runtime internals of the `Workflow`
tool, which the Agent SDK _can_ invoke. So Case 2 has two paths:

- **(i) Delegate to Anthropic's runtime.** Emit a workflow-trigger/script and let the `Workflow`
  runtime execute it (inherit free resume/journaling). Cost: depends on the Opus-4.8 authoring
  injection (spec §8 Q8) and is less controllable.
- **(ii) Emit a portable plan-IR onto Futurator's own harness** (the spike direction). Full control
  (gate-lint, per-phase allowlists, negative enforcement via `agents`/`disallowedTools`/`PreToolUse`
  hooks — all first-class SDK options), no Opus-4.8 dependency, **but must re-implement resume**.

For the **bench's prototype stage Case 2 spawns no agents at all** — it only produces a plan and
stops — so this fork does not block M0–M3. It must be decided before any execution/distillation work.

---

## 7. Recommended phased plan (re-sequenced from the spec's M0–M5)

| Phase                              | Spec intent                    | Verdict                                                                                                                                                                          |
| ---------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 — Case-1 capture**            | net-new                        | **BUILD FIRST.** Path proven (§5); close the live-run cancel [VERIFY].                                                                                                           |
| **M1 — Case-2 planner**            | build planner                  | **MOSTLY DONE.** Wrap existing `pm-plan-prompt` + `applyPlanOutput` + `runSolutioningGate` behind one synchronous `futurator-plan` call. Net-new = the _wrapper_.                |
| **M2 — DecisionPlan + projectors** | normalize                      | **BUILD.** Define the IR; `case1ToDecision` (AST over the captured `.js`) + `case2ToDecision` (PlanSPEC → IR).                                                                   |
| **M3 — scoring**                   | structural/judge/guardrail     | **PARTIAL BUILD.** Adapt `scorecard-assess-job-runner.mjs` for the panel; write structural + guardrail math; combine via `rollup.ts`.                                            |
| **M4 — reps/stats**                | N≥5 distributions              | **NEARLY DONE.** Adapt `A3-stat/run-n.sh`. Mandatory: envelope-matched arms + harvester on both sides (every prior spike A/B was confounded — no ROI number is valid otherwise). |
| **M5 — UI + corpus**               | dual-pty Next.js + Postgres+S3 | **DESCOPE.** Reuse DynamoDB+S3 + scorecard infra for the corpus; minimal results view, not a dual-terminal pty UI.                                                               |

### Smallest end-to-end vertical slice (build this first)

> ONE frozen intent → capture Case-1 script (M0) → run Case-2 via the wrapped existing chain (M1) →
> normalize both to `DecisionPlan` (M2) → run **one** scorer only (structural diff `pattern_match` +
> `dag_shape`) → emit **one** scorecard row (`scorecard/types.ts`).

No judge panel, no reps, no UI in the slice — just prove **capture → normalize → score → persist**
works once. Add the judge panel, guardrail score, N-reps, and UI after the loop is green.

---

## 8. Decisions (LOCKED 2026-06-23)

### 8.1 Case-2 engine — 🔒 LOCKED: package the existing chain

**Decided:** package the existing concept chain (`pm-plan-prompt` + `applyPlanOutput` +
`runSolutioningGate` + `computePlanWaves`) as Case 2 for the MVP (≈80% reuse, ships fast).
**Accepted confound:** the chain is cost-tiered/multi-step, not a faithful single-shot xhigh-Opus
challenger — record it as a known confound on every scorecard (§9 risk #3). Build a single-shot
xhigh-Opus meta-prompt challenger later _only if_ the asymmetry visibly pollutes scores. (The §6.2
execution fork only matters once Case 2 runs agents — the prototype does not, so it stays deferred.)

### 8.2 Plan SPEC — 🔒 LOCKED (by-default): reuse `planOutputSchema`

**Decided:** emit the richer existing `functions/shared/schemas/plan-output-schema.ts` and project
_down_ to the `DecisionPlan` IR. Do **not** invent `planSpec.ts`. (Flag if you want this reopened.)

### 8.3 Store — 🔒 LOCKED: DynamoDB + S3

**Decided:** reuse DynamoDB + S3 + the scorecard infra; **no Postgres**. The corpus is append-mostly
and fits DDB+S3 (matches the zero-cost-serverless / multi-table conventions).

### 8.4 Module home + UI — 🔒 LOCKED: `spikes/` harness

**Decided:** start in **`spikes/`** as a bash+node harness extending the proven `spikes/v3-hybrid`
backbone, with a **minimal static results view** — not a Next.js xterm dual-terminal. Promote to
`apps/` only after capture→normalize→score is validated.

---

## 9. Open questions & risks (ranked for the next iteration)

1. **[blocker] Live cancel keystroke** that provably yields `agentCount: 0` on 2.1.186 — the last M0
   [VERIFY]. (pipeline-spec §8 Q1 is now mostly resolved by §5.)
2. **[blocker] DecisionPlan normalization target.** Case-1 is an orchestration call-graph; Case-2 is
   an epic/story work-breakdown — different artifact _kinds_. Pick a target where structural diff is
   meaningful. (pipeline-spec §8 Q4.)
3. **[high] Case-2 fairness confound.** The deployed chain is cost-tiered (Haiku router, Sonnet
   pm-plan), multi-step across DynamoDB jobs + EC2-daemon disk — **not** a drop-in single-shot
   xhigh-Opus challenger. Decide §8.1. (pipeline-spec §8 Q1/Q7.)
4. **[high] Guardrail axis not in the schema.** The guardrails Case 2 should _win_ on (`test_tier`,
   `skill_bindings`, `isolation`, per-story `agentType`) live in `applyPlanOutput`/`role-policy`,
   **not** in `planOutputSchema` — surfacing them needs a schema extension.
5. **[med] ROI/speed numbers require envelope-matched arms + harvester on both sides.** Every prior
   spike A/B was confounded (toy-scale overhead, cwd-munge `tok=0`, serial tokens unharvested). No
   crossover point measured. Report no structural/ROI number without controlling this.
6. **[med] Telemetry path fragility.** The harvester couples to undocumented, content-hash-keyed
   transcript paths; re-confirm after every CLI update. Case-1 lacks the spike's `stepId` convention →
   defer Case-1 per-agent telemetry out of MVP.
7. **[med] Execution fork & resume parity** (§6.2 / pipeline-spec §8 Q2). Delegating to the runtime
   gives free resume but an Opus-4.8 dependency; the bash harness needs resume re-implemented.
8. **[low] `{role:"system"}` model-exclusivity unverified** (§2.2) — don't gate bench logic on it.
9. **[low] `meta`-block "pure literal" requirement** — verify against 2.1.186 if the bench ever
   lints or generates scripts.
10. **[env-gated] D-round unknowns** (EC2 multi-core, Memgraph, cross-session resume) — parallelism
    may only pay off on the multi-core daemon, not this Mac.

---

## 10. Sources

**Official:** `https://code.claude.com/docs/en/workflows` · `https://code.claude.com/docs/en/sub-agents`
· `https://code.claude.com/docs/en/agent-sdk/overview` ·
`https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code` (the six named
patterns) · `https://claude.com/blog/introducing-dynamic-workflows-in-claude-code`.
**Deep technical (research-preview accurate, may drift):**
`https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/` ·
`https://github.com/Piebald-AI/claude-code-system-prompts` (does **not** contain the authoring prompt).
**In-repo:** `functions/shared/{schemas,services,prompts,pipelines,scorecard}/…`, `spikes/v3-hybrid/…`,
`docs/concepts/pipeline-v3/{concept-dev-bridge-*,dynamic-workflow-orchestration-concept,test-bench-rubric}.md`,
`daemon/pipelines/scorecard-assess-job-runner.mjs`.
**Caveat:** the exact ultracode authoring reminder is unpublished; authoring-layer and Opus-4.8-injection
claims remain inferred from observed behavior + research-preview reversing — re-verify against the
installed `claude --version` each iteration.
