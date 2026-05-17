# Pipeline v2 Assessment — `plan_dino-7_mp8t4wak`

Forensic input: `~/Downloads/plan_dino-7_mp8t4wak-forensic (1).json` (final export)
Blueprint reference: `docs/concepts/pipeline-v2/blueprint-spyhunter-2-and-pr-59-65-expectations.md`
Generated: 2026-05-17 (UTC)

---

## TL;DR

The plan reported **13/13 stories COMPLETED** in the UI, but on close inspection
of DynamoDB + the EC2 git worktree:

- Only **2 of 13 stories** ran the **full Pipeline v2 substrate** (api-author,
  tamper-check, baseline-regression, compile-commit-on-pass, compile-ast,
  review-runtime, compile-push). The other **11 stories ran a legacy 8-step
  pipeline** missing every substrate addition shipped in PR-67 / PR-65 /
  PR-91-followup / Slice A / etc.
- The repository on EC2 contains **only 4 commits total** — initial,
  post-create scaffold, and 2 story commits. **The 11 legacy stories'
  code-writes were never `git commit`-ed at the story boundary**; their files
  were bulk-staged into the final substrate story's `compile-commit-on-pass`,
  producing **one ~1500-line mega-commit instead of 11 attributable per-story
  commits**.
- The **plan-build-check at the end FAILED** (`plan-server-check` couldn't
  boot the dev server because port 3000 was already bound by another
  `next dev` process). Plan never transitioned `developing → review`.
- The dashboard's "13/13 100% $13.44" is therefore **misleading** — work was
  produced, but the substrate guarantees the blueprint expects (per-story
  attribution, bundle-source-check on every wave, AST graph populated from
  every story) did not hold.

This is a **single root cause that cascades**: a stale wave-completion cron
Lambda generates the legacy pipeline for every cron-dispatched wave.

---

## 1. Plan facts

| Field           | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| planId          | `plan_dino-7_mp8t4wak`                                       |
| appId           | `dino-7`                                                     |
| kind            | `initial` (greenfield Next.js canvas-game)                   |
| rigor           | `mvp`                                                        |
| executionMode   | `pipeline` (step-based, not orchestrator)                    |
| status          | **`developing`** (final transition to `review` did NOT fire) |
| startedAt       | 2026-05-16 T21:03:07Z                                        |
| last updatedAt  | 2026-05-16 T22:22:50Z                                        |
| wall-clock      | 1 h 19 min                                                   |
| total cost      | **$13.44** (over $10 mvp ceiling by $3.44)                   |
| epics           | 4 (Foundation / Game Logic / Rendering / Integration)        |
| stories         | 13 (all marked `done` in epic rows)                          |
| attention items | 2 unresolved `compile-failed` (both auto-recovered)          |

### Job inventory (per-story + gate jobs)

| Job ID prefix | createdAt       | Pipeline shape                            | Wave / source      |
| ------------- | --------------- | ----------------------------------------- | ------------------ |
| `e74d0b51`    | 21:03:07 (op)   | **substrate (14 steps)**                  | E1/W0/op-triggered |
| `5abb9c64`    | 21:10:40 (cron) | legacy (8 steps)                          | E1/W1              |
| `cb6355ca`    | 21:26:40 (cron) | legacy                                    | E2/W0              |
| `679874a1`    | 21:26:40 (cron) | legacy                                    | E2/W0              |
| `92e56c57`    | 21:26:40 (cron) | legacy                                    | E2/W0              |
| `7771ddf4`    | 21:26:40 (cron) | legacy                                    | E3/W0              |
| `e570d906`    | 21:26:40 (cron) | legacy                                    | E3/W0              |
| `3f10e0c1`    | 21:26:40 (cron) | legacy                                    | E3/W0              |
| `8221940c`    | 21:42:40 (cron) | legacy                                    | E2/W1              |
| `dd45b0c7`    | 21:53:50 (op?)  | **substrate (15 steps + review-runtime)** | E4/W0              |
| `c191ea49`    | 22:02:40 (cron) | legacy                                    | E4/W1              |
| `99d964db`    | 22:02:40 (cron) | legacy                                    | E4/W1              |
| `e87594c6`    | 22:02:40 (cron) | legacy                                    | E4/W1              |
| `e3c64c4e`    | 22:22:49 (cron) | plan-build (3 steps)                      | **FAILED**         |

