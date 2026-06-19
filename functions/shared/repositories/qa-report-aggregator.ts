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
  ContractClassifiedTest,
  ContractWarning,
  DevPreview,
  EpicQaBreakdown,
  GateCellStatus,
  GateCheck,
  GateRollup,
  GateStageResult,
  GateVqaClaim,
  GateVqaRollup,
  GateWaveRow,
  PlanQaVerdict,
  QaContractDraft,
  QaPillarVerdict,
  QaReport,
  QaRunPanel,
  QaRunSummary,
  VqaExecuteStatus,
  VqaEvidenceIntegrity,
  VqaRollup,
  VqaTestLevel,
  VqaTestResult,
} from '../types/qa-report';
import {
  DEFAULT_COST_BY_LEVEL,
  DEFAULT_WALLCLOCK_BY_LEVEL,
} from '../services/visual-test-classifier';

/** Categories in AttentionItem that belong on the QA page. */
const QA_ATTENTION_CATEGORIES = new Set(['test-gate-failed', 'tamper-reverted', 'dev-server-down']);

// ── Pillar verdict math ──────────────────────────────────────────────

function verdictFromCounts(
  pass: number,
  fail: number,
  pending: number,
  accepted = 0,
): QaPillarVerdict {
  if (fail > 0) return 'fail';
  // B#2 — operator-accepted (known-limitation) tests count as pass-equivalent
  // for the verdict so a pillar whose only "failures" were accepted goes green.
  const effectivePass = pass + accepted;
  // Mixed: some things have passed, others are still waiting → partial.
  if (pending > 0 && effectivePass > 0) return 'partial';
  // Only pending (no results yet) → still pending. Distinguishes "nothing ran"
  // from "some ran + some didn't."
  if (pending > 0) return 'pending';
  if (effectivePass > 0) return 'pass';
  return 'pending';
}

// ── B#2 — failure classification heuristic ──────────────────────────────
//
// A headless visual judge sees ONE static frame of the app's initial state.
// ACs whose satisfaction depends on elapsed time, score/progress, speed,
// motion/animation, or user interaction (keypress/click/scroll) physically
// cannot be observed in that frame — a "fail" on them is almost always a
// static-screenshot limitation, not a code defect. We surface that as
// `interaction-gated` so the operator knows the test is a candidate for
// Accept rather than send-back. Everything else is `render` (a real fail is a
// likely code defect → send back to dev).
const INTERACTION_GATED_RE =
  /\b(after|once|when|until|eventually|over time|eventually|eventually)\b|\b(score|speed|accelerat\w*|velocity|fps|frame rate)\b|\bexceed\w*\b|\b(playing|gameplay|played|elapsed|seconds?|minutes?|ticks?)\b|\b(press|keypress|keyboard|click\w*|tap\w*|scroll\w*|hover\w*|drag\w*|swipe\w*)\b|\b(motion|moving|moves|animat\w*|transition\w*|spawn\w*)\b/i;
// Step-0.6 (2026-06-05) — the judge now self-classifies observability
// SEMANTICALLY (can this idle frame physically show the expected state?)
// and the result rows carry it. When present it is authoritative; the
// keyword regex above survives only as the legacy fallback for rows from
// runs predating the tag. A static-worded dynamic AC ("all four obstacles
// side-by-side") dodges the regex but not the semantic classification.
function classifyVqaFailure(
  expected?: string,
  rationale?: string,
  observability?: 'observable' | 'not-idle-observable',
): 'render' | 'interaction-gated' {
  if (observability === 'not-idle-observable') return 'interaction-gated';
  if (observability === 'observable') return 'render';
  const hay = `${expected ?? ''} ${rationale ?? ''}`;
  return INTERACTION_GATED_RE.test(hay) ? 'interaction-gated' : 'render';
}

function worstVerdict(...vs: QaPillarVerdict[]): QaPillarVerdict {
  const order: QaPillarVerdict[] = ['fail', 'partial', 'pending', 'pass', 'skipped'];
  return order.find((v) => vs.includes(v)) ?? 'pending';
}

