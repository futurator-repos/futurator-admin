/**
 * QA Report Aggregator — pure function that composes a plan-wide QaReport
 * from the plan + its epics + fetched agent jobs + attention items.
 *
 * No network I/O here. The API route is responsible for fetching the inputs;
 * the aggregator is a pure transformation so it's trivial to unit-test.
 *
 * Rigor shapes which pillars are active:
 *   prototype  → AC + VQA pillars only; Gate pillar `skipped`
 *   mvp        → + unit/compile/typecheck/lint
 *   production → + tamper; + browser (when `testingProfile.hasBrowserTests`)
 */

import type { AgentJob } from '../types/agent-orchestrator';
import type { AttentionItem } from '../types/attention';
import type { EpicWorkflow } from '../types/epic-workflow';
import type { Plan } from '../types/plan';
import type {
  AcCriterionResult,
  AcRollup,
  EpicQaBreakdown,
  GateCellStatus,
  GateCheck,
  GateRollup,
  GateWaveRow,
  PlanQaVerdict,
  QaPillarVerdict,
  QaReport,
  QaRunSummary,
  VqaRollup,
  VqaTestResult,
} from '../types/qa-report';

/** Categories in AttentionItem that belong on the QA page. */
const QA_ATTENTION_CATEGORIES = new Set([
  'test-gate-failed',
  'tamper-reverted',
  'dev-server-down',
]);

// ── Pillar verdict math ──────────────────────────────────────────────

function verdictFromCounts(pass: number, fail: number, pending: number): QaPillarVerdict {
  if (fail > 0) return 'fail';
  // Mixed: some things have passed, others are still waiting → partial.
  if (pending > 0 && pass > 0) return 'partial';
  // Only pending (no results yet) → still pending. Distinguishes "nothing ran"
  // from "some ran + some didn't."
  if (pending > 0) return 'pending';
  if (pass > 0) return 'pass';
  return 'pending';
}

function worstVerdict(...vs: QaPillarVerdict[]): QaPillarVerdict {
  const order: QaPillarVerdict[] = ['fail', 'partial', 'pending', 'pass', 'skipped'];
  return (
    order.find((v) => vs.includes(v)) ?? 'pending'
  );
}

function planVerdict(ac: QaPillarVerdict, vqa: QaPillarVerdict, gate: QaPillarVerdict): PlanQaVerdict {
  const activePillars = [ac, vqa, gate].filter((v) => v !== 'skipped');
  if (activePillars.length === 0) return 'not-run';
  if (activePillars.every((v) => v === 'pending')) return 'not-run';
  if (activePillars.some((v) => v === 'fail')) return 'blocking';
  if (activePillars.some((v) => v === 'partial' || v === 'pending')) return 'needs-attention';
  return 'ready';
}

// ── Inputs ───────────────────────────────────────────────────────────

export interface AggregatorInputs {
  plan: Plan;
  epics: EpicWorkflow[];
  jobsById: Record<string, AgentJob>;
  attentionItems: AttentionItem[];
  nowIso?: string;
}

/**
 * Pipeline v2.0 PR-8a — resolve the QA job for an epic.
 *
 * Plan-scoped QA (PR-8a+) sets `plan.qaJobId`; in that mode every epic
 * shares the same QA run. Legacy plans set `epic.qaJobId` per epic.
 * `plan.qaJobId` wins when both are set (a stale `epic.qaJobId` from a
 * pre-PR-8a manual run shouldn't shadow the new plan-level job).
 */
function resolveEpicQaJobId(plan: Plan, epic: EpicWorkflow): string | undefined {
  return plan.qaJobId ?? epic.qaJobId;
}

// ── AC pillar ────────────────────────────────────────────────────────

