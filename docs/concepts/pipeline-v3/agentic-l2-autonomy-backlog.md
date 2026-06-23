# Agentic L2 Autonomy — Pending Developments (Concept + Dev)

> **Status:** IN PROGRESS — Waves A + B (keystone) + C (fix-loop) **built, tested & committed** on `feat/pipeline-v3` (862c4ef, 50742cf); not yet deployed · **Created:** 2026-06-23
> **Author:** `QAreview-agentic`

## ⚙️ Build progress (2026-06-23)

The Concept → QA-AUTHOR → QA-EXECUTE spine is built and unit-tested. What shipped this pass:

| Item                            | What was built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Tests                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **CS-1** ✅                     | `validateVerifyCoverage` gate (browser AC ⇒ `verify` required) wired at both plan-apply + import API gates; schema coherence rule (`build` ⇏ `needsBrowser`); PM-prompt HARD REQUIREMENT + `thenObservable` guidance. Kept OUT of the always-on schema so legacy round-trips still parse.                                                                                                                                                                                                                                                      | `plan-output-schema.test.ts` (+5)                                     |
| **CS-3** ✅                     | `thenObservable` now rendered in the story-context pack ("And observable:") — the QA-AUTHOR's compile target reaches story-dev.                                                                                                                                                                                                                                                                                                                                                                                                                | `story-context-pack.test.mjs` (+1)                                    |
| **QAA-1 + QAA-2** ✅ (keystone) | `qa-author.ts` — a PURE deterministic probe compiler: `compileObservableToAssert` (prose→`{expr,op,expected}`, RULE-4 set-membership) + `authorProbeFlow`/`authorProbeFlows` (reach→screenshot→assert synthesis). Wired at the QA chokepoint (`launchPlanQaAggregate`, after backfill / before classify) via a new `resolveSeamContract`. Deterministic-first: unmappable prose left flow-less for CONTRACT_INCOMPLETE. **Built as a compiler, not a new LLM agent step** (the DEV already authors flows; this reliably repairs/authors them). | `qa-author.test.ts` (16)                                              |
| **DV-2 / QR-2** ✅              | `SEAM_NEVER_PUBLISHED` static catch — `seamHook` added to the boilerplate `testHarness` contract (canvas-game + dashboard); qa-prepare greps app `src/` for the hook import → `seam-wiring.json`; qa-judge-l2 blocks an un-imported seam pre-screenshot (cheaper than 5s runtime SEAM_ABSENT).                                                                                                                                                                                                                                                 | `visual-qa-l2-guards.test.ts` (+3)                                    |
| **FL-1** ✅ (Wave C)            | `daemon/lib/vqa-triage-router.mjs` — pure verdict→route classifier (structural prefix wins; LLM triage class is fallback). Wired into `buildVqaFixStories`: a SEAM\_\*/CONTRACT_INCOMPLETE failure mints a "build the feature" story, FLOW_NOOP a "fix the interaction" story; an operator/environment-only bundle ESCALATES (operator card) instead of minting. Daemon card copy branches on escalation reason.                                                                                                                               | `vqa-triage-router.test.mjs` (10), `wave-vqa-fix-story.test.mjs` (+3) |
| **FL-2** ✅ (Wave C)            | Deterministic re-verify — the minted fix-story criteria preserve the AC's `verify` + `thenObservable` (+ given/when/then), carried via the handoff (`wave-vqa-runner` `buildHandoff`). The fix story's QA re-run then re-authors a DETERMINISTIC probe (qa-author / QAA-1) and exits on a seam assert, not a vision re-judge.                                                                                                                                                                                                                  | `wave-vqa-fix-story.test.mjs` (+1)                                    |
| **FL-3** ✅ (Wave C)            | Reflector `story.vqa.fix` learning target — added to `ReflectionTarget`; `reflector-apply` appends a confirmed VQA fix (triage class + probe change) to `.context/vqa-fixes.jsonl` (idempotent on proposal id) + commit path + Reflection-Inbox UI key. (Producer side — the REFLECTOR emitting these proposals — is future.)                                                                                                                                                                                                                  | `reflector-apply.test.mjs` (+3)                                       |

