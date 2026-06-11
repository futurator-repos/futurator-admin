# QA Review — honest critique + redesign plan (v2.6 follow-up)

> Status: PROPOSED 2026-06-12, from the pong1 M6 E2E forensics.
> Companion: wave-gate-vqa-implementation-plan.md (§6 status log).

## 0. What pong1 proved and what it exposed

The pipeline WORKED: 6/6 stories, every wave gated, one real judged failure
(AC-S5-1) fix-forwarded into an auto-minted story that passed at wave 3,
final QA green, app renders. But the QA Review stage — the operator's
shipping decision surface — failed four honesty tests the operator
immediately noticed (L0/L1/L2 invisible, 8 screenshots for 4 tests, two
identical "epic" QA logs, no per-test evidence drill-in), and the forensic
exposed three pipeline diseases.

## 1. Forensic findings (pipeline, not UI)

### P1 — CRITICAL: story commits don't guarantee the story's touchPoints ship

Wave-0's VQA report says it plainly: "Feature file
src/features/court-preview.feature.tsx was never created … Generated
page.tsx renders empty." The file EXISTED in the story worktree — untracked
— and the smoke validated it there. The commit step's snapshot-diff staging
(`comm -23` post-DEV vs capture-dev-baseline) subtracts everything present
at baseline; on a RETRY job in the SAME worktree, the first attempt's
untracked output IS the baseline (`baseline_dirty=1 baseline_untracked=6`),
so it is permanently un-stageable. The story "passed" while shipping a
subset of what was validated. Validated ≠ shipped, story-level edition.
**Fix:** (a) after snapshot-diff staging, unconditionally `git add --` every
declared touchPoint that exists on disk (the touchPoints ARE the story's
contract); (b) post-commit tripwire: every touchPoint present on disk must
exist in HEAD, else a loud STORY_COMMIT_INCOMPLETE marker (daemon writes a
HIGH card); (c) on a retry job with no `story: <id>` commit in history, the
story owns its worktree's uncommitted state — skip baseline subtraction for
files matching touchPoints.

### P2 — Forensic attribution: wave-gate work books as machine-wait (41%!)

The timing slicer has no category for the v2.6 gate stages — the VQA
evidence/judge/triage/fixer minutes and merge/validation time on the gate
jobs land in `machine-wait` (a1042032 alone: 431s). Add slicer categories:
`merge-gate` (wave-merge runner lines) and `vqa-gate` (`[wave-vqa]` lines),
keyed off the gate job's streamed event text. Separately, ~4-5 min of true
`__inter_` wait is the wave-completion cron's 60s cadence × 6 wave
boundaries — known cost, candidate for event-driven reduction later, not
now.

### P3 — Notification hygiene (4 cards from this plan)

- `test-gate-failed` rec=36: the story-failure card was re-upserted by every
  cron tick while the story sat failed. Extend the snake3 write-once guard
  to story-level cards (write on state CHANGE, not on every reduce).
- `wave-vqa-failed` (AC-S5-1) stayed OPEN although its auto-minted fix story
  PASSED the wave-3 gate. When a `wave-vqa-fix` story's criteria pass at a
  later gate, auto-resolve the originating card (dedupKey
  `wave-vqa:<plan>:<epic>:<wave>:<ownerStoryId>`) — the loop should close
  itself end-to-end.
- `compile-failed` (knowledge compiler, story b73e4e8d): collateral of the
  P1 retry mess (stale .pipeline state in the reused worktree). Re-check
  after P1; no separate fix unless it recurs on a clean story.
- `wave-vqa-unverifiable` (wave 0): CORRECT and honest — it caught P1 live.
  Keep.

## 2. QA Review — the four operator questions, answered from code

1. **"Where are L0/L1/L2?"** They exist only at the CONTRACT phase
   (`classifiedTests[].level`, auto-approved at mvp before the operator can
   see it) and on each TEST_RESULTS entry — the gallery and verdict strip
   never render them. The operator cannot see that L0 = console-error scan,
   L1 = static screenshot judges, L2 = interaction flows, nor which tests
   ran at which level (pong1: L1×4; L0 ran app-wide; L2 empty).
2. **"Why 8 screenshots?"** Double-count bug. `buildVqaRollup` iterates
   `for (epic of epics)` and resolves the SAME plan-level qaJob for every
   epic (`resolveEpicQaJobId` → `plan.qaJobId` wins), then ingests the
   job's FULL app-wide TEST_RESULTS once per epic: 2 epics × 4 tests = 8
   thumbnails, "VQA 8/8", doubled runCostUsd, and wrong epicId stamping.
