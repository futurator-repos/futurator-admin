# Pipeline v2 — PR-14 → PR-21 fix plan

Catalogue of every issue surfaced by the **dino-runner-1** end-to-end run
(2026-05-02) and the analysis of its forensic JSON. Each PR is sized to
ship independently. Order is suggested execution sequence; dependencies
are noted inline.

Source artefacts referenced throughout:
- Forensic JSON: `docs/concepts/logs/plan_dino-runner-1_moo8zzmz-forensic.json`
- Plan dashboard: `admin.futurator.ai/labs/?planId=plan_dino-runner-1_moo8zzmz`

---

## Quick summary table

| PR | Title | Effort | Risk | Group |
|----|-------|--------|------|-------|
| PR-14a | Classifier role-case fix | 15 min | low | bundle |
| PR-14b | Plan `totalCostUsd` rollup on `step_complete` | 30 min | low | bundle |
| PR-14c | Strip `[timing-debug]` diagnostic logs | 5 min | low | bundle |
| PR-14d | Forensic `?include=events` opt-in (default off) | 30 min | low | bundle |
| PR-14e | Compile-failure → attention-inbox surface | 30 min | low | bundle |
| PR-15 | `PROJECT_CONTEXT` ships full file contents (kill 50% of `Read` tool calls) | 1–2 h | medium | context |
| PR-16 | Forensic snapshot at terminal-status (write S3, route 302's) | 1–2 h | low | architecture |
| PR-17 | Wave-boundary timing snapshot (replace 5 s polling) | 2–3 h | medium | architecture |
| PR-18 | Investigate `compilation-failed` 50% rate | 30 min audit | n/a | investigation |
| PR-19 | Per-story `git push` after `compile-sync` | 30 min | low | git |
| PR-20 | Investigate parallel-wave commit gap (waves 2/3 lost) | 1 h audit | n/a | investigation |
| PR-21 | VQA pillar respects `rigor === 'prototype'` (mark `skipped`, unblock Promote) | 30 min | low | qa |

PR-14a → PR-14e ship as a single bundled commit (the "small fixes" PR).
PR-15 / PR-16 / PR-17 each their own PR.

---

## Findings tied to the dino-runner-1 run

The forensic JSON has 442 events, 442 slices, 18m 16s wall-clock.
Concrete inefficiencies and bugs identified:

1. **Re-reads of identical files** — `src/game/types.ts` was `Read` 16 times across 6 stories. Total `Read` tool calls: **111 of 442 events (25%)**. Most of this is wasted because once a file is created in story N, story N+1 still re-reads it from scratch. (Address: PR-15.)
2. **Classifier emits `dev: 87%`, `review: 0%`** despite 6 reviewer steps. Root cause: daemon emits `agentId: 'REVIEWER'` (uppercase pipeline ID) but classifier table keys are lowercase (`reviewer`); slicer falls back to `event.agentId` for `agentRole` lookup → mismatch → reviewer events fall through to default `'dev'`. (Address: PR-14a.)
3. **`plan.totalCostUsd` is always `0`** — every `step_complete` event carries real `cost` (e.g. `0.22` for one DEV step) but no rollup writes back to the Plan row. (Address: PR-14b.)
4. **Compile-step failed 50% of the time** — 3 `compilation-completed` vs 3 `compilation-failed` events in the run, with zero UI surface. (Address: PR-14e for visibility, PR-18 for root cause.)
5. **Forensic JSON ships events AND slices** (same data, different shape) → 9800 lines for a 6-story run. (Address: PR-14d.)
6. **GitHub repo has 2 commits, EC2 has 5** — `compile-commit-on-pass` commits but never pushes. (Address: PR-19.)
7. **EC2 has 3 story commits, plan had 6 stories** — waves 2 + 3 never ran the compile phase. (Address: PR-20.)
8. **"Promote to Deploy" button disabled even though prototype run is complete** — VQA pillar stuck `pending` because aggregator doesn't honor prototype rigor. (Address: PR-21.)
9. **Live `/timing` polling every 5 s recomputes 442 slices on every tick** — wasteful even after the SEQ_START fix. (Address: PR-16 + PR-17.)

---

## Group 1 — Bundle PR-14 (small, ship together)

### PR-14a — Classifier role-case fix

**Files**: `functions/shared/timer/slicer.ts`

**Change**: in `buildJobContext`, lowercase the resolved role before storing
on `JobContext`.

```ts
const agentRole: string =
  (event.role ?? event.agentId ?? 'dev').toLowerCase();
```

**Why**: AgentRole type is `'orchestrator' | 'dev' | 'reviewer'` (lowercase);
classifier table keys are lowercase; daemon emits `agentId` as uppercase
pipeline IDs (`'DEV'`, `'REVIEWER'`, `'COMPILER'`). Without lowercasing,
`byRole['REVIEWER']` is `undefined` → falls through to default category.

**Test**: re-export forensic on `dino-runner-1` after deploy. Expect:
- `aggregate.byCategory.review.totalMs` non-zero (~3–5 m).
- `aggregate.byCategory.dev` drops from 87 % to ~60 %.

---

### PR-14b — `plan.totalCostUsd` rollup on `step_complete`

**Files**: `daemon/agent-daemon.mjs` (step_complete handler).

**Change**: when a `step_complete` event fires with non-zero `cost`,
issue an `UpdateItem` against the Plan row associated with the job:

```js
ADD totalCostUsd :stepCost
```

Plan resolution: walk `job.epicId → epic.planId`. If unresolvable, skip
silently (orchestrator-mode jobs may not have a direct plan link — that's
fine, the cost still lives on the job).

**Why**: today the dashboard's "Cost" header on every plan reads `$0.00`
even when the run cost real money. The data exists per-step; we just
never roll it up.

---

### PR-14c — Strip `[timing-debug]` diagnostic logs

**Files**: `functions/api/index.ts` — the `app.get('/api/plans/:planId/timing', …)` handler.

**Change**: remove the temporary `console.log('[timing-debug] start ...')`,
`[timing-debug] result …`, `[timing-debug] stack: …` lines added during
the 2026-05-04 incident. The bug is fixed; logs are just noise now.

---

### PR-14d — Forensic `?include=events` opt-in

**Files**: `functions/api/index.ts` — `/api/plans/:planId/timing/forensic`.

**Change**: by default, the route returns the forensic payload **without**
the `events[]` array (slices alone are enough for charts/cohort/narrative).
Only `?include=events` returns the full version (for debug replay).

```ts
const includeEvents = c.req.query('include')?.split(',').includes('events');
const payload = await buildForensicPayload(...);
if (!includeEvents) delete payload.events;
return c.body(JSON.stringify(payload, null, 2), …);
```

**Impact on the dino-runner-1 export**: ~9800 lines → ~5000 lines.
Halves S3 storage cost too once PR-16 lands.

---

### PR-14e — Compile-failure attention surface

**Files**: `daemon/pipelines/compile-events.mjs` (or wherever
`emitCompilationFailed` is wired).

**Change**: alongside the `compilation-failed` event, write an
`AttentionItem` row with:
- `severity: 'medium'`
- `category: 'compile-failed'`
- `title: 'Knowledge compiler failed for story <storyId>'`
- `body: <error message>`
- `context: { jobId, storyId, epicId, stepId: 'compile-knowledge' }`
- `suggestedActions: [ {label: 'Open logs', kind: 'open-logs'}, {label: 'Open story', kind: 'open-story'} ]`

**Why**: today these failures are silent — the run shows COMPLETED, the
pipeline accepts compile failure as non-blocking (which is correct), but
the operator never learns about a 50 % failure rate.

This sets up PR-18 by making the failures discoverable.

---

## Group 2 — Context efficiency (PR-15)

### PR-15 — `PROJECT_CONTEXT` ships full file contents

**Files**: `daemon/pipelines/lib/story-context-pack.mjs`

**Goal**: kill the "DEV reads `types.ts` 16 times" pattern. Currently the
context pack ships only `head-50` of declared touch-point files. Once
files grow past 50 lines, every agent re-reads the entire file because
the prompt only showed them the first 50 lines.

**Change**:

1. Bump `HEAD_LINES_FULL` from 50 → 300. Most game/util/config files fit.
2. For files > 300 lines, ship the whole file when total context pack
   bytes < `tokenBudget`. The existing token-budget guard already handles
   the over-budget case by truncating; just give it room first.
3. **Include sibling-story-created files in the same wave/epic.** Today
   the pack only ships files in `storySpec.touchPoints[]`. After story 1
   creates `dino.ts`, story 4's pack should include `dino.ts` even if it's
   not in story 4's declared touchPoints — it's part of the project state
   the dev needs to know about.
4. Cache stability: keep the deterministic ordering + the existing
   "drop the largest" fallback when over budget.

**Risk**: prompt size grows ~2–3×. For the dino run that's ~3 KB → 10 KB
per agent call. Cost impact: +10–20 % per cold cache call, ~0 % per warm.

**Win**: 110 wasted Read tool calls go away. Gross compute saved >
prompt-size cost.

**Test**: re-run dino plan with PR-15 + PR-13 starter. Expect Read count
in the forensic JSON drops from ~111 to ~30.

---

## Group 3 — Architecture (kill recompute / kill polling)

### PR-16 — Forensic snapshot at terminal status

**Files**:
- `functions/api/index.ts` (transition endpoint)
- `daemon/pipelines/forensic-snapshot.mjs` (new file)
- `daemon/pipelines/job-router.mjs` (new `forensic-snapshot` jobType)

**Change**:

1. When `transitionPlanStatus(planId, to)` flips to a terminal status
   (`delivered`, `abandoned`, or first time entering `review`), enqueue
   a `forensic-snapshot` agent-job.
2. Daemon picks it up, runs `buildForensicPayload(planId, cohortFetcher)`
   once, and writes the JSON to:
   `s3://futurator-ai-website/timing/<planId>-forensic.json`.
3. The `/api/plans/:planId/timing/forensic` route checks if the S3 object
   exists; if yes, return a 302 redirect (or stream the bytes). If no
   (in-flight plan), fall back to existing live compute.

**Win**: clicking "Export forensic JSON" on a finished plan does **zero**
DDB scans. Just an S3 GetObject (already redirected by CloudFront).

**Edge cases**:
- Re-render forensic on `transitionPlanStatus(planId, 'developing')`
  (going back to dev) — invalidate the snapshot.
- If the forensic-snapshot job fails, the route falls back to live compute
  → no user-visible regression.

**Dependencies**: ships independently. Does NOT depend on PR-17.

---

### PR-17 — Wave-boundary timing snapshot (replace polling)

**Files**:
- `functions/cron/wave-completion-check.ts`
- `functions/shared/repositories/plan-timing-snapshot-repository.ts` (new)
- `functions/api/index.ts` — `/api/plans/:planId/timing` modifications
- `src/hooks/use-plan-timing.ts`

**Change**:

1. New DDB table `futurator-plan-timing-snapshot` (PK: `planId`).
2. `wave-completion-check` cron, when it observes a wave closing for a
   plan: compute `sliceForPlan` once, persist `{slices, aggregate, planTotalMs, isLive, lastUpdated}` to the snapshot row.
3. `GET /api/plans/:planId/timing` returns the snapshot (single DDB Get).
   Falls back to live compute only if snapshot is missing (first-time
   load) **and** plan is in-flight.
4. Frontend hook: drop 5 s polling. Add a `Refresh now` button that calls
   the live-compute path with `?fresh=1`.

**Win**: The 5 s polling cost we discussed earlier (~$1/month) drops to
roughly zero. UX trade: timing data is "live to the last wave-close
event" instead of "live to the last 5 seconds" — operators don't watch
timing real-time anyway.

**Dependencies**:
- Best to ship PR-16 first to validate the S3-snapshot pattern on the
  forensic side before extending to the live timing path.

---

## Group 4 — Investigation (no code yet)

### PR-18 — Investigate `compilation-failed` root cause

**Action**: pull the 3 `compilation-failed` events from the dino forensic
JSON, look at the error messages and stack traces. Likely culprits:

1. `DIFF_MANIFEST` includes paths the COMPILER's tool allowlist
   (`Read,Write,Edit,Glob,Grep` — no `Bash`) can't reach.
2. Haiku ran out of context on a large diff.
3. Prompt format threw on edge cases (e.g. story with apostrophe).

**Output**: one-paragraph note per failure mode + a fix proposal. Could
be a follow-up PR (raise compiler model, tighten diff filter) or a doc
update if the failures are benign.

**Pre-requisite**: PR-14e (compile-failed attention) shipped, so we can
use the attention items as the source of truth for failure reasons going
forward.

---

### PR-20 — Investigate parallel-wave commit gap

**Action**: figure out why `compile-commit-on-pass` ran for stories S1–S3
but not S4–S6 in the dino run.

**Hypotheses to verify**:
1. **Git-lock race when 2 stories in the same wave finish within a few
   seconds** — story A holds `.git/index.lock`, story B's commit step
   fails with a lock error, the daemon marks compile-step "failed
   non-blocking" and continues. Wave-2 has 2 stories (S4, S5) running in
   parallel — fits the pattern.
2. **`wave-completion-check` cron path skips compile when launching the
   next wave** — the launcher might dispatch wave-N stories without
   running the compile pipeline for wave-(N-1) close.
3. **`useEpicOrchestrator: true` plan was using the orchestrator path
   for some stories and per-story pipeline for others** — inconsistent
   handler routing.

**Method**: scan `daemon/pipelines/compile-events.mjs` and
`functions/cron/wave-completion-check.ts` for the launch path. Diff the
DDB `agent-events` rows for jobs S1 (committed) vs S4 (didn't commit) —
look for a `step_error` on `compile-commit-on-pass` for S4.

**Output**: root-cause note + fix proposal. Likely a small PR adding
file-level locking around `git add && git commit` (e.g. `flock`-style
sentinel file) or serializing compile steps within a wave.

---

## Group 5 — Git / git-push (PR-19)

### PR-19 — Per-story `git push` after `compile-sync`

**Files**: `functions/shared/pipelines/story-pipeline.ts`

**Change**: add a `compile-push` step at the end of the compile phase:

```ts
{
  id: 'compile-push',
  stepType: 'shell',
  command:
    `cd ${workingDir} && ` +
    // best-effort: a failed push (network, auth, fast-forward conflict)
    // shouldn't fail the story. Surface as a soft warning.
    `git push origin main 2>&1 || ` +
    `echo 'GIT_PUSH_WARN: push failed, will retry on next compile-push' >&2`,
  timeout: 30000,
  captureAs: 'GIT_PUSH_OUTPUT',
  onFail: { action: 'continue' as const },
}
```

**Why this isn't already there**: PR-13's bootstrap saga's
`commit-and-push.mjs` does push, but it only runs once at App creation.
Per-story commits since then sit on EC2.

**Edge cases**:
- Push conflict (e.g. operator pushed to GitHub directly): log
  `GIT_PUSH_WARN`, leave the local commit in place. Next compile-push
  will retry. Manual `git pull --rebase` resolves.
- Auth failure: same — soft warn, retry next time.
- Big repo: 30 s timeout should be plenty for incremental pushes.

**Combine with**: a one-shot recovery for `dino-runner-1` —
`ssh ec2 -- 'cd /home/ubuntu/projects/dino-runner-1 && git push origin main'`
to land the 3 missing story commits on GitHub.

---

## Group 6 — QA prototype-rigor unblock (PR-21)

### PR-21 — VQA pillar respects `rigor === 'prototype'`

**Files**: `functions/shared/repositories/qa-report-aggregator.ts`

**Change**: in `buildVqaRollup`, mirror the prototype-skip pattern from
`buildGateRollup`:

```ts
function buildVqaRollup(plan, epics, jobsById): VqaRollup {
  const rigor = plan.rigor ?? 'mvp';
  // Prototype rigor — no automated VQA. Operator signs off manually
  // via the plan-actions-bar "Sign Off & Deploy" button. Do NOT
  // mark visualTests as 'pending' — they're not actually running.
  if (rigor === 'prototype') {
    return {
      verdict: 'skipped',
      total: 0, pass: 0, fail: 0, pending: 0,
      thumbnails: [], failures: [], results: [],
    };
  }
  // ...existing logic for mvp/production
}
```

**Why**: today, prototype runs go through review with VQA stuck
`pending` forever (no qaJob runs but `visualTests` from `needsBrowser`
ACs are counted), making `planVerdict` resolve to `needs-attention`,
which disables the verdict-strip "Promote to Deploy" button.

**UX consequence**: the verdict-strip button becomes clickable for
prototype plans (matching the modal copy "Skip tests + tamper-check.
Manual visual review only"). Operator can also still use the top-left
"Sign Off & Deploy" button which already works.

**Test**: re-render `dino-runner-1` plan → verdict flips
`needs-attention` → `ready` → Promote button enables.

---

## Suggested execution order

1. **Bundle ship** (1 hour total): PR-14a + 14b + 14c + 14d + 14e + PR-21.
   All low risk, all small. Single deploy.
2. **PR-19 (git push)** + manual `git push` to recover dino-runner-1's 3
   missing commits. Half hour.
3. **Audits** (PR-18, PR-20). Half-day investigation; outputs are notes,
   not code.
4. **PR-15** (context pack). Real win on tool-call efficiency. Test on a
   fresh plan run.
5. **PR-16** (forensic snapshot at terminal). Validates the S3-snapshot
   pattern.
6. **PR-17** (wave-boundary timing snapshot). Bigger change, builds on
   PR-16's pattern.

---

## Stretch / future (not scoped here)

- **Live UI for compile failures**: a small badge on the story row
  ("compile failed → click to retry"). Low priority since PR-14e gets
  failures into the bell already.
- **Token-budget instrumentation**: print actual context pack bytes vs
  budget on every assemble call so we can tune `HEAD_LINES_FULL`
  empirically.
- **Cohort-aware rigor recommendation**: once the cohort has 5+ samples,
  surface "your similar plans typically ran in 18m / cost $4 / used 2k
  tokens — is your scope right-sized?" on plan creation.
