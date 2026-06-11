/**
 * QA Report — plan-wide aggregation of every epic's QA + PO + build signals,
 * plus attention items scoped to QA categories.
 *
 * Returned by GET /api/plans/:id/qa-report. Designed to be fed verbatim into
 * the frontend `QaReviewView` with minimal client-side transformation.
 *
 * Rigor-awareness: pillars and gate columns adapt to `plan.rigor`. Prototype
 * plans surface only AC + VQA. MVP adds unit gate. Production adds tamper +
 * browser + full build matrix.
 */

import type { PlanRigor } from './plan';
import type { AttentionItemSummary } from './attention';

export type QaPillarVerdict = 'pass' | 'partial' | 'fail' | 'pending' | 'skipped';

/** Top-level plan verdict — drives the big status pill + Publish-gate. */
export type PlanQaVerdict =
  | 'ready' // all pillars pass
  | 'needs-attention' // at least one partial or pending
  | 'blocking' // at least one fail
  | 'not-run'; // no QA runs yet

export interface QaRunSummary {
  runId: string; // composite: ${epicId}:${qaJobId}
  ranAt: string;
  verdict: PlanQaVerdict;
  acPass: number;
  acFail: number;
  vqaPass: number;
  vqaFail: number;
  gateVerdict: QaPillarVerdict;
}

// ── AC Audit pillar ──────────────────────────────────────────────────

export interface AcCriterionResult {
  criterionId: string; // e.g. "AC-1"
  storyId: string;
  epicId: string;
  text: string;
  /** Passed per PO review OR inferred (story done + hasBrowserTests covers it). */
  passed: boolean;
  needsBrowser: boolean;
  poNote?: string; // free-text from PO job output
}

export interface AcRollup {
  verdict: QaPillarVerdict;
  total: number;
  pass: number;
  fail: number;
  pending: number; // criteria without a PO review yet
  failures: AcCriterionResult[]; // just the failures; full list on drill-down
  /** Manual sign-off from `plan.acApproval`. Undefined when not signed. */
  manualApproval?: { approvedAt: string; approvedBy: string };
  /**
   * True when the operator can (and usefully) click "Mark AC reviewed": at
   * least one criterion is pending AND there's no PO job AND no existing
   * manual approval. UI shows the button only when this is true.
   */
  canManuallyApprove: boolean;
}

// ── Visual QA pillar ─────────────────────────────────────────────────

/**
 * Per-test status:
 *   pass             — qaJob COMPLETED and this test passed
 *   fail             — qaJob COMPLETED and this test failed
 *   uncertain        — judge couldn't decide OR per-test budget exceeded (PR-8)
 *   skipped-budget   — plan-level cost ceiling exhausted (PR-8 Q5.2)
 *   errored          — judge invocation crashed (PR-8)
 *   pending          — qaJob is PENDING/RUNNING, or no qaJob yet
 *
 * UI colors thumbnails: pass=green, fail=red, uncertain=amber-stripe,
 * skipped-budget=grey, errored=red-outline, pending=amber.
 */
export type VqaTestStatus =
  | 'pass'
  | 'fail'
  | 'uncertain'
  | 'skipped-budget'
  | 'errored'
  | 'pending';

/** Pipeline v2.0 PR-8 — three-level routing visible in the report. */
export type VqaTestLevel = 'L0' | 'L1' | 'L2';

export interface VqaTestResult {
  testId: string; // e.g. "VT-S5-1"
  storyId: string;
  epicId: string;
  /** True iff `status === 'pass'`. Kept for back-compat with older clients. */
  passed: boolean;
  /** Authoritative per-test status — derive rendering from this. */
  status: VqaTestStatus;
  screenshotUrl?: string;
  expected?: string; // what the test expected
  observed?: string; // what the agent saw

