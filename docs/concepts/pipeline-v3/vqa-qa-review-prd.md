# PRD — VQA + QA-Review v3: Behavioral Probes, Deterministic Seam & the Closed Fix Loop

**Status:** v1.2 — PRD for development, FINAL / merge-ready (adversarial-stress-hardened + cross-session locked, 2026-06-16). **§11 Hardening OVERRIDES any earlier section it touches; §11.1 is the canonical epic list for epic/story generation.**
**Author:** Ricardo (with Claude + agent panel)
**Design source:** `docs/concepts/pipeline-v3/vqa-qa-review-redesign.md` (v0.4) — this PRD is the _requirements/epics_ extraction of that design; the design doc holds the rationale, the disease analysis, and the file:line evidence map.
**Sister PRD:** `docs/concepts/pipeline-v3/concept-stage-v2-bmad.md` (v0.6) — owns the PM role + plan/AC schema. **Cross-session coordination rounds 1–3 CLOSED** (round 3 = the Concept v0.6 stress-test handoff: W5/W2/W9 + `manualReason`, absorbed in §11 H12). The two PRDs meet at the **acceptance criterion** and are designed to merge into one epic-story plan.
**Scope:** the Developing-stage **wave-gate VQA** and the **QA Review** stage — test authoring, execution, observation, level-setting, and the agentic fix loop. **Not** the Concept stage (sister PRD) and **not** Deploy.

---

## 1. Problem & goal

**Problem (the disease).** Today a QA verdict = _an LLM judging a single static idle screenshot against a prose AC_ (`daemon/lib/wave-vqa-runner.mjs:173-175`). That primitive cannot observe behavior, time, or interaction; it uses a probabilistic oracle for deterministic truths; and authorship is split across three agents with no owner of "is this reachable + observable." Symptoms: `UNVERIFIABLE` verdicts, interaction-gated false-negatives (pacman1 E7), preview/assembly drift (E4), and **L2 "interaction flows" defined but empty**.

**Goal.** Re-found the test as a **probe (reach → act → observe over controlled time)** whose oracle is **deterministic-first (read app state), vision-second (judge the right frame), human-last (operator lane)** — generic across all app types (web / form / dashboard / mobile / human-in-the-loop), so Playwright tests actually _inspect_ behavior and the agentic fix loop can _close_.

**Non-goals (this PRD).** Concept-stage planning; agentic exploratory testing (L3); real-native mobile driver; pixel-baseline diffing; deploy/runtime monitoring.

---

## 2. Success metrics

| Metric                                                                             | Today (baseline)           | Target                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Interaction-gated `UNVERIFIABLE` rate (browser ACs)                                | high (E7 class)            | → ~0 for state/behavior ACs with a seam                                                                |
| Behavior _logic_ verified deterministically (where a seam exists)                  | ~0 (L2 empty)              | covered — but **always paired with an appearance check**, never maximized at vision's expense (§11 H3) |
| Shipped renders contradicted by their own state (right state, broken/invisible UI) | unmeasured                 | **zero** — sampled vision audit of L2-state passes finds no appearance defect (§11 H1, H3)             |
| False-green on a flaky/self-certified pass                                         | unmeasured                 | **zero** — seam tamper-checked + flake-guarded closure (§11 H1, H2)                                    |
| Fix-loop closure on a deterministic exit gate                                      | none (judged ≠ closable)   | auto-close on re-run of the failing probe                                                              |
| Vision-judge spend per browser AC                                                  | ~$0.005–0.1 each, every AC | only appearance + ambiguous behavior                                                                   |
| App-type coverage                                                                  | game-centric               | game + form + dashboard + mobile(web) + chat                                                           |
| Silent false-pass at wrong level                                                   | seen (spyhunter-1: 26 ACs) | 0 (needsBrowser floor + coverage check)                                                                |

---

## 3. Functional requirements

**Probe model & interaction grammar**

- **FR-1** A visual test is a **probe** (`reach → act → observe`) executed by a **driver-abstracted** runner (Playwright today). Games/keyboard are one instance.
- **FR-2** The action grammar supports: `navigate, click, fill, select, drag, press, hold, tap, pointer{x,y}, wait, clock, screenshot, assert, seed`. (Today only `navigate|click|wait|screenshot|fill` exist — `epic-workflow.ts:106-119`.)
- **FR-3** Time-dependent probes use `page.clock` (install/fastForward/runFor), not wall-clock `--wait-for-timeout`.
- **FR-4** A **state oracle** (`assert` step) reads `window.__harness.snapshot()` / `events` via `page.evaluate` and compares with an operator (`eq/neq/gt/contains/truthy/...`).
- **FR-5** Vision-judge prompts must reflect that frames are captured **after** the declared interactions (fix the stale "flow NOT executed / idle" note — `visual-qa-pipeline.ts:719, :819`).

