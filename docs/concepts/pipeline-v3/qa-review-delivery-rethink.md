# QA Review — Purpose Rethink: Delivery-Driven, Complexity-Tiered

> **Status:** DESIGN / for review · **Created:** 2026-06-24 · **Author:** `QAreview-agentic`
> **Trigger:** pacman3 runs 1–6. Operator observation: "the QA review is epic-driven, but
> that doesn't make sense — it should target the final merged, assembled delivery of the
> plan. Some tests belong at story level in development; some are too complex and need a
> human; the quality of the tests depends on the scripts, which I can't see."
> **Companions:** [`vqa-qa-review-redesign.md`](./vqa-qa-review-redesign.md) (executor mechanics —
> the probe grammar, seam, judge), [`agentic-l2-autonomy-backlog.md`](./agentic-l2-autonomy-backlog.md)
> (the QA-AUTHOR compiler). This doc is about **what the QA stage is FOR**, not how a probe runs.

---

## 0. TL;DR

Final QA today **replays every story's per-AC visual test against the assembled app, grouped by
epic**. That is a _development_ verification pointed at a _finished product_ — the wrong
granularity, largely redundant with the wave gate, and it produces noise (isolated
intermediate-state tests, un-automatable terminal-state tests, single-frame movement tests).

Rethink: **final QA verifies the DELIVERED PRODUCT's key journeys on the merged PLAN in the dev
environment** (`dev.futurator.ai/<plan>`, plan-scoped) — a small curated set, not every AC — and
every test carries a **complexity tier** that routes it to the right verifier, including a
first-class **Human** tier the operator approves. The generated Playwright script becomes a
**visible, editable artifact**. (Terminology: dev = **plan**, staging/prod = **app** — see §3.1.)

---

## 1. What exists today (grounded in code)

### 1.1 Origin — tests are per-AC, authored in development

- The DEV agent authors **one visual test per acceptance criterion**, per story, into
  `visual-tests.md` (`functions/shared/pipelines/story-pipeline.ts:990`; merged + deduped by
  `criteriaRef` in `daemon/pipelines/lib/visual-tests-writer.mjs:99`). Persisted to
  `story.visualTests[]`.
- Shape: `{ id, criteriaRef, level, setup, expect, judge, flow?, screenshot? }`.

### 1.2 Two QA layers — different mechanisms, both per-AC

| Layer         | Code                                                  | On what                       | Mechanism                                                                           | UI column          |
| ------------- | ----------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| **Wave gate** | `daemon/lib/wave-vqa-runner.mjs:435`                  | merged-so-far code, each wave | agent **dynamically captures** evidence per `needsBrowser` AC → judge panel votes   | "Gate W0/W1 ✓/?"   |
| **Final QA**  | `functions/shared/services/visual-qa-launcher.ts:245` | assembled app                 | **executes the DEV-authored `story.visualTests` flows**, flattened across all epics | "Final QA" verdict |

### 1.3 The gap

- **No delivery / journey / smoke / "primary capability" tier exists.** Both layers operate at
  per-AC granularity. Final QA runs _all_ per-AC tests (or all operator-approved ones); there is
  no curated integration subset. (Confirmed: searched journey/integration/delivery/smoke/primary —
  only a story-title "verification" classifier at `story-pipeline.ts:174`, unrelated.)
- **Multi-frame capture is supported** (`visual-qa-pipeline.ts:671` labels per `screenshot` step;
  `:771` final frame) — but the QA-AUTHOR compiler emits only **one** "after" frame, so behavioral
  movement claims are unverifiable (judge: "only one screenshot … no before/after").

---

## 2. The core problem — two questions conflated

The pipeline must answer two distinct questions; today both are answered the same way (per-AC) and
the second is pointed at the wrong granularity.

|                                      | Question                                      | Right granularity                     | Where it belongs                                      |
| ------------------------------------ | --------------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| **Development verification**         | Did each story build its piece correctly?     | per-AC, exhaustive                    | the **wave gate** (already dynamic, per-AC, per-wave) |
| **Delivery verification (final QA)** | Does the assembled product deliver its value? | **per journey / capability**, curated | should be NEW — today it wrongly replays per-AC       |

Symptoms this conflation produced on pacman3:

- **Isolated intermediate-state tests** (Image 18 — "title screen shows PACS 3, no maze visible"):
  legitimate during S6 dev; meaningless as a standalone final-delivery test. (Also mis-routed to
  NEEDS_PROBE because "Press ENTER" trips the interaction-gated regex — a bug, see §4.A.2.)
- **Un-automatable terminal states** (Image 19 — game-over overlay): needs real play to reach;
  there is no tier for "human verifies this."