/**
 * AC verdict logic (as of 2026-04-23):
 *
 * Per-criterion decision cascade, in order:
 *   1. Explicit PO job FAILED_CRITERIA → fail.
 *   2. Explicit PO job VERDICT=PASS (or the criterion not in FAILED_CRITERIA) → pass.
 *   3. Manual `plan.acApproval` set → pass (operator sign-off).
 *   4. No PO job, no manual approval, AND story is `done` → pass
 *      (implicit: the Orchestrator does review inline during dev, so story-done
 *      means AC satisfied — a production-rigor plan should still get explicit
 *      sign-off but mvp/prototype doesn't require it).
 *   5. else → pending.
 *
 * Production rigor tightens rule 4: for `rigor === 'production'` plans, a
 * story-done story with no PO/manual approval stays PENDING so the operator
 * must explicitly sign off. This keeps the strict gate meaningful.
 */
function buildAcRollup(
  plan: Plan,
  epics: EpicWorkflow[],
  jobsById: Record<string, AgentJob>,
): AcRollup {
  const failures: AcCriterionResult[] = [];
  let pass = 0;
  let fail = 0;
  let pending = 0;
  let total = 0;

  const rigor = plan.rigor ?? 'mvp';
  const hasManualApproval = !!plan.acApproval;
  const strictMode = rigor === 'production' && !hasManualApproval;

  for (const epic of epics) {
    const poJob = epic.poJobId ? jobsById[epic.poJobId] : undefined;
    const poCompleted = poJob?.status === 'COMPLETED';
    const failedCriteriaRaw = poJob?.variables?.FAILED_CRITERIA;
    const failedCriteriaIds = new Set(
      (failedCriteriaRaw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    for (const story of epic.stories) {
      const criteria = story.criteria ?? [];
      for (const c of criteria) {
        total += 1;
        const storyDone = story.status === 'done';
        const noteKey = `PO_NOTE_${c.id}`;
        const poNote = poJob?.variables?.[noteKey];

        // Cascade per doc above.
        let passed: boolean | null;
        if (poCompleted && failedCriteriaIds.has(c.id)) {
          passed = false;
        } else if (poCompleted) {
          passed = true;
        } else if (hasManualApproval) {
          passed = true;
        } else if (storyDone && !strictMode) {
          // Rule 4 — implicit pass (mvp/prototype only).
          passed = true;
        } else {
          passed = null;
        }

        if (passed === true) {
          pass += 1;
        } else if (passed === false) {
          fail += 1;
          failures.push({
            criterionId: c.id,
            storyId: story.storyId,
            epicId: epic.epicId,
            text: c.text,
            passed: false,
            needsBrowser: !!c.needsBrowser,
            poNote,
          });
        } else {
          pending += 1;
        }
      }
    }
  }

  // No PO job means every epic has `epic.poJobId` empty.
  const anyPoJob = epics.some((e) => !!e.poJobId);
  const canManuallyApprove = pending > 0 && !anyPoJob && !hasManualApproval;

  return {
    verdict: verdictFromCounts(pass, fail, pending),
    total,
    pass,
    fail,
    pending,
    failures,
    manualApproval: plan.acApproval,
    canManuallyApprove,
  };
}

// ── VQA pillar ───────────────────────────────────────────────────────

function parseScreenshotsBlock(raw: string | undefined): Array<{ id: string; url: string }> {
  if (!raw) return [];
  const out: Array<{ id: string; url: string }> = [];
  for (const line of raw.split('\n')) {
    const m = /^\s*[-*]\s*[*_`]*([\w-]+)[*_`]*:\s*(https?:\/\/\S+)/.exec(line);
    if (m) out.push({ id: m[1], url: m[2] });
  }
  return out;
}

function parseFailedTestsBlock(raw: string | undefined): string[] {
  if (!raw) return [];
  const cleaned = raw.trim();
  if (!cleaned || cleaned.toLowerCase() === 'none') return [];
  return cleaned
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pipeline v2.0 PR-8 (Q5.3) — parse the qa-execute pipeline's
 * TEST_RESULTS JSON variable. Returns null if absent (legacy path
 * falls back to FAILED_TESTS+SCREENSHOTS).
 */
function parseTestResultsBlock(raw: string | undefined): Array<{
  testId: string;
  level?: 'L0' | 'L1' | 'L2';
  verdict: 'pass' | 'fail' | 'uncertain' | 'skipped-budget' | 'errored';
  rationale?: string;
  screenshotUrl?: string;
  costUsd?: number;
  durationMs?: number;
}> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildVqaRollup(
  plan: Plan,
  epics: EpicWorkflow[],
  jobsById: Record<string, AgentJob>,
): VqaRollup {
  // PR-21 — prototype rigor explicitly skips automated visual QA. The plan
  // creation modal documents this as "Skip tests + tamper-check. Manual
  // visual review only." For prototype runs no qaJob ever runs, but stories
  // can still declare `visualTests[]` from `needsBrowser` ACs. Without this
  // guard, every visualTests entry gets counted as `pending` → planVerdict
  // resolves to `needs-attention` → "Promote to Deploy" stays disabled
  // forever (only "Sign Off & Deploy" works). Mirror buildGateRollup which
  // already skips for prototype rigor; the operator promotes manually.
  // 2026-05-02 dino-runner-1: 6 stories all done, AC 12/12 pass, but the
  // verdict-strip Promote button was greyed because VQA showed pending.
  const rigor = plan.rigor ?? 'mvp';
  if (rigor === 'prototype') {
    return {
      verdict: 'skipped',
      total: 0,
      pass: 0,
      fail: 0,
      pending: 0,
      thumbnails: [],
      failures: [],
      results: [],
    };
  }

  const failures: VqaTestResult[] = [];
  const thumbnails: VqaTestResult[] = [];
  const allResults: VqaTestResult[] = [];
  let pass = 0;
  let fail = 0;
  let pending = 0;
  let uncertain = 0;
  let skippedBudget = 0;
  let errored = 0;
  let total = 0;
  let overviewUrl: string | undefined;
  let runCostUsd: number | undefined;
  let runWallclockSec: number | undefined;

  for (const epic of epics) {
    const qaJobId = resolveEpicQaJobId(plan, epic);
    const qaJob = qaJobId ? jobsById[qaJobId] : undefined;
    const visualTests = epic.stories.flatMap((s) =>
      (s.visualTests ?? []).map((v) => ({ story: s, vt: v })),
    );
    if (!qaJob || qaJob.status !== 'COMPLETED') {
      for (const { story, vt } of visualTests) {
        total += 1;
        pending += 1;
        const r: VqaTestResult = {
          testId: vt.id,
          storyId: story.storyId,
          epicId: epic.epicId,
          passed: false,
          status: 'pending',
          level: vt.level,
          expected: vt.expect,
        };
        thumbnails.push(r);
        allResults.push(r);
      }
      continue;
    }

    const vars = qaJob.variables ?? {};
    if (!overviewUrl && vars.OVERVIEW_URL) overviewUrl = vars.OVERVIEW_URL;
    if (vars.COST_USD) runCostUsd = (runCostUsd ?? 0) + Number(vars.COST_USD);
    if (vars.WALLCLOCK_SEC)
      runWallclockSec = (runWallclockSec ?? 0) + Number(vars.WALLCLOCK_SEC);

    // PR-8 path: TEST_RESULTS JSON contains everything.
    const testResults = parseTestResultsBlock(vars.TEST_RESULTS);
    if (testResults && testResults.length > 0) {
      // Map each TEST_RESULTS entry to a VqaTestResult, joining the
      // story/epic ids by walking the visualTests list.
      const storyByTestId = new Map<string, { storyId: string; expect: string }>();
      for (const { story, vt } of visualTests) {
        storyByTestId.set(vt.id, { storyId: story.storyId, expect: vt.expect });
      }
      for (const tr of testResults) {
        total += 1;
        const meta = storyByTestId.get(tr.testId);
        const status: VqaTestResult['status'] =
          tr.verdict === 'pass'
            ? 'pass'
            : tr.verdict === 'fail'
              ? 'fail'
              : tr.verdict === 'uncertain'
                ? 'uncertain'
                : tr.verdict === 'skipped-budget'
                  ? 'skipped-budget'
                  : 'errored';
        switch (status) {
          case 'pass':
            pass += 1;
            break;
          case 'fail':
            fail += 1;
            break;
          case 'uncertain':
            uncertain += 1;
            break;
          case 'skipped-budget':
            skippedBudget += 1;
            break;
          case 'errored':
            errored += 1;
            break;
        }
        const r: VqaTestResult = {
          testId: tr.testId,
          storyId: meta?.storyId ?? '',
          epicId: epic.epicId,
          passed: status === 'pass',
          status,
          screenshotUrl: tr.screenshotUrl,
          expected: meta?.expect,
          level: tr.level,
          rationale: tr.rationale,
          costUsd: tr.costUsd,
          durationMs: tr.durationMs,
        };
        if (status === 'fail') failures.push(r);
        thumbnails.push(r);
        allResults.push(r);
      }
      continue;
    }

    // Legacy path (pre-PR-8 jobs) — read FAILED_TESTS + SCREENSHOTS.
    const shots = parseScreenshotsBlock(vars.SCREENSHOTS);
    const shotsByTestId = new Map(shots.map((s) => [s.id, s.url]));
    const failedIds = new Set(parseFailedTestsBlock(vars.FAILED_TESTS));
    for (const { story, vt } of visualTests) {
      total += 1;
      const failed = failedIds.has(vt.id);
      const r: VqaTestResult = {
        testId: vt.id,
        storyId: story.storyId,
        epicId: epic.epicId,
        passed: !failed,
        status: failed ? 'fail' : 'pass',
        screenshotUrl: shotsByTestId.get(vt.id),
        expected: vt.expect,
        level: vt.level,
      };
      if (failed) {
        fail += 1;
        failures.push(r);
      } else {
        pass += 1;
      }
      thumbnails.push(r);
      allResults.push(r);
    }
  }

  return {
    verdict: verdictFromCounts(pass, fail, pending),
    total,
    pass,
    fail,
    pending,
    uncertain: uncertain || undefined,
    skippedBudget: skippedBudget || undefined,
    errored: errored || undefined,
    overviewUrl,
    thumbnails: thumbnails.slice(0, 6),
    failures,
    results: allResults,
    costUsd: runCostUsd,
    wallclockSec: runWallclockSec,
  };
}

// ── Gate pillar ──────────────────────────────────────────────────────

function rigorActiveChecks(plan: Plan): GateCheck[] {
  const rigor = plan.rigor ?? 'mvp';
  const hasBrowser = !!plan.testingProfile?.hasBrowserTests;
  const base: GateCheck[] = ['compile', 'typecheck', 'lint'];
  if (rigor === 'prototype') return base;
  const checks: GateCheck[] = [...base, 'unit'];
  if (hasBrowser) checks.push('browser');
  if (rigor === 'production') checks.push('tamper');
  return checks;
}

function jobVerdictToCell(job: AgentJob | undefined, key: string): GateCellStatus {
  if (!job) return 'pending';
  if (job.status === 'PENDING' || job.status === 'RUNNING') return 'pending';
  const v = (job.variables ?? {})[key];
  if (!v) {
    // If the job completed but didn't emit the key, infer from job status.
    return job.status === 'COMPLETED' ? 'pass' : 'fail';
  }
  const normalized = v.toUpperCase();
  if (normalized === 'PASS' || normalized === 'GREEN' || normalized === 'OK') return 'pass';
  if (normalized === 'FAIL' || normalized === 'RED' || normalized === 'ERROR') return 'fail';
  if (normalized === 'SKIP' || normalized === 'SKIPPED') return 'skipped';
  return 'pending';
}

function buildGateRollup(
  plan: Plan,
  epics: EpicWorkflow[],
  jobsById: Record<string, AgentJob>,
  attentionItems: AttentionItem[],
): GateRollup {
  const rigor = plan.rigor ?? 'mvp';
  if (rigor === 'prototype') {
    return {
      verdict: 'skipped',
      activeChecks: rigorActiveChecks(plan),
      waveRows: [],
      tamperCountsByStory: {},
    };
  }

  const activeChecks = rigorActiveChecks(plan);

  // Tamper counts from attention items (Phase D / Pillar 3 in v2 plan).
  const tamperCountsByStory: Record<string, number> = {};
  for (const item of attentionItems) {
    if (item.category === 'tamper-reverted' && item.context.storyId) {
      tamperCountsByStory[item.context.storyId] =
        (tamperCountsByStory[item.context.storyId] || 0) + 1;
    }
  }

  const waveRows: GateWaveRow[] = [];
  let cellsPass = 0;
  let cellsFail = 0;
  let cellsPending = 0;

  epics.forEach((epic, epicIdx) => {
    const epicLabel = `E${epicIdx + 1}`;
    const waves = new Map<number, number>(); // waveIndex → jobId lookup via waveBuildJobs
    for (const story of epic.stories) {
      const w = story.wave ?? 0;
      if (!waves.has(w)) waves.set(w, w);
    }
    const waveIndexes = [...waves.keys()].sort((a, b) => a - b);

    for (const wIdx of waveIndexes) {
      // waveBuildJobs keys are stringified wave indexes.
      const buildJobId = epic.waveBuildJobs?.[String(wIdx)];
      const buildJob = buildJobId ? jobsById[buildJobId] : undefined;
      const cells: Partial<Record<GateCheck, GateCellStatus>> = {};
      const jobIds: Partial<Record<GateCheck, string>> = {};

      for (const check of activeChecks) {
        // Each gate check maps to a variable in the build-check job's output.
        // Mapping chosen to be forward-compatible with new keys the daemon
        // may emit; absent keys default to pass/fail by job status.
        const varKey = {
          compile: 'COMPILE_VERDICT',
          typecheck: 'TYPECHECK_VERDICT',
          lint: 'LINT_VERDICT',
          unit: 'UNIT_TESTS_VERDICT',
          browser: 'BROWSER_TESTS_VERDICT',
          tamper: 'TAMPER_VERDICT',
        }[check];
        const status = jobVerdictToCell(buildJob, varKey);
        cells[check] = status;
        if (buildJobId) jobIds[check] = buildJobId;

        if (status === 'pass') cellsPass += 1;
        else if (status === 'fail') cellsFail += 1;
        else if (status === 'pending') cellsPending += 1;
      }

      waveRows.push({
        epicId: epic.epicId,
        epicLabel,
        waveIndex: wIdx,
        waveLabel: `Wave ${wIdx}`,
        cells,
        jobIds,
      });
    }
  });

  return {
    verdict: verdictFromCounts(cellsPass, cellsFail, cellsPending),
    activeChecks,
    waveRows,
    tamperCountsByStory,
  };
}

// ── Per-epic breakdown ───────────────────────────────────────────────

function buildPerEpic(
  plan: Plan,
  epics: EpicWorkflow[],
  jobsById: Record<string, AgentJob>,
): EpicQaBreakdown[] {
  return epics.map((epic, idx) => {
    const qaJobId = resolveEpicQaJobId(plan, epic);
    const qaJob = qaJobId ? jobsById[qaJobId] : undefined;
    const poJob = epic.poJobId ? jobsById[epic.poJobId] : undefined;
    return {
      epicId: epic.epicId,
      epicLabel: `E${idx + 1}`,
      title: epic.title,
      qaJobId,
      poJobId: epic.poJobId,
      qaVerdict: qaVerdictFromJob(qaJob, 'OVERALL_VERDICT'),
      poVerdict: qaVerdictFromJob(poJob, 'VERDICT'),
      ranAt: qaJob?.updatedAt ?? poJob?.updatedAt,
    };
  });
}

function qaVerdictFromJob(job: AgentJob | undefined, verdictKey: string): QaPillarVerdict {
  if (!job) return 'pending';
  if (job.status === 'PENDING' || job.status === 'RUNNING') return 'pending';
  if (job.status === 'FAILED') return 'fail';
  const v = (job.variables ?? {})[verdictKey];
  if (v === 'PASS') return 'pass';
  if (v === 'FAIL') return 'fail';
  return 'pending';
}

// ── Run history ──────────────────────────────────────────────────────

function buildRunHistory(
  plan: Plan,
  epics: EpicWorkflow[],
  jobsById: Record<string, AgentJob>,
): QaRunSummary[] {
  // Pipeline v2.0 PR-8a — when plan-scoped QA is in effect, every epic
  // resolves to the SAME job. Dedupe by jobId so the run history doesn't
  // emit N copies of the same run.
  const runs: QaRunSummary[] = [];
  const seen = new Set<string>();
  for (const epic of epics) {
    const qaJobId = resolveEpicQaJobId(plan, epic);
    if (!qaJobId || seen.has(qaJobId)) continue;
    seen.add(qaJobId);
    const qaJob = jobsById[qaJobId];
    if (!qaJob || qaJob.status !== 'COMPLETED') continue;
    const vars = qaJob.variables ?? {};
    const failedIds = parseFailedTestsBlock(vars.FAILED_TESTS);
    // For plan-scoped runs, sum visual tests across every epic in the plan.
    // For legacy per-epic runs, only the current epic contributes.
    const isPlanScoped = qaJobId === plan.qaJobId;
    const epicsForCount = isPlanScoped ? epics : [epic];
    const vtCount = epicsForCount.reduce(
      (n, e) => n + e.stories.reduce((m, s) => m + (s.visualTests?.length ?? 0), 0),
      0,
    );
    const vqaFail = failedIds.length;
    const vqaPass = Math.max(0, vtCount - vqaFail);
    runs.push({
      runId: isPlanScoped ? `plan:${plan.planId}:${qaJob.jobId}` : `${epic.epicId}:${qaJob.jobId}`,
      ranAt: qaJob.updatedAt,
      verdict: vars.OVERALL_VERDICT === 'PASS' ? 'ready' : 'blocking',
      acPass: 0, // AC history tracked separately; 0 here for compactness
      acFail: 0,
      vqaPass,
      vqaFail,
      gateVerdict: 'pending',
    });
  }
  runs.sort((a, b) => a.ranAt.localeCompare(b.ranAt));
  return runs;
}

// ── Top-level aggregator ─────────────────────────────────────────────

export function buildQaReport(inputs: AggregatorInputs): QaReport {
  const { plan, epics, jobsById, attentionItems } = inputs;

  const ac = buildAcRollup(plan, epics, jobsById);
  const vqa = buildVqaRollup(plan, epics, jobsById);
  const gate = buildGateRollup(plan, epics, jobsById, attentionItems);

  const attentionSummaries = attentionItems
    .filter((i) => QA_ATTENTION_CATEGORIES.has(i.category) && i.status !== 'resolved')
    .map((i) => ({
      planId: i.planId,
      itemId: i.itemId,
      createdAt: i.createdAt,
      resolvedAt: i.resolvedAt,
      severity: i.severity,
      category: i.category,
      title: i.title,
      status: i.status,
    }));

  const overall = planVerdict(ac.verdict, vqa.verdict, gate.verdict);
  const blockingReason =
    overall === 'blocking'
      ? [
          ac.verdict === 'fail' ? `${ac.fail} acceptance criteria failing` : null,
          vqa.verdict === 'fail' ? `${vqa.fail} visual tests failing` : null,
          gate.verdict === 'fail' ? `automated gate failing` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : overall === 'needs-attention'
        ? 'Review pending items'
        : undefined;

  // Satisfy the linter — worstVerdict is intentionally defined but only used
  // in future iterations (e.g. wave-level rollup under an epic).
  void worstVerdict;

  return {
    planId: plan.planId,
    rigor: plan.rigor ?? 'mvp',
    autoRunQa: plan.autoRunQa ?? (plan.rigor === 'production'),
    hasBrowserTests: !!plan.testingProfile?.hasBrowserTests,
    verdict: overall,
    blockingReason,
    ac,
    vqa,
    gate,
    perEpic: buildPerEpic(plan, epics, jobsById),
    attentionItems: attentionSummaries,
    runHistory: buildRunHistory(plan, epics, jobsById),
    generatedAt: inputs.nowIso ?? new Date().toISOString(),
  };
}