function planVerdict(
  ac: QaPillarVerdict,
  vqa: QaPillarVerdict,
  gate: QaPillarVerdict,
): PlanQaVerdict {
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

/**
 * STUCK_CAPTURE wiring (2026-06-19) — parse the qa-report's
 * `EVIDENCE_INTEGRITY_JSON` variable (the compact evidence-integrity summary)
 * into the typed rollup field. Returns undefined on absent/malformed input so a
 * missing signal degrades to "no evidence-integrity data", never a fabricated one.
 */
function parseEvidenceIntegrity(raw: string | undefined): VqaEvidenceIntegrity | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.captured !== 'number' || typeof o.authored !== 'number') return undefined;
    return {
      captured: o.captured,
      authored: o.authored,
      ratio: typeof o.ratio === 'number' ? o.ratio : o.captured / Math.max(1, o.authored),
      integrityFailed: !!o.integrityFailed,
      stuckCapture: !!o.stuckCapture,
      dominantRatio: typeof o.dominantRatio === 'number' ? o.dominantRatio : undefined,
      distinctHashes: typeof o.distinctHashes === 'number' ? o.distinctHashes : undefined,
    };
  } catch {
    return undefined;
  }
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
  /** Step-0.6 — judge's semantic observability self-classification. */
  observability?: 'observable' | 'not-idle-observable';
}> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── PR-8d contract parsing ──────────────────────────────────────────
//
// The qa-aggregate step writes a delimited block to stdout (see
// `functions/shared/pipelines/visual-qa-pipeline.ts:298-310`). The
// daemon captures it as `AGGREGATE_OUTPUT`. We re-parse it here so the
// ContractGate UI can render the full classified test list + warnings
// without a second roundtrip.

interface AggregateClassification {
  testId: string;
  level: VqaTestLevel;
  reason: string;
}

interface ParsedAggregateOutput {
  totalTests: number;
  byLevel: { L0: number; L1: number; L2: number };
  estimatedCostUsd: number;
  estimatedWallclockSec: number;
  classifications: AggregateClassification[];
  coverageWarnings: ContractWarning[];
  specificityWarnings: ContractWarning[];
}

function parseAggregateOutput(raw: string | undefined): ParsedAggregateOutput | null {
  if (!raw) return null;
  const num = (key: string, fallback = 0): number => {
    const m = new RegExp(`${key}:\\s*([\\d.]+)`).exec(raw);
    return m ? Number(m[1]) : fallback;
  };
  const jsonBlock = (key: string): unknown => {
    // Matches `KEY: [ ... ]` with possibly-multiline JSON. Non-greedy on the
    // content; anchored on `]` followed by newline or end of string.
    const m = new RegExp(`${key}:\\s*(\\[[\\s\\S]*?\\])\\s*(?:\\n|$)`).exec(raw);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  };

  const totalTests = num('TOTAL_TESTS');
  if (totalTests === 0 && !/CLASSIFIED_TESTS:/.test(raw)) return null;

  const classRaw = jsonBlock('CLASSIFIED_TESTS');
  const classifications: AggregateClassification[] = [];
  if (Array.isArray(classRaw)) {
    for (const c of classRaw as unknown[]) {
      const item = c as {
        testId?: unknown;
        classification?: { level?: unknown; reason?: unknown };
      };
      if (
        typeof item?.testId === 'string' &&
        (item.classification?.level === 'L0' ||
          item.classification?.level === 'L1' ||
          item.classification?.level === 'L2')
      ) {
        classifications.push({
          testId: item.testId,
          level: item.classification.level,
          reason: typeof item.classification.reason === 'string' ? item.classification.reason : '',
        });
      }
    }
  }

  const coverageRaw = jsonBlock('COVERAGE_WARNINGS');
  const coverageWarnings: ContractWarning[] = Array.isArray(coverageRaw)
    ? (coverageRaw as Array<{ acId?: unknown; message?: unknown; reason?: unknown }>).map((w) => ({
        refId: typeof w.acId === 'string' ? w.acId : undefined,
        reason: typeof w.reason === 'string' ? w.reason : undefined,
        message: typeof w.message === 'string' ? w.message : String(w.message ?? ''),
      }))
    : [];

  const specRaw = jsonBlock('SPECIFICITY_WARNINGS');
  const specificityWarnings: ContractWarning[] = Array.isArray(specRaw)
    ? (specRaw as Array<{ testId?: unknown; message?: unknown; reason?: unknown }>).map((w) => ({
        refId: typeof w.testId === 'string' ? w.testId : undefined,
        reason: typeof w.reason === 'string' ? w.reason : undefined,
        message: typeof w.message === 'string' ? w.message : String(w.message ?? ''),
      }))
    : [];

  return {
    totalTests,
    byLevel: {
      L0: num('L0_COUNT'),
      L1: num('L1_COUNT'),
      L2: num('L2_COUNT'),
    },
    estimatedCostUsd: num('ESTIMATED_COST_USD'),
    estimatedWallclockSec: num('ESTIMATED_WALLCLOCK_SEC'),
    classifications,
    coverageWarnings,
    specificityWarnings,
  };
}

/**
 * Join parsed aggregate output with `story.visualTests[]` across the
 * plan's epics so the ContractGate has full test context (description,
 * expect, criteriaRef, storyTitle, epicLabel) without a second fetch.
 */
