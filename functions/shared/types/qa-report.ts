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
  // ── QA-A (pong1 2026-06-12) — claim attribution for the claims table ──
  /** Title of the owning story (from the plan-wide visualTests join). */
  storyTitle?: string;
  /** 1-indexed epic display label ("E1"). */
  epicLabel?: string;
  /** The AC this test verifies (story.visualTests[].criteriaRef). */
  criteriaRef?: string;
  /** Test description from the authored visual test. */
  description?: string;
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

/**
 * STUCK_CAPTURE wiring (2026-06-19) — the qa-prepare evidence-integrity summary
 * (sidecar `evidence-integrity.json`), surfaced via the qa-report's
 * `EVIDENCE_INTEGRITY_JSON` variable. Carries the byte-diversity signal so the
 * UI and the Plan Retrospect Q-C6 detector can distinguish a real capture from
 * a stuck/wrong-surface one (all per-test frames identical), not just a missing
 * one. `stuckCapture` is true when most captured frames share one content hash.
 */
export interface VqaEvidenceIntegrity {
  /** Per-test frames present and ≥2KB (non-blank). */
  captured: number;
  /** Authored test count. */
  authored: number;
  /** captured / authored. <0.9 hard-fails the qa-prepare gate (missing frames). */
  ratio: number;
  /** True when the qa-prepare gate aborted the run (missing/blank capture). */
  integrityFailed: boolean;
  /** True when most captured frames are byte-identical (stuck / wrong surface). */
  stuckCapture: boolean;
  /** Share of captured frames sharing the single most-common content hash. */
  dominantRatio?: number;
  /** Distinct content hashes across captured frames (1 = all identical). */
  distinctHashes?: number;
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
  /** STUCK_CAPTURE wiring (2026-06-19) — evidence-integrity summary for Q-C6. */
  evidenceIntegrity?: VqaEvidenceIntegrity;
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

/**
 * QA-D (pong1 2026-06-12) — one ACTUAL stage outcome from the wave-merge
 * gate, persisted by the runner in `waveMergeResult.stages[]`. Unlike the
 * legacy `cells` (which inferred per-check status from a single job-status
 * bit — the "24 green cells from one bit" façade), these are real: one row
 * per blocking command that RAN, with its own exit outcome.
 */
export interface GateStageResult {
  /** Mechanical label derived from the command ("build", "test", "lint"…). */
  key: string;
  /** The command that ran (or would have run, for skipped stages). */
  cmd: string;
  /**
   * pass    — exited 0 (or no-op-tests tolerance)
   * fail    — exited non-zero (gate halted here)
   * skipped — a prior stage failed; this one never ran
   */
  status: GateCellStatus;
  durationMs?: number;
  /** True when the agentic build-fix repaired this stage and revalidation passed. */
  fixedByAgent?: boolean;
}

/** v2.6 gate-VQA outcome for a wave (the matrix's `gate VQA` column). */
export interface GateWaveVqaCell {
  outcome: 'pass' | 'fixed' | 'fix-forward' | 'skipped' | 'env-blocked' | 'unverifiable';
  pass?: number;
  fixed?: number;
  fixForward?: number;
  unverifiable?: number;
}

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
  // ── QA-D (pong1) — truthful per-stage outcomes ──────────────────────
  /** Actual stage outcomes from waveMergeResult.stages. When present the UI
   *  MUST render these instead of `cells` (which are inferred). */
  stages?: GateStageResult[];
  /** v2.6 gate-VQA outcome for this wave, when the VQA stage ran. */
  vqa?: GateWaveVqaCell;
  /** True when `cells` were inferred from the job's single COMPLETED bit
   *  (legacy jobs with no per-stage data). The UI labels these honestly
   *  instead of painting N independent green checks. */
  inferred?: boolean;
}

export interface GateRollup {
  verdict: QaPillarVerdict;
  /** Which checks are active for the plan's rigor. */
  activeChecks: GateCheck[];
  waveRows: GateWaveRow[];
  tamperCountsByStory: Record<string, number>; // storyId → count
  /** QA-D — true when at least one wave row carries real stage data. */
  hasStageData?: boolean;
}

