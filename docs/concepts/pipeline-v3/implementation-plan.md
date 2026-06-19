# Pipeline v3 — Concept→Dev Bridge: Implementation Plan (Option A)

Status: **SUPERSEDED on scope by `concept-dev-bridge-epics.md` (RECONCILED 2026-06-19)** · evidence:
`spike-test-results.md` §2b/§2c.
Branch base: `feat/pipeline-v3` (already off `main`, which has the pacman4 deadlock fix `5f497c0`).

> ⚠ **Read the reconciliation first.** A 16-agent audit (`v3-epic-reconcile-audit`) matched this plan
> against the **deployed** codebase and found it over-scopes: the proposed standalone `checkout-gates.ts`
> is **not built** — acyclicity already throws (`computePlanWaves`), collision is already resolved
> (`computeStoryWavesWithTouchPoints`), and coverage already lives (dormant) in `runSolutioningGate`. E1
> is therefore **wiring + persistence on the existing gate**, not a new gate file. The build spec of
> record is now `concept-dev-bridge-epics.md`'s per-story verdict map; this doc's _evidence basis_ and
> _rationale_ (below) still stand — its _file-level "create X" instructions_ are superseded where they
> conflict with the reconciled epics.

> **Why Option A.** The heavy-output A/B (`spike-test-results.md` §2c) showed the planning
> swarm is **not a proven speed win** (290.9s vs 135.1s single-shot; identical AC-throughput
> 0.54 vs 0.53 ACs/s; ~15× token multiplier at 690k tokens) on a CPU-limited host. But the
> **deterministic checkout gates** it carried caught two real defects (a coverage gap + a
> contract-drift candidate) the current single-shot ships blind. So we land the **certain win**
> — gates + prompt-trim on the existing single-shot pm-plan — and keep the **swarm as a deferred,
> EC2-gated experiment**, while taking the swarm + contract enforcement _downstream_ where the
> evidence says it pays (the blind test/dev bench).

---

## 0. Evidence basis (what each decision rests on)

| Decision                                                          | Evidence                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep single-shot pm-plan; trim it                                 | Heavy single-shot did 15 stories/71 ACs in 135s; the 20-min prod cost is prompt weight (~430-line prompt `pm-plan-prompt.ts:139-566`) + heavy per-story output + `maxIterations:2` retry, **not** orchestration shape (§2c) |
| Add deterministic checkout gates                                  | The gates caught a coverage GAP (3 dropped `DEC-*`) + a drift candidate; single-shot has no such check (§2c)                                                                                                                |
| Defer the planning swarm                                          | No demonstrated crossover; 15× token multiplier; arms not envelope-matched (§2c)                                                                                                                                            |
| Move contract+test authoring to a pre-dev bench (blind, enforced) | A1-stub: a non-enforced contract **backfires** (§2b); pacman4 deadlock = validation-after-freeze with conflicting scopes (`test-dev-contract-incident.md` + main `5f497c0`)                                                 |
| Per-agent capability strip for bench/swarm agents                 | A5: frontmatter `tools:` denies Bash even under `bypassPermissions` (§1 reconciliation)                                                                                                                                     |
| Every gate/agent/subagent must emit a `stepId` event              | B1: telemetry is recoverable only with a stable `stepId` per agent (§1)                                                                                                                                                     |

---

## 1. Architecture — the bridge (Option A)

```
 CONCEPT (before "start development", YOLO auto-approves gates)
   Analyst → PM(PRD) → UX → Architect
        └─▶ PLAN-GEN (single-shot pm-plan, TRIMMED)            [Slice 1]
                 └─▶ CHECKOUT GATES (deterministic, bash):      [Slice 1]
                       coverage · collision · acyclicity · conformance
                     → persist plan.checkoutGates + emit __gate__ events
                 └─▶ human plan approval  (auto-passed under YOLO)
 ── "start development" ───────────────────────────────────────
 DEV (per epic-wave, just-in-time)
        └─▶ CONTRACT+TEST BENCH (dev phase 0, blind+enforced):  [Slice 2]
              api-author swarm → freeze contracts (tsc-gated)
              test-author swarm → author tests vs frozen contracts
              each agent: write → self-gate → reroute (cap+escalate)
        └─▶ DEV swarm (starts at DEV; test/api-author REMOVED from story-pipeline)
        └─▶ merge → existing wave gates
 DEFERRED (EC2, gated on an envelope-matched crossover run)
        └─▶ PLAN-DECOMPOSITION SWARM (replaces single-shot only if it wins)
```

