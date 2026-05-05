# QA Stage Redesign — Plan-Scoped, Bash-First, Level-Routed

> **Status:** design proposal. Direct response to the dino1 forensic (2026-04-29).
> **Position:** addendum to Pipeline v2.5; replaces the current epic-scoped QA fan-out with a single plan-scoped pipeline routed by test level.
> **Companion to:** `qa-stage-forensic-and-brainstorm.md` (the input forensic).
> **Goal:** cut QA cost ~85%, eliminate t2.micro hangs, kill the 224-attention-item explosion, and turn QA from "the stage that gets stuck" into a deterministic, operator-gated, last-mile review.

---

## Document map

- [The headline redesign](#headline)
- [Why plan-scoped, definitively](#why-plan-scoped)
- [The bash-first reframe — three-level test routing](#three-levels)
- [Tests as operator-gated contracts](#tests-as-contracts)
- [The redesigned pipeline](#redesigned-pipeline)
- [Rigor tiering — which tests run when](#rigor-tiering)
- [Per-test budgets and escalation](#budgets)
- [Operator triage UI](#triage-ui)
- [How the redesign answers each of the 10 problems](#mapping)
- [Forward compatibility with v2.5/v2.6 directions](#forward-compatibility)
- [Worked example — dino1 redone properly](#worked-example)
- [Cost and time comparison](#cost-comparison)
- [Implementation effort and phasing](#implementation)
- [Open design questions for the operator](#open-questions)

---

<a id="headline"></a>
## 1. The headline redesign

Four architectural changes, each addressing a Root Cause from the forensic:

1. **QA is plan-scoped, not epic-scoped.** One QA job per plan, ever. The wave-reducer fan-out across epics goes away. Single dev server, single screenshot set, single report. Solves Root 1.
2. **Bash does what bash can, the LLM only judges.** A new internal taxonomy splits visual tests into three levels (L0, L1, L2). L0 is pure bash, $0 LLM cost. L1 uses Haiku per screenshot. Only L2 (behavioral flows) uses Sonnet. Solves Root 2.
3. **Visual tests are an operator-gated contract.** The dev-emitted `---VISUAL_TESTS---` blocks become a draft. The operator reviews the aggregated test list before QA spawns, with bash-side validation flagging vague expectations and missing AC linkage. Solves Root 3 + Failure A/B/C.
4. **Per-test isolation, not per-pipeline-run.** Each test has its own wall-clock cap, cost cap, retry budget. A single bad test can't take down the run. Failures route to a triage drawer, not the inbox.

These changes compose. None of them is independently sufficient.

---

<a id="why-plan-scoped"></a>
## 2. Why plan-scoped, definitively

The forensic strongly suggests plan-scoped. Let me make the argument explicit, because the same logic governs future scope decisions.

### 2.1 The unit-of-work test

Ask: "what is QA actually verifying?" Answer: "the deliverable that's about to ship to the operator." That deliverable is the **plan**, not any sub-unit.

| Unit | What it produces mid-flight | Is it a deliverable? |
|---|---|---|
| Story | a slice of code in `wip/<storyId>/` (Phase 2) or in the shared tree (today) | No — pre-integration |
| Wave | merged story output that builds | No — mid-plan, no semantic completion |
| Epic | a coherent group of stories complete | No — in v1 all epics share the same project root and the same artifact |
| **Plan** | **the artifact about to ship** | **Yes** |
| Release | a tagged production deploy | Yes, but post-QA |

Stories and waves are too early — no integrated artifact to test. Epics are a fiction in v1 because there's only one project per plan. Releases are too late — they consume QA's output. Plans are the only unit where "is this thing ready to ship?" is a coherent question.

### 2.2 The duplication argument

Today: 4 epics × identical project root × identical visual tests = 4× the same work. Every epic-level QA agent boots its own dev server, takes its own screenshots, uploads its own copies, runs its own LLM judgement. The work product is byte-identical across epics.

Plan-scoped: 1 dev server, 1 screenshot set, 1 LLM judgement pass. Memory pressure drops ~75%, which by itself solves the t2.micro hangs (Problem #2).

### 2.3 The Phase-2 alignment argument

Per-story worktrees (Constraint 2) make the case ironclad. When stories run in `/wip/<storyId>/` worktrees and merge to the trunk at wave-close, there's literally nothing meaningful at the epic level to test mid-flight. The integrated artifact only exists post-plan-merge. Plan-scoped QA aligns naturally with where the pipeline is heading.

### 2.4 The deliverable-shape argument

Constraint 5: "QA stage is the **last gate before deploy**. Mistakes here ship to S3." Last gates gate deliverables. Deliverables are plans. Therefore QA gates plans.

If you ever want sub-plan QA in the future (e.g., for very long-running plans where you want progressive sign-off), that's a different mechanism — checkpoint deploys or staged releases — not a re-introduction of epic-scoped QA. Don't conflate "I want intermediate signal" with "QA should fan out."

### 2.5 Migration path for in-flight plans

The existing `epic.qaJobId` field stays as legacy. New `plan.qaJobId` becomes primary. Wave-reducer's per-epic spawn is gated behind a feature flag; new plans default to plan-scoped, in-flight plans complete on the legacy path or get abandoned during the cutover window.

---

<a id="three-levels"></a>
## 3. The bash-first reframe — three-level test routing

This is the redesign's core technical innovation. Today every visual test goes through the same heavyweight LLM pipeline. The redesign routes each test through the cheapest mechanism that can answer it correctly.

### 3.1 The principle, restated

From PR-3's bash-first axiom: "every fix must answer 'why can't bash do this?' before adding to a prompt." Apply ruthlessly to QA. Of `qa-evaluate`'s current responsibilities — boot dev server, make directory, run playwright, upload to S3, list S3, compare against rubric — **only the visual judgement step is irreducibly LLM-needed**. Everything else is deterministic shell that's currently being charged at Sonnet rates.

But "visual judgement" itself decomposes. Some judgements need no LLM at all. Some need a cheap LLM. Some need a smart LLM.

### 3.2 The three levels

| Level | What it can verify | Mechanism | Cost per test | Wall-clock per test |
|---|---|---|---|---|
| **L0** | Page renders, no console errors, expected URL returns 200, screenshot is non-blank, expected text appears in page source | Pure bash (curl + grep + ImageMagick `compare`) | $0 | <1s |
| **L1** | Specific visual element renders correctly: "dino sprite at canvas position (50, 200)", "chord overlay shows Am7 in correct color", "menu has Start button visible" | Bash-driven screenshot + Haiku judge | ~$0.005 | ~5s |
| **L2** | Behavioral flows: "clicking Start transitions menu to game-active state", "two-player input maps to two separate dinos correctly" | Bash-driven Playwright flow (multi-step) + Sonnet judge | ~$0.05 | ~30-60s |

### 3.3 Test schema with level

Today's `---VISUAL_TESTS---` block becomes:

```yaml
---VISUAL_TESTS---
- id: vt-001
  criteriaRef: AC-3
  level: L0
  expect: page returns 200, no console errors during initial load
  url: /
  console-error-allow: []      # regex patterns explicitly tolerated

- id: vt-002
  criteriaRef: AC-5
  level: L1
  expect: dino sprite renders at canvas position (50, 200) in idle frame
  url: /
  screenshot:
    viewport: 1280,720         # FIXED at the schema layer (commas, not x)
    selector: '#game-canvas'
    wait-for: 'networkidle'

- id: vt-003
  criteriaRef: AC-7
  level: L2
  expect: clicking Start transitions menu to game-active state
  flow:
    - action: navigate
      url: /
    - action: screenshot
      label: menu
    - action: click
      selector: 'button#start'
    - action: wait
      ms: 500
    - action: screenshot
      label: game-active
  judge: |
    Compare menu and game-active screenshots. Menu should show a Start
    button on a stationary background. Game-active should show the
    dino mid-game (animated sprite, score visible, no Start button).
---END_VISUAL_TESTS---
```

The `level:` field is required at parse time. The `criteriaRef:` is required. The `expect:` is required and runs through a specificity check (Failure C cure). The `viewport:` syntax is fixed at the schema level so the playwright `--viewport-size` flag bug (Problem #5) cannot recur.

### 3.4 What "level" means operationally

For a 36-test plan with realistic distribution:

| Level | Typical share | Example tests |
|---|---|---|
| L0 | ~50–60% | "/ returns 200", "console has no errors", "screenshot is non-blank", "page contains text 'dino'" |
| L1 | ~30–40% | "canvas at expected position", "specific UI element visible", "color matches expected palette" |
| L2 | ~5–15% | "user flow X completes successfully", "two-player input works", "navigation between screens" |

A 36-test plan with 20 L0 / 12 L1 / 4 L2:
- L0: 20 × $0 = **$0**
- L1: 12 × $0.005 = **$0.06**
- L2: 4 × $0.05 = **$0.20**
- **Total: ~$0.26**

vs current: $0.50 × 4 epics = $2.00 (and 92 minutes wall-clock with 0 product).

### 3.5 Auto-classification

Operators don't have to manually assign levels. A bash-side classifier (run during `qa-aggregate`, see §5) inspects each test and proposes a level:

- Has `flow:` with multiple steps → L2
- Has `screenshot:` with a `selector:` and a positional/visual `expect:` → L1
- Otherwise (URL + status + text-presence) → L0

Operator can override at the test-contract review gate.

### 3.6 The level boundary is enforced at the test-write step

A test cannot escalate level mid-flight. If an L1 test's bash judge can't reach a verdict, it's marked **uncertain** and surfaced to the operator — it doesn't auto-promote to L2. This keeps cost predictable. If the operator wants tighter judgement, they re-classify the test as L2 in the contract review and re-run.

---

<a id="tests-as-contracts"></a>
## 4. Tests as operator-gated contracts

Failure A from the forensic: dev agent invents tests, operator never sees them, garbage-in-garbage-out. This is structurally identical to v2.5's API-AUTHOR pattern (frozen `.d.ts` reviewed before TEST/DEV), applied to test definitions instead of type signatures.

### 4.1 The new operator decision card

After all dev work for the plan completes, before QA spawns, a new card surfaces:

```
[Pipeline]   Plan: dino1
              Status: dev-complete, qa-review-pending
              36 visual tests aggregated from dev work across 10 stories.

              Coverage check:
                ✅ All 14 ACs marked needsBrowser: true have ≥1 test
                ⚠️  AC-7 has 5 tests; possible over-testing
                ⚠️  AC-12 has 0 tests but is marked needsBrowser: false
                    (acceptable; flagged for review)

              Specificity check:
                ⚠️  vt-018 expect: "renders correctly" is too vague
                ⚠️  vt-024 expect: "looks fine" is too vague
                4 other warnings — see drawer

              Level distribution:
                L0: 20 tests (auto-classified)
                L1: 12 tests (auto-classified)
                L2: 4 tests (auto-classified)

              Estimated cost: $0.26
              Estimated wall-clock: ~3-4 minutes

              [Review Tests]  [Approve as-is]  [Cancel QA]
```

If the operator clicks **Review Tests**, they get a test editor where they can:
- Edit any test's `expect:`, `level:`, `criteriaRef:`
- Add new tests
- Remove tests
- Mark a vague test as "intentionally vague, accept" (suppresses the warning)

After edits, the operator clicks **Approve test contract** and QA spawns against the approved list.

### 4.2 What this costs the operator

For a typical plan: 30 seconds to scan, accept warnings, approve. For a problematic plan: 2-5 minutes to fix bad tests before they cost real money to run. This is asymmetric in our favor — operator time is cheap relative to a stuck QA run.

### 4.3 What it changes about the dev agent's incentives

Today the dev agent emits tests as a side-effect, with no quality signal back. Under the contract model, the dev agent's tests get scored (coverage + specificity warnings). Over time REFLECTOR can promote a project-level skill: *"In this project, dev agents tend to write vague visual tests; here's the convention for specific ones."* The contract gate is a forcing function for dev test quality.

### 4.4 Test contract is committed

The approved test list is committed to `<projectDir>/visual-tests-approved.md` with the operator's approval recorded in the commit metadata:

```
test(qa-contract): approve visual test list for dino1

Project: dino1
Plan: dino1
Agent: OPERATOR-APPROVE
Tests-Approved: 36
Tests-Edited: 2
Tests-Added: 0
Tests-Removed: 0
Coverage-Warnings: 2
Specificity-Warnings: 6 (4 unresolved, 2 acknowledged)
```

Auditable. If a regression slips past QA later, you can trace which test was approved with what specificity warning unresolved.

---

<a id="redesigned-pipeline"></a>
## 5. The redesigned pipeline

```
[Dev/wave work completes for the plan; plan transitions to: dev-complete]
   ↓
qa-aggregate              shell    Read all dev-emitted ---VISUAL_TESTS--- blocks across stories;
                                    auto-classify L0/L1/L2; run coverage + specificity checks;
                                    produce visual-tests-draft.md; estimate cost; surface card.
   ↓
[OPERATOR APPROVES THE TEST CONTRACT]   ← new decision card (§4.1)
   ↓
qa-prepare                shell    Boot ONE dev server (1× per plan, not per epic);
                                    run playwright screenshots in parallel batches (5 at a time);
                                    capture page console logs to /tmp/console-<plan>.log;
                                    aws s3 cp screenshots in parallel batches.
   ↓
qa-judge-l0               shell    Run all L0 tests purely in bash (curl, grep, file size, log scan).
                                    No LLM. Each test independent. Results to qa-report.json.
   ↓
qa-judge-l1               agent    For each L1 test, fire a Haiku invocation with:
                                    - the test's expect text
                                    - the screenshot URL (S3 presigned)
                                    - the relevant CLAUDE.md slice
                                   Per-test budget: $0.02 hard cap, 30s wall-clock.
                                   Tests run in parallel batches of 5.
   ↓
qa-judge-l2               agent    For each L2 test, fire a Sonnet invocation with:
                                    - the test's expect text + judge text
                                    - all screenshots from the flow (S3 presigned)
                                    - the relevant CLAUDE.md slice
                                   Per-test budget: $0.10 hard cap, 90s wall-clock.
                                   Tests run sequentially (Playwright flows can't safely interleave).
   ↓
qa-report                 shell    Aggregate qa-report.json into single markdown report.
                                    Emit ONE plan-level attention item: "QA done, X passed, Y failed".
                                    Emit per-failed-test items inside the QA drawer (not inbox).
                                    Update plan.qaStatus.
   ↓
qa-cleanup                shell    Stop dev server. Archive logs. Snapshot the screenshot set
                                    to S3 with versioning so re-runs don't clobber history.
   ↓
[Plan transitions to: review (if QA passed) or qa-failed (if any test failed)]
```

### 5.1 Step-by-step rationale

**`qa-aggregate`**: pure bash. Reads all `---VISUAL_TESTS---` blocks emitted during dev. Validates schema (criteriaRef present, expect present, level valid). Runs coverage check (every needsBrowser AC has ≥1 test). Runs specificity check (regex against vague-expect patterns). Auto-classifies any test missing a `level:` field. Output: `visual-tests-draft.md` + a JSON report card.

**`qa-prepare`**: bash. ONE dev server boot. Parallel screenshot capture using playwright's batch mode (5 concurrent pages, viewport syntax fixed at the bash layer so the comma-vs-x bug can't recur). Parallel S3 upload. Console log capture (so console errors are part of the dataset, not just visuals).

**`qa-judge-l0`**: bash. Every L0 test is a pass/fail check expressible in shell. No LLM ever invoked at this level.

**`qa-judge-l1`**: Haiku, per-test, parallel batches of 5. Each invocation is single-purpose: "Look at this screenshot. Does it match this expectation? Yes/no/uncertain + 1-line rationale." No tool calls; vision-only. Per-test cost ceiling enforced at the daemon (kill the invocation if it exceeds $0.02).

**`qa-judge-l2`**: Sonnet, per-test, sequential because Playwright flows can race. Each invocation gets the flow's screenshots and the judge text. Same single-purpose discipline: judge yes/no/uncertain + rationale.

**`qa-report`**: bash. Aggregates per-test results. Writes one plan-level attention item (per-failed-test items live inside the drawer, not the inbox — see §8.3 below). Updates plan status.

**`qa-cleanup`**: bash. Tears down the single dev server. Archives logs. Versioned screenshot snapshot (so re-runs don't lose history).

### 5.2 Concurrency profile

vs the dino1 incident:

| Resource | Today (4 epics) | Redesign (1 plan) |
|---|---|---|
| Concurrent `npm run dev` | 4 | 1 |
| Concurrent `claude -p` (Sonnet) | 4, all-purpose | 1 at a time, L2 only |
| Concurrent Haiku invocations | 0 | 5 (L1 parallel batch) |
| Peak RAM (rough) | ~2.5–3 GB | ~600–800 MB |
| t2.micro fits? | No (hangs) | Yes (comfortable) |

The peak RAM drop is the single biggest reliability win. Plan-scoped QA on t2.micro fits comfortably in the box's 1 GB.

---

<a id="rigor-tiering"></a>
## 6. Rigor tiering — which tests run when

QA fidelity scales with rigor, the same way the rest of v2.5 does. Maps cleanly to the existing `PlanRigor` enum.

| Rigor | QA shape |
|---|---|
| **exploration** | No QA at all. Per the exploration rigor addendum, exploration plans never auto-merge; visual feasibility is the operator's eye-check. The findings doc replaces a QA report. |
| **prototype** | L0 only. Bash-driven smoke checks (page renders, no console errors, screenshots non-blank). No LLM cost. ~30 seconds wall-clock for a 36-test plan. |
| **mvp** | L0 + L1. Full smoke + visual judgement on specific elements. Haiku-only on the LLM side. ~3-4 minutes wall-clock. ~$0.10–0.20 cost. |
| **production** | L0 + L1 + L2. Full smoke + visual + behavioral flows. Sonnet only at L2. ~5-10 minutes wall-clock. ~$0.30–0.50 cost. The 24h staging soak (v2.5 §36) consumes the full report as one of its inputs. |

### 6.1 Why exploration has no QA

Three reasons: (a) exploration plans never merge, so there's no deliverable to gate; (b) the findings doc captures the learning, which is the actual artifact; (c) running QA on throwaway code wastes everyone's time. If you ever want to "see what the spike looks like" you open the experiment branch's preview URL and look.

### 6.2 Why prototype is L0 only

Prototype velocity matters more than fidelity. L0 is essentially free ($0, ~30s) and catches the most common breakage class ("page errors out, screenshot is blank"). Higher fidelity at prototype rigor is overkill — you're going to redo the work at MVP anyway.

### 6.3 Why MVP introduces L1

MVP is the "first credible deliverable" rigor. Visual element correctness matters; behavioral flows are still being shaped. L1 is the right precision: "did the dino render where it should?" without paying for "does the entire game loop work?"

### 6.4 Why production needs L2

By production rigor, the deliverable ships to real users and lives behind the 24h soak gate. L2 catches the class of bug L0+L1 miss: "everything looks right at rest, but the user can't actually progress through the flow." Sonnet's price is justified because the cost of shipping an L2-class bug is much higher.

### 6.5 Crossing the boundary: prototype → mvp → production rigor upgrade

When a project upgrades rigor (v2.5 §4.1), the rigor-upgrade plan auto-includes a QA epic:

```yaml
plan:
  kind: rigor-upgrade
  fromRigor: prototype
  toRigor: mvp
  epics:
    - "Backfill tests for existing code (target ≥60% coverage)"
    - "Backfill L1 visual tests for existing UI components"   # NEW
    - "Run SKILL-SCOUT brownfield audit"
    - "Run ARCHITECT brownfield audit"
    - "Configure dev/staging deploy targets"
```

The L1 backfill is operator-reviewed via the same contract gate — they decide which UI elements warrant L1 coverage going forward.

---

<a id="budgets"></a>
## 7. Per-test budgets and escalation

The 92-minute hang in dino1 happened because there was no automatic escalation — the QA agent could spin forever, and the operator had to abandon. The redesign makes this impossible by enforcing per-test budgets.

### 7.1 Three budgets per test

| Budget | L0 default | L1 default | L2 default | Override |
|---|---|---|---|---|
| Wall-clock per test | 5s | 30s | 90s | Per-test in the contract |
| Cost per test | $0 | $0.02 | $0.10 | Per-test in the contract |
| Retry attempts | 0 (deterministic) | 1 | 1 | Per-test in the contract |

When a test exceeds wall-clock OR cost: marked **uncertain**, the LLM invocation is killed, the rest of the run continues. Uncertain tests aren't pass-or-fail — they're a third state that surfaces to operator triage.

### 7.2 Plan-level budgets

| Budget | Default | Override |
|---|---|---|
| Wall-clock per plan QA run | 30 minutes | Per-plan in the deploy gate |
| Cost per plan QA run | $1.00 | Per-plan, with operator confirmation if exceeded |

When the plan-level budget is exceeded mid-run: any tests not yet started are skipped (marked **skipped-budget**), in-flight tests complete, qa-report runs normally. The operator sees a clear "QA stopped at X/Y tests due to budget" signal and can decide whether to bump the budget and re-run the remainder.

### 7.3 Why retries are minimal

L0 tests are deterministic — retrying a 200-vs-500 status check changes nothing; if it fails twice it's a real failure. L1/L2 retries are one attempt because LLM nondeterminism is real but small; two attempts catch most flakiness without burning budget. Three+ retries is masking a test problem (vague expect, flaky selector) that should be fixed at the contract level instead.

### 7.4 Cost preview at the approval gate

Recall §4.1's decision card:

> Estimated cost: $0.26
> Estimated wall-clock: ~3-4 minutes

These come from summing per-test budgets. The operator sees the bill before approving. If a plan's QA estimate is unexpectedly large (say, 50 L2 tests at $5.00), that's a signal something is wrong with the test list — too many flows tested, or L2 misclassified for what should be L1. Operator triages before paying.

---

<a id="triage-ui"></a>
## 8. Operator triage UI

Today the operator's only QA action is **Abandon plan**. That's a disaster — abandoning loses all the dev work. The redesign exposes per-test triage so QA failures don't escalate to plan-abandon.

### 8.1 The QA report drawer

After QA completes, the plan dashboard's QA tab shows:

```
QA Report — dino1 (plan)

Approved tests:        36
Passed:                28
Failed:                4
Uncertain:             2
Skipped (budget):      0
Errored:               2

Wall-clock:            3m 42s
Cost:                  $0.31

[Re-run all]  [Re-run failed only]  [View screenshots]
```

Each of the 36 tests is a row. Click into a failed test to see:

```
vt-014 — FAILED

Expectation:  dino sprite renders at canvas position (50, 200)
Level:        L1
Verdict:      Haiku judge: NO — sprite is at (50, 240), 40px lower than expected
Confidence:   high
Rationale:    "The dino sprite appears at canvas Y=240, not Y=200 as expected.
               Likely a CSS top-margin issue on the canvas wrapper."
Screenshot:   [thumbnail, click to expand]
Story:        E2-S3 (canvas-rendering)
Last commit:  a3f9c2e — feat(E2/S3): position dino sprite

Actions:
  [Real failure → file bug]
  [Test was wrong → edit and retry this test only]
  [Known issue → mark and continue]
  [Retry this test only]
```

### 8.2 Per-test retry

The most important affordance: **retry this test only**. Cheap (one Haiku invocation, ~$0.005), fast (5 seconds), local (doesn't disturb the rest of the report). Operator can iterate: edit the test's `expect:`, retry, see if it passes, accept the contract change.

### 8.3 No more 224 attention items

Per-failed-test items live inside the QA drawer, not the global inbox. The inbox gets ONE item per QA run:

> ⚠️ **dino1 — QA review needed** — 4 failed, 2 uncertain (out of 36) — [Open QA drawer]

When the operator triages each failed test in the drawer (mark as "real failure" / "test was wrong" / "known issue"), the inbox item updates its count or auto-resolves. No item duplication, no inbox explosion.

### 8.4 The "test was wrong, edit and retry" flow

```
Operator clicks [Test was wrong → edit and retry this test only]
   ↓
[Inline edit form]
   - Expect: dino sprite renders at canvas position (50, ~200) [was: (50, 200)]
   - Level: L1 [unchanged]
   - Test contract diff visible
   ↓
Operator clicks [Save & retry]
   ↓
qa-judge-l1 fires for this single test only
   ↓
Result: PASS
   ↓
Operator clicks [Accept contract update]
   ↓
visual-tests-approved.md updated with new expect
Commit: test(qa-contract): refine vt-014 expect after retry
```

This is the highest-leverage operator action in the whole pipeline. It lets the operator iterate on test quality without paying full QA cost each time, and it captures the refinement as a permanent contract update.

### 8.5 The "real failure" flow

```
Operator clicks [Real failure → file bug]
   ↓
Triage agent spawns (existing pattern)
   - Reads the failed test + screenshot + relevant story commits
   - Proposes a bugfix plan with the test as the regression target
   ↓
Operator reviews proposed plan, approves
   ↓
Bugfix plan starts; the failed visual test becomes a forced-included test
in the next QA run for the bugfix plan.
```

This connects QA failures to the brownfield/bugfix loop cleanly. A QA failure is no longer a dead-end ("abandon plan") — it's input to the next plan.

---

<a id="mapping"></a>
## 9. How the redesign answers each of the 10 problems

| # | Problem | How the redesign solves it |
|---|---|---|
| 1 | Plan-scoped artifact, epic-scoped QA — N× duplicated work | Plan-scoped QA. Wave-reducer fan-out across epics removed. |
| 2 | t2.micro memory pressure under QA fan-out | One dev server per plan; peak RAM drops ~75%. |
| 3 | Visual tests come from synthetic dev-emitted block, never operator-reviewed | Operator-gated test contract. Bash-side specificity + coverage checks before approval. |
| 4 | QA prompt is boilerplate-blind | `qa-aggregate` reads `BOILERPLATE_REGISTRY[plan.boilerplateType]` for entry point + dev-server command + relevant URL paths. Prompts thread the boilerplate type through. |
| 5 | Playwright invocation prompt has wrong example | Viewport syntax fixed at the schema layer (`viewport: 1280,720`), bash converts to playwright's flag. The LLM never sees the flag string. |
| 6 | No retry / escalation / wall-clock cap on the QA agent | Per-test wall-clock + cost budgets, automatic kill on exceed, plan-level wall-clock + cost budget. Tests marked **uncertain** when budget exceeded. |
| 7 | The agent does the screenshot work the daemon could do | Bash does prepare + L0 + parallel orchestration. LLM only judges (L1 = Haiku, L2 = Sonnet). ~80% of the LLM-side work goes away. |
| 8 | 224 QA-related attention items | One plan-level item; per-failed-test items live in the QA drawer (not the inbox). Wave-reducer dedup pattern from PR-7 G+H+I applies. |
| 9 | Per-port server collisions with the dev pipeline's plan-build step | Single dev server per plan, on a single port, with proper teardown. No port range to manage. |
| 10 | Plan dashboard cannot recover gracefully — operator must abandon | Per-test triage drawer with retry-this-test, edit-and-retry, mark-as-known-issue actions. Plan-abandon is no longer the only escape hatch. |

Every problem traces to either Root 1 (wrong unit of work), Root 2 (LLM doing bash work), or Root 3 (unreviewed test contract). The redesign attacks all three roots simultaneously — that's why it composes.

---

<a id="forward-compatibility"></a>
## 10. Forward compatibility with v2.5/v2.6 directions

### 10.1 More boilerplates

Constraint 1 from the forensic. `qa-aggregate` reads `BOILERPLATE_REGISTRY[plan.boilerplateType]` to know:
- Where the entry point lives (vanilla JS: `index.html` + `game.js`; React: `src/App.tsx`; SST: `web/src/App.tsx`)
- What the dev-server boot command is (`npm run dev`, `npx sst dev`, `expo start`)
- What URL paths matter (root, key routes)
- What console-error patterns are expected/tolerated (some boilerplates emit known dev-time warnings)

Threading the boilerplate type through means the same QA pipeline works for nextjs, sst, vite, vanilla, mobile (Expo), without prompt forking. Same pattern PR-5 used for the PM agent.

### 10.2 Per-story worktree isolation (Phase 2)

When stories run in `wip/<storyId>/` worktrees and merge to the trunk at wave-close, the only meaningful artifact is the post-merge plan trunk. Plan-scoped QA aligns naturally — there's nothing to test below plan-merge.

### 10.3 Compounding (Phase 3, skill loadouts)

The L1/L2 judge prompts can pull from a project-local skill: `<project>-visual-judgement-conventions`. This skill accumulates "in this project, the following expressions mean: 'idle frame' = sprite-1.png; 'jumping frame' = sprite-2.png." The QA agent for `dino1 v2.0` knows what `dino1 v1.0` looked like via this skill.

REFLECTOR distills this skill from repeated per-test rationale across plans. Auto-distillation at encounter ≥ 3, per v2.5 §41.

### 10.4 Cost ceilings (T1.4 in the efficiency-fixes plan)

Per-test and per-plan budgets are the hook for cost ceilings. `qa.estimatedCostUsd` is exposed at the contract review gate. Daily cost ceiling integrates by checking remaining budget before spawning QA — if the plan would exceed the daily ceiling, the spawn is deferred or escalated to operator.

### 10.5 Review-stage gating (Constraint 5)

QA is the last gate. Bash-first hardens it: deterministic L0 checks catch the "test passed because nothing rendered" class of false positive. Operator-gated test contract catches the "right test on the wrong AC" class. Per-test budgets prevent the "stuck QA can't be triaged" class. The 24h staging soak (v2.5 §36) consumes QA's report; QA's per-test rigor governs how trustworthy that input is.

### 10.6 t2.micro upgrade decision

The redesign makes t3.medium unnecessary for the QA-driven hangs. If you still want t3.medium for parallel dev-stage work, that's a separate decision. Don't conflate "QA needs more RAM" with "the daemon needs more RAM" — the redesign solves the former at the algorithmic level.

### 10.7 Exploration rigor (the addendum)

The QA stage is one of several places where exploration rigor strips ceremony. §6.1 above codifies: exploration plans run no QA. The findings doc replaces the QA report. This composes cleanly with the rigor-tiered fidelity in §6.

---

<a id="worked-example"></a>
## 11. Worked example — dino1 redone properly

Replay the dino1 plan under the redesigned QA stage.

### 11.1 The setup

Same plan as before: 4 epics, 10 stories, 33 ACs, ~36 visual tests emitted by dev agents.

### 11.2 Dev work completes

```
[Pipeline]   All 10 stories complete. All 4 wave-build-checks green.
              Plan transitions: developing → dev-complete.
              Daemon spawns qa-aggregate.
```

### 11.3 qa-aggregate runs (bash, ~10 seconds)

```
[Pipeline]   qa-aggregate begin
              - Read 10 ---VISUAL_TESTS--- blocks from story commits
              - Total tests: 36
              - Auto-classified:
                  L0: 22 (page renders, no console errors, expected text)
                  L1: 11 (specific element renders correctly)
                  L2: 3 (game-loop flow, collision detection, scoring)
              - Coverage check:
                  ✅ 14/14 needsBrowser ACs have ≥1 test
                  ⚠️ AC-7 has 5 tests (over-testing)
              - Specificity check:
                  ⚠️ vt-018 expect: "renders correctly" → flagged
                  ⚠️ vt-024 expect: "looks fine" → flagged
              - Estimated cost: $0.27
              - Estimated wall-clock: 4 min
              - Surface card to operator
```

### 11.4 Operator reviews and approves (90 seconds)

```
[Operator]   Opens [Review Tests]
              - Edits vt-018 expect to "score increments by 1 every second"
              - Edits vt-024 expect to "dino sprite is visible in the canvas top-left"
              - Removes 2 redundant tests on AC-7
              - Approves the contract.
              Total tests after edits: 34
              Updated estimate: $0.25, ~4 min
```

### 11.5 qa-prepare runs (~30 seconds)

```
[Pipeline]   qa-prepare begin
              - Boot 1× npm run dev on :5173 (4-second boot)
              - Capture console log to /tmp/console-dino1.log
              - Run 34 playwright screenshots in parallel batches of 5
                  Total batches: 7
                  Wall-clock: ~25s
              - Parallel s3 cp of 34 PNGs (versioned)
              - Verify all 34 uploads (s3 ls)
              All screenshots in S3. qa-prepare ok (28s).
```

### 11.6 qa-judge-l0 runs (~5 seconds, $0)

```
[Pipeline]   qa-judge-l0 begin
              - 22 tests, parallel bash
              - Each test: curl + grep + image size check
              - 21 pass, 1 fail (vt-007: page returned 200 but console showed
                a "Cannot find module" warning — captured from the dev-server log)
              qa-judge-l0 ok (4s).
```

### 11.7 qa-judge-l1 runs (~60 seconds, $0.06)

```
[Pipeline]   qa-judge-l1 begin
              - 11 tests, parallel batches of 5
              - Each test: Haiku invocation with screenshot + expect
              - Per-test budget: $0.02 hard cap, 30s wall-clock
              Results:
                10 pass
                1 uncertain (vt-014: Haiku says "sprite is at (50, ~210), expected (50, 200)"; confidence medium — flagged)
              qa-judge-l1 ok (52s, $0.06).
```

### 11.8 qa-judge-l2 runs (~120 seconds, $0.13)

```
[Pipeline]   qa-judge-l2 begin
              - 3 tests, sequential
              - Each test: Sonnet invocation with flow + screenshots
              - Per-test budget: $0.10 hard cap, 90s wall-clock
              Results:
                vt-031 (game-loop): pass ($0.04)
                vt-032 (collision): fail ($0.05) — Sonnet says "dino passes through cactus without dying, expected death animation + game-over screen"
                vt-033 (scoring):   pass ($0.04)
              qa-judge-l2 ok (108s, $0.13).
```

### 11.9 qa-report runs (~5 seconds)

```
[Pipeline]   qa-report begin
              Total: 34 tests, 31 pass, 2 fail, 1 uncertain
              Single inbox item created:
                "dino1 — QA review needed: 2 failed, 1 uncertain (out of 34)"
              Per-failed-test items inside QA drawer:
                vt-007: console error during page load (L0)
                vt-032: dino doesn't die on cactus collision (L2)
                vt-014: sprite position slightly off (L1, uncertain)
              Total cost: $0.21
              Total wall-clock: 3m 47s
              qa-report ok (4s).
```

### 11.10 Operator triages

```
[Operator]   Opens QA drawer.

              vt-007 (L0): clicks [Real failure → file bug]
                Triage agent proposes a bugfix plan to clean up the import warning.
                Operator approves.

              vt-032 (L2): clicks [Real failure → file bug]
                Triage agent proposes a bugfix plan: "collision detection broken in
                story E3-S5, dino doesn't trigger death state on cactus contact"
                Operator approves.

              vt-014 (L1, uncertain): clicks [Test was wrong → edit and retry]
                - Original expect: "dino sprite renders at canvas position (50, 200)"
                - Edited expect:   "dino sprite renders at canvas position (50, 200)
                                    ±15px tolerance"
                - Click [Save & retry]
                - qa-judge-l1 reruns single test (~$0.005, 5s)
                - Result: PASS
                - Operator clicks [Accept contract update]
                - Contract updated.

              Final state:
                28 pass, 1 retry-pass, 0 uncertain, 2 real failures (bugfix plans queued)
              Operator marks QA review complete.
              Plan transitions: dev-complete → qa-failed
              Two bugfix plans now in the queue.
```

### 11.11 The compare

| Metric | dino1 today | dino1 redone |
|---|---|---|
| Wall-clock | 92m 33s (abandoned) | 5m 17s (including operator triage) |
| LLM cost | ~$2.00 (and stuck) | ~$0.22 |
| Visual tests judged | 0/36 | 34/34 |
| Attention items | 224 | 1 (plan-level) + 3 (in drawer) |
| t2.micro hung? | Yes, twice | No |
| Operator action | Abandon | Approve contract → triage 3 results |
| Useful output | None | Bugfix queue + contract refinement |

A 1700% wall-clock reduction. A 90% cost reduction. Net work product went from zero to a complete report and a bugfix queue.

---

<a id="cost-comparison"></a>
## 12. Cost and time comparison

Generalized across plan sizes. Assumes the test-distribution profile (60% L0, 30% L1, 10% L2):

| Plan size | Today (epic-scoped, all-Sonnet) | Redesigned (plan-scoped, level-routed) | Reduction |
|---|---|---|---|
| Small (10 tests, 2 epics) | ~$1.00, ~30 min (or stuck) | ~$0.07, ~2 min | ~93% |
| Medium (36 tests, 4 epics) | ~$2.00, ~90 min (or stuck) | ~$0.22, ~4 min | ~89% |
| Large (80 tests, 8 epics) | ~$4.00, fan-out impossible on t2.micro | ~$0.50, ~10 min | ~88% |

Even larger plans benefit more from the redesign because the fan-out problem grows superlinearly on small boxes.

The wall-clock reductions are the bigger story than the cost reductions. dino1's 92-minute abandonment isn't unique — it's the steady state of the current QA design under any reasonable plan size on t2.micro.

---

<a id="implementation"></a>
## 13. Implementation effort and phasing

The redesign isn't atomic. Phased rollout to limit risk:

### Phase Q1 — kill the fan-out (highest leverage, 3 days)

| # | Item | Effort |
|---|---|---|
| Q1.1 | Move `epic.qaJobId` to `plan.qaJobId` (schema migration) | ½ day |
| Q1.2 | Change `wave-completion-check.ts` to spawn one QA per plan, not one per epic | 1 day |
| Q1.3 | Update plan dashboard to show plan-scoped QA status | 1 day |
| Q1.4 | Drain mode for in-flight plans on the legacy path | ½ day |

**Phase Q1 total: ~3 days. Eliminates Problems #1 and #2 immediately.** This is the smallest change with the biggest impact — ship it first.

### Phase Q2 — bash-first prep (1.5 days)

| # | Item | Effort |
|---|---|---|
| Q2.1 | Move screenshot capture from agent to bash (`qa-prepare`) | 1 day |
| Q2.2 | Fix viewport-size at schema layer; remove the bug example from prompts | ½ day |
| Q2.3 | BOILERPLATE_REGISTRY threading into qa-prepare | (folded in) |

**Phase Q2 total: ~1.5 days. Eliminates Problems #4, #5, #7 (partial), #9.**

### Phase Q3 — three-level routing (4 days)

| # | Item | Effort |
|---|---|---|
| Q3.1 | Test schema with `level:` and auto-classifier | 1 day |
| Q3.2 | `qa-judge-l0` bash (curl + grep + image checks) | 1 day |
| Q3.3 | `qa-judge-l1` Haiku per-screenshot judge | 1 day |
| Q3.4 | `qa-judge-l2` Sonnet per-flow judge | 1 day |

**Phase Q3 total: ~4 days. Eliminates the rest of Problem #7 (LLM doing bash work). Cost reductions kick in here.**

### Phase Q4 — test contract gate (3 days)

| # | Item | Effort |
|---|---|---|
| Q4.1 | `qa-aggregate` bash with coverage + specificity checks | 1 day |
| Q4.2 | Test contract review UI (decision card) | 1 day |
| Q4.3 | Operator approval commit to `visual-tests-approved.md` | ½ day |
| Q4.4 | Coverage rule: every needsBrowser AC has ≥1 test | ½ day |

**Phase Q4 total: ~3 days. Solves Problem #3 and Failures A/B/C.**

### Phase Q5 — budgets and triage (3 days)

| # | Item | Effort |
|---|---|---|
| Q5.1 | Per-test wall-clock + cost budgets in daemon | 1 day |
| Q5.2 | Plan-level QA budget + operator confirmation on overage | ½ day |
| Q5.3 | QA report drawer with per-test results + actions | 1 day |
| Q5.4 | Per-test retry, edit-and-retry flows | ½ day |

**Phase Q5 total: ~3 days. Solves Problems #6, #8, #10.**

### Total

Original estimate: ~14 days. **Revised estimate after reviewer addendum (§16): ~21 days.** Q3's level-routing phase is the swelling factor — its schema design interacts with the contract format, dev-agent emit pattern, daemon parser, and UI editor; any one re-spec cascades through the others. Q1 alone (3 days) still gets you ~80% of the value — kill the fan-out, fix the t2.micro hangs, eliminate the duplication. Everything after Q1 is fidelity and cost optimization on top.

### 13.1 Recommended order

**Updated per reviewer addendum (§16.6): Q1 → Q2 → Q3 → Q4 → Q5.**

Why this order:
- Q1 is the existential fix. Ship it standalone.
- Q2 is the bash-first cleanup; cheap and unlocks Q3.
- Q3 (level routing) before Q4 (contract gate) because Q3 is the cost-reduction phase. If Q4 ships first, the operator approves contracts that get executed at full Sonnet cost (no levels yet). Better to land the cost win first, then layer the operator gate on top. Q4 can manage manual level assignment until Q3's auto-classifier is reliable.
- Q4 (contract gate) ships when level routing is stable — the operator's approval is most valuable when they're approving a known-cheap execution.
- Q5 is the operator UX layer; ships last because earlier phases provide its inputs.

Each phase ships independently and is reversible.

---

<a id="open-questions"></a>
## 14. Open design questions for the operator

These are the calls I made in the redesign that you might want to revisit. Each has a recommended answer; explicit so we can argue with them.

### Q1 — Is "exploration rigor has no QA" the right call?

The exploration rigor addendum says exploration plans never auto-merge and findings docs replace QA reports. §6.1 above codifies "exploration plans run no QA." Alternative: run L0 only on exploration plans, just to catch outright broken pages. Cost is ~$0 and ~30s, so why not?

**Recommended:** keep "no QA" as the default but allow `qa-on-exploration: true` in the plan card for cases where you do want a quick smoke check.

### Q2 — Should L1 use Haiku or Sonnet?

Haiku is much cheaper but less reliable on visual interpretation. Real numbers needed. If Haiku at $0.005/test misses 10% of legit failures, that's a problem; if it misses 1%, it's fine.

**Recommended:** start with Haiku, instrument the false-negative rate, switch to Sonnet at L1 only if the false-negative rate exceeds 5%. The instrumentation hook is REFLECTOR reading the per-test rationale and flagging "Haiku said pass, operator marked as real failure" patterns.

### Q3 — Should the contract approval be skippable in prototype rigor?

Prototype's whole point is velocity. The contract approval gate adds 30-90 seconds of operator time. Worth it?

**Recommended:** yes, but with an `auto-approve-on-no-warnings` mode. If the contract has zero coverage warnings and zero specificity warnings, prototype rigor auto-approves silently. mvp+ always shows the card.

### Q4 — Where does the QA agent (the v2.5 §3 role) sit in this redesign?

v2.5 declared a QA agent role (Sonnet, "Playwright/visual tests, end-to-end smoke, production rigor only"). The redesign splits this role into multiple LLM invocations (Haiku for L1, Sonnet for L2) plus a lot of bash. Is "QA agent" still a coherent agent role in v2.6?

**Recommended:** yes, but redefine. The "QA agent" is now the Sonnet invocation that handles L2 behavioral flows. L1 is a sub-agent (or just "Haiku judge call"). The role shrinks to the high-fidelity behavioral case. Update v2.5 §3 accordingly.

### Q5 — Should the test contract feed back to the dev agents?

REFLECTOR could read approved contracts across plans and propose: "in this project, dev agents tend to write vague tests; here's the convention for specific ones." This becomes a project-level skill. Worth implementing as part of this redesign or defer to Phase 3?

**Recommended:** defer. Get the contract gate working first; let it accumulate signal for ~10 plans; then ask REFLECTOR to distill. Premature distillation is worse than late distillation.

### Q6 — Cost ceiling integration: hard block or soft warning?

Today the daily cost ceiling is being defined (T1.4). When a plan's QA estimate would push us over the ceiling, do we:
- (a) Hard-block the QA spawn until tomorrow
- (b) Surface a confirmation card; operator decides
- (c) Allow but log

**Recommended:** (b). Hard blocks cause operator workarounds (bypass scripts, manual triggers). Confirmation cards force a deliberate decision. (c) is too permissive — defeats the ceiling's purpose.

### Q7 — Should re-runs cost less than first-runs?

If a test's screenshot is already in S3 and the page hasn't changed (same project SHA), can the L1 judge use the cached screenshot? Probably yes — saves the qa-prepare time on retries. But cache invalidation on dev-server restarts is tricky.

**Recommended:** cache screenshots by `(plan-sha, test-id, viewport)` with a 1-hour TTL. Re-run within the hour reuses the screenshot; after that re-prepares. Simple; cheap; correct in the common case.

---

## 15. Closing observations

Three meta-points worth capturing.

**The pipeline already had the answers — it just wasn't applying them to QA.** The bash-first principle from PR-3, the operator-gated contract pattern from API-AUTHOR, the per-test isolation pattern from story-pipeline retries — all of these existed in v2.5 already. The QA stage just hadn't received the same treatment because it was added before those patterns crystallized. The redesign isn't inventing new ideas; it's applying existing ideas consistently.

**The fan-out was a v0 fossil.** Epic-scoped QA made sense when "epic" meant "potentially-separate-deployable." It doesn't anymore. v1's universal `plan.workingDir` made the fan-out pure waste. This is a class of bug worth watching for elsewhere — ask: "what unit of work was this designed for, and does that unit still exist?"

**Bash-first isn't just about cost — it's about fault-tolerance.** Sonnet running a 10-step pipeline can fail at any step and leave you with no diagnosis. Bash running a 10-step pipeline with the LLM only at step 7 can fail at any step and you know exactly which step failed. The 92-minute hang in dino1 was the LLM failing at step 7 (judge) but the bash steps 1-6 (prepare) and 8-10 (cleanup, report) all surrendered control to the LLM along with the work. Reclaiming the deterministic steps reclaims diagnosability.

The QA stage should be the most boring stage in the pipeline. Boot a server, take some screenshots, ask an LLM "does this look right?", report the answer. The fact that it's been the most exciting stage — the one that hangs, the one that produces 224 attention items, the one that gets abandoned — is a signal it's been doing too much.

After this redesign: boring. Predictable cost. Predictable wall-clock. Predictable failure modes. Boring is what production rigor needs from its last gate.

---

## 16. Reviewer addendum (Claude — PR-8 implementer)

This section captures deltas from a second-pass review against the original
forensic problem list and against the codebase as it exists at the start of
PR-8 implementation. The redesign as written is sound; everything below is
either a clarification, a caveat the original author left implicit, or a
pragmatic adjustment based on what the implementation actually touches.
Numbered for cross-reference, not in priority order.

### 16.1 — Auto-classifier needs a fixture set, not just rules

§3.5 lists the bash-side classifier rules in plain English. In practice the
classifier is the highest-risk piece of the redesign: misclassifying an L0
test as L1 wastes Sonnet budget, misclassifying an L1 test as L0 produces
false negatives (test passes but the screen is broken). The mitigation is a
**fixture-driven test suite** for the classifier itself before any QA stage
calls it.

- Build `functions/shared/services/visual-test-classifier.test.ts` with
  ~30 known-test → expected-level pairs drawn from the dino1, dino2,
  bookkeeping, and donut plans. Every classifier rule change must keep
  fixtures green.
- Adds **½ day** to Q3.1 budget. Worth it — without fixtures, classifier
  drift is invisible until it causes a forensic-level incident.

### 16.2 — Start L1 with Sonnet, not Haiku

§3.3 (and §6.2) suggests Haiku for L1. Haiku 4.5 is fast and cheap but its
visual reasoning is meaningfully weaker than Sonnet's, especially for
"is this label associated with this control" or "does this number align
with this row" questions which dominate L1.

Recommendation: **L1 = Sonnet by default; revisit Haiku only after we have
a 50-test fixture set and can measure agreement.** The redesign's cost
math (§12) still holds with Sonnet at L1 because L1 tests use a single
viewport + single screenshot and stop on first signal — a Sonnet L1 call
is ~$0.02-0.04, not the $0.50-1.00 that the current QA stage burns.

Update §6.2 to read "L1: Sonnet (single screenshot per test, ~$0.03/call,
escalate to Haiku only after measurement). L2: Sonnet (multi-screenshot,
~$0.08/call)." And update §13 cost projections: L0 60% / L1 25% / L2 15%
on Sonnet stays roughly $1-2/plan vs current $30-50/plan — the headline
~95% reduction is preserved.

### 16.3 — Defer the triage agent (§8.5)

§8 describes a separate triage Sonnet that classifies failures into
attention buckets. This is **not needed for Phase Q1-Q3** — the existing
attention-item upsert path (PR-7) plus a stable `dedupKey` per (planId,
testId) gets the operator the same value: deduplicated, severity-tagged
items in the bell. Add the triage agent in Phase Q5 (or later) only if
operator feedback shows the categorization is wrong often enough to
justify another LLM call per failure.

For Q1-Q4: emit one attention item per failed visual test with
`dedupKey = "qa-test-failed:<planId>:<testId>"`, severity from the
classifier (L2-only fails = high; L0/L1 fails = medium), category =
`'qa-failure'`. Done. No new agent needed.

### 16.4 — Cache invalidation key should be app-code SHA, not plan-meta SHA

§5 mentions "skip QA if nothing changed." The implementation-trap here is
keying off plan metadata or epic completion timestamps. The right key is
**SHA of the deployed `apps/<planSlug>/` artifact** (or, pre-deploy, SHA
of the working-directory's `dist/` after build).

- If artifact SHA matches last-passing QA's SHA → skip, attach prior
  result to the plan with a "cache hit" badge.
- If artifact SHA differs by even one byte → run QA.

This avoids the failure mode where a doc-only commit triggers a full QA
run, AND avoids the worse failure mode where a "no plan-meta change"
heuristic skips QA on a real code regression. Implement in Q4.2.

### 16.5 — Progress streaming during qa-judge phases

§5 describes the pipeline phases but doesn't specify operator-facing
progress signals. The current QA stage emits a single `qa-status:running`
ND-JSON event and then nothing for 10-90 minutes — operator has no way to
distinguish "L2 thinking hard" from "L2 hung." Add **per-phase progress
events**:

- `qa-progress: classifying` (bash, <2s)
- `qa-progress: bash-checks-running` (parallel L0, ~10-30s)
- `qa-progress: l1-screenshots N/M` (per-test counter)
- `qa-progress: l2-screenshots N/M` (per-test counter)
- `qa-progress: report-rendering`

These slot into the existing event-translator → kanban-board pipeline
without schema changes. Add to §5 phase descriptions and to Q2.4 task
list. ~½ day in Q2.

### 16.6 — Migrate `visual-tests.md` → draft/approved pair (Q4.0)

§4 introduces the operator-approval gate for visual tests. The cleanest
migration path is a **rename + split**: `visual-tests-draft.md` (PM agent
output) and `visual-tests-approved.md` (operator-blessed contract). This
keeps the old `visual-tests.md` files in legacy plans untouched and lets
QA's contract-loader read `-approved.md` only.

Add as **Q4.0** (a renaming task) ahead of Q4.1's contract-enforcement
work — without the rename, the contract loader has to disambiguate intent
of `visual-tests.md` (draft? approved? legacy?) at every call.

### 16.7 — Sequencing change: Q3 before Q4

The original §13 ordered phases `Q1 → Q2 → Q4 → Q3 → Q5`. The auto-
classifier (Q3) is a **prerequisite** for the operator-approval gate (Q4)
because the operator approves "tests at level X with budget Y" — without
Q3's classifier, the operator has no levels to approve at.

Order as **Q1 → Q2 → Q3 → Q4 → Q5**. Already applied to §13.

### 16.8 — Effort revised to ~21 days

The original §13 estimated ~14 days. After absorbing 16.1 (½ day for
classifier fixtures), 16.5 (½ day for progress streaming), 16.4 (1 day
for SHA-keyed cache), and the realistic plan-scoped-QA migration cost
(legacy in-flight plans need a drain mode, ~2 days), revised total is
**~21 days of focused engineering**. Already applied to §13.

### 16.9 — Empty-test-case handling

What happens when a plan has zero `visual-tests-approved.md` entries?
Two policies, pick one explicitly:

- **Strict**: refuse to mark plan DONE; emit attention item "no approved
  visual tests for this plan."
- **Lenient**: skip QA entirely; mark plan DONE with `qaStatus: 'skipped-no-tests'`.

Recommendation: **strict for plans with `executionMode: 'production'`,
lenient for `executionMode: 'experimental'`** (the existing field on
Plan). Implement in Q4.1 alongside the contract loader.

### 16.10 — Coverage-check escalation

If a story acceptance-criterion is tagged `needsBrowser: true` but no
visual test covers it, the current redesign is silent on what to do. Add
explicit policy in Q4.1:

- Coverage analyzer runs after PM emits `visual-tests-draft.md`.
- Any AC with `needsBrowser: true` and zero matching draft tests → emit
  attention item, block plan from advancing past PM stage until either
  (a) PM revises draft, (b) operator overrides with `coverage-waived: true`
  on the AC.

This catches the common failure where PM forgets a test and QA passes by
default.

### 16.11 — BOILERPLATE_REGISTRY needs a `qaContext` extension (Q2.3)

PR-5 added boilerplate-aware PM prompts via `BOILERPLATE_REGISTRY[boilerplate].pmContext`.
QA needs the same treatment: each boilerplate should declare what its
working app looks like (e.g., Vite-React-default boots on :5173, has
`#root`, no auth gate; Next.js-default boots on :3000, has SSR shell, may
need warmup) so the QA stage's bash phase can pick the right healthcheck.

Add `qaContext: { defaultPort, healthcheckPath, warmupMs }` per
boilerplate entry. Implement in Q2.3 alongside the plan-scoped server
launcher.

### 16.12 — Q14 open question: hierarchical vs independent levels

§14 asks open questions but misses one that came up while implementing:
**should L0 → L1 → L2 be hierarchical (L1 only runs if L0 passed) or
independent (all three levels run regardless)?**

Hierarchical is cheaper but creates ordering bugs (L1 might pass even
though L0 failed for a different reason). Independent is wasteful but
gives complete signal.

Recommendation for Q3.2: **independent within a single test, hierarchical
across tests in the same plan.** I.e., a single test runs at exactly one
level (its classified level). But if the bash phase finds a server-boot
failure (universal L0), don't bother running any L1/L2 tests — short-
circuit the whole stage with a single attention item.

### 16.13 — Non-goals worth stating

To prevent scope creep during implementation:

- **Not in scope:** visual regression diffing, percy/chromatic-style
  pixel comparison, screenshot baselines, accessibility audits beyond
  what L2 sees in a single screenshot, performance budgets.
- **Not in scope yet:** mobile viewports beyond the one PM specifies,
  cross-browser testing, dark-mode validation.
- **Reserved for v2.6:** test-stability dashboards, flake detection,
  per-operator test approval workflows.

### 16.14 — What changes for the dev agent

The dev-agent prompt currently doesn't mention visual tests at all
(QA happens after dev DONE). Under the redesign, dev-agent should:

- Be **aware** that `visual-tests-approved.md` is the contract the QA
  stage will enforce (so dev should read it before implementing).
- Be **forbidden** from editing `visual-tests-approved.md` (only PM +
  operator can).
- Be **encouraged** to write its own L0 sanity tests (boot + smoke) into
  the plan's `tests/qa-sanity/*.sh` directory — these run as L0 in the
  QA stage and catch dumb regressions before L1/L2 cost is incurred.

Add to dev-prompt template in Q4.3.

---

*End of reviewer addendum. Original redesign signed off; phases Q1-Q5
proceed in the order above (Q1 → Q2 → Q3 → Q4 → Q5). PR-8a begins with
Phase Q1 (kill the epic-scoped fan-out).*
