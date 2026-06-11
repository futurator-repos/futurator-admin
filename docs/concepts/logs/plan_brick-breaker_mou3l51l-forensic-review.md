# Forensic review — `plan_brick-breaker_mou3l51l`

| Field               | Value                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| **Plan ID**         | `plan_brick-breaker_mou3l51l`                                                |
| **App**             | `brick-breaker` (canonical Phase 2 incident-class test)                      |
| **Kind**            | `initial` (legacy Phase-1 kind)                                              |
| **Rigor**           | `prototype`                                                                  |
| **Execution mode**  | **`orchestrator`** ← single most important finding                           |
| **Started**         | 2026-05-06T13:36:44.923Z                                                     |
| **Reached review**  | 2026-05-06T14:17:49.902Z (41m 4s wall-clock)                                 |
| **Slice time**      | 61m 18s (3 678 467 ms across 921 slices)                                     |
| **Stories**         | 11/11 marked done                                                            |
| **Cost**            | **$8.46 / $5.00 prototype threshold (+69% over)**                            |
| **Tokens**          | 155 k                                                                        |
| **GitHub commits**  | **1 (initial bootstrap only) — no per-story commits pushed**                 |
| **Attention items** | 2 × `compile-failed` (medium, non-blocking)                                  |
| **Authored**        | 2026-05-06 (this review)                                                     |
| **Forensic source** | `docs/concepts/logs/plan_brick-breaker_mou3l51l-forensic.json` (9 310 lines) |

---

## 0. The headline

The plan reached the QA Review stage with all 11 stories marked done, but **none of the recent Phase 2-A hardening (PR-32 → PR-42) ran on this plan**. Two compounding root causes:

1. **`executionMode: "orchestrator"`** routes the plan through `daemon/pipelines/epic-dev-pipeline.mjs`, _bypassing_ `functions/shared/pipelines/story-pipeline.ts` entirely. PR-32 → PR-42 modify the step-based pipeline; the orchestrator path is a separate code path that still runs Phase-1 conventions.
2. **Likely no `sst deploy` since today's PR batch.** Even if the plan had run on the step-based pipeline, the Lambda probably still serves pre-PR-32 pipeline definitions to new jobs.

Result: tightened tool allowlists didn't apply, turn caps didn't apply, baseline-diff didn't run, tamper-check didn't run, the typed `PROJECT_CONTEXT` schema didn't validate, and `existingTests` / `publicExports` weren't populated. The plan completed regardless — the orchestrator path is functional Phase-1 substrate — but it shipped a known-broken `collisions.ts` past REVIEWER, missed the budget by 69%, and produced **zero git pushes** for any of the eleven story commits.

---

## 1. Aggregate timing

```
total: 61m 18s (slice time, 921 slices, 12 jobs incl. 1 inter-job synthetic)

dev          69%   42m 19s   617 events   ← 11 stories' implementation
review       14%    8m 31s    77 events   ← REVIEWER turns + tool calls
compile       6%    3m 55s   189 events   ← compile-knowledge + sync
machine-wait 11%    6m 33s    34 events   ← inter-job slot gaps
fix           ~0%   48 ms     4 events    ← essentially zero retries
others        0%
```

Two observations:

- **`fix = 48 ms`** across 4 events. Either nothing failed (unlikely given the broken-file evidence) or the orchestrator path doesn't surface retry events as `fix`-classified slices. The classifier's `fix-on-retry` rule (PR-1.8.1, retryCount > 0 promotion) requires the daemon to track retryCount — which the orchestrator path may not propagate to the Slicer's JobContext.
- **`machine-wait = 6m 33s`** is the gap between consecutive jobs while the daemon's two slots churn. With 11 stories serialized through 2 slots, this is the irreducible scheduling tax. PR-29's `MAX_CONCURRENT=2` is honored.

---

## 2. Critical findings — ranked by severity

### 🔴 F-1 — Plan ran on the legacy orchestrator path, not the step-based pipeline

`forensic.plan.executionMode === "orchestrator"`.

This routes the plan through `daemon/pipelines/epic-dev-pipeline.mjs` (the per-story dev → reviewer → compiler orchestration), **not** through `functions/shared/pipelines/story-pipeline.ts` where every PR from PR-32 onward lives. Implications:

- No tightened `--allowedTools` / `--disallowedTools` per role (PR-32 / PR-32b)
- No `--max-turns` cap from the v2.5 §17 matrix (PR-38)
- No baseline-regression step (PR-36)
- No tamper-check at mvp+ (PR-41)
- No frozen-file husky hook (PR-41)
- No PROJECT_CONTEXT typed validation (PR-33)
- No `existingTests` / `publicExports` enrichment (PR-42)
- No single-pass test verify discipline (PR-40)

Per CLAUDE.md "Recent changes" Epic 17, `Plan.executionMode` is the canonical switch. Epic 16-4 (retire orchestrator path) is **deferred until step-based proven**. Brick-breaker is exactly the proving ground — but it just ran the path being deferred-from, not the path being deferred-to.

**Why this happened:** the API endpoint that creates plans defaults `executionMode` to whichever side it's hardcoded on. The brick-breaker plan was created via `POST /api/apps/:appId/plans` (createPlanForAppInputSchema) which has `executionMode: planExecutionModeSchema.optional()`. When omitted, the persistence layer's default kicks in. That default is currently `"orchestrator"` — meaning every new plan implicitly bypasses Phase 2-A.

**Fix shape** (proposed `PR-43 — flip executionMode default to 'pipeline'`):

1. Find the persistence default in `functions/shared/repositories/plan-repository.ts` (or equivalent).
2. Change default to `'pipeline'`.
3. Add a migration helper: existing in-flight plans keep their `executionMode`; new plans land on `'pipeline'`.
4. UI ("New Plan" form) surfaces the choice with a hint that pipeline is the Phase 2 path.
5. Effort: ~½ day, mostly testing.

### 🔴 F-2 — Lambda likely not redeployed since PR-32

Independent of F-1. Even on the orchestrator path, certain shared modules are loaded from `functions/shared/` at Lambda init time. The `BoilerplateMetadata.augmentFiles` consumed by the daemon's app-bootstrap saga comes from the Lambda's `BOILERPLATE_REGISTRY`. If the Lambda never picked up PR-35's `BASELINE_DIFF_AUGMENTS` or PR-41's `FROZEN_FILE_AUGMENTS`, the brick-breaker worktree won't have any of those files written.

**Verification (operator action):**

```bash
ssh ec2-instance
ls /home/ubuntu/projects/brick-breaker/scripts/ \
   /home/ubuntu/projects/brick-breaker/.husky/ \
   /home/ubuntu/projects/brick-breaker/.pipeline/ 2>&1
```

- If `scripts/capture-test-baseline.sh` is missing → PR-35 not deployed
- If `.husky/pre-commit-frozen` is missing → PR-41 not deployed
- If `.pipeline/.gitignore` is missing → PR-35 not deployed

**Fix:** `sst deploy` to push Lambda. Then restart daemon on EC2 to pick up PR-32b mirror. Story `PR-43` above is the structural fix; this is the one-time deploy.

### 🔴 F-3 — Zero per-story commits pushed to GitHub

GitHub `futurator-repos/brick-breaker/commits/main` shows only `Initial commit 03d31d2` (the bootstrap commit-and-push from app-create saga). All 11 story commits — which `compile-commit-on-pass` should have created locally — never reached `origin/main`.

**Why:** PR-19 added a `compile-push` step to the **step-based** story-pipeline. The orchestrator path (F-1) has no equivalent push step. Local commits accumulate on the EC2 worktree; if EC2 is lost or wiped, all eleven stories' history is gone — only the deployed S3 artifact would remain.

This is a **silent data-loss risk**, not a failure. The dashboard says ✅ ; GitHub says ❌. They disagree, and the deploy stage will use the EC2 working tree (not GitHub) — masking the problem until someone tries to clone the repo for a hotfix.

**Fix shape** (proposed `PR-44 — orchestrator path emits per-story git push`):

1. In `daemon/pipelines/epic-dev-pipeline.mjs`, after a story's COMPILER step writes knowledge updates, run `git push origin HEAD` with the same soft-fail semantics as PR-19's compile-push.
2. Surface `git-push-failed` attention items (fresh attention type) so silent push failures become visible.
3. Effort: ~½ day. Test with a fresh plan against a brand-new App.

### 🟠 F-4 — README placeholders not substituted

The pushed README still reads:

```
# APP_DISPLAY_NAME

Generated from futurator-repos/template-nextjs on INIT_DATE.
```