---

## 2. Slice 1 — checkout gates + prompt-trim on the existing single-shot (CERTAIN WIN)

### 2.1 Trim the pm-plan prompt + lighten output

- **File:** `functions/shared/prompts/pm-plan-prompt.ts` (the ~430-line single string, L139–566).
- Move the bulky, rarely-decisive guidance (the anti-pattern essays L262–311, the visual-coverage
  essay L428–486) into a **linked rubric the agent may consult**, not inlined every run. Keep the
  hard rules (parallelism model L194–216, touch-points L294–311, output format L494–526).
- Keep the enriched per-story fields (`userStory`/`technicalNotes`/`tasks`/`criteria`) — they are
  the product, not the waste. The waste is the _instruction_ token weight + the retry.
- **Acceptance:** same plan quality (coverage/collision/acyclicity gates green), measurably lower
  wall-clock + output tokens on the Pac-Man docs vs the current prompt.

### 2.2 The checkout gates (deterministic, no LLM)

Add a `runCheckoutGates(plan, output)` step invoked from `applyPlanOutput`
(`functions/shared/services/plan-generation-service.ts:238-379`), right where it already computes
`computeStoryWavesWithTouchPoints` (L280) and `computePlanWaves` (L356). Four gates, ported from
the validated probe (`spikes/v3-hybrid/probes/E1-plan-swarm/`):

1. **Coverage** — every PRD-FR / UX-screen / arch-module/decision id maps to ≥1 epic's
   `coversSpecIds`. (Probe caught 3 dropped `DEC-*`.) Requires the breakdown/plan to carry
   `coversSpecIds`; for single-shot, derive from the prompt's spec-id enumeration.
2. **Collision** — no two same-wave stories share a `touchPoint` (reuses the wave math already at
   L280; today it _serializes_ collisions silently — the gate makes them visible/auditable).
3. **Acyclicity** — epic `dependsOnEpics` DAG + intra-epic story `dependsOn` DAG are acyclic
   (Kahn — `probes/E1-plan-swarm/acyclic.py`).
4. **Conformance** — cross-epic: any domain-type name used by **≥2 epics** must be in the frozen
   contract surface (`probes/E1-plan-swarm/conformance.py`, corrected ≥2-epic threshold). For the
   single-shot, the "surface" is the foundation/types story's exports.

**Gate posture:** blocking on coverage/acyclicity/conformance (a real defect); **advisory** on
collision (the scheduler already serializes — surface it, don't block). Under **YOLO**, blocking
gates auto-pass with the violation recorded (prototyping mode — see §5).

### 2.3 Persist + audit (see §6 for the full audit wiring)

- New `plan.checkoutGates` field (mirror the `qaContractStatus` pattern, `plan.ts:299-324`).
- Each gate emits a `__gate__` event (mirror `__shell__`, `agent-daemon.mjs:1699-1956`).

---

## 3. Slice 2 — contract+test bench (dev phase 0) + relocation (DOWNSTREAM, where the swarm pays)

### 3.1 Relocate test-author + api-author out of the per-story pipeline

- **File:** `functions/shared/pipelines/story-pipeline.ts` — remove `api-author` (step L317, role
  `API_AUTHOR` L260) and `test-author` (step L341, role `TEST` L249). The story pipeline now
  **starts at `dev` (L640)** against already-frozen contracts + tests.

### 3.2 The bench (runs on `start`, per epic-wave, just-in-time)

On `POST /api/plans/:id/start` (`functions/api/index.ts:2796-2950`), before
`launchPipelineWave`, run the bench for the wave's epics (contracts freeze before dependents'
tests; per-wave keeps runs short — O5):

1. **api-author swarm** → contract stubs (`.d.ts`/signatures) for shared types + each story's
   exports. **Freeze only after `tsc` passes on stubs alone** (enforced — A1-stub).