**Verifiability seam**

- **FR-6** `BoilerplateRuntimeContract` gains a `testHarness` block: `{ globalKey, readySignal, snapshotShape, stubs }` (`functions/shared/boilerplates/registry.ts`).
- **FR-7** Each UI-bearing boilerplate ships a **default, domain-specific** `window.__harness` (game→`{gameState,score,lives,entities,gameOver}`; form→`{fields,errors,submitted}`; dashboard→`{data,filters,selectedRange}`; chat→`{messages,pendingTurn,consentState}`); DEV populates it.
- **FR-8** The seam is **test-only** (no-op / tree-shaken in production builds).

**Levels & routing**

- **FR-9** **L0** = deterministic liveness (bash: 200 / console+pageerror clean / non-blank / expected text). _(keep)_
- **FR-10** **L1** = appearance vision-judge of a single frame, fed the correct surface/state. _(keep, fix frame)_
- **FR-11** **L2** has two oracle modes: **L2-state** (deterministic seam read) and **L2-vision** (judge a post-interaction frame).
- **FR-12** The `rigor` cap gates **vision tiers only** (L1 / L2-vision / L3). **L0 and L2-state are rigor-exempt** (deterministic = free). (Split the cap at `visual-test-classifier.ts:123-127`.)
- **FR-13** The concrete L-level is **derived** (`build→L0 · appearance→L1 · state→L2-state if seam else L1-vision · behavior→L2 · manual→operator-lane`), then classifier-defaulted and operator-overridable at the ContractGate.

**Authorship & level-setting**

