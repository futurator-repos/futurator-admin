# QA Review Stage Enhancement — Plan of Action: Genuinely Agentic L2

> **Status:** Phases 0–3 BUILT + DEPLOYED to production (2026-06-23). Remaining: the
> cross-session QA-AUTHOR agent + concept-stage `verify` intent (see §8). · **Created:** 2026-06-23
> **Author:** `QAreview-agentic` session (multi-agent audit: 4 parallel deep-dives → adversarial verification → synthesis; all load-bearing claims verified against live code)
> **Trigger run:** `plan_pamcan6_mqphhdgo` (appId `pamcan6`) · QA job `979c6b82-1e0d-4d41-a3e9-fef1e22f1616` (COMPLETED, BLOCKING)
> **Design of record:** [`vqa-qa-review-redesign.md`](./vqa-qa-review-redesign.md) §3.1–3.7, [`vqa-qa-review-prd.md`](./vqa-qa-review-prd.md). This doc is the **enforcement/implementation layer** that promotes that design from paper to code — not a re-design.

**One-line thesis:** The v3 redesign already designs the cure (L2-state seam, reach→act→observe, deterministic exit gate). pamcan6 proves the gap is **enforcement + a missing event-wait/force-state primitive**, not design. Promote the paper to code, and make every level↔evidence binding a _gate_, not prose.

---

## ✅ Build & deploy status (2026-06-23)

All executor + enforcement phases are \*\*built, tested (181 QA tests + `node --check`

- esbuild scaffold guards), and deployed to production\*\* (`origin/main` @ `8a4c277`,
  `sst deploy --stage production`). Commits (cherry-picked clean onto main):

| Phase                          | Status      | Commit (main) | What landed                                                                                                                      |
| ------------------------------ | ----------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **0** — contract guards        | ✅ deployed | `a21f358`     | `CONTRACT_INCOMPLETE` (flowless L2 blocks), `FLOW_NOOP` (idle-identical blocks), stepLog→judge, aggregator `STRUCTURAL_BLOCK_RE` |
| **1** — seam self-verification | ✅ deployed | `f641bf7`     | `SEAM_ABSENT` readiness gate, poll-assert, `'win'` enum                                                                          |
| **2a** — agentic verbs         | ✅ deployed | `44b3319`     | `waitForEvent`, `repeat…until-event`                                                                                             |
| **2b** — force-state seam      | ✅ deployed | `8a4c277`     | scaffold `dispatch`/`forceStatus`/`__force`/events (new apps), `force` probe verb                                                |
| **3** — authoring guidance     | ✅ deployed | `8a4c277`     | pm-plan teaches the agentic flows; enforcement = the Phase-0 gate                                                                |
| scaffold-syntax guard          | ✅ deployed | `8a4c277`     | esbuild-checks every shipped `.ts/.tsx` scaffold                                                                                 |

**Effect now live:** no more fake greens — a flowless "L2", a static-preview app with
no published seam, or an all-identical capture each blocks with a precise reason. New
apps can drive keys until an event or force terminal states (gameover/win).

**Remaining (cross-session, by design):** §8 — the QA-AUTHOR agent that auto-authors
the flows, gated on the concept stage emitting `verify` intent on ACs. The deployed
gates now FORCE this (block until a real game + real flows exist); §8 is the handoff
to make it autonomous.

---

## 0. Why this run was meaningless, not just failing (the killer finding)

Three independent layers failed together; any one alone produces a false verdict:

- **(A) The app under test isn't running the game.** pamcan6's only mounted feature is `PacmanPreview` — a static `drawFrame()` paint. It never calls `useGameStateMachine` / `useGameLoop` / `useKeyboard`, so `window.__harness` **never publishes at runtime**. The full reducer (`src/game/pacman-reducer.ts`: ghostCollision→`over` :119, win→`win` :122-123, lives/stages — all unit-tested) is referenced **only by unit tests**. The "8 identical idle frames" are a static maze paint, not a running game. So there was nothing to interact with and nothing to observe.
- **(B) "L2" is a label with no actions behind it.** Both L2 tests (`AC-S7-2`, `AC-S7-4`) were authored with `flow: (none)`, every test `url: None`. The capture loop partitions on **flow presence, not level** (`visual-qa-pipeline.ts:665-666`), so an empty-flow L2 falls to `runOne` (`:552-565`) → one static `playwright screenshot --wait-for-timeout=2000` → the **same `<id>.png` the L2 judge then reads** (`:982-983`). The `l2Tests` filter (`:462`) selects on `t.level==='L2'` and never checks flow.
- **(C) The judge prompt manufactures the false positive.** For an empty-flow L2, `allShots=[<id>.png]` — the same idle file L1 reads (`:871`). The L2 prompt (`:994`) unconditionally states _"these screenshots are captured AFTER the declared probe interactions … POST-INTERACTION state"_ and licenses _"you MAY FAIL"_. The `stepLog` (`:649-661`) that would reveal no interaction ran is never passed in. → `AC-S7-4` (PAUSED) "passed" describing the plain maze.

**Why L0/L1/L2 is cosmetic:** the level drives _only the budget_. Capture routes on `flow` (`:665`), judge-shot-selection routes on `flow` (`:982`), and the classifier's `resolvedLevel`/`needs-probe` (`visual-test-classifier.ts:599-626`) feeds **only** the unused contract-gate draft (`visual-qa-pipeline.ts:331-354`) — never `buildQaExecutePipeline`. The writer (`daemon/pipelines/lib/visual-tests-writer.mjs:111-121`) validates only `criteriaRef`. Nothing forces L2⇒flow, state⇒assert, or gated⇒probe.

**Why STUCK_CAPTURE didn't save it:** `stuckCapture` (`:723`) only `console.log`s a WARN (`:730`); the hard gate (`:727`, bash `grep` at `:762`) fires only on `ratio<0.9` (missing/blank). With `ratio=1, distinctHashes:1` it only warned. The per-frame `identical` flag (`:707-709`) is computed, written to `evidence-integrity.json`, and **never consumed by any verdict path**.

### Adversarial-verification additions (deepest root causes)

- **The verifiability seam is itself unverified.** The boilerplate ships the seam + a tamper-guard on `__harness.schema.json` (`registry.ts:270-286`) but **no check that any mounted feature actually imports `useGameStateMachine`** so `__harness` ever publishes. pamcan6 shipped a preview-only mount → the seam silently never existed. _Deepest structural cause._
- **Distinctness data exists but is unconsumed.** `hashCounts`/`identical` (`:698-709`) are never read by the judge selection (`:982-988`) or by a per-test verdict — the cheapest, already-computed lever, unused.
- **`stepLog` never reaches the judge** → false pos/neg at the judge layer even after routing is fixed.
- **`assertOp` treats a missing seam like a wrong value** (`:591-603`): `undefined === expected` is just `false`; no distinct `SEAM_ABSENT`. pamcan6's detached reducer would mis-report as a product mismatch.
- **`seed` is a phantom verb** — in the grammar (`probe-step-schema.ts:40`) with no interpreter branch, logs `ok:true` and no-ops.

**Real-defect vs capability-gap (per AC):**

| AC                           | Verdict shown | Truth                                                                      |
| ---------------------------- | ------------- | -------------------------------------------------------------------------- |
| AC-S7-1 (Start overlay)      | FAIL          | **REAL DEFECT** — no interactive game/overlay built → send-back to BUILD   |
| AC-S7-3 (Game Over)          | UNCERTAIN     | **REAL DEFECT** — overlay not built; also interaction-gated                |
| AC-S7-5 (Win)                | FAIL          | **REAL DEFECT** — overlay not built; reducer emits `win` but unmounted     |
| AC-S7-4 (PAUSED)             | PASS          | **STRUCTURAL FALSE POSITIVE** — do NOT Accept; re-run under a real flow    |
| AC-S7-2 (start dismisses)    | PASS          | **Coincidental** — start was never there; maze just happened to be visible |
| AC-S2-1/2/3 (maze/HUD/vault) | PASS          | Legitimately verifiable at L1 (static appearance)                          |