2. **test-author swarm** → all tests for the wave in parallel, against the **frozen** contracts.
3. Each bench agent runs the **validate→reroute loop** (the C1 fix-swarm pattern): write →
   deterministic self-gate (parses? RED vs absent impl? covers every AC?) → on fail **re-spawn that
   one agent** with the error (cap 2, escalate sonnet→opus, I6) → freeze only on pass. **This
   dissolves the pacman4 deadlock**: tests are validated _before_ they become the frozen contract,
   so no downstream actor ever needs to edit a frozen test.

- Bench agents are **capability-stripped** via custom-agent frontmatter (A5): write only their one
  declared path, no Bash/network.
- Optional **test-bench review gate** before the expensive dev swarm (separate workflow — no
  mid-run input; auto-passed under YOLO).

### 3.3 Reuse the validated probe code

The bench's reroute loop = `probes/C1-fixswarm/fixswarm.workflow.js` (I3/I5/I6 + held-out
negative control); the contract freeze = the A1 enforced-stub arm; blind authoring = the spike's
git-topology blindness (`run-spike.sh`).

---

## 4. Deferred — the planning-decomposition swarm (EC2-gated)

Ship **only if** an envelope-matched run on the real multi-core daemon proves a crossover:
same frozen plan size, swarm-with-doc-slicing vs single-shot, measuring wall-clock + tokens.
Instrument exists: `probes/E1-plan-swarm/run-heavy.sh` (+ `epic-elicitation-heavy.workflow.js`
with doc-slicing + checkout). Until then, the checkout gates (§2.2) run on the single-shot — they
were always the value, independent of orchestration.

---

## 5. Cross-cutting — YOLO auto-approve toggle