Two unresolved placeholders: `APP_DISPLAY_NAME` and `INIT_DATE`. The daemon's `inject-app-values` step uses placeholder format `__APP_SLUG__`, `__APP_DISPLAY_NAME__` (per `boilerplates/types.ts`). The template repo uses `APP_DISPLAY_NAME` and `INIT_DATE` — bare names, no surrounding underscores — so the substitutor finds nothing to replace.

**Format mismatch between template and substitutor.** Either:

- The template repo `futurator-repos/template-nextjs` uses an older placeholder convention.
- The daemon's substitutor was tightened to require `__X__` after the template was authored.

**Fix:** edit the template repo's README to use `__APP_DISPLAY_NAME__` and `__INIT_DATE__` (matching the substitutor's contract). Add a daemon-side test: bootstrap a synthetic App, assert no occurrence of `APP_DISPLAY_NAME` or `INIT_DATE` (un-prefixed) in the resulting working tree. Effort: 30 min.

### 🟠 F-5 — Budget overrun by 69% with no in-flight throttle

Plan spent $8.46 on a $5.00 prototype budget. The "BUDGET WARNING" banner surfaces _after_ the plan finishes — at that point you've already paid the over-spend.

PR-1 (Phase 1 hardening) shipped a "cost-ceiling-after-DONE detector". Looking at the attention items, only the two `compile-failed` entries surfaced — no cost-ceiling attention item fired. Two possibilities:

- The detector triggers post-DONE only for terminal status, and "review" status doesn't hit the same path.
- The detector requires a per-story budget threshold not configured for prototype rigor.

Either way, the user has no in-flight kill switch — the plan can run to $20+ before anyone notices.

**Fix shape** (proposed `Story 2-A-misc-2 — soft cost ceiling at 1.5× prototype budget`):

1. After every `step_complete` event with non-zero `cost`, the daemon checks `plan.totalCostUsd` against `rigor.softCeiling`.
2. At 1.5× threshold (e.g. $7.50 for prototype) → emit `cost-ceiling-warning` attention item, do not block.
3. At 3× threshold ($15 for prototype) → emit `cost-ceiling-block` attention, transition plan to `NEEDS_ATTENTION`, halt new story dispatches.
4. Operator can dismiss + raise threshold or abort.
5. Effort: ~1 day. Aligns with the existing PR-1 retry-budget infrastructure.

### 🟠 F-6 — REVIEWER passed a syntactically broken file

From the dev log shared earlier (e2w0s1 collisions story):

```ts
function paddleToEntity(paddle: Paddle): Entity {
  return {
    id: 'paddle',
    x: paddl.x,                 // typo: missing 'e' AND .position
    y: paddle.position.y,
    ...
```

And:

```ts
if (b.position.y - b.radius <= 0) {\ // Floor — ball lost
                                  // ↑ literal backslash, no newline
```

Plus the file truncates mid-`/* ── Paddle collision ─...`. REVIEWER then ran `npx tsc --noEmit` four times (timing out at 30s each), then _passed_ the story with the verdict "All errors are pre-existing (React type declarations missing)". That verdict is a hallucination — tsc on a syntactically broken TS file emits **parse errors**, not the React-types pre-existing errors REVIEWER claimed.

Three failures stack:

1. **DEV's Write tool emitted truncated content.** Either Claude's max-tokens cap was hit mid-Write, or the Write was interrupted by the daemon (cap on `numTurns=8` for prototype DEV, but PR-38 isn't deployed). The orchestrator path's own turn-cap may have triggered.
2. **REVIEWER had Bash access** (orchestrator path doesn't apply PR-3 Bash deny consistently). Without Bash, REVIEWER would have to make a verdict from the diff text alone — which is what v2.5 §10's REVIEWER stance is _supposed_ to enforce.
3. **REVIEWER's tsc commands timed out** — but instead of treating a tsc timeout as "couldn't verify", REVIEWER treated it as "no real errors found" and passed.

**Fix shape:** F-1's resolution (route through step-based pipeline) addresses points 2 and 3 directly. Point 1 needs separate investigation — see F-7.

### 🟡 F-7 — DEV produces truncated output near turn caps

`numTurns: 8` for the collisions DEV step. Whether this is PR-38's prototype cap (also 8) or a coincidence is moot — DEV exhausted its turn budget on 17+ file Reads before writing, then the Write itself was incomplete. The pattern is:

- DEV's first turns consume the budget on discovery (because PROJECT_CONTEXT didn't carry types/exports — F-9)
- DEV reaches the implementation step with little budget left
- The Write tool starts producing the file, but the agent's response is truncated mid-token
- DEV declares done, REVIEWER validates against the truncated file

**Fix shape** (proposed `Story 2-A-misc-3 — daemon detects truncated writes`):

1. After every `Write` tool_use, the daemon parses the captured stream for the `tool_result` event.
2. If the result contains a `tool_result` with a partial JSON or the tool's "successful write" marker is absent → flag the step as `dev-write-truncated`.
3. Auto-retry the step with the prompt addendum "your previous attempt's Write tool was truncated; complete the file in one shot."
4. Limit to 1 retry (existing retry budget covers it).
5. Effort: ~½ day. Adds robustness without changing the prompt-cache prefix.

### 🟡 F-8 — Visual QA skipped because DEV emitted no `---VISUAL_TESTS---` blocks

Visual QA panel: "No visual tests captured. Dev agent emits them during story work."

DEV's prompt template (Phase 1 + PR-3) instructs DEV to emit `---VISUAL_TESTS---` for stories with `[needs_browser=true]` ACs. None of the 11 stories included that block. Either:

- PM didn't mark any ACs as `needs_browser=true` for this plan (likely, since the plan kind is `initial` for a canvas game where every visible state is implicitly browser-testable).
- DEV emitted the block but the parser missed it (less likely).

For brick-breaker specifically — every AC is browser-testable. The PM-prompt's heuristic for marking ACs as `needs_browser=true` needs work. This is **PR-23d-style PM prompt tuning** territory; not a Phase 2 critical path issue but a quality regression vs dino-runner-1 which had visual QA fire.

**Fix:** PM prompt update — for canvas-game starter-pack plans, all rendering ACs default to `needs_browser=true`. ~30 min.

### 🟡 F-9 — DEV did 17+ file Reads when PROJECT_CONTEXT should have carried the answer

E2W0S1 DEV log shows 17+ Read tool calls before the implementation Write. This is **exactly** the symptom PR-42 was meant to eliminate (`existingTests` + `publicExports` populated in PROJECT_CONTEXT).

PR-42 enriches the daemon's `story-context-pack.mjs` assembler. But if the orchestrator path uses a different context-pack builder (or none at all), PR-42's enrichment never reaches DEV's prompt.

**Fix:** F-1's resolution. PR-43 (default to `pipeline` mode) makes PR-42 reachable for new plans.

### 🟢 F-10 — Two `compile-failed` attention items (already non-blocking)

Both attention items: "Compile step `compile-diff` threw: Shell step compile-diff failed. Compile is non-blocking — the rest of the pipeline continued."

Stories `02862a9a-0c04-4975-81b9-47a39b5f3baf` and `5861ef6a-e9e3-4aaa-ba66-dbe635b0e831`. Standard `compile-diff` failure mode. Per Phase 1 PR-A.4 hardening, compile failures don't block the pipeline. This is expected behavior for now.

What's not expected: only 2 of 11 stories had compile-failed attention. The forensic shows `compilation-completed: 9, compilation-failed: 2`. Which means 9 stories' compile-diff DID succeed and presumably called `compile-knowledge` → `compile-sync` → `compile-push`. So compile-push DID run for 9 stories. Yet GitHub has 0 of those pushes. Either:

- compile-push ran but failed silently (network, auth, branch-protection mismatch).
- compile-push doesn't exist on the orchestrator path (most likely — the step-based pipeline added it in PR-19).

The orchestrator path's compile sub-pipeline is `daemon/pipelines/compile-pipeline.mjs::getCompileSteps`. Looking at that file (per PR-32b migration), it has steps `commit-on-pass`, `compile-diff`, `compile-knowledge`, `compile-sync` — but **no `compile-push`**. F-3's `PR-44` covers this.

---

## 3. Comparison to dino-runner-1 baseline

The two reference plans from Phase 1 wrap (`epics-pipeline-v2-phase-1.md` §14):

| Metric             | `dino-runner-1` (2026-05-02)      | `dino-runner-1` (2026-05-05)      | `brick-breaker` (today) |
| ------------------ | --------------------------------- | --------------------------------- | ----------------------- |
| Stories            | 5                                 | 5                                 | 11                      |
| Wall time          | ~22m                              | ~16m                              | 41m 4s                  |
| Cost               | ~$2                               | ~$2                               | $8.46                   |
| Cost/story         | ~$0.40                            | ~$0.40                            | $0.77                   |
| GitHub pushes      | (verified ✅)                     | (verified ✅)                     | **none past initial**   |
| Visual QA captured | yes                               | yes                               | **no**                  |
| Execution mode     | (likely orchestrator pre-Epic-17) | (likely orchestrator pre-Epic-17) | orchestrator            |
| Notable failures   | PR-14→PR-21 catalogue             | clean                             | F-1 → F-10 above        |

`brick-breaker` is roughly 2× more expensive per story than `dino-runner-1` and produces no observable history. It's a more complex game (11 stories vs 5) on the same starter pack. The complexity premium is real — paddle physics, ball physics, brick grid, collision rules — but the per-story cost ratio (~2×) suggests degraded efficiency. F-9 (DEV file Reads) is the most likely culprit.

---

## 4. Cohort accumulation status (Phase 1 ship-gate #4)

```
1. plan_dino-runner-1_moo8zzmz   2026-05-02   nextjs-canvas-game initial
2. plan_dino-runner-1_moseuhc9   2026-05-05   nextjs-canvas-game change/brownfield
3. plan_brick-breaker_mou3l51l   2026-05-06   nextjs-canvas-game initial   ← this run
```

**3 same-shape plans accumulated.** Need ≥5 to fire the 3× escalator. Two more `(nextjs-canvas-game, initial)` plans and Phase 1 ship-gate #4 flips to PASS.

---

## 5. Pipeline path selection — the structural conclusion

The biggest single uplift Phase 2 can ship right now is **route new plans through the step-based pipeline by default**. Without this, every PR from PR-32 onwards is dead code on production runs — they only execute on hand-crafted test plans. The brick-breaker plan demonstrates that Phase 2-A's improvements are _invisible_ to operators because the default isn't using them.

PR-43 (proposed, ~½ day): flip `executionMode` default + UI surface. After PR-43 lands and is deployed, the next brick-breaker-style plan would:

- Apply PR-32 / PR-32b allowlists (REVIEWER would not have Bash; DEV would not call Agent Explore)
- Apply PR-38 turn caps (DEV ≤ 8 turns at prototype; cap is enforced by `--max-turns`)
- Run baseline-regression step (PR-36) at mvp+ (not at prototype, but next plan we'd test at mvp)
- Run tamper-check at mvp+ (PR-41)
- Validate PROJECT_CONTEXT shape (PR-33)
- Show `existingTests` + `publicExports` to DEV (PR-42)
- Single-pass test verify (PR-40) — no DEV-side npm test

The combination should drop $/story by 30–50% and eliminate the truncated-file class entirely (DEV's prompt focus + REVIEWER without Bash).

---

## 6. Recommended fix order

The user can pick from this sequence; each item is independently shippable:

| Order | PR                                                                                                   | Effort  | What it fixes                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| 1     | `sst deploy` (no PR — operator action)                                                               | minutes | F-2: pushes PR-32 → PR-42 to Lambda; restart daemon on EC2                           |
| 2     | **PR-43** — flip `executionMode` default to `'pipeline'`                                             | ½d      | F-1, F-9 (and indirectly F-6, F-7)                                                   |
| 3     | **PR-44** — orchestrator path emits per-story git push (or the inverse: deprecate orchestrator path) | ½d      | F-3 (silent data loss)                                                               |
| 4     | Template-repo placeholder fix (`__X__` convention)                                                   | 30 min  | F-4                                                                                  |
| 5     | **Story 2-A-misc-2** — soft cost ceiling at 1.5× / hard at 3×                                        | 1d      | F-5 (in-flight throttle)                                                             |
| 6     | **Story 2-A-misc-3** — daemon detects truncated DEV writes                                           | ½d      | F-7                                                                                  |
| 7     | PM prompt update — canvas-game ACs default `needs_browser=true`                                      | 30 min  | F-8                                                                                  |
| 8     | **Story 2-A-7-4** — SSE push for live dashboard                                                      | ½d      | The user's earlier "timer not updating" observation; lifts the blindfold during runs |

Order 1–2 unlock the biggest improvements. Order 3 closes the silent-data-loss gap. Order 4–8 are quality-of-life and observability.

---

## 7. What worked

Despite the findings above, this plan is also evidence that several Phase 1 + Phase 2 systems are functioning:

- **MAX_CONCURRENT=2 honored** (PR-29) — only 2 slots in use at peak; the other 2 PW1 stories queued.
- **Plan-Based Labs (Epic 17) plan-wave parallelism worked** — E2 + E3 ran in PW1 in parallel (the user's observed "wave of epics" was correct intended behavior).
- **Timer Intelligence captured 921 slices** with MECE invariant intact (sum to 61m 18s, no `unattributed` leak — Gate G-4 holds).
- **Forensic JSON exported cleanly** with the canonical `schemaVersion: "timer-intel-v1.0"` shape — Phase 1 ship-gate #3 holds.
- **Plan reached `review` status end-to-end** — the orchestrator path is operational; this is not a broken plan, just a sub-optimal one.
- **2 of 4 attention items fired correctly** (compile-failed, non-blocking), demonstrating the attention-writer pipeline is live.

---

## 8. Status of brick-breaker right now

- Stories: 11/11 marked done
- Pipeline status: `review` (stage 3 of 5)
- Visual QA: skipped
- AC audit: 19/19 pass (auto-pass on prototype)
- Automated gate: skipped (rigor=prototype)
- The dashboard's **READY TO PUBLISH** + **PROMOTE TO DEPLOY** buttons are both green
- GitHub: only initial commit pushed; eleven stories of work live on EC2 only

**Recommendation:** _do not_ promote to Deploy yet. Fix F-3 (per-story git push, PR-44) first — otherwise the deploy will succeed from EC2 working state, but a future hotfix or operator-triggered repo clone will see an empty repo with one bootstrap commit.

If the goal is to keep the brick-breaker artifact as a working sample: **Abandon this plan** (operator action, surfaces in the UI), `sst deploy`, restart daemon, then run `brick-breaker-2` from scratch with `executionMode: 'pipeline'` set explicitly and `rigor: 'mvp'` — that's the truest Phase 2-A test we'll get pre-PR-43.

---

## 9. Open questions

1. **Why did the daemon swap to `executionMode: 'orchestrator'` for this plan?** The user clicked + New Plan via the standard UI. The form's default needs auditing. Is there a per-App preference that brick-breaker inherited? Or is the API's persistence default `'orchestrator'`?
2. **Are the augment files (`scripts/`, `.husky/pre-commit-frozen`, `.pipeline/`) actually present in `/home/ubuntu/projects/brick-breaker`?** Please run the `ls` from §2 F-2 and report back. Determines whether F-2 is "Lambda not deployed" or "augments don't apply on orchestrator path".
3. **Did `compile-push` actually exist as a step on the orchestrator path?** If yes, why did all 9 successful compile-knowledge runs fail to push? If no, F-3 (`PR-44`) is the structural fix and we update the daemon.
4. **What's the actual `compile-diff` failure for the 2 stories?** The attention body says "Shell step compile-diff failed" with no detail. Worth fetching the daemon's stderr capture for those job IDs to see if `git diff HEAD~1 HEAD` returned empty (PR-A.3's "EMPTY_DIFF" failure mode) — which would mean the per-story commit produced zero in-scope changes.

---

## 10. Update to Phase 2 epics doc

When PR-43 + PR-44 are scoped, add them to `docs/concepts/pipeline-v2/epics-pipeline-v2-phase-2.md` §16 hardening pass catalogue. Suggested:

- **PR-43** — flip `executionMode` default to `'pipeline'` (~½d) — closes F-1
- **PR-44** — orchestrator path per-story git push OR deprecate orchestrator (~½d) — closes F-3
- **Story 2-A-misc-1** — daemon `MAX_CONCURRENT` enforces per-plan ceiling (~½d) — proposed earlier, not invalidated by this run (the run honored 2 slots)
- **Story 2-A-misc-2** — soft cost ceiling at 1.5× / hard at 3× (~1d) — closes F-5
- **Story 2-A-misc-3** — daemon detects truncated DEV writes (~½d) — closes F-7
- **Story 2-A-7-4** — SSE event push for live dashboard (~½d) — closes the "timer not updating" gap

Update the §16 PR catalogue + cohort tracker accordingly.