---

## 1. Target L0/L1/L2 model (explicit capability boundaries)

The level is no longer a label — it is a contract binding evidence type, executor path, oracle, and blocking authority (redesign §3.3).

| Level         | MAY do                                                                                                                       | MAY NOT do                                                                      | Oracle                                        | Blocking                                      | Evidence required                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| **L0**        | Pure bash/static (boot, build, console-error, file-exists)                                                                   | Open a browser, judge appearance                                                | Deterministic (exit code)                     | **Yes**                                       | command exit + log                                              |
| **L1**        | Capture ONE idle/load frame; judge static _appearance_ on the correct surface                                                | Interact, advance time, claim post-interaction                                  | LLM vision (single frame)                     | No (rigor-capped)                             | 1 frame; judge told it is IDLE                                  |
| **L2-state**  | reach→act→observe; drive keys/pointer/clock; **force terminal states**; **poll seam until event**; assert `window.__harness` | Pass with `flow=[]`; pass on a frame identical to idle; pass with `SEAM_ABSENT` | **Deterministic seam read**                   | **Yes** (rigor-EXEMPT — deterministic = free) | non-empty flow + ≥1 assert + ≥1 distinct post-interaction frame |
| **L2-vision** | Judge _appearance_ of a genuine post-interaction frame                                                                       | Run with `flow=[]`; be scored as post-interaction unless flow ran               | LLM vision (post-action frame, fed `stepLog`) | No (rigor-capped)                             | distinct post-interaction frame + executed stepLog              |

L2-state is the spine: the only tier that blocks-green on behavior and the only one that gives the fix loop a deterministic exit gate (§3.5). L2-vision rides the _same_ executed flow but adds appearance judgment and never blocks. The cure for "gameover/win aren't bounded-budget reachable by real gameplay" is the **force-state seam command** + **event-wait** (§4).

---

## 2. The AUTHORING fix — owner + ENFORCING gate (prose already failed)

**Who authors (redesign §3.4):** promote the test-author to **QA-AUTHOR**, owning both code tests and interaction probes at story-dev start (TDD-red), when seam availability is known. PM sets a `verify` intent at planning; DEV builds the seam shape; QA-AUTHOR finalizes the L-level and **writes the flow + asserts**.

**The gate that makes it real** (load-bearing — pamcan6 proves prose fails): a **coherence validator** at BOTH (a) the writer (`daemon/pipelines/lib/visual-tests-writer.mjs`, extend `:111-121`) and (b) a new guard in `buildQaExecutePipeline` before the partition (`visual-qa-pipeline.ts`, before `:665`):

```
RULE-1  level==='L2'                         ⇒ Array.isArray(flow) && flow.length > 0   (else CONTRACT_INCOMPLETE)
RULE-2  level==='L2' && verifyKind==='state' ⇒ flow has ≥1 'assert' OR ≥1 'waitForEvent'
RULE-3  classifier.resolvedLevel==='needs-probe' ⇒ hasExecutableProbe (else blocked, not idle-captured)
RULE-4  flow has 'assert'/'waitForEvent'      ⇒ expr targets a key in the locked snapshot shape (registry.ts:262-268)
```

**Enforcement mechanics (deterministic, not advisory):**

- In `buildQaExecutePipeline`, a test failing RULE-1/2/3 is **never** sent to `runOne`; it resolves to `verdict:'errored', rationale:'CONTRACT_INCOMPLETE: L2 test has no executable flow'` and **blocks the gate** (missing-probe, not product fail). Closes the partition collapse at `:665-666` deterministically.
- Wire the classifier into runtime: `buildQaExecutePipeline` must consult `classification.resolvedLevel` (today ignored — `:462`/`:665`). `needs-probe` becomes a **routing input**, not a dead report.
- The writer rejects the incoherent entry at ingest so a bad L2 never reaches DynamoDB.