3. **"Why 2 epic QA logs?"** Same root: per-epic breakdown panels each
   point at plan.qaJobId — two panels, one job, byte-identical logs.
4. **"Where is each test's pass + details?"** Only FAILURES have a drawer.
   Passing tests are anonymous thumbnails labeled by raw VT id
   (`VT-<uuid>-1`) — no expected text, story, AC, level, rationale,
   full-size screenshot, or history.

Additional honesty problems found while answering:

- **The build matrix is a façade.** Cells (compile/typecheck/lint/unit ×
  wave) come from per-check variables the wave-merge job NEVER emits, so
  every cell falls back to the job's single COMPLETED bit: one green bit
  painted as 24 independent checks. M4's rigor-composed stages make the
  truth available — the matrix doesn't read it.
- **Wave-gate VQA — the strongest evidence in the system (per-AC judged
  verdicts on the merged candidate, fix history, committed reports) — is
  entirely absent from QA Review.** The fix-forward → fix-story → verified
  arc that actually happened on pong1 is invisible at the shipping
  decision.
- **"AC 12/12 PASS" at mvp is an auto-pass rubber stamp** presented with
  the same visual weight as real verification.

## 3. Redesign — what QA Review should be

**Principle: claim-centric, single-counted, evidence-linked.** The unit of
QA is a browser AC / visual test (a CLAIM about the product), not a job.
Every claim shows its full verification lifecycle; every verdict is one
click from its evidence; nothing is double-counted; nothing not-run is
painted green.

### Layout (top → bottom)

1. **Verdict strip (honest):**
   `READY TO PUBLISH · VQA 4/4 · gate-VQA 5 verified / 1 fix-forwarded→fixed
· checks 18 ran / 0 fail · AC audit auto-pass (mvp) · rigor MVP`.
   Unique counts only. AC chip explicitly labeled auto-pass below
   production rigor.
2. **Claims table** grouped Epic → Story → AC/visual-test rows:
   `AC text · level chip (L0/L1/L2) · gate verdict (wave N) · final QA
verdict · thumbnail`. The fix-forward arc renders inline:
   `wave 2 FAIL → fix story S6 → wave 3 PASS → final PASS`.
3. **Universal evidence drawer** (click ANY row, pass or fail): full-size
   screenshot(s) (gate isolation shot + final composed shot), expected
   verbatim, judge rationale/observations, level + what that level means,
   captured URL/surface, cost + duration, story link, attempt history from
   the handoff packet, accept-as-known-limitation action (exists today for
   fails — keep).
4. **Run panel (one, plan-scoped):** L0 console scan result (its own row:
   allow-listed vs flagged lines), L1/L2 counts, ONE log stream, cost,
   re-run controls. Per-epic panels only when legacy per-epic qaJobIds
   actually differ.
5. **Gate matrix (truthful):** rows = epic·wave; columns = the rigor's
   ACTUAL blocking stages (from qualityGate composition: build, tests,
   lint@budget — plus knip/format:check at production) + a `gate VQA`
   column (pass/fixed/fix-forward/unverifiable/skipped). Cells render
   `skipped`/`n-a` when a stage didn't run — never inferred green. Needs a
   small daemon addition: wave-merge persists per-stage outcomes
   (`waveMergeResult.stages[]`) instead of one bit.

### Implementation milestones

- **QA-A (aggregator correctness — fixes 2 of the 4 complaints outright):**
  plan-scoped rollup computed ONCE (not per epic); per-test story/epic
  attribution via the visualTests join; `level` + `criteriaRef` exposed on
  every VqaTestResult; de-dup per-epic panels; cost summed once. Unit
  tests pin: N unique tests → N results regardless of epic count.
- **QA-B (gate-VQA ingestion):** aggregate `waveMergeResult.vqa` from each
  epic's waveBuildJobs (+ handoff packets / committed wave reports) into a
  `gateVqa` section keyed by acId; join to claims; auto-resolve the
  wave-vqa-failed card when the fix story's AC passes (P3).
- **QA-C (UI):** claims table + universal evidence drawer + honest verdict
  strip + single run panel with L0/L1/L2 made legible.
- **QA-D (truthful matrix):** daemon persists per-stage gate outcomes;
  matrix reads them; VQA column; `skipped` rendering.
- **P-fixes ride alongside:** P1 commit-staging contract (CRITICAL, before
  the next parallel-stories test), P2 slicer categories, P3 card hygiene.

### Order of execution

P1 first (it corrupts any multi-story run), then QA-A (pure correctness),
QA-B+QA-C together (the operator-facing redesign), QA-D + P2/P3 last.
