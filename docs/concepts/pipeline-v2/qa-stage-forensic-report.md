# QA Stage — Forensic Report & Brainstorm Brief

| Field             | Value                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| **Status**        | Pre-design — operator brainstorm input                                                               |
| **Source incident** | `dino1` plan, 2026-04-29 — QA stuck >40 minutes, operator abandoned. 36 visual tests pending, 224 QA-related attention items, 4 parallel epic-scoped QA jobs running on a single t2.micro. |
| **Audience**      | Operator + future PR author of the QA refactor (PR-8 in the efficiency-fixes plan)                  |
| **Goal**          | Document every problem the dino1 QA run exposed so the redesign can attack root causes, not symptoms. Frames the design space; does NOT prescribe a solution. |

---

## Document map

- [What we observed in dino1](#what-we-observed)
- [The 10 distinct problems](#the-10-problems)
- [Why these problems exist (architectural roots)](#why-these-problems-exist)
- [Are the QA tasks themselves valid?](#are-the-qa-tasks-themselves-valid)
- [Cost / time / waste accounting](#cost-time-waste-accounting)
- [Design-space questions (operator brainstorm input)](#design-space-questions)
- [Where the pipeline is heading — design constraints](#where-the-pipeline-is-heading)
- [Out of scope for this brainstorm](#out-of-scope)

---

<a id="what-we-observed"></a>
## What we observed in dino1

### Pipeline shape

Plan dino1: 1 plan → 4 epics → 10 stories → 33 ACs → 36 visual tests (dev-emitted) → 4 epic-scoped QA jobs.

Each epic-QA job runs the same pipeline definition (`buildQaPipeline` in `functions/shared/pipelines/visual-qa-pipeline.ts`):

```
qa-start-server  →  qa-evaluate (LLM agent: Sonnet)  →  qa-stop-server
   (shell)            (the heavy step)                     (shell)
```

### Timing of the 4 parallel QA agents (verbatim from the live-log)

| Time  | e1 (port 5173)              | e2 (port 5174)              | e3 (port 5175)              | e4 (port 5176)              |
|-------|-----------------------------|-----------------------------|-----------------------------|-----------------------------|
| 15:20:40 | qa-start-server begin    | qa-start-server begin       | qa-start-server begin       | qa-start-server begin       |
| 15:20:44 | qa-start ok (4263 ms)    | qa-start ok (4158 ms)       | qa-start ok (4175 ms)       | qa-start ok (4217 ms)       |
| 15:20:44 | qa-evaluate spawn        | qa-evaluate spawn           | qa-evaluate spawn           | qa-evaluate spawn           |
| 15:20:51 | mkdir vt-screenshots     | mkdir vt-screenshots        | mkdir vt-screenshots        | mkdir vt-screenshots        |
| 15:20:54 | playwright screenshot \"1280x720\" (FAILS) | same | same | same |
| 15:21:02 | playwright screenshot \"1280,720\" (retry) | same | same | same |
| 15:21:04 | reads game.js fragment  | reads game.js fragment      | reads game.js fragment      | reads game.js fragment      |
| ...      | (still running 92 min later, 0 screenshots uploaded) |  |  |  |
| 16:53    | operator clicks Abandon — QA stage at 92m 33s, status `running`, 0/36 tests passed, 224 attention items |

### Headline numbers

| Metric                                | Value         |
|---------------------------------------|---------------|
| Wall-clock until abandon              | 92m 33s       |
| Visual tests passed                   | 0 / 36        |
| QA-related attention items            | 224           |
| Parallel `npm run dev` instances      | 4             |
| Parallel `claude -p` QA agents        | 4             |
| Approx peak memory pressure (t2.micro)| ~2.5–3 GB target / 1 GB physical → swapping |
| Net work product (screenshots in S3)  | 0             |

---

<a id="the-10-problems"></a>
## The 10 distinct problems

The dino1 run exposed ten distinct issues. Some compound (memory pressure × parallel agents × stuck pipeline = kernel hang we saw the next day). Some are independent.

### 1. Plan-scoped artifact, epic-scoped QA — N× duplicated work

**Observation:** All four epics serve the **same** project at `/home/ubuntu/projects/dino1`. Different ports (5173, 5174, 5175, 5176) all run `npm run dev` against the **same source tree**. Screenshots from epic-1's QA are byte-identical to epic-2's, etc.

**Effect:** Each visual test is captured up to 4 times. Each `npm run dev` boot pays its own ~4-second cost. Each QA agent reads the same `game.js` independently.

**Code reference:** `functions/shared/services/visual-qa-launcher.ts:50-133` is invoked once per epic by `functions/cron/wave-completion-check.ts:104` in a `for (let i = 0; i < epicsForPlan.length; i++)` loop. Each iteration produces an independent QA job with `port = QA_PORT_BASE + (i % QA_PORT_RANGE)`.

**Why this happened:** the launcher was designed when each epic might have its own deployable. In practice for v1 single-project plans, all epics share `epic.workingDir` (= `plan.workingDir`).

### 2. t2.micro memory pressure under QA fan-out

**Observation:** four simultaneous `npm run dev` (~150–300 MB each, vite + esbuild) + four simultaneous `claude -p --model sonnet` (~250 MB each, accumulating context). Peak target: ~2.5–3 GB. Box has 1 GB.

**Effect:** kernel swaps, then OOM-kills, then hangs. Two kernel-level instance hangs in 24 hours (2026-04-28 13:17 and 2026-04-29 15:23) both required AWS `stop --force` + `start` to recover.

**Code reference:** `MAX_CONCURRENT_TOTAL=4` set in `/opt/futurator-daemon/.env` (per `pipelinev1-deferrals.md:1078`) was tuned for 4 parallel **dev** agents on the assumption that QA wasn't simultaneously running 4 dev-servers. With QA fan-out the budget breaks.

**Compound effect with #1:** if QA were plan-scoped (1 dev server, 1 agent), peak memory would drop ~75% and the hangs likely disappear.

### 3. Visual tests come from a synthetic dev-emitted block, never operator-reviewed

**Observation:** the dev agent emits `---VISUAL_TESTS---` YAML blocks (parser at `functions/shared/pipelines/visual-qa-pipeline.ts:19-46`). The dev agent invents the tests; QA tests against them; the operator never sees the test definitions before QA runs.

**Effect:** garbage-in, garbage-out. A dev that emits "verify the canvas renders" can't catch "the canvas renders the wrong thing." The 36 dev-emitted tests for dino1 likely overlap heavily and miss real visual regressions.

**Code reference:** `mergeVisualTestsBlock` in `daemon/pipelines/lib/visual-tests-writer.mjs` writes whatever the dev produces to `<projectDir>/visual-tests.md` with no validation other than parse-shape.

### 4. QA prompt is boilerplate-blind

**Observation:** the QA prompt at `visual-qa-pipeline.ts:142` says: "Read `${workingDir}/src/App.tsx` briefly to cross-reference what SHOULD render." dino1 is vanilla JS — there is no `App.tsx`, the entry is `game.js` + `index.html`. The agent does an aborted Read, gets confused, falls back to rubric-only judgement.

**Effect:** for non-React projects, QA's cross-check step is a no-op. Same disease as PR-5's PM prompt before we made it boilerplate-aware.

**Code reference:** `visual-qa-pipeline.ts:142` hardcodes `src/App.tsx`. No `boilerplateType` is threaded through `launchVisualQa` to `buildQaPipeline`.

### 5. Playwright invocation prompt has wrong example

**Observation:** every QA agent in all 4 epics ran the same self-correction:

```
15:20:54  npx playwright screenshot --viewport-size="1280x720" ...   (FAILS)
15:21:02  npx playwright screenshot --viewport-size="1280,720" ...   (succeeds)
```

The prompt says `--viewport-size="${viewport}"` where `viewport = "1280x720"`. Playwright's flag actually expects `1280,720` (comma). The agent learns by retry — paying for the mistake.

**Effect:** ~$0.05 per epic × 4 = ~$0.20 wasted on every QA run on this exact same retry pattern. Reproducible across plans.

**Code reference:** `visual-qa-pipeline.ts:99` defaults `viewport = '1280x720'`. The prompt should pass `1280,720` directly.

### 6. No retry / escalation / wall-clock cap on the QA agent

**Observation:** `buildQaPipeline` returns a pipeline with `maxIterations: 1`. The `qa-evaluate` step has no per-step timeout. The dino1 QA agents have been "RUNNING" for 92m+ when the operator abandoned.

**Effect:** when QA gets stuck (network blip on S3 upload, agent loops on a screenshot, agent hits cost ceiling), there's no automatic escalation. Operator must abandon manually.

**Compound effect with PR-1's T0.3:** dev-pipeline retries are now bounded (`MAX_DEV_ATTEMPTS_PER_STORY=2`); QA pipeline has no equivalent. Any future PR-6 retry-resume work won't help QA either.

### 7. The agent does the screenshot work the daemon could do

**Observation:** `qa-evaluate`'s prompt instructs the LLM to:
- Run `mkdir`
- Loop `npx playwright screenshot` for each visual test
- Run `aws s3 cp` for each PNG
- Run `aws s3 ls` to verify upload
- Then judge from screenshots.

All of those are deterministic shell commands. The only irreducibly LLM-needed step is: **looking at a screenshot and judging "does the canvas render the dino correctly?"**

**Effect:** ~80% of `qa-evaluate`'s tool calls are bash that doesn't need an LLM. At Sonnet pricing × N tests, that's substantial waste. The same anti-pattern PR-3 fixed for B-series gates ("bash between agents").

### 8. `224 QA-related attention items` — wave-reducer dedup gap

**Observation:** the inbox shows 224 items, all variants of "QA stuck" / "test failed" / "wave gate not met."

**Effect:** identical to the dev-pipeline issue documented in `pipeline-v2-0-efficency-fixes.md` PR-7 (G+H+I). Every cron tick + every job-status transition that observes "wave still has failures" creates a brand-new attention item. Over 92 minutes × hourly cron × 4 epics × multiple status transitions = N×M×K duplicates.

**Code reference:** `functions/shared/services/wave-reducer.ts:170-213` (also referenced in PR-7 plan).

### 9. Per-port server collisions with the dev pipeline's plan-build step

**Observation:** `qa-start-server` does `kill $(lsof -ti:${port})` on its own port. But `plan-build-pipeline.ts`'s `plan-server-check` step uses port 5173 unconditionally. If a dev-side build server is still running when QA starts, port 5173 gets killed but ports 5174–5176 may inherit a stale `node_modules/.vite/` cache lock from the dev's build that wasn't gracefully shut down.

**Effect:** intermittent QA boot failures that look like "Vite hangs at startup". The `kill $(lsof -ti:${port})` is a partial fix because it doesn't clear vite's filesystem locks.

**Code reference:** `visual-qa-pipeline.ts:111` (per-port kill) vs. `plan-build-pipeline.ts:74` (unconditional :5173).

### 10. Plan dashboard cannot recover gracefully — operator must abandon

**Observation:** when QA is stuck, the only operator action surfaced is "Abandon plan". There is no "kill QA, retry the failed test, escalate this specific test" surface.

**Effect:** the operator has to abandon the entire plan to break out, losing all the dev-stage work product. dino1's 4 epics × 10 stories × all the dev cost was effectively wasted because QA got stuck.

**Code reference:** `src/components/labs/plan-dashboard/views/qa-review-view.tsx` (UI surface).

---

<a id="why-these-problems-exist"></a>
## Why these problems exist (architectural roots)

Three patterns underlie most of the 10 problems:

### Root 1: epic-scoped QA was the wrong unit of work

The launcher was designed before `App.workingDir` was the universal project root. In v0 each epic could theoretically have its own deployable; in v1 all epics share `plan.workingDir`. The launcher fan-out (`for epic of epicsForPlan: launchVisualQa(epic, ...)`) is now actively harmful: it duplicates work, racks up memory pressure, and makes the inbox unreadable.

### Root 2: the LLM is doing work bash should do

Following PR-3's bash-first principle: "every fix in this plan must answer 'why can't bash do this?' before adding to a prompt." The QA pipeline violates this:
- Screenshot taking → bash
- S3 upload → bash
- File existence check → bash
- Visual judgement → LLM (legitimately)

The prompt mixes 80% bash work with 20% LLM judgement and pays Sonnet rates for both.

### Root 3: visual-test definitions skip the operator

The dev agent invents tests; QA tests them; operator only sees results. The trust model is upside-down: we're paying QA's cost on tests that may not even be the right tests. The operator has the highest signal about what should be tested but no input until after the run.

---

<a id="are-the-qa-tasks-themselves-valid"></a>
## Are the QA tasks themselves valid?

Three failure modes for "the right tests are running":

### Failure A — Dev-emitted tests are unreviewed
- Dev produces visual-tests inline.
- QA runs against them.
- Operator never gates the test list.
- **Cure:** new "Visual Tests" tab in the plan dashboard at the Developing → QA Review transition. Operator can edit / remove / add visual tests before QA spawns.

### Failure B — Tests don't reflect the plan's actual ACs
- The plan AC says "the dino dies on cactus collision."
- The dev-emitted visual test says "the canvas renders blue."
- These are unrelated. QA passes the unrelated test and we mark the AC done.
- **Cure:** require visual tests to have a `criteriaRef:` that points at a real AC ID. Reject tests without one. Add a coverage check: every AC marked `needsBrowser: true` MUST have at least one visual test referencing it.

### Failure C — Tests are too coarse to fail
- "The app renders" is technically a visual test but always passes if the page returns 200.
- 36 such tests pass; the actual game has a broken collision detector.
- **Cure:** rubric step in the QA prompt — reject tests whose `expect:` is generic ("renders correctly", "looks fine"). Require a specific assertion ("dino sprite at x=50, y=200 in idle state").

These are content problems, not architectural problems. They get solved by **inserting an operator review gate** (Failure A's cure). The other two cures are bash-side validations that augment the operator review.

---

<a id="cost-time-waste-accounting"></a>
## Cost / time / waste accounting

Forensic estimate of dino1's QA stage if it had completed (or 4× if currently per-epic):

| Item                                          | Per-epic | × 4 epics | Plan-scoped (target) |
|-----------------------------------------------|----------|-----------|---------------------|
| `npm run dev` boot (RAM-seconds)              | 4 s × 250 MB = 1 GB·s | 4 GB·s | 1 GB·s |
| Persistent dev server during QA               | 92m × 250 MB = ~23 GB·min | ~92 GB·min | ~23 GB·min |
| `claude -p` agent (input + output tokens)     | ~3k in + ~2k out + many tool turns | × 4 | × 1 |
| Approx Sonnet cost (rough)                    | ~$0.50 | ~$2.00 | ~$0.50 |
| Wasted on `viewport-size` retry (bug #5)     | ~$0.05 | ~$0.20 | ~$0.05 |
| Screenshots taken                             | 36 (dup'd) | 144 (dup'd) | 36 (unique) |
| S3 upload bandwidth                           | 36 PNGs | 144 PNGs | 36 PNGs |
| Attention items written                       | ~50 | ~224 | 0–4 (per PR-7 G) |

**Bottom line:** plan-scoped QA + bash-driven screenshots + retry-cap should cut QA cost by ~80–90% and eliminate the t2.micro hangs.

---

<a id="design-space-questions"></a>
## Design-space questions (operator brainstorm input)

These are the open questions the redesign needs answers to. **No prescribed answer here** — this is your input space.

### Q1 — What does "visual QA" actually mean for the project?

Three plausible answers, each leads to a different architecture:

**(a) Smoke-screenshot per AC** — "every AC marked needsBrowser gets a screenshot the operator scrolls through." Simple, cheap, low-fidelity. QA agent's role is just orchestration + S3 upload. Operator does the actual judgement in the gallery.

**(b) Behavioral verification** — "QA agent should drive the app (click, type, wait) per the test's setup/action and assert specific UI state." High-fidelity, costly, brittle. QA agent does real Playwright work. Best for production rigor.

**(c) Hybrid** — smoke for prototype rigor, behavioral for mvp/production. Maps cleanly to existing PlanRigor enum.

**Question for operator:** which of these three matches your mental model?

### Q2 — Who writes the visual tests?

Three options:

**(a) Operator writes them at plan creation** — like ACs. Highest fidelity, slowest.
**(b) Dev agent emits them inline** (current). Fastest, lowest fidelity.
**(c) Hybrid: dev emits drafts, operator reviews in a UI tab before QA runs.**

(c) is what I'd recommend (see Failure A above). But (a) might be the right answer for production rigor.

### Q3 — How fault-tolerant should QA be?

When QA fails on test #18 of 36:
- **(a) Halt the whole run** — operator triages, fixes, re-runs all 36. Simple, expensive.
- **(b) Continue, mark #18 failed, finish the rest** — produces a complete report with one failure. Operator decides.
- **(c) Retry #18 alone with backoff** — 2 retries, then either halt or continue.

Today the answer is implicit (b) but with no escalation. (c) seems best.

### Q4 — Should QA run against the operator's local dev server too?

Today QA always runs the project's `npm run dev` on EC2. If the operator already has the dev server running locally (or against the deployed S3 site), QA could test against `https://<plan>.futurator.ai/` instead. Saves the dev-server boot cost; tests the actual artifact.

**Question:** is "QA tests EC2-local" a hard requirement or an artifact of where the pipeline started?

### Q5 — How does QA interact with retries?

If the dev pipeline retries a story and the story re-emits `---VISUAL_TESTS---`, do we:
- **(a) Re-run all QA tests** — safe, slow.
- **(b) Re-run only tests whose `criteriaRef` matches the changed story's ACs** — efficient, requires test→AC linkage.
- **(c) Diff visual-tests.md and re-run only changed/added entries.**

(b) is the bash-first answer (deterministic from the diff) but requires Q3's coverage rule.

### Q6 — Where does the operator triage QA failures?

Today: an inbox item with "Open story" / "Open logs" buttons. Better:
- **(a) A QA-specific failure drawer** showing screenshot + expected text + recent dev work summary side-by-side. Operator marks "this is a real failure" or "test was wrong" with one click.
- **(b) Retry-with-hint flow** — operator types "the dino color is right but you tested in dark mode" → re-run with that hint → cheaper than re-running the entire QA stage.
- **(c) Inline edit-and-rerun** — operator edits the test's `expect:` field, the daemon re-runs that single test.

(c) is highest-leverage but biggest UI lift.

### Q7 — Plan-scoped QA changes the wave-reducer

Today wave-reducer fans out QA per-epic. Plan-scoped QA means:
- Wave-reducer creates **one** QA job at plan-completion.
- Visual tests are aggregated across all epics.
- A QA failure is a plan-level signal, not epic-level.

**Implication:** the existing `epic.qaJobId` field becomes legacy. New `plan.qaJobId` field. Migration path for in-flight plans?

### Q8 — How should QA escalate to the operator?

Today: 224 attention items in the inbox + plan-dashboard "stuck" indicator. Better:
- **(a) Per-failed-test attention items** — one item per failed visual test. Operator triages each.
- **(b) Single "QA report ready, X failed" item** — drills into the QA report drawer.
- **(c) PR-7's Labs-root bell** with "QA failures: 3" badge across all plans.

These compose: (b) at the plan level, (a) inside the QA drawer, (c) at the Labs nav.

---

<a id="where-the-pipeline-is-heading"></a>
## Where the pipeline is heading — design constraints

The QA redesign should anticipate where the rest of the pipeline is going. From the v2.5 consolidated spec + this conversation's running fixes:

### Constraint 1 — More boilerplates, more conventions

Today: nextjs (wired) + sst/vite/mobile (stub). Phase 2 wires the others. Each has different file layouts and entry points. **QA prompts must consume `BOILERPLATE_REGISTRY[type].pmContext`** the same way PR-5's PM prompt does. Otherwise the "Read src/App.tsx" hardcode (problem #4) recurs for every new boilerplate.

### Constraint 2 — Per-story worktree isolation (Phase 2 deferral)

Today: all stories edit the same working directory. Phase 2 introduces `wip/<storyId>/` worktrees so parallel stories can't race. **Implication for QA**: the artifact under test will live at the plan-merge level (after wave-close compile rolls everything into the trunk), not at any single worktree. This further argues for plan-scoped QA — there's nothing meaningful to test at the epic level mid-flight.

### Constraint 3 — Compounding (Phase 3)

Phase 3 introduces "skill loadouts" — agents that learn from prior plans. **Implication for QA**: the QA agent should accumulate knowledge of what the plan's deliverable looks like across iterations. A QA prompt for `dino1 v2.0` should know what `dino1 v1.0` looked like. Currently every QA run is stateless.

### Constraint 4 — Cost ceilings (T1.4 in the efficiency-fixes plan)

Per-plan and daily cost ceilings will fire. **Implication for QA**: QA is the most expensive single stage of a plan's lifecycle (especially today's 4× duplicated work). It must respect the ceiling proactively, not crash at it. The redesign should expose `qa.estimatedCostUsd` so the operator can see "this QA run will cost $0.50" before spawning.

### Constraint 5 — Review-stage gating

The QA stage is the **last gate before deploy**. Mistakes here ship to S3. The redesign must make false-positive ("test passed but bug exists") the operator's responsibility, not the agent's. The bash-first principle helps: deterministic shell-side checks (file exists, page returns 200, no console errors in dev-server log) catch a lot of "test passed because nothing rendered."

### Constraint 6 — t2.micro upgrade

The 2026-04-28 + 2026-04-29 hangs prove the box is undersized for current parallelism. A t3.medium ($30/mo) gives 4 GB RAM. **Implication for QA**: even if QA stays at 4 parallel epics, t3.medium handles it. But plan-scoped QA on t2.micro is the cleanest answer — solves the cost problem without infrastructure changes.

---

<a id="out-of-scope"></a>
## Out of scope for this brainstorm

These are things the QA redesign should **not** try to solve. They belong in other PRs:

- **Attention dedup** — covered in PR-7 G+H+I (idempotent upsert + auto-resolve).
- **Labs-root bell** — covered in PR-7 J.
- **Test-first development (TDD-style red-gate)** — handled at the dev stage by `test-author` + `test-gate-red`. QA is a separate concern.
- **Static-site deploy verification** — that's the Deploy stage's job (currently Lambda + sst). QA verifies the dev-server output, not the deployed artifact.
- **Continuous-monitoring of deployed apps** — out of scope. QA is a one-time gate.
- **Visual diffing across plan iterations** — Phase 3 / skill loadout territory.

---

## Document conventions

- **Status field on each Problem**: add `Status: open | in-design | done` inline as the redesign work progresses.
- **Source incident** — keep a link to the dino1 logs (or whatever future plans expose the same patterns) so the redesign can be tested against the same failure shape.
- **Cost numbers** are rough — the brainstorm is qualitative, not budgeted.