**Remaining (next waves):** QAA-3/QR-1 (resolvedLevel→execute belt-and-braces — partially covered: authored flows now classify L2-state, and flowless tests are blocked by the deployed CONTRACT_INCOMPLETE gate), CS-2 (manual operator flag), DV-1/DV-3/DV-4 (dev-side: mount real game, declare-conform, build overlays — prompt-steered), QR-3/4/5 (cleanups).

> **Companion:** [`qa-l2-agentic-enhancement-plan.md`](./qa-l2-agentic-enhancement-plan.md) (the QA executor+enforcement side, **built & deployed** `origin/main @ 8a4c277`). This doc is the **upstream remainder** — everything the Concept stage and the Dev stage must build so the deployed QA capability actually fires end-to-end.
> **Design of record:** [`vqa-qa-review-redesign.md`](./vqa-qa-review-redesign.md) §3.3–3.7, [`concept-stage-v2-bmad.md`](./concept-stage-v2-bmad.md) §4/§8.

---

## 0. What is ALREADY deployed (the contract upstream must target)

The QA executor + enforcement is live and waiting for real input. Upstream work must produce data that fits these:

- **Probe grammar** (`functions/shared/types/epic-workflow.ts` `ProbeStepAction`; zod `functions/shared/schemas/probe-step-schema.ts`): `navigate · click · fill · wait · screenshot · press · hold · tap · pointer · select · drag · clock · assert · waitForEvent · repeat · force` (+ legacy/H10 verbs).
- **Executor** (`functions/shared/pipelines/visual-qa-pipeline.ts` `runFlow`): drives the grammar against `window.__harness` with a seam-readiness gate, poll-assert, event-wait, drive-until-event, force-state.
- **Drivable seam** (new canvas-game apps, `functions/shared/boilerplates/registry.ts`): `window.__harness = { ready, snapshot(), events[], dispatch(action), forceStatus(status) }` under `NEXT_PUBLIC_TEST_HARNESS`.
- **Deterministic gates** (block at QA, never re-bucketed): `CONTRACT_INCOMPLETE` (a `level:'L2'` test with no flow), `SEAM_ABSENT` (a seam-asserting flow whose seam never published), `FLOW_NOOP` (a frame byte-identical to idle). Verdict regex `STRUCTURAL_BLOCK_RE` in `qa-report-aggregator.ts:89`.
- **Verify-derived oracle tiers** (`functions/shared/services/visual-test-classifier.ts`): `deriveLevelFromVerify`, `resolvedLevel` (`L0|L1|L2-state|L2-vision|operator|needs-probe`), `hasExecutableProbe`, `deriveNeedsBrowser`, `capVisionLevelByRigor`, `downgradeManualToBehavior` — all PURE and ready, but **only consumed by the contract-gate draft today** (`visual-qa-pipeline.ts:333`), not by execution or authoring.
- **Schema for the AC** (`functions/shared/schemas/plan-output-schema.ts`): `verify`, `given/when/then/thenObservable`, `manualReason` (closed enum + `.superRefine`) — and `plan-generation-service.ts:222,317` persists `verify`.

**The gap in one sentence:** the AC carries intent and the QA side can execute probes, but **nothing authors the probe flow from the intent**, **the PM doesn't reliably emit the intent**, and **the Dev side ships apps whose seam never publishes** — so the deployed gates currently just _block honestly_ instead of _passing real verification_.

---

## 1. The end-to-end target flow (and where each gap sits)