  // ── Pipeline v2.0 PR-8 (Q5.3) — extended per-test fields ─────────
  /** Routing level the test was judged at. Surfaces in the operator drawer
   *  so they can see "L0 fails are deterministic, retry won't change them". */
  level?: VqaTestLevel;
  /** One-line judge rationale (or bash diagnostic for L0). */
  rationale?: string;
  /** Cost in USD attributed to this test. 0 for L0. */
  costUsd?: number;
  /** Wall-clock in milliseconds. */
  durationMs?: number;

  // ── B#2 (2026-06-03) — failure classification + operator accept ─────
  /**
   * Heuristic class of a FAILing test, to guide the operator:
   *   'render'           — observable in a static screenshot; a real fail is
   *                        likely a genuine code defect → send back to dev.
   *   'interaction-gated' — the AC depends on time/score/speed/motion/keypress,
   *                        so a static screenshot CANNOT show it. A fail here is
   *                        likely a static-screenshot limitation → consider Accept.
   * Only set for non-pass tests.
   */
  failureClass?: 'render' | 'interaction-gated';
  /**
   * Step-0.6 (2026-06-05) — the judge's SEMANTIC self-classification of
   * whether the expected state is physically observable in the idle frame.
   * When present it is authoritative for `failureClass` (the keyword regex
   * is only the legacy fallback for rows predating the tag).
   */
  observability?: 'observable' | 'not-idle-observable';
  /**
   * True when the operator has accepted this test as a known limitation
   * (testId ∈ plan.qaAcceptedTestIds). Accepted fails are NON-BLOCKING — they
   * don't count toward the VQA fail tally or the plan's blocking verdict.
   */
  accepted?: boolean;
}

/**
 * Pipeline v2.0 PR-8d — execute-stage lifecycle as seen from the UI.
 *
 *   never-run        — no aggregate, no execute. Operator hasn't clicked
 *                      "Run QA Review" yet (or rigor === 'prototype').
 *   queued-contract  — aggregate COMPLETED, contract waiting for operator
 *                      approval. ContractGate component renders.
 *   rejected         — operator clicked Reject; no execute will run unless
 *                      they Re-classify.
 *   queued-execute   — operator approved; execute job exists but daemon
 *                      hasn't picked it up yet (PENDING).
 *   running          — execute job RUNNING.
 *   done             — execute job COMPLETED (verdict from TEST_RESULTS).
 */
export type VqaExecuteStatus =
  | 'never-run'
  | 'queued-contract'
  | 'rejected'
  | 'queued-execute'
  | 'running'
  | 'done';

/**
 * One row in the ContractGate's test table. Enriched join of
 * `CLASSIFIED_TESTS` (from qa-aggregate's AGGREGATE_OUTPUT) with the
 * source `story.visualTests[]` entry so the UI can render a complete row
 * without re-fetching epics or re-classifying.
 */
export interface ContractClassifiedTest {
  testId: string;
  storyId: string;
  storyTitle: string;
  epicId: string;
  epicLabel: string; // "E1" 1-indexed
  criteriaRef?: string;
  description: string;
  expect: string;
  level: VqaTestLevel;
  /** classifier `reason` string (e.g. "raised to L1: AC needsBrowser…"). */
  classifierReason: string;
  /** Per-test cost estimate at the current level, in USD. */
  estimatedCostUsd: number;
  /** Per-test wall-clock estimate at the current level, in seconds. */
  estimatedWallclockSec: number;
}

export interface ContractWarning {
  /** Free-text identifier of the offending entity (testId or AC id). */
  refId?: string;
  reason?: string;
  message: string;
}

/**
 * Snapshot of the qa-aggregate step's output, scoped for the operator
 * contract-review UI. Populated when `executeStatus === 'queued-contract'`
 * (or `'rejected'` — the operator can still see what they declined).
 *
 * Carries enough data that the ContractGate doesn't need a second
 * roundtrip: the full classified test list, both warning arrays, and
 * the aggregate totals.
 */
