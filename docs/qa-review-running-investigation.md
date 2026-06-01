# QA Review stuck on "RUNNING NO SCREENSHOT" — Investigation & Fix Brief

**Status:** Diagnosed, fix not yet implemented.
**Investigator:** Claude session, 2026-05-18
**Reproducible plan:** `plan_snake-4_mpa9a9gs` (DDB row exists, can be used as a live debug target).

---

## 1. TL;DR

PR-8d (Pipeline v2.0) restructured the plan-scoped Visual QA flow into a
**two-stage pipeline with a mandatory operator-approval gate between
them**:

```
Re-run QA  →  qa-aggregate  →  ⛔ contract approval  →  qa-execute  →  screenshots
```

The backend ships both stages and the gate. The **frontend was never
wired to clear the gate** (no button calls `POST /qa-contract/approve`),
and the **cron does not auto-clear it either**. Once
`plan.qaContractStatus = 'pending'`, the workflow is frozen forever, and
the gallery renders every visual test as "RUNNING NO SCREENSHOT" because
the per-test `status: 'pending'` defaults to the badge text `running`.

This is unrelated to the snake-3/4 pipeline fixes committed earlier today
(commits `14c71af`, `3afe6d0`, `9909104`). It is a pre-existing UX bug
that was hidden until plans started actually reaching the `review` stage.

---

## 2. Symptom (operator-visible)

On the QA Review tab of any plan that has completed `developing → review`:

- VQA gauge: `0/8` with "8 pending"
- Visual QA Gallery: every thumbnail tile shows **RUNNING** badge with
  **NO SCREENSHOT** placeholder
- "Re-run QA" button keeps producing the same state; subsequent clicks
  are no-ops because backend rejects a fresh aggregate when one already
  exists
- AC pillar: PASS (50/50)
- Gate pillar: PASS (24/24)
- Plan can't be promoted because VQA verdict is `pending`

---

## 3. Concrete evidence on snake-4 (live DDB state)

```bash
aws dynamodb get-item --region us-east-1 --table-name futurator-plans \
  --key '{"planId":{"S":"plan_snake-4_mpa9a9gs"}}'
```

Returns:

```json
{
  "status":           "review",
  "qaAggregateJobId": "1a980fbf-678d-4fdb-bb24-a851ce03b06b",
  "qaContractStatus": "pending",
  "qaJobId":          <unset>          ← execute stage never launched
}
```

The aggregate job itself:

```bash
aws dynamodb get-item --region us-east-1 --table-name futurator-agent-jobs \
  --key '{"jobId":{"S":"1a980fbf-678d-4fdb-bb24-a851ce03b06b"}}'
```

Returns:

- `status: COMPLETED` (at 2026-05-18T12:40:12)
- `stepResults[0].durationMs: 60` (correct — aggregate is just a node-based classifier)
- `stepResults[0].validationResults: [exit code 0, passed=true]`
- `variables.AGGREGATE_OUTPUT` (truncated):
  ```
  ---QA_AGGREGATE_REPORT---
  CONTRACT_STATUS: PENDING_APPROVAL
  OVERALL_VERDICT: PENDING_APPROVAL
  TOTAL_TESTS: 8
  L0_COUNT: 0
  L1_COUNT: 8
  L2_COUNT: 0
  ESTIMATED_COST_USD: 0.0400
  ESTIMATED_WALLCLOCK_SEC: 40
  ```

So aggregate did its job correctly. The system is just sitting at the gate.

---

## 4. Architecture (2-stage pipeline with operator gate)

```
┌────────────────────────────────────────────────────────────────────┐
│  Frontend: VerdictStrip [Re-run QA button]                         │
│  src/components/labs/plan-dashboard/views/qa/verdict-strip.tsx:53  │
│  Calls hook → useRunQaReview                                       │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ mutation
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│  Hook: useRunQaReview                                              │
│  src/hooks/use-qa-report.ts:38                                     │
│  api.post('/plans/:id/qa-review')                                  │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│  Backend route: POST /api/plans/:id/qa-review                      │
│  functions/api/index.ts:2143                                       │
│  Calls launchPlanQaAggregate                                       │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│  Aggregate launcher                                                │
│  functions/shared/services/visual-qa-launcher.ts:363               │
│  Creates a SINGLE-step job (qa-aggregate). Persists                │
│  plan.qaAggregateJobId + plan.qaContractStatus = 'pending'.        │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│  Daemon runs qa-aggregate step (~60ms)                             │
│  Step body: node -e <inline> requires                              │
│    /opt/futurator-daemon/lib/visual-test-classifier-bundle.cjs     │
│  Output: AGGREGATE_OUTPUT with CONTRACT_STATUS=PENDING_APPROVAL    │
│  Job: COMPLETED                                                    │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
                  ⛔ GATE — no one clears it
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│  Backend route: POST /api/plans/:id/qa-contract/approve            │
│  functions/api/index.ts:2218                                       │
│  EXISTS but has NO CALLER (no UI, no cron).                        │
│  Would launch launchPlanQaExecute → qa-execute job (Playwright +   │
│  screenshots).                                                     │
└────────────────────────────────────────────────────────────────────┘
```

