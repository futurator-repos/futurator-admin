# PRD — Concept→Dev Bridge: Checkout Gates, Contract/Test Bench & Governed Swarms

Status: **PRD / FOR-EPICS (2026-06-19)**
Derives from: `implementation-plan.md` (Option A) · `spike-test-results.md` (evidence) ·
`dynamic-workflow-orchestration-concept.md` (the v3 thesis).
Audience: the epics-and-stories workflow. Every FR/NFR has a stable id so stories can map back
(and the new coverage gate can verify nothing is dropped).

---

## 1. Problem & opportunity

The pipeline's concept→development bridge has three measured pathologies:

1. **Plan generation is slow and unchecked.** The single-shot `pm-plan` step takes ~20m / $1.45
   (75% of concept-stage cost) — caused by prompt weight + heavy per-story output + retry, **not**
   orchestration shape. And the emitted plan passes through **no structural validation**: a dropped
   spec, a touchpoint collision, a dependency cycle, or a cross-story contract drift all ship
   silently.
2. **Test/contract authoring lives inside each story pipeline**, front-loading every story and
   creating the **pacman4 deadlock** (a test with a parse error gets frozen as the contract, then
   no actor is allowed to fix it — lint wants the fix, tamper-freeze forbids it).
3. **There is no governed way to fan work out.** As plans grow (real apps, full BMAD rigor),
   parallelism is the only way to scale — but blind parallel agents drift on shared contracts, burn
   ~15× tokens, re-read the same files, and today carry no per-role skill loadout or audit trail.

**Opportunity:** make the bridge **fast, structurally validated, deadlock-free, and governable** —
and lay the rails so parallel swarms (test/contract bench now; planning swarm later) are
token-efficient, skill-aware, and fully auditable.

## 2. Goals & success metrics

| Goal                                       | Metric                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| G1 — Faster plan-gen                       | pm-plan wall-clock + output tokens materially down on a fixed doc set; quality gates stay green                                 |
| G2 — No silent plan defects                | 100% of coverage/acyclicity/conformance violations are caught and recorded before "start development"                           |
| G3 — Deadlock-free contract/test authoring | The pacman4 failure (broken test frozen as contract) cannot recur; injected parse-error test is caught + re-routed pre-freeze   |
| G4 — Governed, efficient swarms            | Every swarm subagent is capability-scoped, skill-loaded by role, and its tokens/model/duration are recovered into the scorecard |
| G5 — Full auditability                     | A single Plan Retrospect bundle shows every gate verdict, agent cost, and subagent telemetry — enough to measure & iterate      |
| G6 — Unattended prototyping                | A plan with the YOLO toggle runs concept→dev end-to-end without human stops, with all auto-approvals recorded                   |

## 3. Evidence basis (non-negotiable grounding)

- Heavy A/B: single-shot 135s/15-stories vs swarm 290.9s/29-stories, **identical AC-throughput**
  (0.54 vs 0.53), swarm **690k tokens** (~15×) → swarm-for-speed unproven; gates valuable
  regardless (`spike-test-results.md` §2c).
- The checkout gates caught a real coverage gap + a drift candidate the single-shot ships blind (§2c).
- A1-stub: a **non-enforced** contract backfires — drift is worse than no contract (§2b).
- A5: per-agent frontmatter capability-strip blocks tools even under `bypassPermissions`.
- B1: subagent telemetry is recoverable only with a stable `stepId` per agent.

## 4. Scope

**In scope (this PRD):** checkout gates + prompt-trim on the single-shot pm-plan; the per-wave
blind+enforced contract/test bench + relocation; token/context optimization for swarms; skill-scout
per-role loadout for swarms; YOLO auto-approve toggle; audit + Plan Retrospect integration;
planning-workflow linter profile.

**Out of scope (deferred / other PRDs):** the planning-decomposition swarm replacing pm-plan (gated
on an EC2 crossover run); cross-vendor critics; multi-host dispatch (v4); the graph-gate
enforcement (soft dependency, advisory until the MCP is live).

## 5. Users

Single-operator factory (Labs, internal). The operator creates plans, optionally enables YOLO,
reviews the Plan Retrospect bundle, and iterates pipeline quality. No multi-tenant concerns.

---

## 6. Functional requirements

### FR-A — Plan checkout gates (deterministic, on the single-shot pm-plan)

- **FR-A1 Coverage gate.** Every PRD functional requirement, UX screen/flow, and architecture
  module/decision id maps to ≥1 plan epic. A dropped spec is a **blocking** violation.
- **FR-A2 Collision gate.** No two stories scheduled in the same wave share a `touchPoint` file.
  **Advisory** (the scheduler already serializes) but always recorded.
- **FR-A3 Acyclicity gate.** The epic `dependsOnEpics` graph and each epic's intra-story
  `dependsOn` graph are acyclic. **Blocking.**