export interface QaContractDraft {
  aggregateJobId: string;
  /** Mirror of `plan.qaContractStatus` for client convenience. */
  status: 'pending' | 'approved' | 'rejected';
  totalTests: number;
  byLevel: { L0: number; L1: number; L2: number };
  /** Aggregate-step estimate (sum across classified tests). */
  estimatedCostUsd: number;
  estimatedWallclockSec: number;
  coverageWarnings: ContractWarning[];
  specificityWarnings: ContractWarning[];
  classifiedTests: ContractClassifiedTest[];
  /** Mirrors `plan.qaContractDecidedAt`/`…By` when status !== 'pending'. */
  decidedAt?: string;
  decidedBy?: string;
}

export interface VqaRollup {
  verdict: QaPillarVerdict;
  total: number;
  pass: number;
  fail: number;
  pending: number;
  /** PR-8 Q5.3 — uncertain count (budget kill or judge couldn't decide). */
  uncertain?: number;
  /** B#2 — count of failing tests the operator accepted as known limitations
   *  (non-blocking). These are excluded from `fail`. */
  accepted?: number;
  /** PR-8 Q5.2 — skipped due to plan budget. */
  skippedBudget?: number;
  /** PR-8 — judge invocation crashes. */
  errored?: number;
  overviewUrl?: string;
  thumbnails: VqaTestResult[]; // first ~6 for the card strip
  failures: VqaTestResult[];
  /** PR-8 Q5.3 — full per-test result list for the operator drawer. */
  results?: VqaTestResult[];
  /** PR-8 — total cost spent on this run. */
  costUsd?: number;
  /** PR-8 — total wall-clock for this run. */
  wallclockSec?: number;
  /** PR-8d — execute-stage lifecycle. Drives ContractGate visibility +
   *  the gallery badge labels + the verdict-strip CTAs. */
  executeStatus: VqaExecuteStatus;
  /** PR-8d — populated when an aggregate job has run (i.e. executeStatus
   *  is anything except `never-run`). The ContractGate consumes this. */
  contract?: QaContractDraft;
}

// ── Automated Gate pillar ────────────────────────────────────────────

export type GateCheck = 'compile' | 'typecheck' | 'lint' | 'unit' | 'browser' | 'tamper';

export type GateCellStatus = 'pass' | 'fail' | 'pending' | 'skipped';

/** One row in the wave × check matrix. */
export interface GateWaveRow {
  epicId: string;
  epicLabel: string; // "E1"
  waveIndex: number;
  waveLabel: string; // "Wave 0"
  /** Map of check → cell status. Missing keys = skipped by rigor. */
  cells: Partial<Record<GateCheck, GateCellStatus>>;
  /** Related jobIds for log drill-down. */
  jobIds: Partial<Record<GateCheck, string>>;
}

export interface GateRollup {
  verdict: QaPillarVerdict;
  /** Which checks are active for the plan's rigor. */
  activeChecks: GateCheck[];
  waveRows: GateWaveRow[];
  tamperCountsByStory: Record<string, number>; // storyId → count
}

// ── Per-epic breakdown (for "stacked drill-down" layout) ─────────────

export interface EpicQaBreakdown {
  epicId: string;
  epicLabel: string; // "E1" display label (1-indexed)
  title: string;
  qaJobId?: string;
  poJobId?: string;
  qaVerdict: QaPillarVerdict;
  poVerdict: QaPillarVerdict;
  ranAt?: string;
}

// ── Top-level report ─────────────────────────────────────────────────

export interface QaReport {
  planId: string;
  rigor: PlanRigor;
  autoRunQa: boolean;
  hasBrowserTests: boolean;

  /** Overall plan verdict, computed from pillar rollups. */
  verdict: PlanQaVerdict;
  /** Human-readable reason why we're not ready (if not ready). Empty when ready. */
  blockingReason?: string;

  ac: AcRollup;
  vqa: VqaRollup;
  gate: GateRollup;

  perEpic: EpicQaBreakdown[];

  /** Attention items filtered to QA-relevant categories. */
  attentionItems: AttentionItemSummary[];

  /** Prior runs for the timeline at the bottom of the page. */
  runHistory: QaRunSummary[];

  generatedAt: string;
}