- **Single-frame behavioral tests** (Images 20/21 — Pac-Man moved): capture works, but one "after"
  frame can't prove _directional_ movement.

---

## 3. The rethink

### 3.1 Purpose of each layer (make the split real)

- **Wave gate = development verification.** Keep exhaustive, per-AC, on merged code. This is the
  right home for "every AC was built." No change to its purpose.
- **Final QA = delivery verification.** A **small, curated set of journey/capability tests** on the
  **merged PLAN in the dev environment** — NOT re-litigating every AC. It confirms the integrated
  product delivers its headline value and the critical journeys work end-to-end.

**Terminology — plan vs app (aligned with `deployment-v2.5.md` §15.2, F29).** The three
environments have distinct identities, and QA lives at the first one:

| Env         | Identity               | URL                        | What QA does here                                                                                                        |
| ----------- | ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **dev**     | **plan** (`plan.name`) | `dev.futurator.ai/<plan>`  | **QA reviews the merged plan** (waves merged), before it's accepted as the app. Plan-scoped + immutable. **Harness ON.** |
| **staging** | **app** (`appId`)      | `stage.futurator.ai/<app>` | post-merge smoke of the app's release candidate. **Harness OFF.**                                                        |
| **prod**    | **app** (`appId`)      | `futurator.ai/apps/<app>`  | live app. **Harness OFF.**                                                                                               |

So "QA Review" verifies the **plan in dev**, not "the app" — the app exists only after the plan
merges to `main` (staging → prod). This doc says **"merged plan (dev)"** everywhere it previously
said "assembled app."

**Environment-aware seam contract (F29 Part C coordination).** The `window.__harness` seam is
production-absent by design — it only publishes under `NEXT_PUBLIC_TEST_HARNESS=1`, which the
deployment ladder bakes into the **dev** build only. Therefore the structural verdicts
`SEAM_ABSENT` / `SEAM_NEVER_PUBLISHED` must be **environment-aware**:

- on **dev** (harness ON) → a missing seam is a **hard, blocking** regression (today's behavior);
- on **staging/prod** (harness OFF) → a missing seam is **expected, non-blocking** — seam-asserting
  probes are skipped/N-A, never a defect. (A harness-off staging smoke must not misread the absent
  seam as a regression.)

QA owns this gating; it lands when QA cuts over from booting its own `next dev` to verifying against
`dev.futurator.ai/<plan>` (the F11/Q-C9/Q7 root fix, unblocked by F29).

For pacman3, final QA becomes ~4 journeys instead of 16 ACs:

1. **Load & start** — load → press Enter → maze + Pac-Man + ghosts running (folds S6-1, S6-2,
   S2-\*, S3-1, S4-1).
2. **Move & eat** — start → move → dots disappear (folds S3-2/3/4).
3. **Scoring** — eat dots → score increases (S5-\*).
4. **End & restart** — reach game-over → overlay → restart (**Human-verified**).

### 3.2 Complexity taxonomy (orthogonal to the L0/L1/L2 cost level)

| Tier           | Verifier               | Frames                  | Deterministic? | Example                            |
| -------------- | ---------------------- | ----------------------- | -------------- | ---------------------------------- |
| **Smoke**      | bash (L0)              | —                       | yes            | boots, no console errors           |
| **Appearance** | vision (L1)            | 1 (idle or after-start) | no             | "title shows PACS 3"               |
| **State**      | seam assert (L2-state) | 1 + assert              | **yes**        | "press Enter → status=running"     |
| **Behavior**   | vision (L2-vision)     | **before + after**      | no             | "ArrowRight → Pac-Man moved right" |
| **Human**      | operator               | n/a                     | n/a            | game-over, win, "feels responsive" |

Two additions carry most of the value:

- **Human tier** — terminal/subjective claims route to the operator with a clear card; the operator
  verifies and approves (maps to the existing `verify:'manual'` + operator lane, currently unused
  for this). This is the operator's stated, accepted workflow.
- **Behavior = before + after frames** — the compiler must capture a baseline frame, perform the
  action, capture the result, and hand BOTH to the judge ("did X change between frame 1 and 2?").

### 3.3 Scripts as first-class, visible artifacts

Today the flow is interpreted into Playwright only at runtime, inside a heredoc — the operator
never sees the actual script. **The generated Playwright (or the flow + its faithful Playwright
translation) must be surfaced per test in the review UI, before approval, and be editable.** Test
quality lives in these scripts; making them inspectable turns the operator into the QA author's
reviewer. Example of what a flow compiles to (`runFlow`, `visual-qa-pipeline.ts:641`):

```js
// flow: [{press:"Enter"},{wait:600},{press:"ArrowRight"},{wait:400},{screenshot:"after"}]
await page.goto('http://localhost:3700/', { waitUntil: 'load' });
await page.keyboard.press('Enter'); // start-gate
await page.waitForTimeout(600);
await page.keyboard.press('ArrowRight'); // the AC's action
await page.waitForTimeout(400);
await page.screenshot({ path: 'VT-…-after.png' });
```

---

## 4. Staged build plan

### Stage A — tactical, low-risk (no change to what QA _is_)

1. **Before/after frames for Behavior tests.** When the compiler authors a behavioral
   (movement/visual-change) flow, capture a `before` screenshot, then the reach, then an `after`
   screenshot; the L2-vision judge compares the two. Fixes Images 20/21.
   _Files:_ `functions/shared/services/qa-author.ts` (authoring), judge prompt already reads all
   frames (`visual-qa-pipeline.ts:1156`).
2. **Title/start-screen ACs are idle-judged, not NEEDS_PROBE.** The L1 NEEDS*PROBE guard
   (`visual-qa-pipeline.ts:991`) and the classifier's interaction-gated detector must defer to the
   start-screen detector — a "Press ENTER" title AC is an appearance check of the idle frame, not a
   probe target. Fixes Image 18.
   \_Files:* `qa-author.ts` (`isStartScreenObservable`), `visual-qa-pipeline.ts` (L1 guard).
3. **Human complexity tier.** Auto-detect terminal-state ("game over", "win", "you lose") and
   subjective ("feels", "smooth", "responsive") ACs → route to the operator lane with a distinct
   card ("Human-verified — reach this state by playing; approve when confirmed"). Operator approves.
   _Files:_ classifier (`visual-test-classifier.ts`), report aggregator, review UI.
4. **Scripts visible in the review UI.** Emit each test's generated Playwright (or flow→Playwright
   translation) into the contract-review payload; render + allow edit.
   _Files:_ `qa-author.ts` / launcher (emit), review UI component.