The qa-execute pipeline (when it finally runs) is 6 steps:
`qa-prepare → qa-judge-l0 → qa-judge-l1 → qa-judge-l2 → qa-report → qa-cleanup`
(see `functions/shared/pipelines/visual-qa-pipeline.ts:362-388`).

---

## 5. Why the UI shows "RUNNING NO SCREENSHOT"

`functions/shared/repositories/qa-report-aggregator.ts:290-307`:

```ts
if (!qaJob || qaJob.status !== 'COMPLETED') {
  for (const { story, vt } of visualTests) {
    total += 1;
    pending += 1;
    const r: VqaTestResult = {
      testId: vt.id, ...
      passed: false,
      status: 'pending',     // ← every test enters the gallery as pending
      ...
    };
    thumbnails.push(r);
    allResults.push(r);
  }
  continue;
}
```

`resolveEpicQaJobId(plan, epic)` returns the **execute-stage** `qaJobId`,
not the aggregate's. Since `qaJobId` is unset, `qaJob` is `undefined`,
the early-return branch fires, and all 8 tests land in `thumbnails`
with `status: 'pending'`.

Then the gallery:
`src/components/labs/plan-dashboard/views/qa/vqa-gallery.tsx:194-195`:

```ts
const badgeLabel =
  thumb.status === 'pending' ? 'running' : thumb.status === 'pass' ? 'pass' : 'fail';
```

`pending` → `'running'` text + amber border. Hence the misleading
"RUNNING NO SCREENSHOT" visual.

---

## 6. Exhaustive grep for the missing piece

```bash
# All references to qaContractStatus in src/  (frontend)
grep -rn "qaContractStatus\|qa-contract" src/ --include='*.ts' --include='*.tsx'
```

Returns ONLY type definitions:

```
src/types/plan.ts:75:  qaContractStatus?: 'pending' | 'approved' | 'rejected';
src/types/plan.ts:76:  qaContractDecidedAt?: string;
src/types/plan.ts:77:  qaContractDecidedBy?: string;
```

Zero hooks. Zero components. Zero buttons. Zero usage.

```bash
# All references to /qa-contract/ in backend cron/services
grep -rn "qa-contract/approve\|launchPlanQaExecute" functions/cron functions/shared/services
```

Returns:

- `functions/shared/services/visual-qa-launcher.ts:490` (the implementation)
- Zero callers from `functions/cron/` — the cron never approves either.

Confirmed: backend is complete, frontend and cron are missing.

---

## 7. Root cause classification

This is **not a regression from today's pipeline fixes** (snake-3/4 work).
It's a long-standing UX gap from PR-8d that never surfaced because:

1. Until today, plans got stuck during `developing` and never reached
   `review`.
2. The `pending → 'running'` UI mapping made the contract gate look like
   a "currently executing" state.

---

## 8. Solution options (with trade-offs)

| #   | Option                                                  | Backend work | Frontend work      | Preserves PR-8d UX          | When to choose                                                                      |
| --- | ------------------------------------------------------- | ------------ | ------------------ | --------------------------- | ----------------------------------------------------------------------------------- |
| A   | **Auto-approve in cron**                                | small        | none               | Yes (UI can be added later) | You want dino-2 to flow with zero manual steps and don't yet need operator curation |
| B   | Drop the gate (chain aggregate→execute in `/qa-review`) | small        | none               | No — reverts PR-8d intent   | You're sure you'll never want operator curation                                     |
| C   | Ship the contract-approval UI                           | none         | medium (~half day) | Yes (full intent)           | You want operator-in-the-loop QA test curation                                      |
| D   | One-off curl for snake-4 only                           | none         | none               | N/A                         | Just to confirm execute works end-to-end                                            |

**Recommended path: A** for dino-2 readiness, with C added later if/when you want operator curation. B throws away a feature that may be valuable for `production` rigor plans.

---

## 9. Recommended implementation — Option A (auto-approve in cron)

### File to modify

`functions/cron/wave-completion-check.ts` — after the existing
`launchPlanQaAggregate` block (around line 109-160), add a second
sweep that detects `qaContractStatus === 'pending'` plans whose
aggregate job is `COMPLETED`, then calls `launchPlanQaExecute` and
flips `qaContractStatus` to `'approved'`.

### Outline