- **FR-A4 Cross-epic conformance gate.** Any domain-type name referenced by ≥2 epics must exist in
  the plan's frozen contract surface (foundation/types story exports). A shared, out-of-surface name
  is **blocking** drift. (Single-epic-internal names are NOT flagged.)
- **FR-A5 Gate posture & override.** Blocking gates halt the concept→dev transition unless YOLO is on
  (FR-F), in which case they auto-pass **and record the violation**. Gates never silently drop a defect.
- **FR-A6 Gate determinism.** All gates are pure functions over the plan JSON — no LLM, repeatable,
  same input → same verdict.

### FR-B — pm-plan prompt slimming

- **FR-B1** Reduce the pm-plan instruction payload (move rarely-decisive guidance to a consulted
  rubric; keep hard rules) without regressing plan quality (gates stay green).
- **FR-B2** Keep the enriched per-story output fields (userStory/technicalNotes/tasks/criteria);
  the target is instruction weight + retry, not the product.
- **FR-B3** Emit `coversSpecIds` per epic so FR-A1 can run on the single-shot output.

### FR-C — Contract & test bench (per-wave, blind, enforced)

- **FR-C1 Relocation.** Remove `api-author` and `test-author` from the per-story pipeline; the story
  pipeline starts at the DEV agent against frozen contracts + tests.
- **FR-C2 Contract freeze (enforced).** An api-author step produces contract stubs; they are frozen
  as the baseline **only after** a typecheck passes on the stubs alone (the A1-stub enforcement).
- **FR-C3 Parallel test authoring.** Tests for a wave's stories are authored in parallel, against the
  **frozen** contracts, one agent per story.
- **FR-C4 Validate-then-freeze (deadlock fix).** Each authored test is validated by a deterministic
  self-gate (parses / typechecks; is RED against the absent impl; covers every AC) **before** being
  frozen as the contract. A test that fails its gate is never frozen.
- **FR-C5 Re-route on failure.** A bench agent whose output fails its gate is **re-spawned with the
  failure as input**, capped (default 2 rounds) with model escalation (sonnet→opus), then routed to
  the operator on exhaustion. Re-routing one agent never disturbs its siblings.
- **FR-C6 Just-in-time per wave.** The bench runs per epic-wave at "start development" time, so a
  later wave's tests author against an earlier wave's already-frozen contracts.
- **FR-C7 Capability scoping.** Each bench agent may write only its one declared file path and has no
  shell/network access (enforced at the agent-definition level, not the permission mode).

### FR-D — Token & context optimization (applies to every swarm)

- **FR-D1 Scout-once brief.** A single scout reads the repo/graph once and emits a compact brief; the
  orchestrator injects it into every worker so subagents do not re-explore the same files.
- **FR-D2 Cache-aligned prompts.** Shared, stable content (system prompt, scout brief, contract
  surface) is placed as an identical prefix across a swarm's subagents to maximize prompt-cache reuse;
  per-agent variable content goes last.
- **FR-D3 Doc/context slicing.** Each subagent receives only the inputs relevant to its unit of work,
  not the full document set.
- **FR-D4 Typed handoffs.** Prior-wave outputs and the contract surface are passed as structured
  arguments injected into prompts, not as "go read the files" instructions.
- **FR-D5 Model tiering.** Cheap roles (scout, classify, inventory) run on the lowest adequate tier;
  authoring on mid; adversarial/gate roles on the highest — within the existing model floors.

### FR-E — Skill-scout for swarms

- **FR-E1 Per-role loadout.** When a swarm spawns a role (test-author, api-author, and future test
  roles), the system resolves and loads that role's relevant skills via skill-scout — not a hardcoded
  set.
- **FR-E2 Dynamic to the growing module.** Loadout resolves against the live skills module so newly
  added skills become available to the matching roles without code changes.
- **FR-E3 Auditable loadout.** The resolved skill loadout per subagent is recorded and surfaced in the
  audit bundle (FR-G).
- **FR-E4 Scoped to role.** A role receives only its pertinent skills (e.g. test roles get
  test-authoring skills), respecting the same capability scoping as FR-C7.

### FR-F — YOLO auto-approve toggle

- **FR-F1** A per-plan flag set at creation that auto-approves every human gate (concept artifact
  approvals, plan approval, the test-bench review gate, and FR-A blocking gates).
- **FR-F2** Auto-approval **records** what it bypassed (especially FR-A violations) so the audit
  bundle reflects every skipped stop.
- **FR-F3** With the flag on, a new plan runs concept→development end-to-end with no human stops.

### FR-G — Auditability & Plan Retrospect integration

- **FR-G1 Gate events.** Every checkout gate and bench gate emits a first-class event
  (stepId/role/status/durationMs) on the same rails as today's shell gates.