**Why this kills the pamcan6 failure:** AC-S7-2/4 (L2, flow=none) would hit RULE-1 → `errored`/blocking at ingest, never producing the false-positive idle capture.

---

## 3. Executor + seam enhancements (event-driven agentic flows)

The reach→act→observe engine **already exists** (`runFlow` `:605-663`: real Playwright context, navigate/click/fill/press/hold/pointer/clock/assert against `window.__harness`). Three primitives are missing.

**3a. `waitForEvent` / `waitUntil` ProbeStepAction** — the single missing primitive that unlocks terminal events. Add to `ProbeStepAction` (`epic-workflow.ts:156-178`) + `probe-step-schema.ts`; implement in the `runFlow` dispatch (`:619-648`) as a `page.waitForFunction` polling the seam:

```js
else if (step.action === 'waitForEvent') {
  await page.waitForFunction(
    ([expr, op, expected]) => { /* read window.__harness.snapshot(), reduce expr, assertOp */ },
    [step.expr, step.op, step.expected],
    { timeout: Math.min(step.timeoutMs || 5000, 15000), polling: 100 }
  ); // TimeoutError → routable WAIT_EVENT_TIMEOUT, not a silent idle frame
}
```

This is exactly "wait until `phase===over` / ghost-catches-pacman." Today `wait` (`:624`) is `waitForTimeout` only.

**3b. Force-state command on the seam** — makes hard terminal states bounded-budget reachable. The seam is OBSERVE-ONLY (`registry.ts:416-423`: `snapshot()` + empty `events[]`, no command channel) though `useGameStateMachine` returns `[state, safeDispatch, ref]` (`:426`). Add a test-only dispatch passthrough under the same `NEXT_PUBLIC_TEST_HARNESS==='1'` guard (tree-shaken in prod):

```js
window.__harness = { ready:true, snapshot:()=>({...}), events:[],
  dispatch:   (action) => safeDispatch(action),          // NEW — test-only
  forceStatus:(s)      => safeDispatch({ type:'__force', status:s }) }; // NEW
```

Add a matching `dispatch`/`force` ProbeStepAction + interpreter branch. Then AC-S7-3/5 = `press Space → assert running → dispatch {type:'ghostCollision'} → waitForEvent status==='over' → screenshot → assert status==='over'` in <2s. QA-AUTHOR owns the assert/shape (tamper-checked; DEV only conforms values).

**3c. Bounded `repeat` / `untilEvent` loop** — genuine agentic sequence: `{ action:'repeat', step:{press ArrowLeft}, untilExpr:'snapshot.status', untilOp:'eq', untilExpected:'over', maxIterations:200, budgetMs:30000 }`. Drives an indefinite-length sequence to a terminal event within budget. Today the flow is one linear pass (`:619`).

**3d. Make `assert` poll, not one-shot.** Wrap the `:638-648` `page.evaluate` in a `waitForFunction` with the step timeout, so a terminal-state assert tolerates the event arriving slightly later.

**3e. Harness-readiness gate** — turns pamcan6's silent `undefined` into a loud `SEAM_ABSENT`. After `goto` (`:618`), before any step: `await page.waitForFunction("window.__harness && window.__harness.ready", {timeout:5000})`; on timeout throw `SEAM_ABSENT` → `errored` (missing-wiring send-back). Currently the assert reads `undefined` silently (`:639-644`) and `assertOp` (`:591-603`) treats it as an ordinary mismatch.

**3f. Promote the playwright-unresolvable degrade to `errored`.** `:606-610` falls back to `runOne` (idle frame) with only a note. A flowed L2 must NEVER silently become an idle-frame PASS → resolve `errored: FLOW_EXEC_SKIPPED`.

**3g. Implement-or-delete `seed`.** No interpreter branch (`probe-step-schema.ts:40`); it no-ops and logs `ok:true` (`:649`). Give it a `dispatch`-backed branch (precondition seeding) or remove it from the grammar.