// ── QA-B (pong1 2026-06-12) — wave-gate VQA ingestion ────────────────
//
// The v2.6 wave gate produces the strongest evidence in the system: per-AC
// judged verdicts on the MERGED candidate, in-gate fix history, fix-forward
// → auto-minted fix story → re-verification at a later gate. Pre-QA-B none
// of it reached the QA Review surface. These types carry that evidence,
// keyed by AC (the claim), aggregated from every wave-merge job's
// `waveMergeResult.vqa` summary.

export interface GateVqaAttempt {
  waveNumber: number;
  /** Judge-panel consensus at this gate. FIXED_IN_GATE = the capped
   *  in-candidate fixer cleared it and re-judge passed. */
  result: 'PASS' | 'FAIL' | 'UNVERIFIABLE' | 'FIXED_IN_GATE';
  observation?: string;
  screenshotUrl?: string;
  /** wave-merge jobId — log drill-down. */
  jobId?: string;
}

export interface GateVqaClaim {
  acId: string;
  storyId: string;
  epicId: string;
  acText?: string;
  /** Chronological gate history (the fix-forward arc renders from this). */
  attempts: GateVqaAttempt[];
  /**
   * verified       — passed at its first gate
   * fixed-in-gate  — failed, in-gate fixer cleared it (committed + re-judged)
   * fixed-by-story — fix-forwarded, the auto-minted fix story passed a later gate
   * fix-forwarded  — failed and NOT yet re-verified (open loop)
   * unverifiable   — evidence agent concluded no idle frame can show it
   */
  final: 'verified' | 'fixed-in-gate' | 'fixed-by-story' | 'fix-forwarded' | 'unverifiable';
  /** The auto-minted wave-vqa-fix story, when one exists for this AC. */
  fixStoryId?: string;
}

export interface GateVqaRollup {
  verified: number;
  fixedInGate: number;
  fixedByStory: number;
  /** Still-open fix-forwards (no later gate has verified them yet). */
  fixForwarded: number;
  unverifiable: number;
  claims: GateVqaClaim[];
}

// ── QA-A (pong1 2026-06-12) — unique QA run panels ───────────────────
//
// Plan-scoped QA means every epic resolves to the SAME execute job; the UI
// rendered one log panel per epic → N byte-identical panels for one run
// (the operator's "why are there 2 epic QA logs?"). The aggregator now
// emits one entry per UNIQUE job with its scope spelled out.

export interface QaRunPanel {
  qaJobId: string;
  scope: 'plan' | 'epic';
  epicIds: string[];
  /** Display labels of the epics this run covers (["E1","E2"]). */
  epicLabels: string[];
  title: string; // e.g. "QA run · plan-scoped · covers E1, E2"
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

  /** QA-B (pong1) — wave-gate VQA evidence, keyed by AC. Undefined when no
   *  wave-merge job carries a vqa summary (pre-v2.6 plans). */
  gateVqa?: GateVqaRollup;

  perEpic: EpicQaBreakdown[];

  /** QA-A (pong1) — one entry per UNIQUE QA job; drives the run-log panels
   *  (replaces the per-epic panels that duplicated plan-scoped runs). */
  qaRuns: QaRunPanel[];

  /** Attention items filtered to QA-relevant categories. */
  attentionItems: AttentionItemSummary[];

  /** Prior runs for the timeline at the bottom of the page. */
  runHistory: QaRunSummary[];

  /**
   * Deployment v2.5 — the clickable dev-preview the operator can open to
   * exercise the merged build by hand (what headless QA tests against, but
   * visible). Auto-deployed when the plan reaches `review`.
   */
  devPreview: DevPreview;

  generatedAt: string;
}

/** Deployment v2.5 — dev-preview status surfaced on the QA stage. */
export interface DevPreview {
  /**
   * Highest-wave epic id — the deploy primitive is epic-keyed, so this is the
   * target for a manual "Deploy to dev" click. `null` when the plan has no
   * epics yet.
   */
  epicId: string | null;
  /** Live dev URL once a dev deploy has succeeded (`plan.devUrl`). */
  url?: string;
  /**
   * `none`      — never dev-deployed (or the deploy job can't be resolved)
   * `deploying` — a dev deploy job is PENDING/RUNNING
   * `live`      — last dev deploy COMPLETED and a URL is recorded
   * `failed`    — last dev deploy FAILED/NEEDS_ATTENTION
   */
  status: 'none' | 'deploying' | 'live' | 'failed';
  /** FK to the dev deploy job, for QA-stage log streaming. = plan.devDeployJobId. */
  jobId?: string;
}