- **FR-G2 Subagent telemetry.** Every swarm/bench subagent carries a stable `stepId`; a harvester
  recovers each subagent's model/tokens/duration and writes it as an event mapped to its plan/story.
- **FR-G3 Plan-row gate summary.** Gate verdicts persist on the plan row (parallel to the existing
  QA-contract status field).
- **FR-G4 Retrospect detector + bundle.** A new scorecard detector surfaces each gate verdict; the
  Plan Retrospect bundled JSON gains a checkout-gates rollup. The operator can paste the bundle and
  see every gate, agent cost, subagent telemetry, and skill loadout.
- **FR-G5 Cost reconciliation.** The overview cost-reconciliation includes harvested subagent spend
  so totals stay honest at fan-out.

### FR-H — Planning-workflow linter profile

- **FR-H1** The workflow linter supports a planning-workflow profile where structural "verification"
  is the checkout gate and "checkpoint" is the orchestrator persisting the plan — so a planning
  workflow lints clean without faking a code-verification role.

### FR-I — Deferred: planning-decomposition swarm (conditional)

- **FR-I1** The planning swarm replaces the single-shot pm-plan **only if** an envelope-matched run on
  the multi-core daemon host demonstrates a wall-clock crossover at production rigor. Until then the
  checkout gates (FR-A) run on the single-shot. (Instrument already built.)

---

## 7. Non-functional requirements

- **NFR-1 Determinism.** Gates and assembly are deterministic; agent non-determinism is bounded by
  deterministic gates + capped re-routing.
- **NFR-2 Ephemeral-state safety.** Swarm/bench runs are sized per-wave so they complete within a
  session; nothing load-bearing depends on cross-session workflow resume. Durable record stays in
  DDB/git.
- **NFR-3 Undocumented-API isolation.** All workflow-runtime coupling (primitives, transcript paths
  for the harvester) sits behind one adapter; re-validated on CLI bumps.
- **NFR-4 Deploy safety.** No change touches the public-bucket scoped paths; `out/` never syncs to
  `futurator-ai-website` (CLAUDE.md).
- **NFR-5 Throughput, not cost.** Optimization targets rate-limit headroom / latency under the flat
  Max subscription, not per-token dollars.
- **NFR-6 Backward compatibility.** The existing v2.5 pipeline keeps running; changes are additive to
  the concept→dev bridge and the per-story pipeline's entry point.

## 8. Dependencies

- **Harvester** (FR-G2) couples to workflow transcript layout (NFR-3).
- **Skills module** (FR-E) — the live, growing skill set + skill-scout.
- **Graph MCP** (soft) — improves the scout brief (FR-D1) when available; glob/grep fallback otherwise.
- **Scorecard / forensic layer** (FR-G) — existing detectors, event/timer rails, retrospect bundle.

## 9. Risks

- **R1 Coverage gate needs spec-ids** from the single-shot (FR-B3) — low risk, schema addition.
- **R2 Harvester drift** on CLI updates (NFR-3) — isolate + tripwire.
- **R3 Bench per-wave latency** — must net-positive vs the removed per-story test-author; measure.
- **R4 YOLO hiding defects** — mitigated by FR-F2 (record every bypass).
- **R5 Skill over-loading** inflates tokens (works against FR-D) — scope loadout tightly (FR-E4).

## 10. Acceptance (ties to metrics)

- G1: pm-plan wall-clock/output-tokens measurably reduced on the Pac-Man doc set, gates green.
- G2: a plan with an intentionally dropped spec / cycle / shared-name drift is **blocked or recorded**
  by FR-A; verified by re-running a known-defective plan.
- G3: injecting the `pac-man's` parse-error into a bench test → caught + re-routed pre-freeze; the
  story pipeline never receives a broken frozen test.
- G4: every swarm subagent appears in the bundle with skill loadout + model/tokens/duration.
- G5: the Plan Retrospect bundle contains a checkout-gates section + reconciled subagent spend.
- G6: a YOLO plan completes concept→dev unattended with all bypasses recorded.

## 11. Open questions for architecture/epics

1. Where does the scout brief (FR-D1) source from — graph MCP, a Glob/grep scout, or both with
   fallback — and how is it cache-keyed (FR-D2)?
2. Bench orchestration unit: one workflow per epic-wave vs one per plan-start; resume/death behavior
   (NFR-2).
3. Skill-scout resolution surface for swarm roles (FR-E1): custom-agent frontmatter pinning vs
   orchestrator-injected loadout — which, and where the role→skills mapping lives.
4. Harvester delivery: daemon component vs Lambda post-processing; exact transcript-path adapter
   (NFR-3, FR-G2).
5. Checkout gate location: inside `applyPlanOutput` vs a dedicated post-plan job that emits its own
   events (FR-G1).
6. The crossover experiment design that would unlock FR-I1 (envelope-matched, host, story-count sweep).