**3h. Schema reconciliation.** Add `'win'` to `CANVAS_GAME_SNAPSHOT_SHAPE` (`registry.ts:262-268`) — the reducer emits `status:'win'` but the locked enum is `['idle','running','paused','over']`. Add `'win'` to the scaffold `GameStatus`, retype the reducer's loose `status:string`, and add a CI conformance check that emitted status values ⊆ the locked enum.

---

## 4. Capture-distinctness verification (a stuck run can NEVER pass)

The detection data already exists and is unused — wire it to the verdict.

**4a. Per-test distinctness assert** (cheap, high-leverage). After `runFlow`, hash `<id>.png` against the idle baseline for that surface; if identical → `errored, rationale:'FLOW_NOOP: post-interaction frame byte-identical to idle baseline'`. The integrity loop already computes per-frame sha1 + `identical` (`:698-709`) — pass `hashCounts`/`integrity` into the L2 shot selection (`:982-988`) so a frame equal to the idle baseline is **rejected before the judge sees it**. This alone would have blocked AC-S7-4 even if its flow had run but no-op'd.

**4b. Make STUCK_CAPTURE route, not just warn.** Today `stuckCapture` (`:723`) only WARNs (`:730`); the hard gate (`:727`/`:762`) fires only on `ratio<0.9`. Change: when `stuckCapture && distinctHashes===1` AND ≥1 L2 test exists, **fail the prepare step** (mirror the `integrityFailed` bash gate at `:762`). Keep the legitimate single-screen escape: only block when an L2 (which by contract must produce a distinct post-interaction frame) is present.

**4c. Feed `stepLog` into the L2 judge prompt.** Pass `<id>-flow.json` (`:661`) into the prompt (`:994`). Replace the unconditional "POST-INTERACTION" claim with the truth: "steps that executed: …; steps that failed: …". A flow where keys were ignored / selectors missed no longer reads as fully-interacted. Closes the active false-pos/neg at the judge layer.

---

## 5. Real-defect vs capability-gap (neither masquerades as the other)

A distinct verdict vocabulary so the operator card separates the failure species:

| Situation                                                | Detection                                                           | Verdict                           | Routing                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| Unbuilt feature / detached reducer (pamcan6 AC-S7-1/3/5) | `SEAM_ABSENT` (3e) OR no feature imports `useGameStateMachine` (5a) | `errored: REAL_DEFECT_NO_SEAM`    | **Send-back to BUILD** the interactive game + overlays |
| Verifiable AC, no probe authored                         | RULE-3 + classifier `needs-probe`                                   | `errored: CONTRACT_INCOMPLETE`    | **Send-back to QA-AUTHOR** to write the flow           |
| Probe ran, frame == idle baseline                        | distinctness hash (4a)                                              | `errored: FLOW_NOOP`              | Re-author flow (bad selector/key)                      |
| Probe ran, seam asserts false                            | deterministic assert                                                | `fail` (blocking)                 | Fix loop (deterministic exit gate)                     |
| Vision mismatch on real post-interaction frame           | L2-vision judge                                                     | `fail`/`uncertain` (non-blocking) | ac-wording / Accept                                    |

**5a. Wiring-presence guard (deepest cause).** Cheap static check in qa-prepare: if the canvas-game boilerplate shipped but **no feature imports `useGameStateMachine`** (grep app `src/`), fail QA-prepare with `SEAM_NEVER_PUBLISHED`. Would have caught pamcan6 before a single screenshot.

This guarantees AC-S7-1/3/5 surface as REAL_DEFECT send-backs, AC-S7-4 as FLOW_NOOP/SEAM_ABSENT (re-run, do NOT Accept), and a future genuinely-unprobed-but-buildable AC as CONTRACT_INCOMPLETE — three distinct routes, none masquerading.

---

## 6. Phased rollout (concrete file targets + rough effort)

**Phase 0 — Quick wins / stop-the-bleed (deterministic guards, ~1 day).** Would alone flip pamcan6 from false-positive-PASS to honest-blocking-errored, using only already-computed signals.