- **FR-14** A **QA-AUTHOR** persona owns **both** code tests and interaction probes, authored at **story-dev start (TDD red)**, compiling probes from the PM's BDD ACs.
- **FR-15** Probes consume the PM-set `verify` intent. `needsBrowser` is **derived** for `appearance|state|behavior` (`build→false`) and **kept independent for `manual`**.
- **FR-16** **Coverage check:** every `verify ∈ {appearance,state,behavior}` AC has ≥1 probe linked by `criteriaRef`; a gap fails the aggregate gate.
- **FR-17** Probe runner, capture, seam-location, stubs, and judge prompts read `BOILERPLATE_REGISTRY[type]` + the runtime contract — **no hardcoded entry points** (no recurrence of forensic problem #4).

**The closed agentic fix loop**

- **FR-18** Triage classifies failures as `code-bug | reach-wrong | ac-wording | environment` and routes to the right author (code→DEV; reach→QA-AUTHOR; wording→PM/operator; env→infra).
- **FR-19** The loop's **exit gate re-runs the exact failing probe**; a deterministic (L2-state) pass closes it. Vision failures route to `ac-wording`/operator, never an unbounded loop.
- **FR-20** The loop is **bounded** (round cap by rigor + plan `costCeilingUsd`); on exhaustion → fix-forward → one auto-minted fix story → operator card with the handoff packet.
- **FR-21** **Block green** on deterministic failures (L0, L2-state, boot/build/test). **Never block** on vision (L1/L2-vision).
- **FR-22** Each confirmed-fixed deterministic failure emits `story.vqa.fix` with the **seam delta** (before/after `snapshot()` + diff) into the reflection inbox. _(Correction v1.1: `reflector-apply.mjs` is a working on-disk applier, NOT a stub — the real gap is it has no `story.vqa.fix` target in its switch. See §11 H5.)_

**One engine, two checkpoints**

- **FR-23** A single **probe-runner library** + one verdict vocabulary serve both checkpoints.
- **FR-24** **Wave-gate VQA gains interaction** (no longer idle-only); QA Review runs the full tier on the merged assembly.
- **FR-25** The claims table / evidence drawer / gate arc render the richer payloads (state snapshots + frame sequences) without UI redesign.

**Human-in-the-loop & generality**

- **FR-26** `verify:'manual'` routes to an **operator verification lane** in QA Review: a checklist the operator confirms; **never auto-passed, never silently failed; blocks ship until confirmed**.
- **FR-27** **Test-mode boundary seams** (scripted chat partner, OAuth token, Stripe test keys, mock inbox, captcha test keys) convert external/human boundaries into deterministic L2-state probes; cited via `references[].source:'harness'`. No stub possible → fall back to `manual`.
- **FR-28** **No exact-match oracle for generative/LLM content** — assert structural invariants (L2-state) + semantic adequacy (L2-vision, non-blocking).
- **FR-29** **Driver abstraction:** web via Playwright; mobile via Expo-web target + device emulation (layout/flow only). Real-native (Appium/Maestro) deferred → native-only ACs are `manual`.

---

## 4. Non-functional requirements

- **NFR-1 Determinism.** Deterministic oracles (L0, L2-state) must be flake-free and reproducible — the fix loop depends on it. No `waitForTimeout` for synchronization.
- **NFR-2 Cost.** Honor per-level budgets (`QA_LEVEL_DEFAULTS`, `visual-qa-pipeline.ts:180-192`) and the plan `costCeilingUsd`; deterministic tiers add ~$0.
- **NFR-3 Backward compatibility.** All new schema fields optional; legacy `text` ACs and seam-less apps degrade gracefully (no-seam → L1-vision/`manual`).
- **NFR-4 Prototype purity.** Deterministic tiers still run at `prototype`; no new artifacts/latency on the throwaway path beyond the probe itself.
- **NFR-5 No hardcoding.** Key off `touchPoints` + boilerplate contract + `rigor`; no app/domain keyword hardcoding.
- **NFR-6 Context-pack determinism.** New fields serialized in fixed order, sorted, byte-identical across roles (`story-context-pack.mjs`), within the 30k-token cap.
- **NFR-7 bash-first.** Only judgment uses an LLM; capture/boot/state-read/file-checks stay bash/`page.evaluate`.

---

## 5. Epics, stories & acceptance criteria

> ACs are written in the project's `given/when/then` + `verify` form (dogfooding the model). Most are `verify:build` (typecheck/unit) or `verify:behavior` (integration/probe) — this PRD builds the QA system, so few are browser-visible.

### Epic E1 — Interaction grammar & deterministic time (realize L2 driving)

_Cures organ #1 (weak observation). No Concept dependency. Touch: `epic-workflow.ts:106-119`, `visual-qa-pipeline.ts:146-167, :553-573, :719, :819`._

- **E1-S1 — Extend the action grammar.** Add `press, hold, tap, pointer, clock, select, drag, assert, seed` to `ProbeStep.action` + fields (`key, x, y, ms, expr, op, expected`).
  - AC1 `verify:build` — _GIVEN the type union, WHEN a probe step uses `action:'press'` with `key:'Space'`, THEN it typechecks and the Zod parser accepts it._
  - AC2 `verify:build` — _GIVEN legacy specs, WHEN parsed, THEN existing `navigate|click|wait|screenshot|fill` still validate (back-compat)._
- **E1-S2 — Interpreter executes the new actions.** Extend `runFlow` to dispatch `press→keyboard.press`, `pointer→mouse.click(x,y)`, `clock→page.clock`, etc.
  - AC1 `verify:behavior` — _GIVEN a game route, WHEN a probe runs `press Space → wait → screenshot`, THEN the captured frame shows the post-press state (integration test)._
  - AC2 `verify:behavior` — _GIVEN a `clock` step of 5000ms, WHEN run, THEN time-dependent UI advances deterministically without real waiting._
- **E1-S3 — Document the grammar to authors.** Add a worked `flow:` example to the DEV/QA-AUTHOR prompt.
  - AC1 `verify:build` — _GIVEN the prompt template, WHEN rendered, THEN it contains a multi-step `press/click/wait/assert` example._
- **E1-S4 — Un-stale the judge prompts.** For probes with an `act` phase, the vision-judge prompt states frames are post-interaction and MAY FAIL on dynamic state.
  - AC1 `verify:behavior` — _GIVEN an interacted probe, WHEN the L2-vision judge runs, THEN it is not told "idle/flow not executed" and can FAIL a contradicted post-action frame._

### Epic E2 — Verifiability seam & L2-state oracle

_Cures organ #2 (wrong oracle). Touch: `boilerplates/registry.ts`, `visual-test-classifier.ts:123-127, :174-254`, new runner `assert`._

- **E2-S1 — `testHarness` contract.** Add the block to `BoilerplateRuntimeContract` + per-boilerplate `snapshotShape`.
  - AC1 `verify:build` — _GIVEN the registry, WHEN a UI-bearing boilerplate is read, THEN it exposes a `testHarness` with `globalKey/readySignal/snapshotShape`._
- **E2-S2 — Ship default `__harness` in scaffolds.** canvas-game + form-app + dashboard defaults; test-only.
  - AC1 `verify:state` — _GIVEN a scaffolded app in test mode, WHEN loaded, THEN `window.__harness.ready` becomes true and `snapshot()` returns the domain shape._
  - AC2 `verify:build` — _GIVEN a production build, WHEN inspected, THEN `__harness` is absent/no-op._
- **E2-S3 — L2-state `assert` oracle.** Runner evaluates `expr` against the seam; deterministic verdict.
  - AC1 `verify:behavior` — _GIVEN a collision/submit/filter event, WHEN the `assert` step reads the seam, THEN it yields deterministic PASS/FAIL with no LLM call._
- **E2-S4 — Re-tier levels + split the rigor cap.** L2-state vs L2-vision; rigor caps vision tiers only.
  - AC1 `verify:build` — _GIVEN `rigor:'prototype'` and a state AC with a seam, WHEN classified, THEN it routes to L2-state (NOT capped to L0)._
  - AC2 `verify:build` — _GIVEN an appearance AC at `prototype`, WHEN classified, THEN the vision tier is still rigor-capped._

### Epic E3 — One probe engine, two checkpoints

_Cures the two-system drift. Touch: `daemon/lib/wave-vqa-runner.mjs`, `functions/shared/pipelines/visual-qa-pipeline.ts`, `qa-report.ts:80-86`._

- **E3-S1 — Extract the probe-runner library.** Single module used by wave-gate + QA Review.
  - AC1 `verify:build` — _GIVEN both checkpoints, WHEN they execute probes, THEN they call the same runner + one verdict vocabulary._
- **E3-S2 — Wave-gate VQA gains interaction.** Evidence path drives `reach→act` before capture instead of idle-only.
  - AC1 `verify:behavior` — _GIVEN a behavior AC at the wave gate, WHEN evaluated, THEN the probe reaches the state and verifies it (no automatic `UNVERIFIABLE`)._
- **E3-S3 — Render richer evidence.** Claims table / drawer show state snapshots + frame sequences.
  - AC1 `verify:appearance` — _GIVEN a probe with a snapshot+frames, WHEN the evidence drawer opens, THEN it shows the state delta and the frame sequence._

### Epic E4 — Authorship & agentic level-setting

_Cures organ #3 (decoupled authoring). **Depends on Concept E (verify intent + BDD).** Touch: `story-pipeline.ts:333, :631-704`, `story-context-pack.mjs`._

- **E4-S1 — QA-AUTHOR owns probes.** Consolidate code-test + visual-probe authorship under one persona at story-dev start.
  - AC1 `verify:behavior` — _GIVEN a story with BDD ACs, WHEN the QA-AUTHOR runs, THEN it emits probes (reach/act/observe) linked by `criteriaRef`._
- **E4-S2 — Derive the L-level from `verify`.** Including `needsBrowser` independence for `manual`.
  - AC1 `verify:build` — _GIVEN `verify:'state'` + a seam, WHEN derived, THEN level=L2-state; GIVEN `verify:'manual'`, THEN `needsBrowser` is not force-derived._
- **E4-S3 — Coverage check.** Aggregate gate fails on any auto-verifiable AC with no probe.
  - AC1 `verify:behavior` — _GIVEN an `appearance/state/behavior` AC with no probe, WHEN qa-aggregate runs, THEN the gate reports the coverage gap._

### Epic E5 — The closed agentic fix loop

_Makes "fix until tests pass" real. Touch: `wave-vqa-runner.mjs` triage/fixer, `agent-daemon.mjs:5611-5658`, reflection inbox._

- **E5-S1 — `reach-wrong` triage + routing.** Add the class; route to the right author.
  - AC1 `verify:behavior` — _GIVEN a probe that drove the wrong path, WHEN triaged, THEN it is classed `reach-wrong` and routed to the QA-AUTHOR, not the DEV fixer._
- **E5-S2 — Deterministic exit gate.** Re-run the exact failing probe; close on L2-state pass.
  - AC1 `verify:behavior` — _GIVEN a fixed L2-state failure, WHEN the loop re-runs the probe, THEN a deterministic pass closes the loop._
- **E5-S3 — Bounded escalation + blocking policy.** Round cap + cost ceiling; deterministic blocks green, vision never does.
  - AC1 `verify:behavior` — _GIVEN exhausted rounds, WHEN the loop ends, THEN it fix-forwards + mints one fix story + an operator card; GIVEN a vision FAIL, THEN green is not blocked._
- **E5-S4 — Reflector seam-delta capture.** Emit `story.vqa.fix` with before/after snapshot + diff.
  - AC1 `verify:behavior` — _GIVEN a confirmed-fixed deterministic failure, WHEN it resolves, THEN a reflection row is written with the seam delta._

### Epic E6 — Human-in-the-loop & platform generality

_Covers the unautomatable class + all app types. **Depends on Concept (verify:'manual').** Touch: QA Review UI, runtime contract stubs, driver abstraction._

- **E6-S1 — `verify:'manual'` operator lane.** Checklist surface in QA Review; blocks ship until confirmed.
  - AC1 `verify:manual` — _GIVEN a `manual` AC, WHEN QA Review renders, THEN it appears in the operator verification lane and ship is blocked until confirmed._
  - AC2 `verify:build` — _GIVEN a `manual` AC, WHEN the auto-pipeline runs, THEN it is neither auto-passed nor auto-failed._
- **E6-S2 — Test-mode boundary seams.** Declare stubs in the contract; cite via `source:'harness'`.
  - AC1 `verify:behavior` — _GIVEN an OAuth/payment/chat-partner boundary with a declared test-mode stub, WHEN a probe runs, THEN the boundary is stubbed and the behavior is verified deterministically._
- **E6-S3 — Generative-content rule.** Forbid exact-match; assert structure + judged semantics.
  - AC1 `verify:behavior` — _GIVEN a chat AC over LLM output, WHEN verified, THEN it asserts a structural invariant (e.g. assistant message appended) and a non-blocking semantic judgment, never an exact string._
- **E6-S4 — Mobile driver path.** Expo-web emulation; native-only → `manual`.
  - AC1 `verify:behavior` — _GIVEN a mobile(Expo) app, WHEN a probe runs, THEN it drives the Expo-web target under device emulation; native-only ACs are tagged `manual`._

---

## 6. Dependencies & sequencing

**Build order** (smallest proving loop first): **E1 → E2 → E3 → E4 → E5 → E6**.

- **E1, E2, E3** have **no Concept dependency** — landable immediately (substrate).
- **E4, E6** depend on the **Concept PRD** delivering `AcceptanceCriterion.{verify, given/when/then, thenObservable}` + `references[].source:'harness'` + the `verify:'manual'` enum value.
- **Cross-PRD "ship-together" pair:** VQA **E1** (interaction grammar) + Concept **Slice 1** (verify + BDD in schema/pack) — the probe-from-AC payoff only appears once both land.
- **Coordination resolved (rounds 1 & 2):** verify-intent altitude, idle-visible relaxation, rigor exemption, harness citation, `verify:'manual'` (PM-knowable / QA-routes-ambiguous; Concept gate-check challenges, QA Review enforces). See redesign §9.

---

## 7. Traceability

| FR        | Epic | Disease organ cured | Primary touch point                                                   |
| --------- | ---- | ------------------- | --------------------------------------------------------------------- |
| FR-1..5   | E1   | #1 observation      | `epic-workflow.ts:106-119`, `visual-qa-pipeline.ts:553-573,:719,:819` |
| FR-6..8   | E2   | #2 oracle           | `boilerplates/registry.ts`                                            |
| FR-9..13  | E2   | #2 oracle           | `visual-test-classifier.ts:123-127,:174-254`                          |
| FR-23..25 | E3   | two-system drift    | `wave-vqa-runner.mjs`, `visual-qa-pipeline.ts`, `qa-report.ts:80-86`  |
| FR-14..17 | E4   | #3 authoring        | `story-pipeline.ts:333,:631-704`, `story-context-pack.mjs`            |
| FR-18..22 | E5   | fix-loop closure    | `wave-vqa-runner.mjs`, `agent-daemon.mjs:5611-5658`                   |
| FR-26..29 | E6   | generality + HITL   | QA Review UI, runtime contract, driver abstraction                    |

---

## 8. Out of scope / deferred

- **L3 agentic exploratory testing** (Midscene / UI-TARS / computer-use) — deferred; reserve the level only.
- **Real-native mobile driver** (Appium / Maestro / Detox) — deferred; native-only ACs are `manual`.
- **Per-app seam extension via `architecture.md`** — deferred (MQ5); default boilerplate shape only for v1; `source:'architecture'` slot reserved.
- **Pixel-baseline visual diffing** — rejected (flaky); the seam replaces it.
- **Cross-iteration QA memory / deployed-app monitoring** — out of scope (one-time gate).

---

## 9. Risks

- **R1 — Rigor-cap split missed.** If the cap isn't split (cost vs determinism), `prototype`/`mvp` silently downgrade state ACs to vision — re-introducing the disease. _(E2-S4 is the guard; flag in review.)_
- **R2 — Context-pack budget.** Probes + seam snapshots compete with file digests (30k cap); render only cited sections; account probe bytes first.
- **R3 — Reflector target missing (NOT a stub).** `reflector-apply.mjs` is a working on-disk applier (291 lines, tested) — it simply has no `story.vqa.fix` case in its switch. E5-S4 must add that target + writer, not "wire a stub" (§11 H5).
- **R4 — Seam leakage to production.** E2-S2 AC2 guards it; CI must assert `__harness` absence in prod builds.
- **R5 — `manual` overuse.** Without the Concept gate-check challenge, `manual` becomes a lazy escape hatch; rely on the test-mode-seam-preferred rule + gate division.
- **R6 — Driver-abstraction leakage.** If runner code assumes Playwright APIs directly, the future native driver is blocked; keep the action grammar driver-agnostic (FR-29).

---

## 10. Assumptions

- The Concept PRD lands `verify` (incl. `manual`), BDD `given/when/then`, `thenObservable`, and `references[].source:'harness'` on `AcceptanceCriterion`.
- Apps are generated from `BOILERPLATE_REGISTRY`; the runtime contract is the single source for boot/capture/seam/stubs.
- Labs remains a single-operator internal factory on the Max subscription (Claude judges; no VLM fleet, no per-token Bedrock).

---

## 11. Hardening v1.1 — adversarial stress-test resolutions (OVERRIDES earlier sections)

A 4-adversary stress test (internal-consistency, coverage, codebase-feasibility, first-principles premise) plus the Concept v0.6 stress-test handoff surfaced ~6 blocker-class and ~9 major issues. This section is the authoritative resolution; where it conflicts with §§1–10, **this wins.**

### H1 — Seam self-certification (BLOCKER). New FR-30/31/32.

DEV must not be the sole author of the oracle that grades DEV (the codebase already enforces this for tests via `tamper-check`, `story-pipeline.ts:910-982`).

- **FR-30** The **QA-AUTHOR owns the assertion expressions; the `snapshot()` _shape contract_ is the generator-emitted `__harness.schema.json`** (Concept-side, W2-locked) — **not** DEV-authored. **DEV only conforms the running app to that shape and populates values.** A fixer/DEV edit to the schema is **tamper-reverted** (mirror the test-contract guard). _(This is the core seam-trust fix: the oracle's shape is owned upstream, independent of the code under test.)_
- **FR-31** Prefer **independent observables** — read real engine/store/DOM state (as the existing jsdom integration tests do, `story-pipeline.ts:466-468`) over a DEV-authored convenience getter, wherever feasible.
- **FR-32** **L2-state is never the sole witness for a UI-bearing AC:** a sampled L1/L2-vision cross-check accompanies L2-state passes (ties to H3). _New story in E2; tamper guard added to E5._

### H2 — "Deterministic read" ≠ "deterministic system" (BLOCKER). Revises FR-19; new FR-33.

- **FR-33** Concurrency/ordering/race ACs use an **N-run `flakeGuard`** in the exit gate; **single-pass closure is forbidden** for any AC whose `when/then` involves timing, concurrency, or eventual consistency. The loop may only close (FR-19) when the frozen probe passes the required N runs.

### H3 — Appearance oracle was demoted (BLOCKER). Revises FR-13; new FR-34/35; accepts Concept W9.

- **FR-34** **State AND appearance for UI-bearing `behavior` ACs** — a behavior AC with a visual surface gets _both_ a seam assert _and_ a post-action L2-vision frame on the assembled surface. Not either/or.
- **FR-35** **L2-state cannot block-green alone** for render-class ACs (animation/transition quality, chart geometry, WebGL/canvas pixels) — these require L2-vision (or exposed rendered geometry), because the seam reports state the user never saw.
- **Appearance floor (Concept W9):** a UI-bearing plan needs **≥1 `verify:'appearance'` AC per primary screen/route** (warn `mvp`, block `production`); **L1 runs regardless of rigor** for UI-bearing apps. The "majority at L2-state" metric is **deleted** (it optimized for the measurable over the meaningful).

### H4 — Realtime / multiplayer is unrepresentable today (BLOCKER for that class). New FR-36; matrix row.

The flagship debate apps are multi-human; a single-page `__harness` cannot see cross-client truth, and `page.clock` corrupts WebSocket timing.

- **FR-36 (v1 scope):** realtime/multiplayer ACs are **`verify:'manual'`** for v1, **explicitly** (the §3.7 matrix must show this row, not imply coverage). A multi-context/`actor` probe primitive (+ clock-forbidden-on-realtime) is **deferred** (§8) as the real fix.

### H5 — `reflector-apply.mjs` is NOT a stub (factual correction). Re-scopes E5-S4.

It is a working 291-line on-disk applier; the real gap is **no `story.vqa.fix` target in its switch**. E5-S4 = "add the `story.vqa.fix` case + writer," not "wire a stub." On-disk apply for that target is therefore **in scope** (no longer a hand-wave).

### H6 — `BoilerplateRuntimeContract` does not exist as code (re-scope E2-S1).

It lives only in `boilerplate-runtime-contract.md`; `nodeModulesStrategy`/`basePath` were never built as a unified type (`functions/shared/boilerplates/types.ts` has no such interface). **E2-S1 must _create_ the `RuntimeContract`/`testHarness` field on `BoilerplateMetadata` (new code)**, budgeted as new surface — not "extend" an existing contract. Stop citing `nodeModulesStrategy` as a live precedent.

### H7 — "One engine, two checkpoints" is a re-architecture, not a refactor (re-scope E3; closes OQ3).

The wave gate drives the browser via an **agentic LLM evidence agent improvising CLI** (`wave-vqa-runner.mjs:126-150`); the QA pipeline via **programmatic Playwright** (`visual-qa-pipeline.ts:539-573`); verdict vocabularies are **disjoint** (`PASS|FAIL|UNREACHABLE|UNCERTAIN` vs `pass|fail|uncertain|…`).

- **E3 v1 scope:** share the **probe grammar + types + one verdict vocabulary** only. Add an FR defining the **`(level × verdict) → block`** rule (and _where_ it's computed) so FR-21 is buildable.
- **OQ3 closed:** L2-state **blocks at QA Review**; at the wave gate it runs **non-blocking** until the daemon's agentic-evidence path is replaced by the programmatic probe runner — that replacement is a **separate, explicitly-budgeted epic (E7-arch)**, not part of E3.

### H8 — Seam wiring is real work (revises FR-7/8; new story; v1 scope).

- No test-only gating idiom exists in scaffolds, and React state is **not a singleton** — the seam needs **per-app wiring**. **FR-8** requires a concrete guard (e.g. `if (process.env.NEXT_PUBLIC_TEST_HARNESS)`) shipped in the scaffold + a **CI assertion that `__harness` is absent in prod builds** (new story).
- **v1 seam scope = `nextjs-canvas-game` only** (the only wired UI starter); `nextjs-form-app`/`nextjs-dashboard` are `status:'stub'` — their seam defaults depend on those starters being wired first (added as a dependency, not assumed).

### H9 — Context-pack serializer needs real work (revises NFR-6/R2).

`story-context-pack.mjs` has **no probe/seam section** and its overflow drops **digests**, not probes. NFR-6 now requires: a **dedicated, sorted probe/seam section** in `serializePack`, and an **overflow priority that protects probe bytes before digest-dropping** (`:228-234`). New story under E4.

**W2 manifest format — LOCKED (Concept §6.2; Concept generators emit, VQA builds the read path):**

- **Doc sections:** each `prd-gen`/`ux-gen`/`arch-gen` emits `<artifact>.sections.json = { artifact, rev, contentHash, sections:[{id,title,lineStart,lineEnd}] }`, with each `id` mirrored as a `<!--§id-->` anchor above its heading. `resolveSection(md,id)` = deterministic line-range slice (**no regex**). `references[].section ∈ manifest.ids` is a **set-membership gate** at qa-aggregate.
- **Harness:** `__harness.schema.json = { globalKey, snapshot:{ <jsonPath>:{type,enum?} }, events:[] }`. `references[].source:'harness'` cites by **JSON-path** (e.g. `snapshot.gameState`). The probe compiler resolves `expr`/citations against these keys; **DEV conforms the running app to the shape** (FR-30).
- **Version-binding:** key the probe-compiler cache on `contentHash`/`rev` (doubles as Concept's W1 binding). VQA owns the **pack-serializer read path** for both manifests.

### H10 — Missing coverage classes (revises §3.7 matrix; new FRs, mostly deferred-but-named).

The matrix must add rows (not silently funnel to `manual`): **file upload/download, accessibility (axe + `page.accessibility.snapshot()`), i18n/RTL, responsive/viewport, offline/PWA, notifications/permissions, audio-structural, long-running/server-time jobs, cross-origin iframes, charts-as-geometry, security**. Grammar gaps to add: `viewport{w,h}`, `upload`/`download`, `network:'offline'`, continuous-gesture `stroke[]`.

- **Security ACs (special):** the seam is **stripped in prod (FR-8)**, so security must be verified on the **production-equivalent build via non-seam oracles** (HTTP status, DOM-escape/CSP checks) — **never** via the test-only seam.
- Each class is either given an oracle now or **explicitly listed in §8 as deferred** — the matrix must stop implying coverage it lacks.

### H11 — Acknowledge the seam's four boundaries (design honesty).

State the seam's limits once: it is **production-absent, in-process, post-hydration, same-origin, single-snapshot.** Every H4/H10 gap is one of these boundaries. SSR/hydration ACs (post-hydration blind) need an L0 server-HTML-vs-DOM diff; this is the framing that keeps the matrix honest.

### H12 — Absorb the Concept v0.6 handoff (round 3).

- **W5 — QA-AUTHOR owns the `manual→behavior` downgrade** (new FR + E4 story): performed at story-dev start where seam availability is known; emitted as a **logged reclassification event**; **forces `needsBrowser:true` on downgrade**. Concept's gate only _flags + validates `manualReason`_.
- **`manualReason` (new FR-26 field + AC) — enum LOCKED (8 values):** `real-payment | oauth-consent | captcha | native-device | email-sms-loop | subjective-quality | video-audio-perception | no-stub-possible`. The seven named classes map to a known "stub possible?" verdict; `no-stub-possible` is the QA-AUTHOR's routing fallback. Concept's gate validates `manualReason`; the QA Review surface reads/displays it.
- **`needsBrowser` — one rule:** derived for `appearance|state|behavior` (`build→false`), **independent/explicit for `manual`** (MQ1-followup). All three docs say exactly this; the prior contradictory phrasings are void.
- **W2 — section manifest: FORMAT LOCKED** (Concept §6.2; full spec in H9). Concept generators emit `<artifact>.sections.json` + `__harness.schema.json`; VQA builds the pack-serializer read path; cache keys on `contentHash`/`rev`.
- **W9 — appearance floor:** accepted (folded into H3).
- **MQ7:** test-mode stubs cite `references[].source:'harness'` — confirmed, no new source.

### Build-order impact

- **Still landable now (no Concept dep, accurate substrate):** E1 (grammar + clock + un-stale prompts), the classifier rigor-cap split (FR-12).
- **Re-scoped:** E2 (create the contract type first, canvas-game seam only), E3 (grammar/types only; daemon rewrite → new E7-arch), E5-S4 (add `story.vqa.fix` target).
- **New hard gates before "build-ready":** seam tamper-check (H1), flake-guard (H2), state-AND-appearance + appearance floor (H3), `(level×verdict)→block` rule (H7).
- **R1 (rigor-cap split) remains the highest-risk, easiest-to-miss requirement** — keep it a blocking AC.

### 11.1 Canonical epic list (v1.2 — supersedes the §5 epic headers for generation)

Generate stories from this list; §5 holds the original AC drafts (still valid where not overridden by §11). Concept-dependent epics are marked.

| Epic                                              | Scope (post-hardening)                                                                                                                                                                                            | Key stories (incl. NEW from §11)                                                                                                                                                                                                                                                                                                                                                                      | Depends on                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **E1 — Interaction grammar & deterministic time** | Realize L2 driving. _Clean, landable now._                                                                                                                                                                        | action grammar (`press/hold/tap/pointer/clock/select/drag/assert/seed` + `viewport/upload/download/network/stroke` H10); interpreter; parser; document grammar; **un-stale judge prompts**; `page.clock`                                                                                                                                                                                              | —                                           |
| **E2 — Verifiability seam & L2-state oracle**     | **CREATE** `RuntimeContract`/`testHarness` type (H6); **canvas-game seam only** v1 (H8).                                                                                                                          | create contract type; ship `__harness` conforming to generator `__harness.schema.json`; **test-only guard + CI prod-absence assertion** (H8); L2-state `assert` oracle; **rigor-cap split — blocking AC** (FR-12/R1); **seam tamper-check** (H1)                                                                                                                                                      | Concept harness schema (W2)                 |
| **E3 — Shared probe grammar/types & verdict**     | Grammar/types + **one verdict vocabulary** + **`(level × verdict) → block` rule** (H7). _NOT the daemon rewrite._                                                                                                 | extract shared types/runner-lib; unify verdict vocabulary; blocking-derivation rule; render richer evidence (snapshots + frame sequences)                                                                                                                                                                                                                                                             | E1, E2                                      |
| **E4 — Authorship, level-setting & pack**         | QA-AUTHOR owns probes; derive L-level; pack carries probes.                                                                                                                                                       | QA-AUTHOR persona; consume `verify`; **needsBrowser one-rule** (manual independent); **`manual→behavior` downgrade — logged, forces needsBrowser** (W5/H12); **coverage check asserts oracle-strength, not just presence** (premise-F4); **pack probe section + manifest read path + protect probe bytes** (H9/W2)                                                                                    | **Concept** (verify, BDD, manifests)        |
| **E5 — Closed agentic fix loop**                  | Make "fix until pass" real & un-gameable.                                                                                                                                                                         | `reach-wrong` triage; **frozen oracle mid-loop + seam tamper-check** (H1); **N-run flake-guard closure** (H2); bounded escalation; **add `story.vqa.fix` target to `reflector-apply`** (H5)                                                                                                                                                                                                           | E2, E3                                      |
| **E6 — Human-in-the-loop & generality**           | `manual` lane + all app types.                                                                                                                                                                                    | `verify:'manual'` operator lane; **`manualReason` 8-enum display/validate**; test-mode boundary seams (harness-cited); **no-exact-match generative rule**; **state-AND-appearance + appearance floor** (H3/W9); **render-class can't block-green on L2-state alone** (H3); **security-on-prod-build oracle** (H10); driver abstraction / mobile Expo-web; missing-row oracles or explicit defer (H10) | **Concept** (verify:'manual', manualReason) |
| **E7-arch — Wave-gate evidence rewrite**          | Replace the daemon's **agentic-LLM evidence path** with the **programmatic probe runner**; enables wave-gate L2-state _blocking_ (until then it's non-blocking; OQ3). _Explicitly budgeted; biggest single lift._ | rewrite `wave-vqa-runner` evidence; end-to-end verdict unification                                                                                                                                                                                                                                                                                                                                    | E3                                          |

**Deferred (§8, not in this plan):** L3 agentic exploratory; real-native mobile driver; **multi-context/realtime probe primitive** (realtime/multiplayer = `verify:'manual'` v1, H4); per-app `architecture.md` seam extension.

**Suggested wave order:** E1 ∥ (E2 after contract type) → E3 → E4 ∥ E6 (both Concept-gated) → E5 → E7-arch. The cross-PRD ship-together pair is **VQA E1 + Concept Slice 1**.
