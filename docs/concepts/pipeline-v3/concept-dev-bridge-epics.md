# Epics & Stories — Concept→Dev Bridge

Status: **EPICS / FOR-BUILD (2026-06-19)** · shards `concept-dev-bridge-prd.md`.
Every story tags the FR id it satisfies (so coverage holds) + touchPoints (file:line targets from
`implementation-plan.md`) + ACs. Sized ~1–3h of agent time each.

> **Build prerequisite (not a story):** rebase the build branch onto `main` first — main has the
> pacman4 lint↔tamper deadlock fix (`5f497c0`) that Epic E4 builds on. The current
> `feat/v3-spike-test-plan` branch carries mixed multi-agent work + duplicates already on main;
> cut the build from a fresh branch off `main`, not from this doc branch.

## Epic map & dependency waves

| Epic   | Title                              | FRs         | Depends on               | Wave  |
| ------ | ---------------------------------- | ----------- | ------------------------ | ----- |
| **E1** | Plan checkout gates                | FR-A, FR-B3 | —                        | 0     |
| **E2** | pm-plan prompt slimming            | FR-B1/B2    | —                        | 0     |
| **E3** | Audit & Retrospect integration     | FR-G, FR-H  | E1                       | 1     |
| **E4** | Contract & test bench              | FR-C        | E3 (+ main deadlock fix) | 2     |
| **E5** | Swarm token/context optimization   | FR-D        | E4                       | 3     |
| **E6** | Skill-scout for swarms             | FR-E        | E4                       | 3     |
| **E7** | YOLO auto-approve toggle           | FR-F        | E1                       | 1     |
| **E8** | Deferred: planning-swarm crossover | FR-I        | E5, E6                   | spike |

E1/E2 are wave 0 (independent, both touch plan-gen but disjoint files). E3 and E7 depend on E1's
gate output. E4 is the downstream spine. E5/E6 harden E4's swarm. E8 is a gated spike, not a build.

---

## E1 — Plan checkout gates (FR-A, FR-B3)

**Goal:** no structurally-defective plan reaches "start development" unseen; every verdict recorded.
**Depends on:** none.

- **E1-S1 — Emit `coversSpecIds` per epic (FR-B3).** Add `coversSpecIds` to the pm-plan output schema
  - prompt instruction; persist on the epic row.
  * Touch: `functions/shared/prompts/pm-plan-prompt.ts`, `functions/shared/types/epic-workflow.ts`,
    `functions/shared/services/plan-generation-service.ts`.
  * AC: every emitted epic carries a non-empty `coversSpecIds`; existing plans without it default safely.
- **E1-S2 — Coverage + acyclicity gates (FR-A1, FR-A3, FR-A6).** Pure functions over plan JSON
  (port `acyclic.py` logic to TS); coverage maps every PRD-FR/UX-screen/arch-id to ≥1 epic.
  - Touch: new `functions/shared/services/checkout-gates.ts`; call site in
    `plan-generation-service.ts:applyPlanOutput` (~L356, beside `computePlanWaves`).
  - AC: a plan with a dropped spec → coverage FAIL; a plan with an epic/story cycle → acyclicity FAIL;
    same input → same verdict (deterministic).
- **E1-S3 — Collision + cross-epic conformance gates (FR-A2, FR-A4).** Collision over same-wave
  touchPoints (reuse `computeStoryWavesWithTouchPoints` ~L280); conformance flags a ≥2-epic name
  absent from the contract surface (port `conformance.py` corrected threshold).
  - Touch: `checkout-gates.ts`.
  - AC: two same-wave stories sharing a file → collision recorded (advisory); a shared out-of-surface
    type name → conformance FAIL; a single-epic-internal name → NOT flagged.
- **E1-S4 — Gate posture + plan-row persistence (FR-A5, FR-G3).** Blocking gates halt concept→dev
  (unless YOLO, E7); persist `plan.checkoutGates` (mirror `qaContractStatus`, `plan.ts:299-324`).
  - Touch: `functions/shared/types/plan.ts`, `functions/shared/repositories/plan-repository.ts`
    (`updatePlanFields` L72-100), the concept→dev transition.
  - AC: a blocking violation prevents the transition and is stored on the plan row with reasons.

## E2 — pm-plan prompt slimming (FR-B1, FR-B2)