### Stage B — the reframe (changes what final QA is)

5. **Delivery/journey test set for final QA.** Synthesize candidate journeys by clustering related
   ACs around the primary feature + the plan's user-facing flow, run only those (+ a curated
   appearance set) at final QA; operator curates. The wave gate remains the exhaustive per-AC layer.
   _Files:_ a new journey-synthesis step in the launcher; review UI grouping by journey not epic.

### Stage C — concept feedback (principled end-to-end)

6. **PM emits delivery journeys + complexity hints at planning time** (a small concept-stage
   artifact), so final QA's journeys and the Human tier are declared up front rather than inferred.
   _Files:_ `pm-plan-prompt.ts`, `plan-output-schema.ts`, concept gate.

---

## 5. Definition of done

A plan reaches final QA and the operator sees:

1. A **small set of delivery journeys** (grouped by capability, not epic), each verifying an
   integrated flow on the assembled app — not a replay of every story AC.
2. Each test tagged with its **complexity tier**; Behavior tests show **before + after** frames;
   **Human** tests are clearly flagged for manual approval (not auto-FAIL/UNCERTAIN).
3. The **generated Playwright script** for each test, visible and editable before approval.
4. The **wave gate** unchanged as the exhaustive per-AC development check.

When these hold, the pacman3 class of complaint (epic-driven noise, isolated intermediate-state
tests, un-verifiable movement, un-automatable terminal states, invisible scripts) is structurally
resolved.

---

## 6. Reference — code coordinates

| Concern                                          | File:line                                              |
| ------------------------------------------------ | ------------------------------------------------------ |
| DEV authors per-AC visual tests                  | `functions/shared/pipelines/story-pipeline.ts:990`     |
| Merge/persist `visual-tests.md` (by criteriaRef) | `daemon/pipelines/lib/visual-tests-writer.mjs:99`      |
| Wave gate (dynamic, per-AC, merged code)         | `daemon/lib/wave-vqa-runner.mjs:435`                   |
| Final QA (flatten + run story.visualTests)       | `functions/shared/services/visual-qa-launcher.ts:245`  |
| QA-AUTHOR compiler (flow synthesis)              | `functions/shared/services/qa-author.ts`               |
| Flow → Playwright interpreter (`runFlow`)        | `functions/shared/pipelines/visual-qa-pipeline.ts:641` |
| Screenshot naming (labels + final frame)         | `visual-qa-pipeline.ts:671,771`                        |
| L1 NEEDS_PROBE guard                             | `visual-qa-pipeline.ts:991`                            |
| L2 judge reads all frames                        | `visual-qa-pipeline.ts:1156`                           |
| Complexity / level classifier                    | `functions/shared/services/visual-test-classifier.ts`  |