Plus 7 wave-build-check jobs (all COMPLETED — most ran `dev-server-fix`
multiple times due to port collisions; only one fired `bundle-source-check`).

---

## 2. Findings, ranked by severity

### P0-1 — Cron wave-completion Lambda emits the legacy pipeline shape

**Severity:** P0 (every cron-dispatched wave loses the substrate)

**Evidence:**

- **Two AWS Lambda functions exist** for this admin app, on different stacks:
  - `futurator-admin-production-ApiFunction-zdmmuxuc` — LastModified
    **`2026-05-16T19:37:03Z`** (latest deploy, has all the PR-67/91-followup
    code).
  - `futurator-production-WaveCompletionCheckHandlerFunction-cbowzwhk`
    (different stack prefix: `futurator-production-*` not
    `futurator-admin-production-*`) — LastModified
    **`2026-05-16T18:49:21Z`** (older code).
- Pipelines persisted in DDB show two distinct shapes (full 14-15 step vs
  legacy 8-step). The shape correlates 1:1 with **dispatcher** — not story,
  not boilerplate, not rigor:
  - Jobs created at operator-triggered moments (`21:03:07Z` /
    `21:53:50.040Z`, non-minute-aligned, createdBy = userId or email) →
    **substrate**.
  - Jobs created at cron tick boundaries (`21:26:40.645Z`, `21:42:40.717Z`,
    `22:02:40.914Z` — all minute-aligned) → **legacy**.
- Both stacks call `generateStoryPipeline` from
  `functions/shared/pipelines/story-pipeline.ts`, but the cron's bundled
  artifact is older. `initialVariables` content confirms this — substrate
  jobs carry `{STORY_ID, EPIC_ID, PROJECT_ID, AC_TEXT, TOUCH_POINTS,
PLAN_START_TIME, RUN_COMMAND}` (current code, story-pipeline.ts:124-140);
  legacy jobs carry only `{STORY_ID, EPIC_ID, PROJECT_ID}` (pre-T0.2
  pre-dev-gate code).

**Impact:** 11 of 13 stories silently lost:

- PR-67 `compile-commit-on-pass` (the per-story commit + `STORY_COMMIT_EMPTY`
  guard).
- PR-41 / 2-A-5-1 `tamper-check` (dev modifying test files).
- `baseline-regression` (mvp+ regression gate).
- PR-91-followup `api-author` (the brick-breaker / spyhunter-1 fix —
  TEST + DEV agreeing on a type surface).
- Slice A `compile-ast` (tree-sitter AST → Memgraph functions/classes).
- PR-65 `review-runtime` (visual screenshot gate on browser-AC stories).
- `compile-push` (origin push).

**Fix:** redeploy the wave-completion stack — `sst deploy --stage production`
needs to deploy BOTH stacks, or the cron Lambda needs to be folded into the
admin stack so a single deploy covers it. Verify by re-running and confirming
all jobs created from any source carry the full 14-step pipeline.

---

### P0-2 — 11 of 13 stories produced NO per-story commit

**Severity:** P0 (per-story attribution + audit trail broken)

**Evidence:** `git log` on `/home/ubuntu/projects/dino-7` shows only **4
commits total**:

```
3005520 story: 43674a70 — Wire keyboard and touch input for jump and restart   ← dd45 (substrate)
2623b0a story: 83a442d8 — Extend game types with dino domain entities          ← e74d0b51 (substrate)
578522e chore: post-create scaffold (__APP_SLUG__ -> dino-7)
f8c9631 Initial commit
```

The dd45 commit is enormous — `git show --stat 3005520` lists **40+ files**
including knowledge articles, AST facts, `.context` files, and changes for
ALL OTHER 11 STORIES' work (BackgroundRender / DinoRender / ObstacleRender /
collision / difficulty / dinosaur / obstacle / etc.). The 11 legacy-pipeline
stories wrote their files to the working tree, the daemon never committed
them at the story boundary (no `compile-commit-on-pass` step), so they sat
uncommitted in the worktree until dd45's substrate run did
`git add -A && git commit` and swept them all up.

