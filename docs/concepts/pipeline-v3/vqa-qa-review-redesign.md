# VQA + QA-Review Redesign — Behavioral Verification & the Deterministic Seam

**Status:** v0.4 — design draft (adversarial-stress-hardened; generalized to all app types + human-in-the-loop, §3.7; coordination rounds 1–3 CLOSED, 2026-06-16). **See PRD §11 Hardening for the resolutions that OVERRIDE this doc where they conflict.**
**Author:** Ricardo (with Claude + agent panel)
**Date:** 2026-06-16
**Lineage:** wave-gate VQA v2.6 (`wave-gate-vqa-implementation-plan.md`) + QA Review v2 (`qa-review-redesign.md`, IMPLEMENTED 2026-06-12) → **VQA v3 (behavioral probes + deterministic state seam)**
**Scope:** the **Developing-stage VQA (wave gate)** and the **QA Review stage** — how tests are authored, what they can observe, how levels are set, and how failures are fixed agentically until green. The **Concept stage is owned by a separate session** (`concept-stage-v2-bmad.md`); §9 of this doc is the coordination contract between the two.

> **Design intent in one line:** today a verdict is _an LLM judging a single static idle screenshot against a prose AC_. Replace that primitive with a **probe (reach → act → observe over controlled time)** whose oracle is **deterministic-first (read the app's state), vision-second (judge the right frame)** — so Playwright tests can actually _inspect_ behavior and the agentic fix loop can actually _close_.

---

## 0. TL;DR

1. **The disease** is the atomic unit: a static idle frame + an LLM vision judge. `UNVERIFIABLE`, the "idle-AC / unit-AC split", "interaction-gated → Accept", the `needsBrowser` floor, and the multi-lens panel are all **scar tissue around that one wrong primitive** (§1).
2. **The cure is the codebase's own accepted principle** (`boilerplate-runtime-contract.md`): _a fact the app already knows should be **read**, not **inferred**._ VQA infers behavioral truth from pixels the way deploy used to infer `basePath`. Same cure: **declare it, read it** (§3.2).
3. **Re-found the test as a probe** — `reach → act → observe` under `page.clock` control, driven by Playwright, with a **full interaction grammar (click / fill / press / tap / gesture / select / drag / seed) + a state-reading oracle** added (§3.1). **Generic across app types** — games/keyboard are one instance; form-apps, dashboards, mobile (Expo-web), and human-in-the-loop chat are first-class (§3.7).
4. **Add a verifiability seam** to the boilerplate runtime contract: every generated app exposes `window.__harness = { ready, snapshot(), events }`. Collision→game-over, spawn, score, lives become **deterministic reads**, not vision guesses (§3.2).
5. **Realize the empty L2.** L0/L1/L2 names stay; L2 ("interaction flow") is _specified but unbuilt_ — give it two oracle modes: **L2-state** (deterministic seam read, _can block green_) and **L2-vision** (judge the post-interaction frame) (§3.3).
6. **Authorship gets one owner.** Today it's split (TEST=code, DEV=visual, undocumented `flow` grammar, nobody owns reach+observe). Consolidate probe authorship under a **QA-AUTHOR** agent at story-dev start; DEV builds the seam; PM authors the _claim + intent_ (§3.4).
7. **Set the L-level at the right altitude.** PM sets a **`verify` intent** at planning (agentic, like `needsBrowser`); the **QA-AUTHOR finalizes the concrete L-level** at story-dev start (when seam-availability is actually known); classifier defaults; operator overrides (§3.4, §9).
8. **Close the fix loop.** Reuse the locked machinery (triage / capped fixer / fix-forward / handoff packet / auto-minted fix story / reflector). The deterministic L2-state oracle is what lets the loop have a real **exit gate**; add a `reach-wrong` triage class so failures route to the right _author_ (§3.5).
9. **One probe engine, two checkpoints** — wave gate (catch + fix-forward) and QA Review (confirm + ship) share the runner, the seam, and one verdict vocabulary (§3.6).

---

## 1. The disease (one root, three organs)

**The atomic unit of verification is wrong.** A verdict today = _an LLM judging a single static idle screenshot against a prose AC_. The judge prompt is explicit: _"This is a SINGLE STATIC FRAME at idle: no clicks, no keypresses, no elapsed time, nothing in motion."_ (`daemon/lib/wave-vqa-runner.mjs:173-175`).

Everything else in the stack is compensation for that primitive: the `UNREACHABLE` verdict (`wave-vqa-runner.mjs:184-186`), the `verifiable:false → UNVERIFIABLE` rollup, the PM's "phrase the AC about the idle state" rule (`pm-plan-prompt.ts:282-293`), "interaction-gated → operator Accept" (`Plan.qaAcceptedTestIds`), and the `needsBrowser` L0→L1 floor (`visual-test-classifier.ts:239-246`).

Three organs:

1. **Observation is too weak.** A static frame cannot contain _behavior, time, or input_. A game's truth is _state over time under input_ — structurally absent from one snapshot.
2. **The oracle is the wrong kind.** A probabilistic vision-judge is used for truths that are _deterministic and machine-knowable_ (collision→game-over, spawn count, score, lives). It conflates _"I can't see it"_ with _"it's wrong"_ — which is exactly what `UNVERIFIABLE` is.
3. **Authoring is decoupled from verifiability.** Three authors — PM writes the AC `text` (`epic-workflow.ts:80-84`), DEV writes the (undocumented-grammar) `VISUAL_TESTS` block (`story-pipeline.ts:631-704`), TEST writes a jsdom loop test that never reaches the visual verdict (`story-pipeline.ts:466-468`) — and **nobody owns "is this AC reachable + observable, and how."** Result: **L2 (interaction flows) is defined but empty** (pong1: "L2 empty", `qa-review-redesign.md §2.1`).

### 1.1 The field evidence (pacman1, 2026-06-12)

Two QA-Review failures, neither a real bug — both pure consequences of the disease:

- **E7 — interaction-gated false negative.** AC: _"dark overlay … white 'PRESS SPACE TO START'"_, `needsBrowser:true`. The wave-gate VQA captured the **START-button screen** and (correctly, given its rules) refused to FAIL → `UNVERIFIABLE`. The overlay state was reachable; **nothing ever pressed Space to reach it.** (Organs #1 + #2.)
- **E4 — isolated-preview vs final-assembly drift.** AC written against the story's **feature-isolation surface** (`/?feature=ghosts`, black bg); in the assembled game the ghosts render on the maze, so the judge flagged a "background" mismatch that isn't a defect. (Organ #1 — wrong surface.)

Both were ultimately **Accepted** — the system _salvaged_ them after the fact. The goal of v3 is to **stop generating them.**

---

## 2. Verified map of what exists today (do not rebuild)

| Concern                      | Where                                                                                                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L0/L1/L2 contract            | `functions/shared/types/epic-workflow.ts:86-100`                                                                                                                                                                                               | L0=bash, L1=Haiku static frame, L2=Sonnet multi-step flow. Auto-classified at `qa-aggregate`, overridable at the operator ContractGate.                                                                                                                                                                                  |
| Level budgets                | `functions/shared/pipelines/visual-qa-pipeline.ts:180-192`                                                                                                                                                                                     | `QA_LEVEL_DEFAULTS` (L0 ~$0/5s, L1 ~$0.02/45s, L2 ~$0.1/90s).                                                                                                                                                                                                                                                            |
| Test spec                    | `epic-workflow.ts:121-177` (`VisualTestDef`), `:106-119` (`VisualTestFlowStep`)                                                                                                                                                                | **`flow.action` = `navigate\|click\|wait\|screenshot\|fill` — NO `press`/keyboard.** Legacy free-text `action?` is parsed but never executed.                                                                                                                                                                            |
| AC schema                    | `epic-workflow.ts:80-84`; `plan-output-schema.ts:42-48`                                                                                                                                                                                        | `{ id, text, needsBrowser }` only. No level, no oracle intent, no reach.                                                                                                                                                                                                                                                 |
| PM prompt                    | `functions/shared/prompts/pm-plan-prompt.ts`                                                                                                                                                                                                   | role `:60-62`; "screen-verifiable" `:258-261`; **idle-visible rule** `:282-293` (the workaround to harden, see §9).                                                                                                                                                                                                      |
| Wave-gate VQA (dev-time)     | `daemon/lib/wave-vqa-runner.mjs`                                                                                                                                                                                                               | boot → evidence (agentic) → verifiability gate → judge panel (lenses `:106-117`) → triage → capped fixer → fix-forward → report. **Idle frame only, zero interaction** (`:140-141`, `:173-175`).                                                                                                                         |
| Wave-gate invocation         | `daemon/lib/wave-merge-runner.mjs:1107-1124`; armed `daemon/agent-daemon.mjs:5440-5503`; fix stories `:5611-5658`                                                                                                                              | Runs between post-merge validation and the green advance; judged failures never block green.                                                                                                                                                                                                                             |
| Per-story VQA                | `functions/shared/pipelines/story-pipeline.ts:1121-1156`                                                                                                                                                                                       | Judged VQA **removed**; now a boot-smoke PAGE_STATE classifier only (partial-world rationale).                                                                                                                                                                                                                           |
| Final QA pipeline            | `visual-qa-pipeline.ts`: `qa-prepare :437-625`, `runOne` static `:501-514`, **`runFlow :539-573` (snake3 — DOES interact: click/fill/wait/navigate/screenshot)**, L0 `:628-686`, L1 `:697-787` (prompt `:719`), L2 `:792-863` (prompt `:819`). | **Stale-prompt bug:** L2 judge is told _"flow interactions are NOT executed … idle"_ (`:819`) even though `runFlow` executed them → forced `UNCERTAIN`.                                                                                                                                                                  |
| Classifier                   | `functions/shared/services/visual-test-classifier.ts:174-254`                                                                                                                                                                                  | shape→level; rigor cap `:123-127` (`prototype→L0, mvp→L1, production→L2`); `needsBrowser` floor `:239-246`.                                                                                                                                                                                                              |
| Verdict types                | `functions/shared/types/qa-report.ts:80-86`                                                                                                                                                                                                    | `pass\|fail\|uncertain\|skipped-budget\|errored\|pending`; `observability` tag `:140`; `failureClass` `:133`.                                                                                                                                                                                                            |
| Code-test author             | `story-pipeline.ts:333` (TEST), goal `:377-439`, canvas game-loop integration `:466-468`                                                                                                                                                       | Already drives the game loop in jsdom and inspects `game.entities.length` / `ctx.drawImage` — _the deterministic instinct already exists, just disconnected from the visual verdict._                                                                                                                                    |
| Boilerplate runtime contract | `functions/shared/boilerplates/registry.ts` + `boilerplate-runtime-contract.md`                                                                                                                                                                | The "declare, don't infer" precedent the seam extends.                                                                                                                                                                                                                                                                   |
| Reflector                    | `in-pipeline-vqa-and-reflector-learning.md §3.6` (`story.vqa.fix`); `daemon/pipelines/reflector-apply.mjs`                                                                                                                                     | **Correction (H5):** `reflector-apply.mjs` is a **working** 291-line on-disk applier (tested), NOT a stub. It routes `project-claude-md`/`project-skill` to real writers + git commit. Gap: **no `story.vqa.fix` case** in its switch — that target is the work. (REFLECTOR scheduler auto-fire is separately deferred.) |

**Reuse verbatim** (do not re-coin): claim-centric / single-counted / evidence-linked; claims table; universal evidence drawer; verdict strip; gate arc (`W2 ✗ → W3 ✓`); gate matrix; wave-gate VQA; evidence agent; verifiability gate; judge panel / lenses; triage (`code-bug | environment | ac-wording`); capped fixer; fix-forward; handoff packet; auto-minted fix story (`origin: 'wave-vqa-fix'`, `fixesWave`); `gateVqa` states (verified / fixed-in-gate / fixed-by-story / fix-forwarded / unverifiable); `idle frame`; `capturedSurface`; behavioral verification; `criteriaRef`; coverage check; `needsBrowser`; idle-visible signal; BDD given/when/then; `story.vqa.fix`; ReflectionRow; bash-first; **judged ≠ blocking / deterministic = blocking**; no keyword/domain hardcoding; adoption graded from telemetry.

---

## 3. The redesign

### 3.1 Re-found the test as a probe: REACH → ACT → OBSERVE (over controlled time)

The atomic unit is no longer "static idle screenshot judged by an LLM." It is a **probe**:

- **reach** — `navigate` + optional seed (`addInitScript` storage, route mocks).
- **act** — an ordered action list, **including keyboard** (`press`/`hold`/`keydown`), pointer-at-coords (canvas), and **clock advance** (`page.clock`) for deterministic time.
- **observe** — a **tiered oracle** (§3.3): deterministic state read (preferred) and/or a vision judge of the _post-action_ frame.

Playwright drives it (extend the substrate, never rebuild — consistent with the v3 "never rebuild" rule). Missing primitives to add to `VisualTestFlowStep` (`epic-workflow.ts:106-119`):

```ts
export interface ProbeStep {
  action:
    | 'navigate'
    | 'click'
    | 'fill'
    | 'press'
    | 'hold' // NEW — page.keyboard.press / down+up
    | 'pointer' // NEW — click at {x,y} for canvas
    | 'clock' // NEW — page.clock.fastForward / runFor
    | 'wait'
    | 'screenshot'
    | 'assert'; // NEW — read the seam, compare (L2-state)
  key?: string; // 'Space', 'ArrowLeft' (press/hold)
  x?: number;
  y?: number; // pointer (canvas)
  ms?: number; // wait / clock advance (deterministic, not wall-clock)
  selector?: string;
  value?: string;
  url?: string;
  label?: string;
  // assert (L2-state oracle):
  expr?: string; // e.g. "snapshot().gameState"  (evaluated against window.__harness)
  op?: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'truthy' | 'contains';
  expected?: unknown;
}
```

> **Determinism note:** replace `--wait-for-timeout` with `page.clock` for any time-dependent probe ("at second 2", "spawn within 10s"). A probe that gates a fix loop must not be flaky (§3.5).

### 3.2 The verifiability seam — declare, don't infer (cure for organs #1 & #2)

Extend `BoilerplateRuntimeContract` (`registry.ts`) with a `testHarness` block. Every boilerplate **guarantees** the generated app exposes a deterministic, **test-only** seam:

```ts
// On the contract:
interface BoilerplateRuntimeContract {
  // …existing dev/build/deploy blocks…
  testHarness?: {
    globalKey: string; // 'window.__harness'
    readySignal: string; // 'window.__harness.ready === true'
    snapshotShape: string; // doc/JSON-schema of snapshot() for the QA-AUTHOR to cite
  } | null;
}

// In the running app — snapshot() shape is DOMAIN-SPECIFIC per boilerplate (game shown; see §3.7):
window.__harness = {
  ready: false,
  snapshot() {
    return { gameState, score, lives, entities, gameOver, level, lastCollision /* … */ };
  },
  events: [
    /* append-only domain events: 'spawn','collision','game-over','level-up' */
  ],
};
```

Then any deterministic app-state becomes `page.evaluate(() => window.__harness.snapshot())` → **deterministic PASS/FAIL, no vision guess** — and it generalizes across app types: `collision→gameover` (game) · `submit→errors` (form-app) · `filter→selectedRange` (dashboard) · `send→messages.length+1` (chat). This is the same **declare-don't-infer** move the boilerplate-runtime-contract proposes — **but note (Hardening H6): that contract is still doc-only; `nodeModulesStrategy` was never built as a type. E2-S1 must CREATE the `testHarness` field on `BoilerplateMetadata`, not extend an existing one.** Also (H1): the seam must not be DEV's self-graded oracle — QA-AUTHOR owns the assertion + shape, it is tamper-checked, and independent observables are preferred. The shape is per-boilerplate (§3.7).

Constraints: seam is **test-only** (no-op / tree-shaken in production builds); it is a **citation source** (§9 Q6) so DEV builds the shape the QA-AUTHOR reads; DEV already runs the game loop in jsdom integration tests (`story-pipeline.ts:466-468`), so populating the seam is incremental, not new work.

### 3.3 Re-tier by oracle strength — keep L0/L1/L2 names, realize the empty L2

| Level               | Claim it proves                                                                                    | Oracle                                          | Blocks green? |
| ------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------- |
| **L0**              | Liveness/structural — boots, 200, console/pageerror clean, non-blank, text present                 | **bash, deterministic**                         | **Yes**       |
| **L1**              | _Appearance at load_ — "ghosts have dome tops + wavy skirts"                                       | LLM vision (single idle frame)                  | No (judged)   |
| **L2-state**        | _Behavior, deterministic_ — "after press Space, `gameState==='playing'`"; "collision ⇒ `gameOver`" | **seam read, deterministic**                    | **Yes**       |
| **L2-vision**       | _Appearance after interaction_ — "after start, the maze + HUD look right", on the correct surface  | LLM vision (post-action frame)                  | No            |
| **L3** _(deferred)_ | open-ended "play it, find what's broken"                                                           | agentic VLM (Midscene / UI-TARS / computer-use) | No            |

> **Rigor exemption (resolved w/ Concept v2 v0.3, MQ2/Q5).** The `rigor` cap (`prototype→L0, mvp→L1, production→L2`, `visual-test-classifier.ts:123-127`) must apply **only to the LLM/vision tiers** (L1, L2-vision, L3). **L0 and L2-state are deterministic = free** and are therefore **rigor-exempt** — a `prototype` game still gets deterministic collision/score/spawn verification. Capping L2-state by rigor would re-introduce the disease (a `prototype`/`mvp` plan silently downgraded to a vision guess for a truth the seam already knows). Change: split the cap so it gates oracle _cost_, not oracle _determinism_.

The disease fix: **give L2 a deterministic oracle (the seam) and actually drive it (keyboard + clock).** Most of today's `UNVERIFIABLE` tail moves to **L2-state** and becomes flake-free truth. Concurrent bug fixes: add keyboard (`epic-workflow.ts:108`), un-stale the L2/L1 judge prompts (`visual-qa-pipeline.ts:719`, `:819`), and let the wave-gate evidence path _interact_ instead of only capturing the idle frame.

### 3.4 Who authors, and when (full clarity)

| When                           | Who                                                                                             | Produces                                                                                                | The Playwright test?                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Concept / planning**         | **PM**                                                                                          | AC: `needsBrowser` + BDD `given/when/then` + **`verify` intent** (`build\|appearance\|state\|behavior`) | **No** — the _claim_ + oracle intent. PM never writes Playwright.            |
| **Start dev (story, TDD red)** | **QA-AUTHOR** (promote today's test-author to own **both** code tests _and_ interaction probes) | the **probe spec** (`reach→act→observe`) compiled from the BDD AC; **proposes the concrete L-level**    | **Yes — authored here.** Single owner of "reachable + observable, and how."  |
| **Story dev**                  | **DEV**                                                                                         | feature + the `__harness` **seam**                                                                      | Builds the surface the probe _reads_. Satisfies probes; doesn't author them. |
| **qa-aggregate**               | classifier (deterministic)                                                                      | level default/cap + coverage check (`criteriaRef`)                                                      | Backstop, not authorship.                                                    |
| **ContractGate**               | operator                                                                                        | level override                                                                                          | Human override (exists).                                                     |
| **Wave gate / QA Review**      | probe-runner                                                                                    | executes probes                                                                                         | Runs, not authors.                                                           |

**L-level altitude (the key recommendation).** `needsBrowser` is a property of the _claim_ — the PM knows it. L0/L1/L2 is a property of the _mechanism_ — it depends on **whether a deterministic seam exists**, which isn't known until DEV builds it. So **do not have the PM hand-set L0/L1/L2** (that's inferring a mechanism). Split across two altitudes:

- **PM sets `verify` intent at planning** (agentic, exactly like `needsBrowser`): the planning-altitude fact, sibling of the BDD triple. `needsBrowser` is **derived** for the auto-verifiable values (`appearance|state|behavior → true`, `build → false`) but **stays independent/explicit for `verify:'manual'`** (MQ1-followup) — a `manual` AC may be a real-device or human-judgment claim that needs no browser at all, so the `verify!=='build'` shortcut would mis-derive it. Kept as a computed-with-override field (the classifier floor + wave-gate arming key off it).
- **QA-AUTHOR finalizes the L-level at story-dev start**, derived deterministically: `build→L0 · appearance→L1 · state→L2-state if seam else L1-vision · behavior→L2`. The **rigor cap applies to vision tiers only** (L1/L2-vision/L3); **L0 and L2-state are rigor-exempt** (deterministic = free). The `needsBrowser` floor still applies; the operator can override.

### 3.5 The closed agentic fix loop (until tests pass)

Reuse the locked machinery (`wave-gate-vqa-implementation-plan.md §2.3-2.6`): triage / capped fixer (mvp=1, prod=2) / fix-forward / auto-minted fix story / handoff packet / reflector. Four additions make it actually _close_:

1. **Deterministic exit gate (the key insight).** _You cannot close a loop on a probabilistic oracle_ — you can never _know_ it's fixed. **L2-state** gives a deterministic re-run: fix → re-run the exact failing probe → seam asserts true → **closed.** Vision failures do **not** enter an unbounded fix loop; they route to ac-wording / Accept.
2. **Disease-aligned triage routing.** Extend `code-bug | environment | ac-wording` with **`reach-wrong`**: `code-bug → DEV fixer`; **`reach-wrong → QA-AUTHOR re-authors the probe`** (not the code); `ac-wording → PM/operator re-word or Accept`; `environment → infra`. _Routing the failure to the right **author** is the "disease not symptom" mechanism._
3. **Bounded escalation** (honor `costCeilingUsd` + ship-MVP): loop until the deterministic probe passes **OR** round cap **OR** plan cost ceiling → then fix-forward → one fix story → operator card with handoff packet. **Block green on L2-state + boot/build/test** (extends "deterministic = blocking" to behavior); **never on vision**.
4. **Reflector closes for real.** Each confirmed-fixed _deterministic_ failure emits `story.vqa.fix` with the **seam delta** (before/after `snapshot()` + diff). Correction (H5): `reflector-apply.mjs` is a **working** on-disk applier — the real work is adding a `story.vqa.fix` _target_ to its switch, not "wiring a stub."

### 3.6 Unify the two systems (both together)

One probe-runner library (Playwright + seam + clock + action grammar + tiered oracle + **one** verdict vocabulary) at both checkpoints — killing the divergent verdict vocabularies, the stale "idle" prompts, and the interact-in-one-but-not-the-other drift:

- **Wave gate** (dev-time) = fast tier (L0 + L2-state + cheap L1) + fix-forward.
- **QA Review** (plan-scoped) = full tier (+ L2-vision, + L3 when enabled) + ship gate, on the merged assembly, operator-gated.

The claim-centric surface (claims table / evidence drawer / gate arc) renders the richer evidence (state snapshots + frames) **verbatim** — no UI redesign, just richer payloads.

---

### 3.7 Stress-test matrix — app-type generality & the human-in-the-loop boundary

> The pipeline ships `nextjs-base / canvas-game / form-app / dashboard / vite / mobile(Expo)` (`functions/shared/boilerplates/registry.ts:143-150`). The probe model is **interaction-generic and platform-generic** — games/keyboard are _one_ instance. Stress-tested against the boilerplate surfaces and the honest Playwright limits (`playwright-with-claude.md:456-468`):

| Stress case                        | Example AC                                                     | `verify`              | How the probe handles it                                                                                                                                                                        | Decision / gap                               |
| ---------------------------------- | -------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Pointer / form input               | form-app: "submit blank email → inline error"                  | state                 | act `fill`+`click`; observe seam `{errors}`                                                                                                                                                     | generic ✓                                    |
| Multi-step flow                    | checkout wizard: "step 2 done → Pay enables"                   | behavior              | reach→act(steps)→observe per step                                                                                                                                                               | generic ✓                                    |
| Data / filter view                 | dashboard: "pick last 30d → KPI updates"                       | state (+appearance)   | act `select`; observe seam `{selectedRange,data}` + L1 chart                                                                                                                                    | generic ✓                                    |
| Keyboard / canvas                  | game: "press Space → playing"                                  | behavior              | act `press`; observe seam `{gameState}`                                                                                                                                                         | one instance ✓                               |
| Time / async                       | "toast auto-dismisses after 5s"                                | behavior              | `page.clock` advance; observe                                                                                                                                                                   | generic ✓                                    |
| **Generative / non-deterministic** | chat: "AI replie3s to my message"                              | behavior              | L2-state **structural** ("assistant msg appended within Ns", `count+1`); judged = on-topic. **Exact-match oracle FORBIDDEN.**                                                                   | PRD rule (below)                             |
| **Human-in-the-loop chat**         | debate: "human posts argument → AI responds → human Publishes" | behavior + **manual** | test-mode **scripted human-partner** seam drives the human turns → the AI-response is auto-verifiable (state); the **Publish side-effect mocked**; subjective conversation quality = **manual** | needs `verify:'manual'` + partner seam       |
| External auth                      | "Google login → dashboard"                                     | behavior              | test-mode: token injection / OAuth bypass (`given: 'authed test session'`)                                                                                                                      | needs app test-mode seam; else `manual`      |
| External side-effect               | pay / verify-email / captcha                                   | behavior              | test-mode (Stripe test keys, mock inbox, captcha test keys)                                                                                                                                     | needs app test-mode seam; else `manual`      |
| Real device / native               | mobile: push, camera, biometrics, native gesture               | **manual**            | Expo-web emulation covers **layout/flow only** (`registry.ts:1356`); native = operator-verified                                                                                                 | real-native driver (Appium/Maestro) DEFERRED |
| Video / audio perception           | "video plays, shows X at 0:30"                                 | behavior / manual     | clock-stepped screenshots at key moments + judged; full perception = `manual`                                                                                                                   | partial                                      |

Three things this surfaces that the game-only framing hid:

1. **`verify: 'manual'` — the human-in-the-loop verdict (NEW; re-opens one coordination item, §9.3).** For ACs whose truth requires a real human or an un-stubbable external (the `playwright-with-claude.md:456-468` class), the PM tags `verify:'manual'`. These are **never auto-passed and never silently failed** — they route to an **operator verification lane** in QA Review (a checklist the operator confirms before ship; blocks ship until confirmed). This is the principled home for the human-in-the-loop concern, and it honors "never auto-bypass a designed gate" + the party module's consent-gate ethos. Schema impact: extend the `verify` enum to `build | appearance | state | behavior | manual`.

2. **Test-mode boundary seam — same cure (declare, don't infer).** The fix for external/human boundaries is a declared **test mode** that stubs the other side: a scripted chat partner, an OAuth token, Stripe test keys, a mock inbox, captcha test keys. The AC's `given` states "in test mode"; the probe then runs deterministically. An external boundary with **no** test-mode stub falls back to `verify:'manual'`. The boilerplate runtime contract declares which test-mode stubs it ships (extends `testHarness`), and stories **cite them via the existing `references[].source:'harness'`** — no new reference source (MQ7). _This is what turns "chat with a human" from unautomatable into a deterministic L2-state probe for everything except the genuinely subjective._

3. **No exact-match oracle for generated content.** Any AC over LLM/generative output asserts **structural invariants** (a non-empty `role:'assistant'` message appended; `messages.length` increased; latency < N via `page.clock`) at L2-state, and **semantic adequacy** (on-topic, safe) at L2-vision/judge (judged ≠ blocking). Exact string/pixel match is forbidden — it would re-introduce flakiness the seam exists to remove.

**Platform note (mobile).** The probe runner is a **driver abstraction**, not "Playwright" hardcoded. Today every driver = Playwright (web; mobile = Expo-web target + device emulation, layout-only). The seam concept generalizes to React Native (a JS state bridge); the **real-native driver (Appium / Maestro / Detox) is deferred** — native-only ACs are `manual` until it lands.

**Boilerplate-blindness (forensic root, problem #4).** The probe runner, capture, seam-location, test-mode stubs, and judge prompts must read `BOILERPLATE_REGISTRY[type]` + the runtime contract — **never** hardcode an entry point ("Read src/App.tsx"). Each boilerplate declares its own `testHarness.snapshotShape` and stubs (no keyword/domain hardcoding).

> **Hardening (v0.4) — what the matrix does NOT yet cover, made honest (full detail: PRD §11 H4/H10/H11).** The seam is **production-absent, in-process, post-hydration, same-origin, single-snapshot** — every gap below is one of those boundaries:
>
> - **Realtime / multiplayer** (the debate apps!) — a single-page seam can't see cross-client truth; `page.clock` corrupts WebSocket timing. **v1 = `verify:'manual'`, explicitly** (this row must exist); a multi-context/`actor` primitive is deferred.
> - **Race / async** — a single passing re-run does NOT prove a race fixed → **flake-guard (N-run) closure** (H2), never single-pass.
> - **Render-class** (animation quality, chart geometry, WebGL pixels) — the seam reports state the user never saw → **L2-state cannot block-green alone** here; force L2-vision/geometry (H3/H5-render).
> - **Unlisted-but-automatable** (file I/O, a11y via axe, i18n/RTL, responsive/`viewport`, security-on-prod-build, offline, audio-structural, long-running server-time jobs, cross-origin iframes) — add rows + grammar primitives, or list as deferred in §8 — **stop implying coverage** by funneling them to `manual`.

---

## 4. Tool decision (the debate, grounded)

**Extend Playwright** (substrate — never rebuild): `+ keyboard`, `+ page.clock` (determinism for "second 2 / 10s spawn"), `+ page.evaluate` seam reads. **Vision judge stays Claude** (Labs is a single-operator internal factory on Max — no VLM fleet, no per-token Bedrock). **Agentic exploratory** (Midscene / UI-TARS / computer-use) = **deferred L3**, only if open-ended exploration is ever needed. Pixel-baseline diffing stays _out_ (`playwright-with-claude.md`: "assert on structure, not pixels") — the seam replaces it.

---

## 5. Build order (smallest loop that proves value first)

1. **Slice 1 — Realize L2 (no seam yet).** Complete the **interaction grammar** — add `press`/`hold`/`tap`/`pointer`/`clock` (and confirm `click`/`fill`/`select`/`drag`) to the action union (`epic-workflow.ts:108`) + interpreter (`visual-qa-pipeline.ts:553-559`) + parser (`:146-167`); **document the `flow` grammar in the DEV/QA-AUTHOR prompt** (`story-pipeline.ts:654-681`); **un-stale the judge prompts** (`:719`, `:819`). → Verifiable: a multi-step interaction test (keyboard _and_ pointer/form) passes end-to-end on at least two boilerplates (game + form-app).
2. **Slice 2 — The seam.** Extend `BoilerplateRuntimeContract` + ship `__harness` in the canvas-game scaffold + add the `assert` step (L2-state oracle) + classifier routing. → Verifiable: collision→game-over verified deterministically, zero vision.
3. **Slice 3 — Authorship + `verify` intent.** PM emits `verify` (coordinate with Concept v2, §9); promote QA-AUTHOR to own probes; per-story L0 + L2-state probes. → Verifiable: probe authored from a BDD AC; level derived, not guessed.
4. **Slice 4 — Close the loop.** Deterministic exit gate **+ flake-guard (H2: N-run for concurrency ACs, no single-pass closure)** + `reach-wrong` triage + **frozen oracle inside the loop (H1: seam/probe immutable mid-loop, tamper-checked)** + bounded escalation; add a `story.vqa.fix` target to `reflector-apply` (H5). → Verifiable: a real behavioral failure auto-fixes and re-passes the same _frozen_ probe over N runs.
5. **Slice 5 _(deferred)_ — L3 agentic exploratory.**

---

## 6. Risks / what NOT to break

- **R1 — Don't re-bake the disease into planning.** The "idle-visible signal" rule (`pm-plan-prompt.ts:282-293`) must be **relaxed for behavior ACs**, not hardened (see §9 Q3). Hardening it while QA builds interaction probes points the two sessions at opposite assumptions.
- **R2 — Seam must be test-only.** No-op / tree-shaken in production builds; never ship `__harness` to users.
- **R3 — Reflector target missing, not a stub** (H5). `reflector-apply.mjs` works on disk; add the `story.vqa.fix` case. REFLECTOR scheduler auto-fire is separately deferred.
- **R4 — Don't block green on vision.** Only deterministic oracles (L0, L2-state, boot/build/test) block.
- **R5 — Keep no-hardcoding.** Key off `touchPoints` + the seam contract + `rigor`, never app/domain keywords.
- **R6 — Don't reintroduce** double-counting, façade gate matrices, or per-story _judging_ (all superseded by the v2 QA Review + wave-gate designs).
- **R7 — Pack/token budget.** Probe specs + seam snapshots compete with file digests in the 30k-token Story Context Pack (`story-context-pack.mjs:39`); render only cited seam sections.

---

## 7. Open questions (this doc's own)

- **OQ1** — Single-`press` probe: L1 or L2? (Classifier today routes `flow.length>1`→L2.) Proposal: any probe with an `act` step → L2.
- **OQ2** — Where do probe specs live — extend `VisualTestDef` (current) or a new `probes[]` on the story (§9 Q7)?
- **OQ3** — Should the wave gate run **L2-state** per-story (partial world) or only at the gate? Proposal: per-story for probes the story's own surface supports; full L2 at the gate.
- **OQ4** — L3 trigger: rigor=`production` only, or an explicit operator opt-in?

---

## 8. Appendix A — agent panel (party-mode debate, 2026-06-16)

Pressure-tested by: **Murat/TEA** (deterministic exit gate; "you can't close a loop on a judge that shrugs UNVERIFIABLE"), **Sue Render** (seam + `page.clock` for game state), **Rick** (scope: a missing `page.keyboard.press` ≠ a VLM fleet; route `reach-wrong` to the test author), **Ludwig** (probe orchestration; authoring-time agent vs runtime agent), **Winston** (one probe engine / two checkpoints), **Dave ups!** (headless WebGL `--use-gl=angle`, blast radius / timeouts on EC2), **BMad Master** (synthesis). Tooling grounded in 2026 web research (Playwright Clock API, Midscene.js, UI-TARS, Playwright MCP, canvas/WebGL testing) — see chat transcript.

---

## 9. Coordination contract with the Concept-stage v2 session

> The Concept stage (`concept-stage-v2-bmad.md`) owns the PM role and plan structure. These designs **meet at the acceptance criterion**: Concept v2's BDD triple (`given/when/then`, §4) is _exactly_ the input this doc's probe compiler consumes (`given`→reach, `when`→act, `then`→observe). The questions below decide whether the two designs snap together or drift.

### 9.0 Resolution status (Concept v2 v0.3, 2026-06-16)

The Concept-stage session answered all 7 + returned 3 substantive challenges. Status:

| #       | Topic                                  | Resolution                                                                                                                                                                                   |
| ------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1      | `verify` intent                        | **Resolved** — added to `AcceptanceCriterion` (Concept §4). `needsBrowser` **derived** from it (`verify !== 'build'`), kept as computed field.                                               |
| Q2      | machine-observable `then`              | **Resolved (semantic, not syntactic)** — `then` stays prose; `thenObservable` hint added; QA-AUTHOR does prose→`assert` compilation. PM never authors seam exprs.                            |
| Q3      | idle-visible rule                      | **Resolved (reversed)** — relaxed, gated on `verify`: `appearance`→idle-visible MUST; `behavior\|state`+`when/then`→MAY describe post-interaction (Concept §5). The one collision, conceded. |
| Q4      | QA-AUTHOR persona                      | **Resolved** — PM authors claim+intent only; QA-AUTHOR is a Developing-stage persona; PM authors no probes.                                                                                  |
| Q5      | rigor cap                              | **Resolved (this doc, §3.3)** — L0 + L2-state rigor-exempt (deterministic=free); cap gates vision tiers only.                                                                                |
| Q6      | harness citation                       | **Resolved** — `StoryReference.source: 'harness'` added (Concept §4).                                                                                                                        |
| Q7      | `probes[]` slot                        | **Resolved** — probes live in dev-populated `visualTests[]/probes[]`, never in `plan-output-schema`.                                                                                         |
| **MQ3** | uiBearing → seam pre-provision         | **Resolved** — two-altitude scoping (§9.1). Router pre-selects a seam-capable boilerplate; `verify∈{state,behavior}` is the per-AC trigger.                                                  |
| **MQ5** | where the `__harness` shape is defined | **Resolved** — boilerplate contract ships the default shape (v1); per-app `architecture.md` extension **deferred** (§9.2).                                                                   |

**Coordination rounds 1–3 CLOSED (2026-06-16).** Round 2 = **MQ6 `verify:'manual'`** (§9.3). Round 3 = the Concept v0.6 stress-test handoff — **W5** (QA-AUTHOR owns the `manual→behavior` downgrade as a logged reclassification event, forcing `needsBrowser`), **`manualReason`** closed enum, **W2** section manifest (needs serializer section-addressing, H9), **W9** appearance floor (folded into H3), **MQ1/MQ7** confirmed. Full detail: PRD §11 H12. Both docs mutually consistent.

### 9.1 MQ3 — uiBearing → upstream seam provisioning (RESOLVED)

The Concept Router emits `conceptPlan.uiBearing` (Concept §3.2). Their session proposes this could **upstream-provision the `__harness` seam requirement before DEV starts** — a free win, but a **new dependency from VQA v3 onto their Router**, so it wants a deliberate yes/no.

**VQA v3 position: yes, with a refinement.** `uiBearing` is **necessary but not sufficient** — a static marketing page is `uiBearing` yet has no game/behavior state, so it needs no rich seam. The precise trigger for "harness required" is **the presence of any AC with `verify ∈ {state, behavior}`** (which implies `uiBearing`). Recommended coupling:

- `uiBearing` = the **coarse pre-filter** (Router can pre-warn the boilerplate must be harness-capable).
- `∃ AC.verify ∈ {state,behavior}` = the **precise trigger** → (a) the gate-check asserts the chosen boilerplate declares a `testHarness` contract, and (b) auto-seed `references:[{source:'harness'}]` on those stories.
- The Router should **not** know seam internals; it flags "harness-capable boilerplate required," the boilerplate runtime contract owns the shape, DEV populates it. (Same declare-don't-infer boundary as the rest of the contract.)

**Resolved (2026-06-16), two-altitude scoping** — Concept v2 pinned _which step owns each signal_, because they're knowable at different times: **`uiBearing` (Concept Router, runs first) = capability provisioning** → select a seam-capable boilerplate (necessary because the Router fires before any AC exists — without a seam-capable scaffold, a later `verify:behavior` AC has nothing to read). **`verify∈{state,behavior}` (PM decompose, runs later) = the per-AC trigger** → DEV must populate the seam; the AC carries a `references[].source:'harness'` citation. Neither step knows seam internals. Cross-referenced in `concept-stage-v2-bmad.md §6.1`.

### 9.2 MQ5 — where the `__harness` shape is defined (RESOLVED)

The default seam shape (`snapshot()` keys: `gameState/score/lives/entities/gameOver/…`) ships in the **boilerplate runtime contract** (`testHarness.snapshotShape`); `references[].source:'harness'` cites it. Concept v2's recommendation was _both-with-extension_ — an app may **extend** the default via `architecture.md` (cited as `source:'architecture'`).

**Decision (operator): default shape only for v1; per-app `architecture.md` extension DEFERRED.** Rationale (ship-MVP + determinism): the boilerplate default covers the canvas-game common case; the extension path makes the QA-AUTHOR read two seam sources and makes the seam shape plan-specific (harder to keep the Story Context Pack deterministic/cached). Add the extension path only when a real app proves the default insufficient — the `source:'architecture'` slot is reserved now so adding it later is non-breaking.

### 9.3 MQ6 — `verify:'manual'` for the human-in-the-loop / unautomatable class (OPEN — round 2)

**New requirement (operator, 2026-06-16):** the pipeline builds _all_ app types — web, mobile, form/dashboard, and **human-in-the-loop** apps (chat-with-human / debate). The honest Playwright limits (`playwright-with-claude.md:456-468`) define a class of AC that **no probe, seam, or vision judge can verify autonomously**: real OAuth "Allow", email/SMS clicks, captchas, real payments, video/audio perception, real-device/native behavior, and genuinely subjective human judgment.

**Proposal (needs Concept v2 sign-off — it extends their AC schema):**

1. **Extend the `verify` enum** (`AcceptanceCriterion`, Concept §4) → `build | appearance | state | behavior | manual`.
2. **`manual` routes to an operator verification lane** in QA Review — a checklist the operator confirms; **never auto-passed, never silently failed; blocks ship until confirmed.** (Honors "never auto-bypass a designed gate" + the party-module consent ethos.)
3. **Prefer the test-mode seam over `manual`** wherever possible: a declared test mode (scripted chat partner, OAuth token, Stripe test keys, mock inbox, captcha test keys) converts an external/human boundary into a deterministic L2-state probe. `manual` is the fallback only when no stub is possible (subjective quality, real-device-only).
4. **PM authoring rule:** a `behavior` AC that depends on an external/human boundary must either name the test-mode precondition in `given` (→ stays `behavior`) or be tagged `manual`. The gate-check flags any `behavior` AC with an un-stubbed external dependency.

**Question for Concept v2:** accept `verify:'manual'` + the test-mode-seam-preferred rule? If yes, the `manual` lane in QA Review is the operator's human-in-the-loop surface and the two designs stay aligned.

**RESOLVED (2026-06-16) — round 2 CLOSED.** Concept v2 accepted `verify:'manual'` + the guard + two refinements:

- **Altitude rule:** the **PM sets `manual` only for _knowably_-unautomatable ACs**; the **QA-AUTHOR routes the _ambiguous_ cases** at story-dev start (when it discovers no test-mode stub exists). Same intent-vs-mechanism split as the L-level.
- **Gate division:** the **Concept gate-check _challenges_** a `manual` tag (is it really unautomatable, or just un-stubbed yet?); **QA Review _enforces_** the operator verification lane.
- **MQ1-followup:** `needsBrowser` stays independent for `manual` (folded into §3.4).
- **MQ7:** test-mode stubs cite `references[].source:'harness'`, no new source (folded into §3.7).

---

1. **`verify` intent field** — Will you add `verify: 'build' | 'appearance' | 'state' | 'behavior'` to `AcceptanceCriterion` now (alongside `needsBrowser` + the BDD triple), set by the PM? We want it at planning altitude; it's the natural sibling of `needsBrowser` and the source the QA-AUTHOR derives the L-level from.
2. **Machine-observable `then`** — Is `then` meant to stay "screen-verifiable" prose for an LLM judge, or can we co-design the grammar so `when`→action and `then`→a **machine-observable assertion** (seam expr) map 1:1 onto a probe? This is what turns a behavior AC into deterministic **L2-state** instead of vision-judged.
3. **Relax the idle-visible rule** — Are you committed to keeping the "idle-visible signal" rule for `needsBrowser` ACs (`pm-plan-prompt.ts:282-293`)? We need it relaxed: _an appearance AC must be idle-visible; a **behavior** AC may describe a post-interaction state **iff** it carries `when/then`_ — so the probe reaches the state instead of the PM being forced to describe the load frame. **(This is the one direct collision.)**
4. **QA-AUTHOR persona** — In your new role model, is the PM the only AC/test author, or is there room for a **QA-AUTHOR** that compiles probes from ACs at story-dev start? We propose consolidating today's split (TEST=code, DEV=visual) under one QA owner.
5. **L-level ownership** — Do you want the PM to set L0/L1/L2 directly (like `needsBrowser`), or PM-sets-`verify`-intent + QA-finalizes-level? We recommend the latter (mechanism isn't knowable until the seam exists); need alignment.
6. **Seam as citation** — Will you treat the boilerplate runtime contract / `__harness` seam as a `references[]` citation source, so DEV builds the seam shape the QA agent reads — same way `architecture.md` becomes the consistency contract (§6)?
7. **`probes[]` slot** — Should stories carry a `probes[]` / `testTasks[]` slot parallel to `tasks[]` (§4), or do probes live entirely in the QA layer (`VisualTestDef`)? Affects where the QA-AUTHOR writes and how the Story Context Pack carries it.