```
PM (Concept) ──verify intent + BDD──▶ QA-AUTHOR (story-dev) ──flow probe──▶ QA EXECUTE (deployed) ──verdict──▶ FIX LOOP
   CS-1/2/3                              QAA-1/2/3                          (live)                         FL-1/2/3
        │                                     │
        └── DEV builds the real game + overlays + conforms the seam shape ── DV-1/2/3/4 ──────────────────────┘
```

**Worked example — pamcan6's "GAME OVER overlay" AC, fully autonomous (the target):**

1. **PM** emits the AC with `verify: 'behavior'`, `given:"a game in progress"`, `when:"the player loses the last life"`, `then:"a red GAME OVER overlay with final score and PLAY AGAIN"`, `needsBrowser:true`. _(CS-1 makes this mandatory.)_
2. **QA-AUTHOR** sees `behavior` + a seam exists → authors `level:'L2'` with flow:
   `[{press:Enter}, {force:"over"}, {waitForEvent: snapshot.status==='over'}, {screenshot}, {assert: snapshot.status==='over'}]`. _(QAA-1 builds this step; QAA-2 compiles `then`→assert.)_
3. **DEV** mounts the real `PacmanGame` feature (calls `useGameStateMachine`/`useGameLoop`/`useKeyboard`) and builds the `GameOverOverlay` that renders on `status==='over'`. _(DV-1/DV-4; DV-2 catches the omission early.)_
4. **QA EXECUTE** (deployed) drives the flow, captures the real overlay, asserts the seam → deterministic PASS/FAIL.
5. **FIX LOOP**: a FAIL routes by triage — `code-bug`→FIXER, `reach-wrong`→re-author probe, `real-defect`→build. _(FL-1/2/3.)_

Today step 1 is optional, steps 2 is absent, step 3 is unenforced — so the run blocks at `CONTRACT_INCOMPLETE`/`SEAM_ABSENT`.

---

## 2. CONCEPT stage backlog (owner: `concept-develop`)

### CS-1 — Make `verify` MANDATORY on every UI-bearing AC (enforced, not prose)

- **State:** PARTIAL. Schema supports `verify` (`plan-output-schema.ts:30,54-56`), the mapper persists it (`plan-generation-service.ts:222,317`), and the PM prompt _mentions_ it (`pm-plan-prompt.ts:147,477,485`). But it is OPTIONAL — pamcan6 shipped browser ACs with no `verify`, so the QA classifier's oracle routing stayed dormant.
- **Build:** (a) `plan-output-schema.ts` `.superRefine`: if `needsBrowser === true` then `verify` is REQUIRED (and `verify:'build'` ⇒ `needsBrowser:false`, via `deriveNeedsBrowser`). (b) The concept decompose/gate (Murat) rejects/repairs a plan with a browser AC missing `verify`. (c) Strengthen `pm-plan-prompt.ts` so every browser AC example carries `verify`.
- **Acceptance:** a generated plan where any `needsBrowser` AC lacks `verify` is rejected at concept (not at QA). 100% of browser ACs on a new plan carry a `verify`.
- **Files:** `plan-output-schema.ts`, `pm-plan-prompt.ts`, the concept gate (decompose validation).
- **Deps:** none. **Effort:** S–M. **Unblocks:** QAA-1, QR-1.

### CS-2 — `manual` → operator-confirmation flag (no auto-bounce)

- **State:** DESIGNED (concept v0.6 W5), verify built. Confirm wired: the concept gate FLAGS `verify:'manual'` for operator confirmation with `manualReason` (closed enum, `.superRefine` already enforces reason presence). The `manual→behavior` downgrade is the QA-AUTHOR's at dev time (`downgradeManualToBehavior` exists, unused).
- **Build:** wire the concept gate to surface `manual` ACs to the operator; persist `manualReason`. Do NOT reclassify at concept (altitude rule).
- **Acceptance:** a `manual` AC reaches the operator with its reason; it never silently becomes `behavior` at concept.
- **Files:** concept gate UI/service. **Deps:** CS-1. **Effort:** S.