**Impact:**

- `git log --grep="story: <id>"` returns 0 commits for 11 stories.
- The blueprint's PR-67 guarantee ("Empty diff caught at the right gate") is
  not enforced for these 11 stories.
- Mycelium per-story attribution (forensic narrative + git-graph + per-story
  blame) is wrong — 11 stories' work is attributed to dd45's commit author/
  timestamp.
- A real `STORY_COMMIT_EMPTY` bug (dev writes to wrong path) would have been
  invisible — the next substrate run would just sweep it.

**Fix:** same as P0-1 (deploy fixes the dispatch). For this plan
specifically: nothing to recover — the work is in the working tree and in
the mega-commit, just not split.

---

### P0-3 — Final `plan-build-check` FAILED; plan never reached QA

**Severity:** P0 (gate failure not surfaced in UI; user thought plan was done)

**Evidence:**

- Job `e3c64c4e-c4ae-4b1f-9d97-0bd2344cb24f` (plan-build, last job before
  status would flip to `review`) has `status: FAILED`. Recorded as
  `plan.planBuildJobId`.
- `stepResults[1]` (`plan-server-check`) validation result:

  ```
  Expected 0, got 1. stderr:
  > template-nextjs@0.1.0 dev
  > sh scripts/dev.sh --hostname 0.0.0.0 --port 3000
  ▲ Next.js 16.2.4 (Turbopack)
  - Local:    http://localhost:3000
  ✓ Ready in 637ms
  ⨯ Another `next dev` ...
  ```

  Port 3000 was already bound by another long-running `next dev` (likely an
  earlier wave-build's `dev-server-fix` cycle didn't clean up its subprocess).

- Plan `status: developing` in DDB (not `review`), so the QA stage's auto-run
  hook (`launchPlanQaAggregate` in `wave-completion-check.ts:104`) never
  triggered. UI still renders the plan as "in development" — but no further
  work is being done.

**Impact:**

- Plan is **stuck in a half-completed state**. Operator sees 13/13 done +
  100% but cannot proceed to QA or Deploy.
- The blueprint's framework-detection logic (PR-59) is supposed to pick a
  free port — that protection isn't holding because something else is
  holding port 3000 already.

**Fix candidates:**

1. **Daemon process hygiene** — kill any `next dev` / `vite` / similar
   child processes before starting a new build check. The wave-build steps'
   `dev-server-fix` should track its spawned PIDs and reap them.
2. **PR-59 framework detection** — emit a `QA_PORT` that is freshly chosen
   (e.g. `python3 -c "import socket; s=socket.socket(); s.bind(('',0));
print(s.getsockname()[1])"`) rather than the framework default. Currently
   it falls back to 3000 for Next.js.
3. **Attention item on plan-build failure** — there's no item in
   `futurator-attention-items` for this failure; the operator has no
   indication anything went wrong.

---

### P1-1 — `review-runtime` (PR-65) effectively never fired

**Severity:** P1 (visual-gap detection blueprint feature unverified)

**Evidence:**

- Of 13 stories, only **1 (dd45)** had `review-runtime` in its pipeline.
  e74d0b51 did not (its touch points are `src/game/types.ts` — type-only,
  no UI → blueprint correctly skips it).
- 4+ stories that DO touch UI components (DinoGame.tsx, GameCanvas, canvas
  renderers) ran the legacy pipeline with no `review-runtime` slot at all.
  So the gate that's supposed to catch "the dev server boots but the page
  is empty" never had a chance to fire.
- No `review-runtime` slices appear in the forensic.

**Impact:** the PR-65 contract (catch orphaned implementations via
screenshot judge) is not validated against this plan. If any of the 11
legacy-dispatched UI stories had an orphaned implementation, the pipeline
would not have detected it. Manual visual inspection is the only safety net.

**Fix:** same root cause as P0-1 (cron deploy). Once the substrate runs on
every story, the `hasBrowserTests` gate (set per-story by the planner) will
inject `review-runtime` for UI stories.

---

### P1-2 — `bundle-source-check` (PR-68) ran on only 1 of 7 wave-builds

**Severity:** P1 (orphan-file detection sporadic)