- RULE-1 `L2⇒flow` guard in `buildQaExecutePipeline` before partition (`visual-qa-pipeline.ts:~665`) → empty-flow L2 = `errored`/blocking. **(S)**
- Writer coherence validation extending `visual-tests-writer.mjs:111-121` (RULE-1/2). **(S)**
- Per-test distinctness hash (4a) wiring existing `hashCounts`/`identical` (`:698-709`) into L2 shot selection (`:982-988`). **(S)**
- STUCK_CAPTURE → block when L2 present + `distinctHashes===1` (4b, mirror bash gate `:762`). **(S)**
- Feed `stepLog` into the L2 judge prompt + fix the unconditional POST-INTERACTION claim (`:994`, 4c). **(S)**
- Promote playwright-unresolvable degrade to `errored` (`:606-610`, 3f). **(XS)**

**Phase 1 — Seam self-verification + honest classification (~2-3 days).**

- Harness-readiness gate `waitForFunction(__harness.ready)` after goto (3e) + distinct `SEAM_ABSENT`. **(S)**
- Wiring-presence guard: feature imports `useGameStateMachine` (5a). **(S)**
- Wire classifier `resolvedLevel`/`needs-probe` into `buildQaExecutePipeline` (RULE-3) — kill the dead report path (`visual-test-classifier.ts:599-626` → runtime). **(M)**
- Schema reconcile: add `'win'`, retype reducer status, CI subset check (3h, `registry.ts:262-268`). **(S)**
- Poll-ify `assert` (3d). **(XS)**

**Phase 2 — Agentic-L2 core (the net-new engine, ~4-6 days).**

- `waitForEvent`/`waitUntil` action + `page.waitForFunction` interpreter branch (3a) — `epic-workflow.ts:156-178`, `probe-step-schema.ts`, `visual-qa-pipeline.ts:619-648`. **(M)**
- Force-state seam command (`dispatch`/`forceStatus`) in `registry.ts:416-423` + probe action + interpreter branch (3b). **(M)**
- Bounded `repeat`/`untilEvent` loop action (3c). **(M)**
- Resolve `seed` (implement via dispatch or delete, 3g). **(XS)**
- Events stream: `useGameStateMachine` pushes `{type,tick}` to `__harness.events` on transitions so `waitForEvent` can poll `events contains 'over'` (PRD §3.7). **(S)**

**Phase 3 — QA-AUTHOR ownership + fix-loop closure (~1 week).**

- QA-AUTHOR agent owns flow+assert authoring at story-dev start; PM `verify` intent at planning. **(L)**
- Deterministic exit gate: L2-state re-run closes the fix loop; `reach-wrong` triage class; `story.vqa.fix` target in `reflector-apply.mjs` (§3.5). **(L)**
- Re-run pamcan6 AC-S7-1/3/5 as REAL_DEFECT send-backs (build the game); AC-S7-4 under a real force-state flow.

**Sequencing:** Phase 0 is highest ROI (converts the pamcan6 false-positive into an honest block with already-computed signals). Phase 2 is the genuinely-agentic core. The redesign doc (§3.1–3.6) is the design of record for Phases 2–3 — this plan is its enforcement/implementation layer.

---

## 7. Key files (all verified against live code)

| File                                                  | Anchors                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `functions/shared/pipelines/visual-qa-pipeline.ts`    | partition `:665-666`; `runOne` `:552-565`; `runFlow` `:605-663`; assert `:638-648`; integrity `:688-730`; hard gate `:762`; L2 shot select `:982-988`; L2 prompt `:994`; `l2Tests` `:462`; classifier wiring `:331-354` |
| `functions/shared/boilerplates/registry.ts`           | seam publish `:416-423`; snapshot shape `:262-268`; tamper-guard `:270-286`                                                                                                                                             |
| `functions/shared/types/epic-workflow.ts`             | `ProbeStepAction` enum `:156-178`                                                                                                                                                                                       |
| `functions/shared/schemas/probe-step-schema.ts`       | grammar incl. phantom `seed` `:40`                                                                                                                                                                                      |
| `functions/shared/services/visual-test-classifier.ts` | level preserve `:230-241`; `needs-probe` resolution `:599-626`                                                                                                                                                          |
| `daemon/pipelines/lib/visual-tests-writer.mjs`        | writer validation `:111-121`                                                                                                                                                                                            |
| `docs/concepts/pipeline-v3/vqa-qa-review-redesign.md` | §3.1–3.7 — design of record                                                                                                                                                                                             |