function enrichClassifiedTests(
  parsed: ParsedAggregateOutput,
  epics: EpicWorkflow[],
): ContractClassifiedTest[] {
  type Source = {
    storyId: string;
    storyTitle: string;
    epicId: string;
    epicLabel: string;
    criteriaRef?: string;
    description: string;
    expect: string;
  };
  const sourceByTestId = new Map<string, Source>();
  epics.forEach((epic, idx) => {
    const epicLabel = `E${idx + 1}`;
    for (const story of epic.stories) {
      for (const vt of story.visualTests ?? []) {
        sourceByTestId.set(vt.id, {
          storyId: story.storyId,
          storyTitle: story.title,
          epicId: epic.epicId,
          epicLabel,
          criteriaRef: vt.criteriaRef,
          description: vt.description ?? '',
          expect: vt.expect ?? '',
        });
      }
    }
  });

  const out: ContractClassifiedTest[] = [];
  for (const c of parsed.classifications) {
    const src = sourceByTestId.get(c.testId);
    if (!src) continue; // test was removed since aggregate ran; skip silently
    out.push({
      testId: c.testId,
      storyId: src.storyId,
      storyTitle: src.storyTitle,
      epicId: src.epicId,
      epicLabel: src.epicLabel,
      criteriaRef: src.criteriaRef,
      description: src.description,
      expect: src.expect,
      level: c.level,
      classifierReason: c.reason,
      estimatedCostUsd: DEFAULT_COST_BY_LEVEL[c.level],
      estimatedWallclockSec: DEFAULT_WALLCLOCK_BY_LEVEL[c.level],
    });
  }
  return out;
}

/**
 * Map (aggregate, execute, contractStatus) → UI lifecycle state.
 *
 * 2026-06-03 — a FRESH re-classify supersedes a stale completed execute.
 * `qaContractStatus === 'pending'` means the operator clicked Re-run/Re-classify
 * and a NEW contract is awaiting approval, even if an OLD execute job (qaJobId)
 * already COMPLETED. We must surface `queued-contract` (the approval gate)
 * FIRST in that case — otherwise the stale completed execute returns `done`,
 * the approval panel never re-appears, and Re-run QA looks like a no-op (it
 * did run the aggregate; the UI just kept showing the old gallery).
 */
function computeExecuteStatus(plan: Plan, jobsById: Record<string, AgentJob>): VqaExecuteStatus {
  if (plan.qaContractStatus === 'rejected') return 'rejected';
  // Pending contract wins over any prior execute — await the new approval.
  if (plan.qaContractStatus === 'pending' && plan.qaAggregateJobId) {
    return 'queued-contract';
  }

  const execJob = plan.qaJobId ? jobsById[plan.qaJobId] : undefined;
  if (execJob) {
    if (execJob.status === 'COMPLETED') return 'done';
    if (execJob.status === 'PENDING') return 'queued-execute';
    if (execJob.status === 'RUNNING') return 'running';
    // FAILED falls through — surface as 'done' so the operator can see
    // the failure verdict in the gallery rather than a misleading state.
    if (execJob.status === 'FAILED') return 'done';
  }
  // No execute job (or unresolvable). Branch on contract state.
  if (plan.qaAggregateJobId) {
    const aggJob = jobsById[plan.qaAggregateJobId];
    if (aggJob?.status === 'COMPLETED' && plan.qaContractStatus !== 'approved') {
      return 'queued-contract';
    }
    // Aggregate still running or contract approved but execute job missing.
    if (aggJob && aggJob.status !== 'COMPLETED') return 'queued-contract';
  }
  return 'never-run';
}

function buildContractDraft(
  plan: Plan,
  epics: EpicWorkflow[],
  jobsById: Record<string, AgentJob>,
): QaContractDraft | undefined {
  if (!plan.qaAggregateJobId) return undefined;
  const aggJob = jobsById[plan.qaAggregateJobId];
  if (!aggJob || aggJob.status !== 'COMPLETED') return undefined;
  const parsed = parseAggregateOutput(aggJob.variables?.AGGREGATE_OUTPUT);
  if (!parsed) return undefined;
  return {
    aggregateJobId: plan.qaAggregateJobId,
    status: plan.qaContractStatus ?? 'pending',
    totalTests: parsed.totalTests || parsed.classifications.length,
    byLevel: parsed.byLevel,
    estimatedCostUsd: parsed.estimatedCostUsd,
    estimatedWallclockSec: parsed.estimatedWallclockSec,
    coverageWarnings: parsed.coverageWarnings,
    specificityWarnings: parsed.specificityWarnings,
    classifiedTests: enrichClassifiedTests(parsed, epics),
    decidedAt: plan.qaContractDecidedAt,
    decidedBy: plan.qaContractDecidedBy,
  };
}

/**
 * QA-A (pong1 2026-06-12) — plan-wide visual-test join with full claim
 * attribution. One entry per authored visual test, regardless of which QA
 * run covers it.
 */
interface VtJoinEntry {
  storyId: string;
  storyTitle: string;
  epicId: string;
  epicLabel: string;
  criteriaRef?: string;
  description?: string;
  expect: string;
  level?: VqaTestLevel;
}