### CS-3 — Guarantee the BDD triple reaches the QA-AUTHOR

- **State:** PARTIAL. `given/when/then/thenObservable` are in the schema + persisted, but verify the daemon story-context pack surfaces them at story-dev start (the QA-AUTHOR's input).
- **Build:** ensure `story.acceptanceCriteria[].{given,when,then,thenObservable,verify}` is in the story-context pack the QA-AUTHOR reads (`daemon/pipelines/lib/story-context-pack.mjs`).
- **Acceptance:** the QA-AUTHOR prompt receives each browser AC's full BDD triple + verify intent. **Deps:** QAA-1. **Effort:** S.

---

## 3. QA-AUTHOR bridge backlog (owner: dev pipeline — THE KEYSTONE)

> This is the missing agent that turns intent into an executable probe. Without it, the deployed verbs are inert and the deployed gates only block. It is the single highest-value remaining build.

### QAA-1 — Add a QA-AUTHOR step to the story pipeline

- **State:** ABSENT. `functions/shared/pipelines/story-pipeline.ts` has `test-author` (API-AUTHOR + TEST agent) that writes UNIT-test files (`:268,416,421`); nothing authors `visualTests[].flow`. pamcan6's visualTests had a `level` but `flow:(none)`.
- **Build:** a pipeline step (new agent role, runs at story-dev start, after the seam shape is resolvable) that, for each `needsBrowser` AC:
  - reads `verify` + BDD triple (CS-3) + the boilerplate `__harness.schema.json` (snapshot keys) + the deployed grammar (§0).
  - sets the **concrete L-level** via `deriveLevelFromVerify` + `capVisionLevelByRigor` (the altitude rule: PM set intent; QA-AUTHOR sets level when the seam mechanism is known).
  - **authors the flow:**
    - `appearance` → L1, no flow (idle frame).
    - `state` (seam) → `L2`, flow `[{force?}, {waitForEvent}, {screenshot}, {assert <seam expr>}]`.
    - `behavior` → `L2`, flow `reach→act→observe` (`press`/`repeat`/`force` → `waitForEvent`/`screenshot`/`assert`).
    - `manual` → `downgradeManualToBehavior` if a stub seam exists, else operator lane.
  - writes the result into `story.visualTests` (or the visual-tests block the writer ingests).
- **Acceptance:** for a `behavior`/`state` AC the authored test has `level:'L2'` AND a non-empty flow with ≥1 `assert`/`waitForEvent`. A re-run of the pamcan6 GAME-OVER AC produces the §1 example flow. The deployed `CONTRACT_INCOMPLETE` gate stops firing for properly-authored plans.
- **Files:** `story-pipeline.ts` (new step), a new QA-AUTHOR prompt, the visual-tests writer path.
- **Deps:** CS-1, CS-3, DV-3 (seam shape). **Effort:** L. **Note:** the deployed Phase-0 gate already PUNISHES the absence of this (blocks), so it is forcing-function-backed.

### QAA-2 — Prose→assert compiler (`thenObservable` → seam `assert`)

- **State:** ABSENT (the "AC's BDD triple is the input to VQA v3's probe compiler" promise, concept §sister-note).
- **Build:** a deterministic-first compiler: map `thenObservable` to a concrete `{expr, op, expected}` against the boilerplate snapshot keys (`__harness.schema.json`). LLM-assisted only when no deterministic mapping exists; validate the emitted `expr` is set-member of the locked snapshot shape (`RULE-4` from the QA plan).
- **Acceptance:** `then:"GAME OVER overlay shows"` + `thenObservable:"status is over"` compiles to `{expr:'snapshot.status', op:'eq', expected:'over'}`; an `expr` not in the schema is rejected.
- **Files:** the QA-AUTHOR prompt/helper, a validator against `__harness.schema.json`. **Deps:** QAA-1, DV-3. **Effort:** M.

### QAA-3 — Thread `resolvedLevel`/`needs-probe` into EXECUTION routing

- **State:** ABSENT at execute. `resolvedLevel` is computed and shown only in the contract-gate draft (`visual-qa-pipeline.ts:333`); `buildQaExecutePipeline` routes on `t.level` + flow presence, ignoring the oracle tier.
- **Build:** have `buildQaExecutePipeline` consult the classification (`needs-probe` → block as `CONTRACT_INCOMPLETE`; `L2-state` → deterministic assert path exempt from rigor cap). Belt-and-braces with the deployed Phase-0 runtime gate.
- **Acceptance:** a `needs-probe` test is routed to the honest lane at execute, not silently captured. **Files:** `visual-qa-pipeline.ts`, the qa launcher. **Deps:** QAA-1. **Effort:** M. _(QA-side; can be done by `QAreview-agentic`.)_

---

## 4. DEV stage backlog (owner: dev pipeline + boilerplate)

### DV-1 — DEV must mount the REAL game (seam publishes, game is playable)

- **State:** UNENFORCED at authoring; `SEAM_ABSENT` (deployed) blocks it at QA. pamcan6 mounted a static `PacmanPreview` that never called `useGameStateMachine`/`useGameLoop`/`useKeyboard`, so `window.__harness` never published.
- **Build:** (a) the boilerplate `SCAFFOLD.md` contract + the dev/assembly prompt REQUIRE the primary/assembled feature to consume the game hooks (publish the seam, wire input + loop). (b) tie to the primary-feature surface (already deployed): the `primary:true` feature is the live game.
- **Acceptance:** the assembled feature imports and uses `useGameStateMachine`; `window.__harness.ready` is true under the QA dev server. **Files:** `registry.ts` (SCAFFOLD.md/dev prompt), `pm-plan-prompt.ts` assembly story. **Deps:** none. **Effort:** M.

### DV-2 — `SEAM_NEVER_PUBLISHED` static wiring-presence detector (cheap early signal)

- **State:** verdict WIRED to block (`STRUCTURAL_BLOCK_RE`, `qa-report-aggregator.ts:89`) but **nothing emits it**. The deepest pamcan6 cause ("the verifiability seam is itself unverified").
- **Build:** in `qa-prepare` (`visual-qa-pipeline.ts`): when the plan has ≥1 L2/seam test, grep the app `src/` for a feature importing `useGameStateMachine` (or the boilerplate's seam hook). If none → emit `SEAM_NEVER_PUBLISHED` (catch before any screenshot, cheaper than runtime `SEAM_ABSENT`).
- **Acceptance:** a preview-only app (no seam hook imported) blocks at qa-prepare with `SEAM_NEVER_PUBLISHED` before judging. **Files:** `visual-qa-pipeline.ts`. **Deps:** none. **Effort:** S. _(QA-side; can be `QAreview-agentic`.)_

### DV-3 — Declare-conform: the running app publishes the asserted snapshot keys

- **State:** PARTIAL. `__harness.schema.json` ships + is tamper-guarded (`registry.ts:270-286`); the `'win'` enum is reconciled (deployed). But there's no check that the DEV's running snapshot keys are a superset of what QA-AUTHOR asserts.
- **Build:** a conformance check (CI/qa-prepare): emitted `snapshot` keys ⊇ the keys any authored `assert`/`waitForEvent` references; flag drift. The QA-AUTHOR's `expr` set-membership (QAA-2) is the author-side half; this is the runtime half.
- **Acceptance:** an `assert expr:'snapshot.score'` where the app never sets `score` is caught (drift), not a silent `undefined` mismatch. **Files:** `registry.ts` schema, a qa-prepare check. **Deps:** QAA-2. **Effort:** M.

### DV-4 — Build the state-gated UI the ACs describe (the real defects)

- **State:** app-behavior. pamcan6's Start/GameOver/Win/Paused overlays were never built → genuine defects. `force`/`waitForEvent` let QA REACH the states, but the app must RENDER the overlay on them.
- **Build:** dev prompt steers building an overlay/component for each `behavior`/`state` AC keyed on the seam status; the `REAL_DEFECT_NO_SEAM` / build send-back routes it (FL-1).
- **Acceptance:** an AC "GAME OVER overlay shows on loss" has a component that renders on `status==='over'`. **Files:** dev prompt. **Deps:** DV-1. **Effort:** ongoing (per-app, prompt-steered).

---

## 5. Fix-loop closure (owner: dev pipeline / daemon)

### FL-1 — Triage + routing for the new structural verdicts

- **State:** ABSENT for the new verdicts. The send-back/Accept UI exists; the wave-vqa-fix-story minting exists (`daemon/agent-daemon.mjs:6076`). But `CONTRACT_INCOMPLETE`/`SEAM_ABSENT`/`FLOW_NOOP`/`REAL_DEFECT` have no distinct routing.
- **Build:** triage classes → routes: `code-bug`→FIXER; `reach-wrong`/`FLOW_NOOP`→re-author probe (QA-AUTHOR); `CONTRACT_INCOMPLETE`→QA-AUTHOR; `SEAM_ABSENT`/`REAL_DEFECT`→build send-back; `ac-wording`→operator. Distinct operator-card copy per class.
- **Acceptance:** a `SEAM_ABSENT` block routes to "build the game", a `CONTRACT_INCOMPLETE` to "author the probe" — not a generic "send back to dev". **Files:** `wave-vqa-runner.mjs`/fix-story mint, claims-table UI. **Deps:** QAA-1. **Effort:** M.

### FL-2 — Deterministic exit gate (close the loop on L2-state)

- **State:** ABSENT. redesign §3.5: "you cannot close a loop on a probabilistic oracle." A fixed AC must re-run its L2-state probe and pass deterministically to exit.
- **Build:** on fix re-run, re-execute the AC's probe; an `L2-state` assert passing is the exit condition (not a vision re-judge).
- **Acceptance:** a minted fix story re-runs the probe; the loop exits only on a deterministic pass. **Files:** wave-vqa runner, fix-story flow. **Deps:** QAA-1, FL-1. **Effort:** M–L.

### FL-3 — Reflector `story.vqa.fix` learning target

- **State:** ABSENT/no-op. `daemon/pipelines/reflector-apply.mjs` has deferred/unknown targets (`:116,124`); there's no `story.vqa.fix` target, so VQA fixes don't feed learning.
- **Build:** add a `story.vqa.fix` reflector-apply target that records the fix (triage class, probe change) for the learning loop.
- **Acceptance:** a VQA fix writes a reflection proposal under `story.vqa.fix`. **Files:** `reflector-apply.mjs`. **Deps:** FL-1. **Effort:** S–M.

---

## 6. QA-side remainders (owner: `QAreview-agentic` — small, deferred from the shipped phases)

| ID   | Item                                                                                                                      | State                          | Effort |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------ |
| QR-1 | Thread `resolvedLevel`→execute (same as QAA-3)                                                                            | absent                         | M      |
| QR-2 | `SEAM_NEVER_PUBLISHED` detector (same as DV-2)                                                                            | verdict wired, detector absent | S      |
| QR-3 | `waitForEvent` over the `events[]` stream (not just `snapshot`) — events push is deployed; allow `expr:'events…contains'` | partial                        | S      |
| QR-4 | Resolve the phantom `seed` verb (implement via `dispatch` or remove from grammar)                                         | phantom (no-op `ok:true`)      | XS     |
| QR-5 | Split commit `f8c3268` (un-bundle other-track WIP) — needs force-push                                                     | optional hygiene               | XS     |

---

## 7. Dependency graph + suggested sequencing

```
Wave A (unblock authoring):   CS-1 ──▶ CS-3 ──┐
                              DV-3 (seam shape) ┤
Wave B (the keystone):                          └─▶ QAA-1 ──▶ QAA-2
                              DV-2 / QR-2 (cheap honesty) ─ parallel
Wave C (make it route):       QAA-3/QR-1 ─ parallel ;  FL-1 ──▶ FL-2 ──▶ FL-3
Wave D (real apps):           DV-1 ──▶ DV-4 (prompt-steered, ongoing)
Cleanups:                     QR-3, QR-4, QR-5 anytime
```

- **Wave A** is cheap and unblocks everything: make the PM emit `verify` (CS-1), surface it + the BDD triple to dev (CS-3), and pin the seam shape (DV-3).
- **Wave B is the keystone**: QAA-1 (the QA-AUTHOR step) is the single highest-leverage build — it makes the deployed verbs/gates actually fire. DV-2/QR-2 (the cheap static seam check) can land in parallel and immediately improves diagnosis.
- **Wave C** makes verdicts route correctly and closes the fix loop.
- **Wave D** is the per-app dev-quality steering (real game + overlays), already forced by the deployed gates.

---

## 8. Definition of Done (autonomous agentic L2)

A new game plan runs end-to-end with **no operator probe-authoring** and yields **honest, deterministic verdicts**:

1. Every browser AC carries a `verify` intent (CS-1). ✔ enforced at concept.
2. The QA-AUTHOR authors an executable probe (flow + assert) for every `state`/`behavior` AC (QAA-1/2). ✔ no `CONTRACT_INCOMPLETE`.
3. The DEV mounts the real, playable game; the seam publishes; overlays render on their states (DV-1/3/4). ✔ no `SEAM_ABSENT`/`SEAM_NEVER_PUBLISHED`/`REAL_DEFECT`.
4. QA EXECUTE drives the probe (force/wait/assert), captures distinct post-interaction frames, asserts the seam (deployed). ✔ no `FLOW_NOOP`; L0/L1/L2 genuinely distinct.
5. A FAIL routes by triage and the fix loop closes deterministically on an L2-state re-run (FL-1/2/3). ✔
6. The retrospect grades the QA stage from real verdicts (already wired) and credits the verify/probe coverage. ✔

When all six hold, the pamcan6 class of failure (cosmetic L2, same screenshot, false pos/neg, unverifiable game states) is structurally impossible.

---

## 9. Reference — the deployed contract upstream must satisfy

| Concern                         | Artifact (deployed)                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Probe grammar                   | `functions/shared/types/epic-workflow.ts` `ProbeStepAction`; `functions/shared/schemas/probe-step-schema.ts`                                   |
| Executor                        | `functions/shared/pipelines/visual-qa-pipeline.ts` `runFlow` (seam-readiness, poll-assert, `waitForEvent`, `repeat`, `force`)                  |
| Seam (new apps)                 | `functions/shared/boilerplates/registry.ts` `useGameStateMachine` → `window.__harness.{ready,snapshot,events,dispatch,forceStatus}`            |
| Snapshot shape (assert targets) | `registry.ts` `CANVAS_GAME_SNAPSHOT_SHAPE` + `__harness.schema.json` (tamper-guarded)                                                          |
| Structural verdicts (block)     | `qa-report-aggregator.ts:89` `STRUCTURAL_BLOCK_RE`                                                                                             |
| Verify→oracle (pure, ready)     | `functions/shared/services/visual-test-classifier.ts` `deriveLevelFromVerify`/`resolvedLevel`/`hasExecutableProbe`/`downgradeManualToBehavior` |
| AC schema (verify + BDD)        | `functions/shared/schemas/plan-output-schema.ts`; persisted at `plan-generation-service.ts:222,317`                                            |
| Authoring guidance (live)       | `functions/shared/prompts/pm-plan-prompt.ts` (agentic-flow examples)                                                                           |

> All §0/§9 references verified against `origin/main @ 8a4c277` (the deployed tree).