---

## 8. Concept-stage coordination — handoff to `concept-develop`

The executor + enforcement side is **done and live**. What remains to make agentic L2
_autonomous_ (flows authored without an operator) lives in the concept→authoring track.
This is the contract `QAreview-agentic` needs from `concept-develop`:

**What is now READY for you on the QA side (deployed):**

- The probe grammar supports the full agentic set: `press/hold/pointer/tap/click/wait/
clock/assert/waitForEvent/repeat/force` (`functions/shared/types/epic-workflow.ts`
  `ProbeStepAction`; zod in `functions/shared/schemas/probe-step-schema.ts`).
- The runtime executes them against `window.__harness` with a readiness gate, poll-assert,
  event-wait, drive-until-event, and force-state (`visual-qa-pipeline.ts` `runFlow`).
- The deterministic gate blocks a `level:'L2'` test that lacks a flow
  (`CONTRACT_INCOMPLETE`) and a seam-asserting flow whose seam never published
  (`SEAM_ABSENT`). So a half-authored probe can no longer pass.
- New canvas-game apps publish a DRIVABLE seam (`dispatch`/`forceStatus`/`events`).

**What `concept-develop` must deliver (the two missing pieces):**

1. **PM emits `verify` intent on every AC** (`AcceptanceCriterion.verify` is already in the
   type — `build | appearance | state | behavior | manual`). Today plans ship ACs with no
   `verify`, so the classifier's oracle-routing (`visual-test-classifier.ts`
   `deriveLevelFromVerify` / `resolvedLevel`) stays dormant and everything falls to the
   shape classifier. Emit it at plan time (the altitude rule: PM sets intent, QA-AUTHOR
   sets the concrete L-level). This is the single highest-leverage upstream change.
2. **QA-AUTHOR step authors the flow + asserts at story-dev start** (redesign §3.4), when
   the seam shape is known. For a `behavior`/`state` AC it must emit a probe using the
   verbs above — e.g. `force`/`waitForEvent`/`assert` for a terminal-state overlay, or
   `repeat…until-event` to play to it. The Phase-0 gate already REJECTS a `behavior`/`state`
   AC that arrives without one, so this closes the loop deterministically.

**Boundary note:** force-state is new-apps-only (the boilerplate scaffold change); existing
app worktrees keep the observe-only seam. And a _green_ run also needs the DEV side to mount
the real game — `SEAM_ABSENT`/`CONTRACT_INCOMPLETE` now force that, but the dev prompt should
keep steering it (`pm-plan-prompt.ts` already does for the assembly story).

> Cross-referenced into `concept-stage-v2-bmad.md` (the concept session's doc) so the
> `verify`-intent + QA-AUTHOR work is picked up there.

---

## Appendix — provenance

Produced by a 6-agent multi-agent audit (`ultracode` workflow `wf_8c5a4a48-c3c`): 4 parallel dimension audits (executor-capability, authoring-and-levels, seam-and-app-contract, design-vs-built) → adversarial verification (every load-bearing claim re-checked against the repo with `file:line`) → synthesis. One audit dimension (design-vs-built) hit a structured-output retry cap; its scope is covered by the verification pass and the redesign reconciliation in §0/§6. One citation was flagged unverified by the verifier (`dev-subagent-prompt.md.tpl:29-59` "no QA-AUTHOR step"); the underlying claim (no enforcing QA-AUTHOR gate) stands on verified runtime/writer evidence and is addressed in §2 / Phase 3.