function buildVtJoin(epics: EpicWorkflow[]): Map<string, VtJoinEntry> {
  const byId = new Map<string, VtJoinEntry>();
  epics.forEach((epic, idx) => {
    const epicLabel = `E${idx + 1}`;
    for (const story of epic.stories) {
      for (const vt of story.visualTests ?? []) {
        byId.set(vt.id, {
          storyId: story.storyId,
          storyTitle: story.title,
          epicId: epic.epicId,
          epicLabel,
          criteriaRef: vt.criteriaRef,
          description: vt.description,
          expect: vt.expect,
          level: vt.level,
        });
      }
    }
  });
  return byId;
}

/**
 * QA-A — unique QA runs with their epic scope. Plan-scoped QA (PR-8a)
 * resolves every epic to the SAME plan.qaJobId; legacy per-epic runs have
 * distinct epic.qaJobId values.
 */
function buildEpicsByQaJob(plan: Plan, epics: EpicWorkflow[]): Map<string, EpicWorkflow[]> {
  const byJob = new Map<string, EpicWorkflow[]>();
  for (const epic of epics) {
    const id = resolveEpicQaJobId(plan, epic);
    if (!id) continue;
    const arr = byJob.get(id) ?? [];
    arr.push(epic);
    byJob.set(id, arr);
  }
  return byJob;
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
      executeStatus: 'never-run',
    };
  }

  const failures: VqaTestResult[] = [];
  const thumbnails: VqaTestResult[] = [];
  const allResults: VqaTestResult[] = [];
  // B#2 — operator-accepted (known-limitation) test IDs are non-blocking.
  const acceptedSet = new Set(plan.qaAcceptedTestIds ?? []);
  let pass = 0;
  let fail = 0;
  let pending = 0;
  let uncertain = 0;
  let skippedBudget = 0;
  let errored = 0;
  let accepted = 0;
  let total = 0;
  let overviewUrl: string | undefined;
  let runCostUsd: number | undefined;
  let runWallclockSec: number | undefined;
  // STUCK_CAPTURE wiring (2026-06-19) — the qa-prepare evidence-integrity
  // summary, surfaced by qa-report as EVIDENCE_INTEGRITY_JSON. Lets the UI and
  // the Plan Retrospect Q-C6 detector grade byte-diversity (all-identical / wrong
  // surface), not just the missing-frame ratio.
  let evidenceIntegrity: VqaEvidenceIntegrity | undefined;

  // ── QA-A (pong1 2026-06-12) — single-count rework ───────────────────
  // The old loop iterated PER EPIC and resolved the qa job inside it. With
  // plan-scoped QA every epic resolves to the SAME job, so the job's
  // app-wide TEST_RESULTS were ingested once per epic: pong1 showed
  // "VQA 8/8" for 4 authored tests, 8 thumbnails, doubled runCostUsd, and
  // results stamped with the wrong epicId. Now: ingest each UNIQUE job
  // exactly once; attribute story/epic via the plan-wide visualTests join;
  // anything not covered by a completed run is pending.
  const vtJoin = buildVtJoin(epics);
  const epicsByJob = buildEpicsByQaJob(plan, epics);
  const counted = new Set<string>();

  const pushResult = (r: VqaTestResult, isAccepted: boolean) => {
    switch (r.status) {
      case 'pass':
        pass += 1;
        break;
      case 'fail':
        if (isAccepted) accepted += 1;
        else if (r.failureClass === 'interaction-gated') {
          // FIX2 (2026-06-18) — an interaction-gated "fail" is a static-frame
          // limitation, not a code defect (the judge tagged it not-observable,
          // or the expect is motion/time/input-gated). It must NOT block a
          // working app. Re-bucket as uncertain so it surfaces for an operator
          // probe/Accept instead of forcing the pillar red. Flip the row status
          // too so the UI shows amber 'uncertain', consistent with the count.
          r.status = 'uncertain';
          r.passed = false;
          uncertain += 1;
        } else {
          fail += 1;
          failures.push(r);
        }
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
      case 'pending':
        pending += 1;
        break;
    }
    total += 1;
    thumbnails.push(r);
    allResults.push(r);
  };

  for (const [qaJobId, scopeEpics] of epicsByJob) {
    const qaJob = jobsById[qaJobId];
    if (!qaJob || qaJob.status !== 'COMPLETED') continue;

    const vars = qaJob.variables ?? {};
    if (!overviewUrl && vars.OVERVIEW_URL) overviewUrl = vars.OVERVIEW_URL;
    if (vars.COST_USD) runCostUsd = (runCostUsd ?? 0) + Number(vars.COST_USD);
    if (vars.WALLCLOCK_SEC) runWallclockSec = (runWallclockSec ?? 0) + Number(vars.WALLCLOCK_SEC);
    if (!evidenceIntegrity && vars.EVIDENCE_INTEGRITY_JSON) {
      evidenceIntegrity = parseEvidenceIntegrity(vars.EVIDENCE_INTEGRITY_JSON);
    }

    // PR-8 path: TEST_RESULTS JSON contains everything.
    const testResults = parseTestResultsBlock(vars.TEST_RESULTS);
    if (testResults && testResults.length > 0) {
      for (const tr of testResults) {
        if (counted.has(tr.testId)) continue;
        counted.add(tr.testId);
        const meta = vtJoin.get(tr.testId);
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
        const isAccepted = status === 'fail' && acceptedSet.has(tr.testId);
        pushResult(
          {
            testId: tr.testId,
            storyId: meta?.storyId ?? '',
            epicId: meta?.epicId ?? '',
            storyTitle: meta?.storyTitle,
            epicLabel: meta?.epicLabel,
            criteriaRef: meta?.criteriaRef,
            description: meta?.description,
            passed: status === 'pass',
            status,
            screenshotUrl: tr.screenshotUrl,
            expected: meta?.expect,
            level: tr.level ?? meta?.level,
            rationale: tr.rationale,
            costUsd: tr.costUsd,
            durationMs: tr.durationMs,
            observability: tr.observability,
            failureClass:
              status === 'pass'
                ? undefined
                : classifyVqaFailure(meta?.expect, tr.rationale, tr.observability),
            accepted: isAccepted || undefined,
          },
          isAccepted,
        );
      }
      continue;
    }

    // Legacy path (pre-PR-8 jobs) — read FAILED_TESTS + SCREENSHOTS over
    // the run's epic scope.
    const shots = parseScreenshotsBlock(vars.SCREENSHOTS);
    const shotsByTestId = new Map(shots.map((s) => [s.id, s.url]));
    const failedIds = new Set(parseFailedTestsBlock(vars.FAILED_TESTS));
    for (const epic of scopeEpics) {
      for (const story of epic.stories) {
        for (const vt of story.visualTests ?? []) {
          if (counted.has(vt.id)) continue;
          counted.add(vt.id);
          const meta = vtJoin.get(vt.id);
          const failed = failedIds.has(vt.id);
          const isAccepted = failed && acceptedSet.has(vt.id);
          pushResult(
            {
              testId: vt.id,
              storyId: story.storyId,
              epicId: epic.epicId,
              storyTitle: meta?.storyTitle,
              epicLabel: meta?.epicLabel,
              criteriaRef: meta?.criteriaRef,
              description: meta?.description,
              passed: !failed,
              status: failed ? 'fail' : 'pass',
              screenshotUrl: shotsByTestId.get(vt.id),
              expected: vt.expect,
              level: vt.level,
              failureClass: failed ? classifyVqaFailure(vt.expect) : undefined,
              accepted: isAccepted || undefined,
            },
            isAccepted,
          );
        }
      }
    }
  }

  // Every authored visual test with no result row from a completed run is
  // PENDING (its run hasn't completed, hasn't started, or omitted it).
  for (const [testId, meta] of vtJoin) {
    if (counted.has(testId)) continue;
    pushResult(
      {
        testId,
        storyId: meta.storyId,
        epicId: meta.epicId,
        storyTitle: meta.storyTitle,
        epicLabel: meta.epicLabel,
        criteriaRef: meta.criteriaRef,
        description: meta.description,
        passed: false,
        status: 'pending',
        level: meta.level,
        expected: meta.expect,
      },
      false,
    );
  }

  // dragon1 (2026-06-10) — a plan whose stories declare ZERO visualTests
  // (every AC unit-testable, no needsBrowser ACs) previously resolved this
  // pillar to 'pending' forever: total=0 → verdictFromCounts falls through
  // to 'pending' → planVerdict 'needs-attention' → Promote greyed with no
  // path forward, and "Run QA Review" 400s ('no-visual-tests') with the
  // error swallowed by the UI. Nothing-to-verify is a SKIP, not a pending:
  // mirror the prototype-rigor guard above so AC + gate pillars decide.
  // Scope: only when no execute job is queued/running either — an in-flight
  // QA run with results not yet landed must keep its real executeStatus.
  const executeStatus = computeExecuteStatus(plan, jobsById);
  if (total === 0 && (executeStatus === 'never-run' || executeStatus === 'done')) {
    return {
      verdict: 'skipped',
      total: 0,
      pass: 0,
      fail: 0,
      pending: 0,
      thumbnails: [],
      failures: [],
      results: [],
      executeStatus,
    };
  }

  return {
    verdict: verdictFromCounts(pass, fail, pending, accepted),
    total,
    pass,
    fail,
    pending,
    uncertain: uncertain || undefined,
    skippedBudget: skippedBudget || undefined,
    errored: errored || undefined,
    accepted: accepted || undefined,
    overviewUrl,
    evidenceIntegrity,
    thumbnails: thumbnails.slice(0, 6),
    failures,
    results: allResults,
    costUsd: runCostUsd,
    wallclockSec: runWallclockSec,
    executeStatus,
    contract: buildContractDraft(plan, epics, jobsById),
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

/**
 * QA-D (pong1 2026-06-12) — shape of the per-stage outcomes the wave-merge
 * runner persists on the job row (`waveMergeResult.stages[]`) and of the
 * compact VQA summary (`waveMergeResult.vqa`). Daemon-written (untyped JS);
 * parsed defensively here.
 */
interface PersistedWaveMergeResult {
  outcome?: string;
  stages?: Array<{
    key?: unknown;
    cmd?: unknown;
    status?: unknown;
    durationMs?: unknown;
    fixedByAgent?: unknown;
  }>;
  vqa?: {
    outcome?: unknown;
    pass?: unknown;
    fixed?: unknown;
    fixForward?: Array<{
      storyId?: unknown;
      acId?: unknown;
      observed?: unknown;
      screenshotUrl?: unknown;
    }>;
    unverifiable?: unknown;
    verdicts?: Array<{
      acId?: unknown;
      storyId?: unknown;
      result?: unknown;
      observation?: unknown;
      screenshotUrl?: unknown;
    }>;
    fixedAcIds?: unknown;
  };
}

function readWaveMergeResult(job: AgentJob | undefined): PersistedWaveMergeResult | undefined {
  const wmr = (job as (AgentJob & { waveMergeResult?: PersistedWaveMergeResult }) | undefined)
    ?.waveMergeResult;
  return wmr && typeof wmr === 'object' ? wmr : undefined;
}

function parseStageResults(wmr: PersistedWaveMergeResult | undefined): GateStageResult[] | null {
  if (!wmr || !Array.isArray(wmr.stages) || wmr.stages.length === 0) return null;
  const out: GateStageResult[] = [];
  for (const s of wmr.stages) {
    if (typeof s?.cmd !== 'string') continue;
    const status =
      s.status === 'pass' || s.status === 'fail' || s.status === 'skipped' ? s.status : 'pending';
    out.push({
      key: typeof s.key === 'string' && s.key ? s.key : s.cmd.split(/\s+/)[0],
      cmd: s.cmd,
      status,
      durationMs: typeof s.durationMs === 'number' ? s.durationMs : undefined,
      fixedByAgent: s.fixedByAgent === true || undefined,
    });
  }
  return out.length > 0 ? out : null;
}

function parseVqaCell(wmr: PersistedWaveMergeResult | undefined): GateWaveRow['vqa'] {
  const v = wmr?.vqa;
  if (!v || typeof v.outcome !== 'string') return undefined;
  const outcome = v.outcome as NonNullable<GateWaveRow['vqa']>['outcome'];
  return {
    outcome,
    pass: typeof v.pass === 'number' ? v.pass : undefined,
    fixed: typeof v.fixed === 'number' ? v.fixed : undefined,
    fixForward: Array.isArray(v.fixForward) ? v.fixForward.length : undefined,
    unverifiable: typeof v.unverifiable === 'number' ? v.unverifiable : undefined,
  };
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
  let hasStageData = false;

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

      // ── QA-D (pong1 2026-06-12) — truthful per-stage outcomes ────────
      // When the wave-merge runner persisted `waveMergeResult.stages[]`,
      // those are the ACTUAL commands that ran with their real outcomes.
      // The legacy `cells` below infer N independent checks from the job's
      // single COMPLETED bit (the "24 green cells from one bit" façade) —
      // rows carrying real stages mark `inferred: false`, legacy rows mark
      // `inferred: true` so the UI can label them honestly.
      const wmr = readWaveMergeResult(buildJob);
      const stages = parseStageResults(wmr);
      const vqaCell = parseVqaCell(wmr);
      if (stages) {
        hasStageData = true;
        for (const s of stages) {
          if (s.status === 'pass') cellsPass += 1;
          else if (s.status === 'fail') cellsFail += 1;
          else if (s.status === 'pending') cellsPending += 1;
          // 'skipped' stages don't count toward the verdict.
        }
      } else {
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
      }

      waveRows.push({
        epicId: epic.epicId,
        epicLabel,
        waveIndex: wIdx,
        waveLabel: `Wave ${wIdx}`,
        cells,
        jobIds,
        stages: stages ?? undefined,
        vqa: vqaCell,
        // Legacy rows with a job but no stage data are inferred-from-one-bit.
        inferred: stages ? undefined : buildJob ? true : undefined,
      });
    }
  });

  return {
    verdict: verdictFromCounts(cellsPass, cellsFail, cellsPending),
    activeChecks,
    waveRows,
    tamperCountsByStory,
    hasStageData: hasStageData || undefined,
  };
}