```ts
// After the existing per-plan loop that auto-enqueues aggregate.
// Second sweep: auto-approve pending contracts whose aggregate finished.
for (const plan of plans) {
  if (plan.qaContractStatus !== 'pending' || !plan.qaAggregateJobId || plan.qaJobId) continue;

  const aggJob = await agentJobsRepo.getJobById(plan.qaAggregateJobId);
  if (!aggJob || aggJob.status !== 'COMPLETED') continue;

  // Read the classified test list from AGGREGATE_OUTPUT or re-derive it.
  // The aggregate step stores the *full* classified test list in a
  // captured variable; either parse it from variables.AGGREGATE_OUTPUT
  // or replay the classification (cheaper).
  const epics = await Promise.all((plan.epicIds ?? []).map((id) => epicRepo.getEpicById(id)));
  const approvedTests = collectAndClassifyTests(plan, epics); // helper

  const boilerplate = await resolveQaContext(plan, { getApp: appRepo.getApp });
  const exec = await launchPlanQaExecute(
    plan,
    approvedTests,
    plan.createdBy,
    new Date().toISOString(),
    {
      getJobById: agentJobsRepo.getJobById,
      createJob: agentJobsRepo.createJob,
      parseVisualTests,
      buildQaAggregatePipeline,
      buildQaExecutePipeline,
      uuid: () => crypto.randomUUID(),
    },
    { boilerplate },
  );
  if (exec.ok) {
    await planRepo.updatePlanFields(plan.planId, {
      qaJobId: exec.jobId,
      qaContractStatus: 'approved',
      qaContractDecidedAt: new Date().toISOString(),
      qaContractDecidedBy: 'system:auto-approve',
    });
    log('info', 'wave-completion-check', 'auto-approved QA contract', {
      planId: plan.planId,
      jobId: exec.jobId,
      testCount: exec.testCount,
    });
  }
}
```

### Helper: `collectAndClassifyTests`

Mirrors the loop already present in `launchPlanQaAggregate`
(`functions/shared/services/visual-qa-launcher.ts:378-431`). Either:

- Extract that loop into a shared helper and call it from both places, OR
- Parse `AGGREGATE_OUTPUT` from the completed aggregate job's variables
  (it contains the JSON test list — see Bash audit of variables in §3).

Extraction is cleaner because the L0/L1/L2 level fields are already
classified once; calling `classifyVisualTest` again is harmless but
redundant.

### Plan-level opt-out

If you want to keep the operator gate for high-rigor plans, add:

```ts
if (plan.rigor === 'production' && !plan.qaContractAutoApprove) continue;
```

(Requires adding `qaContractAutoApprove?: boolean` to `Plan`.) For
`mvp` and `prototype` rigor, auto-approve unconditionally.

### Schedule

The cron is already `rate(1 minute)`. No schedule change needed; new
sweep just adds a few DDB reads per tick. Cost is negligible.

### Deploy

1. Land code change.
2. `npx sst deploy --stage production` — same command as today's fixes.
3. The cron picks up the change on its next minute tick.

---

## 10. Test plan

### Pre-deploy

- [ ] `npm run typecheck` — clean for `functions/cron/wave-completion-check.ts`.
- [ ] Add or update a vitest for `wave-completion-check` covering the
      new branch (aggregate COMPLETED + contract pending → execute job
      created + contract approved).

### Post-deploy verification on snake-4

1. **Before cron tick:**

   ```bash
   aws dynamodb get-item --table-name futurator-plans \
     --key '{"planId":{"S":"plan_snake-4_mpa9a9gs"}}' \
     | jq '.Item | {qaContractStatus, qaJobId, qaAggregateJobId}'
   ```

   Expected: `qaContractStatus: pending`, `qaJobId: null`.

2. **Wait ≤60s for cron, then re-query.** Expected:
   - `qaContractStatus: 'approved'`
   - `qaJobId: <new UUID>`
   - `qaContractDecidedBy: 'system:auto-approve'`

3. **Watch daemon log for qa-execute steps:**

   ```bash
   ssh ubuntu@... "sudo tail -f /var/log/futurator-daemon.log | \
     grep -E 'qa-prepare|qa-judge|qa-report|qa-cleanup'"
   ```

   Expected: 6 steps fire in order, qa-prepare boots a Next.js dev server
   on port 3000 (or from boilerplate.defaultPort), captures screenshots,
   uploads to `s3://futurator-ai-website/qa-snapshots/snake-4/<jobId>/`.

4. **UI verification:**
   - Refresh QA Review tab.
   - Gallery thumbs should populate with actual screenshots within ~2-3
     min (Playwright runs sequentially per test).
   - VQA gauge moves from `0/8 pending` to per-test pass/fail counts.

5. **End-to-end success criterion:** plan flips to `published` after
   operator clicks "Promote to Deploy" (out of scope for this fix, but
   confirms the contract gate is no longer in the way).

---

## 11. Out of scope / what this fix is NOT