**Goal:** cut pm-plan wall-clock + output tokens without regressing plan quality.
**Depends on:** none.

- **E2-S1 — Extract rarely-decisive guidance to a consulted rubric.** Move the anti-pattern essays
  (`pm-plan-prompt.ts:262-311`) + visual-coverage essay (`:428-486`) to a linked rubric; keep hard
  rules (parallelism `:194-216`, touch-points `:294-311`, output format `:494-526`).
  - AC: prompt instruction tokens materially reduced; the E1 gates stay green on the Pac-Man docs.
- **E2-S2 — Measure before/after.** Capture pm-plan wall-clock + output tokens on the fixed Pac-Man
  doc set, pre/post trim.
  - Touch: reuse `spikes/v3-hybrid/probes/E1-plan-swarm/` harness.
  - AC: a recorded delta (G1) with gates green; no per-story field dropped (FR-B2).

## E3 — Audit & Retrospect integration (FR-G, FR-H)

**Goal:** every gate/agent/subagent is a replayable event surfaced in one Plan Retrospect bundle.
**Depends on:** E1 (gate events to surface).

- **E3-S1 — `__gate__` events (FR-G1).** Checkout/bench gates emit step_start/step_complete via
  `pushEvent` (`agent-daemon.mjs:641-671`, mirror `executeShellStep` `:1699-1956`); add the new
  stepIds to the step→category map (`timer/step-category-map.ts:26-68`; fix the `lint-verify` gap).
  - AC: each gate appears as an AgentEvent → TimerSlice with stepId + durationMs.
- **E3-S2 — Subagent telemetry harvester (FR-G2, FR-G5).** Ship the B1 harvester
  (`probes/B1-harvester/harvest.mjs`) as a daemon component: on workflow completion, scrape
  `subagents/workflows/<runId>/{journal,agent-*}.jsonl` → one AgentEvent per subagent
  (role `__subagent__`, stepId, model, tokens, derived durationMs); behind a path adapter (NFR-3).
  - AC: every swarm subagent yields an event mapped to its plan/story; OV4 cost-reconciliation
    (`detectors/overview.ts:1-23`) includes harvested spend.
- **E3-S3 — `scoreCheckouts` detector + bundle key (FR-G4).** New detector in the `DETECTORS` array
  (`scorecard/index.ts:196-206`) reading `plan.checkoutGates`; add a `checkoutGates` rollup to
  `RealityCheck` (`compose.ts:86-113`); served by `GET /api/plans/:id/scorecard` (`index.ts:12789`).
  - AC: pasting the bundle shows every gate verdict + agent cost + subagent telemetry + (E6) skill loadout.
- **E3-S4 — Planning-workflow linter profile (FR-H).** Add `@workflow-kind: planning` to
  `workflow-lint.mjs` where verification=checkout gate, checkpoint=plan persistence.
  - AC: a planning workflow lints clean without a fake `compile-gate` role.

## E4 — Contract & test bench (FR-C)

**Goal:** blind, enforced, deadlock-free contract+test authoring before dev; dev starts at DEV.
**Depends on:** E3; main's deadlock fix `5f497c0`.

- **E4-S1 — Relocate api/test-author out of story-pipeline (FR-C1).** Remove `api-author` (step L317,
  role L260) + `test-author` (step L341, role L249) from `functions/shared/pipelines/story-pipeline.ts`;
  story pipeline starts at `dev` (L640).
  - AC: a story job runs DEV-first against pre-existing contracts+tests; no per-story test-author.
- **E4-S2 — api-author swarm + enforced contract freeze (FR-C2).** Parallel contract-stub authoring;
  freeze as baseline only after `tsc` passes on stubs alone.
  - AC: a stub that fails typecheck is not frozen; the A1-stub backfire cannot occur.
- **E4-S3 — Parallel test authoring + validate-then-freeze (FR-C3, FR-C4).** One agent per story
  against frozen contracts; deterministic self-gate (parses/typechecks, RED vs absent impl, covers
  every AC) before freeze.
  - AC: a test failing its self-gate is never frozen; a passing test set becomes the SHA baseline.