// ── QA-B (pong1 2026-06-12) — wave-gate VQA ingestion ────────────────
//
// Aggregates every wave-merge job's `waveMergeResult.vqa` summary into
// per-AC claims with their full gate history. This is the system's
// strongest evidence (judged verdicts on the MERGED candidate) and was
// previously invisible at the shipping decision.

function buildGateVqa(
  epics: EpicWorkflow[],
  jobsById: Record<string, AgentJob>,
): GateVqaRollup | undefined {
  // pacman1 QA fix (2026-06-12) — claims are keyed by (storyId, acId), NOT
  // acId alone. The PM numbers criteria PER STORY ("AC-S1-1" exists in
  // every epic whose first story has one criterion), so an acId-only key
  // merged unrelated claims across epics: pacman1 showed E4, E5, and E7 all
  // wearing one polluted four-attempt gate arc, and the gate-VQA chip
  // undercounted.
  const claimKey = (storyId: string, acId: string) => `${storyId}:${acId}`;
  const claims = new Map<string, GateVqaClaim>();

  // Plan-wide lookups, all (storyId, acId)-scoped. A fix story's criteria
  // copy the OWNER story's acIds, so the fix-story join goes through the
  // owner (dependsOn[0]) — that's the storyId the gate verdicts carry.
  const acTextByKey = new Map<string, string>();
  const fixStoryByOwnerAc = new Map<string, string>();
  // A wave-vqa-fix story re-verifies the OWNER's criteria at a later gate,
  // and that gate's verdicts carry the FIX story's id. Remap them to the
  // owner so the whole arc (owner FAIL → fix story PASS) is ONE claim.
  const ownerByFixStory = new Map<string, string>();
  for (const epic of epics) {
    for (const s of epic.stories) {
      const owner = (s as { origin?: string; dependsOn?: string[] }).dependsOn?.[0];
      const isFix = (s as { origin?: string }).origin === 'wave-vqa-fix' && owner;
      if (isFix) ownerByFixStory.set(s.storyId, owner!);
      for (const c of s.criteria ?? []) {
        acTextByKey.set(claimKey(s.storyId, c.id), c.text);
        if (isFix) fixStoryByOwnerAc.set(claimKey(owner!, c.id), s.storyId);
      }
    }
  }

  for (const epic of epics) {
    const entries = Object.entries(epic.waveBuildJobs ?? {}).sort(
      (a, b) => Number(a[0]) - Number(b[0]),
    );
    for (const [waveKey, jobId] of entries) {
      const wmr = readWaveMergeResult(jobsById[jobId]);
      const vqa = wmr?.vqa;
      if (!vqa) continue;
      const waveNumber = Number(waveKey);
      const fixedSet = new Set(Array.isArray(vqa.fixedAcIds) ? (vqa.fixedAcIds as string[]) : []);

      const ensureClaim = (acId: string, rawStoryId: string): GateVqaClaim => {
        // Fix-story verdicts join the owner's claim (one arc per criterion).
        const storyId = ownerByFixStory.get(rawStoryId) ?? rawStoryId;
        const key = claimKey(storyId, acId);
        let claim = claims.get(key);
        if (!claim) {
          claim = {
            acId,
            storyId,
            epicId: epic.epicId,
            acText: acTextByKey.get(key),
            attempts: [],
            final: 'verified',
            fixStoryId: fixStoryByOwnerAc.get(key),
          };
          claims.set(key, claim);
        }
        return claim;
      };

      for (const v of vqa.verdicts ?? []) {
        if (typeof v?.acId !== 'string' || typeof v?.storyId !== 'string') continue;
        const claim = ensureClaim(v.acId, v.storyId);
        const raw = typeof v.result === 'string' ? v.result : 'FAIL';
        claim.attempts.push({
          waveNumber,
          result: fixedSet.has(v.acId)
            ? 'FIXED_IN_GATE'
            : raw === 'PASS' || raw === 'UNVERIFIABLE'
              ? raw
              : 'FAIL',
          observation: typeof v.observation === 'string' ? v.observation : undefined,
          screenshotUrl: typeof v.screenshotUrl === 'string' ? v.screenshotUrl : undefined,
          jobId,
        });
      }
      // Older summaries (pre per-AC verdict persistence) still carry the
      // fix-forward handoffs — synthesize the FAIL attempts from them.
      for (const h of vqa.fixForward ?? []) {
        if (typeof h?.acId !== 'string' || typeof h?.storyId !== 'string') continue;
        const claim = ensureClaim(h.acId, h.storyId);
        if (!claim.attempts.some((a) => a.waveNumber === waveNumber)) {
          claim.attempts.push({
            waveNumber,
            result: 'FAIL',
            observation: typeof h.observed === 'string' ? h.observed : undefined,
            screenshotUrl: typeof h.screenshotUrl === 'string' ? h.screenshotUrl : undefined,
            jobId,
          });
        }
      }
    }
  }

  if (claims.size === 0) return undefined;

  let verified = 0;
  let fixedInGate = 0;
  let fixedByStory = 0;
  let fixForwarded = 0;
  let unverifiable = 0;
  for (const claim of claims.values()) {
    claim.attempts.sort((a, b) => a.waveNumber - b.waveNumber);
    const last = claim.attempts[claim.attempts.length - 1];
    const everFailed = claim.attempts.some((a) => a.result === 'FAIL');
    claim.final =
      last.result === 'PASS'
        ? everFailed
          ? 'fixed-by-story'
          : 'verified'
        : last.result === 'FIXED_IN_GATE'
          ? 'fixed-in-gate'
          : last.result === 'UNVERIFIABLE'
            ? 'unverifiable'
            : 'fix-forwarded';
    switch (claim.final) {
      case 'verified':
        verified += 1;
        break;
      case 'fixed-in-gate':
        fixedInGate += 1;
        break;
      case 'fixed-by-story':
        fixedByStory += 1;
        break;
      case 'fix-forwarded':
        fixForwarded += 1;
        break;
      case 'unverifiable':
        unverifiable += 1;
        break;
    }
  }

  const sorted = [...claims.values()].sort(
    (a, b) => a.epicId.localeCompare(b.epicId) || a.acId.localeCompare(b.acId),
  );
  return { verified, fixedInGate, fixedByStory, fixForwarded, unverifiable, claims: sorted };
}