- **New field:** `plan.autoApproveGates: boolean`, set at plan creation (UI toggle + API default).
- **Threads through every human gate:**
  - concept artifact approvals (`concept-driver.ts:124-229`) → auto-approve each artifact;
  - plan approval → auto-transition concept→start;
  - the §3.2 test-bench review gate → auto-pass;
  - Slice-1 **blocking** checkout gates → auto-pass **but record the violation** in
    `plan.checkoutGates` (so YOLO never hides a defect — it just doesn't stop).
- Purpose (operator): run a new plan start→end unattended while prototyping the wiring. Recorded
  violations are the audit trail to come back to.

## 5b. Planning-workflow linter profile (governance finding)

`workflow-lint.mjs` FAILs planning workflows on C1 (verification role) + C8 (checkpoint) — it's
dev-pipeline-shaped (`spike-test-results.md` §2b). Add a **profile** (e.g.
`@workflow-kind: planning`) where "verification" = the checkout gate and "checkpoint" = the runner
persisting the plan. Do **not** fake a `compile-gate` role to pass.

---

## 6. Auditability + Plan Retrospect (the explicit requirement)

**Principle:** every new gate, agent, and subagent is a first-class, replayable event on the same
rails the scorecard already reads — so a future plan's gate outcomes + agent/subagent costs +
timings land in one pasteable bundle we can inspect together.

### 6.1 Gates emit events exactly like the existing shell gates

- The checkout gates and bench gates run as `__gate__`/`__shell__` steps that call
  `pushEvent(jobId, stepId, '__gate__', 'step_start'|'step_complete'|'step_error', {durationMs, …})`
  — the same path `executeShellStep` uses (`agent-daemon.mjs:641-671`, `:1699-1956`). `stepId`
  examples: `checkout-coverage`, `checkout-collision`, `checkout-acyclicity`, `checkout-conformance`,
  `bench-contract-freeze`, `bench-test-<storyId>`.
- These become `AgentEvent` rows (`agent-orchestrator.ts:721-779`) → `TimerSlice`
  (`timer/types.ts:101-116`) automatically.
- **Add the new stepIds to the step→category map** (`timer/step-category-map.ts:26-68`) so they
  slice correctly (and fix the noted `lint-verify` gap while there).

### 6.2 Every swarm/bench subagent carries a stepId (B1 requirement)

- Each `agent({schema})` return includes `stepId` (e.g. `decompose-<epicId>`, `fixer-<n>`,
  `test-author-<storyId>`). This is what lets the host-local **harvester**
  (`spikes/v3-hybrid/probes/B1-harvester/harvest.mjs`) map a workflow subagent's
  model/tokens/duration back to its plan/story — closing the O4 hole. Ship the harvester as a
  daemon component that, on workflow completion, scrapes
  `~/.claude/projects/<session>/subagents/workflows/<runId>/{journal,agent-*}.jsonl` and writes
  one `AgentEvent` per subagent (role `__subagent__`, with `stepId`, `model`, tokens, derived
  `durationMs`).

### 6.3 Persist gate summaries on the Plan row

- `plan.checkoutGates: Record<gateId, { passed, checkedAt, checkCount, errors?, autoApproved? }>`
  (new, mirrors `qaContractStatus` `plan.ts:299-324`); written via `updatePlanFields`
  (`plan-repository.ts:72-100`) in the plan-gen completion handler.

### 6.4 New scorecard detector + bundle section

- Add `scoreCheckouts(ctx)` to the `DETECTORS` array (`scorecard/index.ts:196-206`); it reads
  `ctx.plan.checkoutGates` and emits one `ScorecardSlice` per gate (🟢 pass / 🔴 block /
  ⚪ auto-approved-under-YOLO), with `evidenceRefs` pointing at the `__gate__` events.
- Surface in the **bundled JSON** (`RealityCheck`, `compose.ts:86-113`): the gate slices flow into
  `inefficiencies`/`actions` like any other criterion; add a `checkoutGates` rollup key so the
  operator sees pass/fail at a glance. Stored in the `overview` scorecard row
  (`scorecard-repository.ts:43-86`); served by `GET /api/plans/:planId/scorecard`
  (`index.ts:12789-12818`).
- Result: **paste the bundle → we see** every gate verdict, every agent's cost/duration, every
  subagent's tokens/model, and which gates YOLO auto-approved — enough to measure pipeline quality
  and iterate.

### 6.5 Forensic continuity

- The `ForensicPayload` (`forensic-builder.ts:128-144`) already carries `events` + `slices` +
  `costReconciliation`; the new `__gate__`/`__subagent__` events flow in for free. Verify D-WS1
  (`detectors/development.ts:183`), D-CC1 (`:247-280`), OV4 (`detectors/overview.ts:1-23`) still
  reconcile with the added rows; OV4's cost-reconciliation must include harvested subagent spend.

---

## 7. Sequencing & acceptance

| Step         | Deliverable                                                   | Acceptance (measurable)                                                                                                                        |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **1.1**      | Trimmed pm-plan prompt                                        | Lower wall-clock + output tokens on Pac-Man docs; gates green                                                                                  |
| **1.2**      | `runCheckoutGates` + `plan.checkoutGates` + `__gate__` events | Re-running the pacman4 plan surfaces any coverage/acyclicity/conformance defect as a recorded gate verdict                                     |
| **1.3**      | `scoreCheckouts` detector + bundle `checkoutGates` key        | Gate verdicts appear in `GET /api/plans/:id/scorecard` bundle                                                                                  |
| **2.1**      | Remove api/test-author from `story-pipeline.ts`               | Story pipeline starts at `dev`; no per-story test-author                                                                                       |
| **2.2**      | Per-wave contract+test bench + reroute loop                   | Inject the `pac-man's` apostrophe into a bench test → caught + re-routed pre-freeze (no deadlock); contracts tsc-frozen before dependent tests |
| **2.3**      | Harvester daemon component                                    | Each bench/swarm subagent yields an `AgentEvent` with stepId/model/tokens; OV4 reconciles                                                      |
| **3**        | YOLO toggle threaded                                          | A new plan with `autoApproveGates` runs concept→dev unattended; violations still recorded                                                      |
| **5b**       | Planning linter profile                                       | A planning workflow lints clean under `@workflow-kind: planning`                                                                               |
| **deferred** | Planning swarm (EC2)                                          | Envelope-matched crossover run favors swarm before it ships                                                                                    |

## 8. Risks

- **Single-shot coverage gate needs spec-ids.** The single-shot must emit `coversSpecIds` (or we
  derive them) for the coverage gate to run. Low risk — add to the trimmed prompt's output schema.
- **Harvester couples to undocumented transcript paths** (O3). Isolate behind one adapter module;
  re-validate after each CLI bump (the harvester doubles as the tripwire).
- **Bench per-wave latency.** The bench adds a pre-dev phase per wave; measure it lands net-positive
  vs today's per-story test-author (it removes N per-story test-author runs).
- **YOLO hiding defects.** Mitigated: blocking gates auto-pass but **record** the violation; never
  silently drop.