- **E4-S4 — Capped re-route (FR-C5).** Re-spawn a failing bench agent with the error (cap 2, escalate
  sonnet→opus, operator on exhaustion); siblings untouched. Reuse `probes/C1-fixswarm/`.
  - AC: **inject the `pac-man's` parse-error** into a bench test → caught + re-routed pre-freeze; the
    story pipeline never receives a broken frozen test (G3 — the pacman4 regression test).
- **E4-S5 — Just-in-time per-wave + capability scoping (FR-C6, FR-C7).** Bench runs per epic-wave at
  `start` (`index.ts:2796-2950`, before `launchPipelineWave`); each agent writes only its declared
  path, no shell/network (custom-agent frontmatter, A5).
  - AC: wave N+1 tests author against wave N frozen contracts; a bench agent cannot run Bash.

## E5 — Swarm token/context optimization (FR-D)

**Goal:** swarms stay within rate-limit headroom; no redundant re-reads.
**Depends on:** E4.

- **E5-S1 — Scout-once brief (FR-D1).** One scout emits a compact repo/graph brief injected into all
  workers; kills double-Explore.
  - AC: bench/swarm workers receive the brief; no worker re-runs Explore on the same root.
- **E5-S2 — Cache-aligned prompts + slicing + typed handoffs (FR-D2/D3/D4).** Stable shared prefix
  (system+brief+contract surface) first, per-agent content last; each agent gets only its slice;
  prior-wave outputs passed as structured args.
  - AC: harvested `cache_read` token share rises vs an unaligned baseline; per-agent input shrinks.
- **E5-S3 — Model tiering (FR-D5).** Scout/classify on lowest tier, authoring mid, gate/refute high,
  within model floors.
  - AC: role→tier map applied; gate roles never below sonnet.

## E6 — Skill-scout for swarms (FR-E)

**Goal:** each swarm role gets its pertinent skills, dynamically, auditably.
**Depends on:** E4.

- **E6-S1 — Per-role dynamic loadout (FR-E1, FR-E2).** Resolve skills for a swarm role (test-author,
  api-author, future test roles) via skill-scout against the live skills module.
  - AC: adding a new test skill makes it available to test roles without code change.
- **E6-S2 — Scoped + auditable loadout (FR-E3, FR-E4).** A role gets only its skills; the resolved
  loadout per subagent is recorded and surfaced in the bundle (E3-S3).
  - AC: the bundle shows each subagent's skill loadout; a test role does not receive unrelated skills.

## E7 — YOLO auto-approve toggle (FR-F)

**Goal:** unattended concept→dev runs with every bypass recorded.
**Depends on:** E1.

- **E7-S1 — `plan.autoApproveGates` flag + threading (FR-F1).** Set at creation; auto-approve concept
  artifact approvals (`concept-driver.ts:124-229`), plan approval, the test-bench review gate, and
  E1 blocking gates.
  - Touch: `plan.ts`, plan-create API, `concept-driver.ts`, the gate posture from E1-S4.
  - AC: a YOLO plan never stops for a human gate.
- **E7-S2 — Record every bypass (FR-F2, FR-F3).** Auto-approval stamps what it bypassed (esp. E1
  violations) into `plan.checkoutGates` + events.
  - AC: a YOLO run with a known coverage gap completes, and the bundle shows the gap was
    auto-approved (G6) — never silently dropped.

## E8 — Deferred spike: planning-swarm crossover (FR-I)

**Goal:** decide whether the planning swarm replaces the single-shot pm-plan.
**Depends on:** E5, E6. **Not a build epic until the spike unlocks it.**

- **E8-S1 — Envelope-matched EC2 crossover run.** Same frozen plan size, swarm-with-slicing vs
  single-shot, on the multi-core daemon host; sweep story counts. Reuse `run-heavy.sh`.
  - AC: a recorded crossover point (story-count where swarm wall-clock < single-shot). If none, FR-I
    stays deferred and the checkout gates remain on the single-shot.

---

## Coverage check (PRD → epics)

FR-A→E1 · FR-B→E1-S1+E2 · FR-C→E4 · FR-D→E5 · FR-E→E6 · FR-F→E7 · FR-G→E3 · FR-H→E3-S4 · FR-I→E8.
NFRs are cross-cutting acceptance constraints on every epic (determinism, ephemeral-state safety,
undocumented-API isolation, deploy safety, throughput-not-cost, backward-compat).