// ── QA-A (pong1 2026-06-12) — unique QA run panels ───────────────────

function buildQaRuns(plan: Plan, epics: EpicWorkflow[]): QaRunPanel[] {
  const byJob = new Map<string, { epicIds: string[]; epicLabels: string[] }>();
  epics.forEach((epic, idx) => {
    const id = resolveEpicQaJobId(plan, epic);
    if (!id) return;
    const entry = byJob.get(id) ?? { epicIds: [], epicLabels: [] };
    entry.epicIds.push(epic.epicId);
    entry.epicLabels.push(`E${idx + 1}`);
    byJob.set(id, entry);
  });
  return [...byJob.entries()].map(([qaJobId, e]) => {
    const scope: QaRunPanel['scope'] = qaJobId === plan.qaJobId ? 'plan' : 'epic';
    return {
      qaJobId,
      scope,
      epicIds: e.epicIds,
      epicLabels: e.epicLabels,
      title:
        scope === 'plan'
          ? `QA run · plan-scoped · covers ${e.epicLabels.join(', ')}`
          : `QA run · ${e.epicLabels.join(', ')}`,
    };
  });
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

/**
 * Deployment v2.5 — derive the dev-preview the QA stage renders. The deploy
 * primitive is epic-keyed, so the manual "Deploy to dev" target is the
 * highest-wave epic (same rule the Deploy stage uses). Status is read from the
 * dev deploy job (when present in `jobsById`) + the recorded `plan.devUrl`.
 */
function buildDevPreview(
  plan: Plan,
  epics: EpicWorkflow[],
  jobsById: Record<string, AgentJob>,
): DevPreview {
  const epicId =
    [...epics].sort((a, b) => (b.epicWave ?? 0) - (a.epicWave ?? 0))[0]?.epicId ?? null;
  const job = plan.devDeployJobId ? jobsById[plan.devDeployJobId] : undefined;

  let status: DevPreview['status'] = plan.devUrl ? 'live' : 'none';
  if (job) {
    if (job.status === 'PENDING' || job.status === 'RUNNING') status = 'deploying';
    else if (job.status === 'FAILED' || job.status === 'NEEDS_ATTENTION') status = 'failed';
    else if (job.status === 'COMPLETED') status = plan.devUrl ? 'live' : 'none';
  }
  return { epicId, url: plan.devUrl, status, jobId: plan.devDeployJobId };
}

export function buildQaReport(inputs: AggregatorInputs): QaReport {
  const { plan, epics, jobsById, attentionItems } = inputs;

  const ac = buildAcRollup(plan, epics, jobsById);
  const vqa = buildVqaRollup(plan, epics, jobsById);
  const gate = buildGateRollup(plan, epics, jobsById, attentionItems);
  const gateVqa = buildGateVqa(epics, jobsById);

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
    // dino1 (2026-06-10) — auto-QA is default-on for every rigor (was
    // production-only, which made every mvp plan wait for a manual click).
    autoRunQa: plan.autoRunQa ?? true,
    hasBrowserTests: !!plan.testingProfile?.hasBrowserTests,
    verdict: overall,
    blockingReason,
    ac,
    vqa,
    gate,
    gateVqa,
    perEpic: buildPerEpic(plan, epics, jobsById),
    qaRuns: buildQaRuns(plan, epics),
    attentionItems: attentionSummaries,
    runHistory: buildRunHistory(plan, epics, jobsById),
    devPreview: buildDevPreview(plan, epics, jobsById),
    generatedAt: inputs.nowIso ?? new Date().toISOString(),
  };
}