- **Does not** ship the contract-review UI (Option C). Operator
  curation of the test list remains a future enhancement.
- **Does not** touch the snake-3/4 pipeline fixes (those are
  independent and already committed).
- **Does not** address Playwright-side bugs in qa-execute (qa-prepare's
  dev-server boot, screenshot upload to S3, port collision with
  plan-server-check). Those will surface only after this fix unblocks
  the execute stage — and may themselves need follow-up work.
- **Does not** touch the "RUNNING NO SCREENSHOT" label. That UI
  ambiguity remains: even with auto-approve, there will be a window of
  20-60s between aggregate completing and execute capturing the first
  screenshot, during which the gallery still shows "RUNNING". This is
  cosmetic and acceptable; if desired, a follow-up PR can change the
  badge text to `queued` or `awaiting-execute` when `qaJobId` is unset
  but `qaAggregateJobId` is COMPLETED.

---

## 12. Key file references for the implementer

| File                                                          | Lines                                                              | Why                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `functions/cron/wave-completion-check.ts`                     | 90-150 (existing aggregate path), append a sibling sweep           | Where the auto-approve logic lives                                    |
| `functions/api/index.ts`                                      | 2218-2323 (qa-contract/approve route)                              | Reference implementation of approve flow; the cron should mirror this |
| `functions/shared/services/visual-qa-launcher.ts`             | 363-470 (`launchPlanQaAggregate`), 490-545 (`launchPlanQaExecute`) | Public service entrypoints                                            |
| `functions/shared/services/visual-test-classifier.ts`         | `classifyVisualTest`                                               | Pure function for L0/L1/L2 classification — safe to call from cron    |
| `functions/shared/repositories/qa-report-aggregator.ts`       | 290-307 (pending-test fallback)                                    | Why the UI defaults to `pending`                                      |
| `src/components/labs/plan-dashboard/views/qa/vqa-gallery.tsx` | 187-195 (badge label mapping)                                      | Why `pending → 'running'` text                                        |
| `src/types/plan.ts`                                           | 73-77 (contract fields)                                            | Only place frontend "knows" the contract exists                       |
| `functions/shared/types/plan.ts`                              | 170-185 (backend type)                                             | Source of truth for plan fields                                       |
| `daemon/lib/visual-test-classifier-bundle.cjs`                | (bundled)                                                          | What the qa-aggregate step's `node -e` requires at runtime            |

---

## 13. Minimal repro

After landing Option A, to verify on a fresh app:

```bash
# 1. Create a new plan in Labs UI with rigor=mvp, any boilerplate.
# 2. Wait for it to reach `review` stage (developing → review).
# 3. Observe in DDB within 1 min:
aws dynamodb get-item --table-name futurator-plans \
  --key '{"planId":{"S":"<newPlanId>"}}' \
  | jq '.Item | {qaContractStatus, qaJobId, qaAggregateJobId}'
# Expected: contract auto-approved, qaJobId set.
# 4. Within ~3 min, gallery tiles populate with screenshots.
```

If the contract auto-approves but qa-execute then fails, that is a
separate bug class (Playwright / S3 upload / dev-server boot) — open a
new investigation doc for those symptoms.

---

## 14. Don't accidentally do this

- **Do not** call the approve endpoint synchronously from the
  `/qa-review` POST route. The aggregate job may not have completed
  yet (it's an async daemon-executed shell step). Use the cron path.
- **Do not** remove the contract gate from the backend (`qa-contract/approve`,
  `qa-contract/reject` routes). They remain valid endpoints for the
  future contract-review UI.
- **Do not** delete the `qaAggregateJobId` field once execute succeeds —
  it's referenced by the audit trail and any future "show the test
  contract that was approved" feature.
- **Do not** change `wave-completion-check.ts` to run more often than
  `rate(1 minute)` to make the auto-approve faster. Production has had
  cron-race issues before (see 2026-05-17 stale-stage incident in
  CLAUDE.md). Polling once per minute is fine.

---

## 15. Acceptance criteria for the follow-up agent

1. ✅ Cron auto-approves a pending QA contract whose aggregate job is
   COMPLETED, launching the execute stage.
2. ✅ `plan.qaJobId` is set, `qaContractStatus = 'approved'`,
   `qaContractDecidedBy = 'system:auto-approve'`.
3. ✅ snake-4 plan reaches `published` (after manual Promote to Deploy
   click) with at least some passing visual tests in the gallery.
4. ✅ A new dino-2 plan from scratch flows `developing → review →
deploy` without operator intervention beyond the Promote button.
5. ✅ Vitest unit covers: aggregate COMPLETED + contract pending →
   execute job created.
6. ✅ No regression in the existing aggregate auto-enqueue path
   (`plan-completed` + `autoRunQa` + no aggregate/execute → enqueue
   aggregate).