**Evidence:** 7 wave-build jobs were created (one per (epic, wave)):

| Job            | Steps                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| `d49e5637`     | build-check, dev-build-fix, server-check, dev-server-fix                            |
| `8b556b0f`     | build-check, dev-build-fix, server-check, dev-server-fix                            |
| **`3088039a`** | **build-check, dev-build-fix, _bundle-source-check_, server-check, dev-server-fix** |
| `9e21739e`     | build-check, dev-build-fix, server-check, dev-server-fix                            |
| `ed4fc524`     | build-check, dev-build-fix, server-check, dev-server-fix                            |
| `24c57d05`     | build-check, dev-build-fix, server-check, dev-server-fix                            |
| `f5ee2ec6`     | build-check, dev-build-fix, server-check, dev-server-fix                            |

Only `3088039a` (21:36:50, the wave-build for one specific (epic, wave))
includes `bundle-source-check`. Same dispatcher-drift pattern as P0-1
likely — this job was dispatched by a more recent code path; the other 6
by the stale cron.

**Impact:** files written but never imported from the entry would survive 6
of 7 waves silently. PR-68's spyhunter-1 fix (catch orphans at wave boundary)
is only partially active.

---

### P1-3 — `compile-failed` attention items not auto-resolved

**Severity:** P1 (operator sees red badges that aren't actionable)

**Evidence:** 2 unresolved attention items still in `futurator-attention-items`:

```
category: compile-failed
title:    Knowledge compiler failed for story <id>
createdAt:21:05:02 / 21:59:53
resolvedAt: null  ← still open
body:     Compile step "compile-diff" threw: ... Knowledge graph for this
          story is missing; the next compile run will rebuild from the live
          diff.
```

For both stories, the daemon's self-heal retry succeeded — `compilation-completed`
events appear 60-70s after the failure, AND the working tree contains the
knowledge articles for both. So the attention items are stale-positive.

**Fix:** add a resolver that, on `compilation-completed` for a
`(planId, storyId, stepId)` triple, sets `resolvedAt` on any matching
`compile-failed:<dedupKey>` item. Already proposed in the prior session;
not yet implemented.

---

### P1-4 — Memgraph AST graph dramatically under-populated

**Severity:** P1 (Slice A's per-story call graph isn't materializing)

**Evidence:** Cypher against the running Memgraph:

```cypher
MATCH (n:Node {projectId:"dino-7"}) RETURN n.kind, count(*)
→ null = 23, file = 5

MATCH (a:Node {projectId:"dino-7"})-[r]->(b:Node {projectId:"dino-7"})
RETURN type(r), count(*)
→ DEPENDS_ON = 19
```

Blueprint expects (per-story, mvp+, post Slice A):

- file nodes: 3–5 per story × ~10 UI/code stories ≈ **30–50** → actual **5**
- function nodes: 5–25 per story → **0**
- class nodes: → **0**
- DEFINES edges: 5–25 per story → **0**
- IMPORTS edges: 1–6 per story → **0**
- CALLS edges: 0–5 per story → **0**
- DEPENDS_ON: 1–4 per story × 13 ≈ 13–52 → actual **19** (plausible — these
  come from wiki article `[[wikilinks]]` and compile-knowledge ran for all
  stories)

The missing function/class/DEFINES/IMPORTS/CALLS rows trace to one cause:
`compile-ast` (the tree-sitter step that produces `.mycelium/ast-facts.json`)
**was only in the 2 substrate pipelines**. The 11 legacy stories skipped it,
so `graph-sync.mjs` had nothing to MERGE for those stories' AST.

Compounding: `compile-sync` ran for ALL 13 stories, so wiki articles DID land
in Memgraph (the 23 `kind: null` nodes + 19 DEPENDS_ON edges). But the
function-level call graph the blueprint promises is absent.

**Fix:** same root cause as P0-1.

---

### P2-1 — Skills-Used trailer landed but is label-only

**Severity:** P2 (substrate present; content waits on follow-on work)

**Evidence:** `git show` on the 2 story commits:

```
story: 43674a70-85c4-46e1-9509-808a3c64f767 — Wire keyboard and touch input for jump and restart

Skills-Used:                                                  ← label only

Skills-Manifest-Sha: ffada938a010c2de01199e5288909260c4c64ca0cf27df3bb242d2e1a957b224
```

This is the expected v2.5 §42 shape for mvp rigor when the loadedSkills set
is empty — the trailer is present (PR-73 wired, blueprint §5.5
"Commit-metadata lines"), Skills-Manifest-Sha resolves to a 64-char hex
(PR-85 wired, content matches the on-disk manifest), and Skills-Used is the
empty-label form pending SKILL-SCOUT + daemon `loadedSkills[]` tracking
(PR-72-followup + PR-73-followup).

**Verdict:** **as-designed for current state.** Trailer wiring is healthy on
the 2 stories that ran the substrate. Content fills in once SKILL-SCOUT and
the daemon tracker ship.

---

### P2-2 — Budget overrun: $13.44 vs $10 mvp ceiling (+34%)

**Severity:** P2 (cost-ceiling-warn category)

**Evidence:** Plan ran $13.44 against a `costCeilingUsd: 20` ($10 default
mvp threshold + $10 headroom). The forensic header banner shows the warning
chip in the UI but did not abort.

**Slice attribution:**

| Category     | Time (ms)   | Slice count |
| ------------ | ----------- | ----------- |
| test-author  | 2,049,562   | 251         |
| compile      | 1,612,516   | 689         |
| machine-wait | 1,302,880   | 43          |
| dev          | 940,210     | 203         |
| review       | 369,732     | 105         |
| test-execute | 137,515     | 39          |
| other        | <3,000 each | small       |

Test-author dominating dev time (32% vs 14.7%) and 689 compile slices for 13
stories (~53 slices/story) suggests the compile chain (`compile-knowledge`
Haiku) is doing more LLM work per story than the blueprint estimates (~$0.03
× 13 ≈ $0.39 expected). Worth investigating compiler iteration counts.

**Fix:** post-mortem candidate; not a defect.

---

### P2-3 — UI showed "Timing 00:00" until manual refresh

**Severity:** P2 (already diagnosed in prior turn — keeping for the record)

**Cause:** `src/hooks/use-plan-timing.ts:58` — refetch interval is gated by
`data.isLive`. If the dashboard's first poll returned `isLive: false`
(plan still in draft / first job not yet logged events), polling stopped
permanently. Manual refresh worked because a fresh fetch saw live slices.

**Fix:** also poll when `slices.length === 0`. Diff already drafted in the
prior turn; one-line change.

---

### P2-4 — UI badge "Epic 1: 1 unresolved attention" lingered after epic completed

**Severity:** P2 (cosmetic but confusing)

The dot on Epic 1's row in the hierarchy view reflects the stale
`compile-failed` attention item (see P1-3). Resolved by the same fix.

---

## 3. What worked well

- **`claude_md_loaded` (PR-80) is universal.** Every job emitted 4–5 of these
  events (one per Claude session: api-author / test-author / dev / reviewer /
  compiler). Confirms the daemon's `buildAgentSystemPrompt` prepend is wired
  regardless of pipeline shape.
- **`Skills-Manifest-Sha` resolves correctly.** Both substrate commits carry
  the same 64-char hex (the manifest didn't change mid-plan). PR-85 wiring
  is healthy.
- **Self-heal compile retries work.** Both `compilation-failed` events at
  21:05:02 and 21:59:53 produced `compilation-completed` 60–70s later for
  the same job; knowledge articles + Memgraph upserts landed.
- **Worktree dispatch is active.** `.git` is a `gitdir:` pointer to
  `/home/ubuntu/repos/dino-7.git/worktrees/dino-7`, confirming PR-86's
  worktree path scaffolding is in place (though no per-story worktree
  branching yet, which is PR-86-followup).
- **No retry loops.** Every story had exactly 1 `dev step_start` — the
  REVIEWER agent passed every story on first attempt. No `dev-fix-loop` or
  `review-runtime-failed` attention items.
- **Knowledge mirror to S3 worked.** 29 files under
  `s3://futurator-ai-website/knowledge-live/dino-7/`. `compile-sync` is
  upserting Memgraph + writing the wiki articles + S3-mirroring as designed,
  for all 13 stories (not just substrate ones).
- **Plan-time timer-intelligence panel** populated correctly after refresh
  (sub-bar with `dev 14.7%`, `test-author 32%`, `compile 25.1%`, `machine-wait
20.3%`, etc.). Schema-version `timer-intel-v1.0`.

---

## 4. Priorities for the next run

In order of "biggest leverage / smallest blast radius":

1. **P0-1 — Fold the wave-completion cron into the admin stack** (or run
   `sst deploy --stage production` against the second stack
   `futurator-production-*` too). Until this is done, every cron-triggered
   wave will keep emitting legacy pipelines, and P0-2 / P1-1 / P1-2 / P1-4
   will keep recurring.
2. **P0-3 — Add daemon process hygiene for dev-server spawns.** Track PIDs,
   reap children on step exit; OR have `plan-server-check` pick a free port
   instead of defaulting to 3000.
3. **P1-3 — Auto-resolve `compile-failed` items on subsequent
   `compilation-completed` for the same (planId, storyId, stepId).**
   ~30-line change in the daemon's compile-pipeline post-pass + a TTL of
   24h on the dedupKey so stale items don't linger.
4. **P2-3 — Fix the timing-panel polling gate** so it doesn't freeze on an
   empty first response.
5. **(side-effect of #1)** — re-verify the next run produces 13 individual
   story commits, one per story, each carrying its own
   `Skills-Manifest-Sha` trailer; that Memgraph has function/class nodes;
   that `bundle-source-check` runs on every wave.

---

## 5. Open questions for the operator

- **Was dd45 (Epic 4 first story at 21:53:50) op-triggered?** The
  non-cron-aligned timestamp + email-format createdBy suggests yes — but if
  it was a cron tick that just happened to fire off-grid, the dispatch-stack
  hypothesis (P0-1) needs revisiting.
- **Should plan-build failure raise an attention item?** Today it silently
  flips `planBuildJobId` to a FAILED job and leaves the plan in `developing`.
  The operator has no UI signal beyond "still in development."
- **What's the intended QA path for a plan with no per-story commits?** The
  QA stage assumes per-story commit SHAs are available for the visual-diff
  baseline (blueprint §6 "Post-mortem capture"). With 11 missing commits,
  QA can't produce a clean per-story timeline.

---

## 7. Efficiency findings — test-author dominance + compile chain

### Why is test-author 32% of plan time?

Total test-author work: **2049 s** across 13 stories (158 s/story avg, range
51–439 s). Distribution from the forensic:

| Event type   | Time   | Slices | Note                            |
| ------------ | ------ | ------ | ------------------------------- |
| `tool_use`   | 1406 s | 205    | Read/Write/Edit/Bash calls      |
| `text_delta` | 642 s  | 46     | Model streaming the prompt body |

The TEST agent is Haiku (cheap per-token) but spends 69 % of its wall-clock
in _tool use_, not generation. Three drivers stand out:

1. **Per-story context rebuild.** Every TEST spawn re-Reads `project_context`,
   the project tree, and adjacent files. None of this is cached across stories
   within a wave, so a 4-story parallel wave does 4× the same Reads. A
   per-wave `<project_context_cache>` (built once at wave start, referenced
   by every story) would erase ~30–40 s/story.
2. **TEST runs vitest itself.** The agent's prompt allows it to verify its
   own tests are red via Bash → `vitest run`. The dedicated `test-verify`
   shell step then runs vitest AGAIN immediately after dev. Pure duplicate
   work — 5–30 s/story. Fix: restrict TEST's `allowedTools` to remove
   `Bash`; rely on the shell-step verification.
3. **API-AUTHOR only fired on 2 of 13 stories** (the substrate-pipeline ones).
   Without API-AUTHOR's frozen `.d.ts`, the TEST agent invents type names
   from scratch and DEV often invents different ones, leading to red tests
   and longer test-author sessions for the brick-breaker/spyhunter-1
   pattern. Resolving the pipeline-shape bifurcation (P0-1) brings this
   home for all stories.

**Worst offenders (by job, top 3):**

| Job        | Test-author | Tool calls | Likely cause                                 |
| ---------- | ----------- | ---------- | -------------------------------------------- |
| `c191ea49` | 439 s       | 47         | E4 integration story — large context surface |
| `99d964db` | 309 s       | 38         | E4 wave — touches multiple existing files    |
| `e87594c6` | 206 s       | 26         | Same wave                                    |

### Compiler is well-bounded (100 s/story avg)

Compiler agent time: **1303 s** across 13 stories. Per-story range
52–139 s. Less variance than test-author. Two efficiency opportunities:

4. **`WAVE_CLOSE_COMPILER_ENABLED=true`** — Story E.1 already shipped the
   feature flag at `functions/shared/pipelines/story-pipeline.ts:121`
   (`isWaveCloseCompilerEnabled()`). Flipping it would batch the 13 per-story
   Haiku compile sessions into ~4 wave-close calls (one per wave), cutting
   compile-agent time by ~60–70 % AND emitting one wiki article per CHANGED
   file rather than one per existing file. Side effect: changes the wiki
   article granularity from per-story to per-wave — operators viewing the
   `knowledge/code/` tree will see a different scoping.
5. **Verify the `<ground_truth>` AST_FACTS block** — the COMPILER prompt
   includes a `<ground_truth>` section with tree-sitter facts (functions,
   classes, imports, calls) so the LLM doesn't re-derive structure from
   source. If a compile-knowledge step is still reading source via Read
   tool, that's pure waste. Audit the COMPILER tool-use pattern from the
   forensic — 293 tool_use slices in 1303 s suggests it IS reading source
   anyway. Two paths:
   - Tighten the prompt to forbid Read on files already present in
     AST_FACTS.
   - Restrict COMPILER's `allowedTools` to remove `Read` entirely
     (forces it to use ground_truth + the diff manifest).

### Stub wiki article scoping (compile-knowledge output)

Inspecting the dd45 mega-commit's `git show --stat`: 17 separate
`knowledge/code/*.md` files were created or updated, but several are stub
articles for files that didn't actually change in any of the 13 stories
(e.g., scaffold files that came in via the boilerplate). The current
compile-knowledge prompt writes an article for every file in the diff
manifest's "Adjacent files" section, not just files in the actual diff. Fix:
constrain the article-write loop to `DIFF_MANIFEST` only — files added/
modified in HEAD vs HEAD~1.

### Estimated savings from the four wins

| Win                                      | Per-plan ms saved    | Per-plan $ saved |
| ---------------------------------------- | -------------------- | ---------------- |
| Per-wave project_context cache           | ~400 s               | ~$0.50           |
| TEST `allowedTools` removes Bash         | ~150 s               | ~$0.20           |
| Wave-close-compiler (env flag flip)      | ~600 s               | ~$0.80           |
| Trim wiki article scope to DIFF_MANIFEST | ~100 s               | ~$0.10           |
| **Total (estimated)**                    | **~1250 s (20 min)** | **~$1.60**       |

For a 13-story plan at $13.44 + 1 h 19 min, that's ~12 % cost reduction +
~25 % wall-clock reduction. Worth the engineering time, but each has a
behavior implication operators should sign off on before flipping.

---

## 6. Forensic snapshot for cohort comparison

For Phase 3 cohort baselining (per blueprint §6), save these alongside the
forensic JSON:

| Artifact            | Where                                                                   |
| ------------------- | ----------------------------------------------------------------------- | ------- |
| Forensic JSON       | `~/Downloads/plan_dino-7_mp8t4wak-forensic (1).json` (this run)         |
| Git log (full)      | `ssh ec2 git -C /home/ubuntu/projects/dino-7 log --format=%H%n%s%n%n%B` |
| DDB job inventory   | scan `futurator-agent-jobs` where `workingDir` contains `dino-7`        |
| Memgraph dump       | `MATCH (n:Node {projectId:"dino-7"}) RETURN n, [(n)-[r]->(m)            | [r,m]]` |
| S3 knowledge mirror | `s3://futurator-ai-website/knowledge-live/dino-7/` (29 files)           |
| EC2 working tree    | `ssh ec2 ls -la /home/ubuntu/projects/dino-7/src`                       |

Bundle under `docs/concepts/logs/plan_dino-7_2026-05-16/` once dispatched.
