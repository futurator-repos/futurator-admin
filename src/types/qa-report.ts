/**
 * Client mirror of functions/shared/types/qa-report.ts. Keep the two in sync.
 * The backend is the source of truth; this file is only a structural echo so
 * the frontend can type-check against `GET /api/plans/:id/qa-report`.
 */

import type { PlanRigor } from './plan';

export type QaPillarVerdict = 'pass' | 'partial' | 'fail' | 'pending' | 'skipped';

export type PlanQaVerdict = 'ready' | 'needs-attention' | 'blocking' | 'not-run';

export interface QaRunSummary {
  runId: string;
  ranAt: string;
  verdict: PlanQaVerdict;
  acPass: number;
  acFail: number;
  vqaPass: number;
  vqaFail: number;
  gateVerdict: QaPillarVerdict;
}

export interface AcCriterionResult {
  criterionId: string;
  storyId: string;
  epicId: string;
  text: string;
  passed: boolean;
  needsBrowser: boolean;
  poNote?: string;
}

export interface AcRollup {
  verdict: QaPillarVerdict;
  total: number;
  pass: number;
  fail: number;
  pending: number;
  failures: AcCriterionResult[];
  manualApproval?: { approvedAt: string; approvedBy: string };
  canManuallyApprove: boolean;
}

/** Pipeline v2.0 PR-8 — extended verdict states. */
export type VqaTestStatus =
  | 'pass'
  | 'fail'
  | 'uncertain'
  | 'skipped-budget'
  | 'errored'
  | 'pending';

export type VqaTestLevel = 'L0' | 'L1' | 'L2';

export interface VqaTestResult {
  testId: string;
  storyId: string;
  epicId: string;
  /** True iff status === 'pass'. Kept for back-compat. */
  passed: boolean;
  status: VqaTestStatus;
  screenshotUrl?: string;
  expected?: string;
  observed?: string;
  level?: VqaTestLevel;
  rationale?: string;
  costUsd?: number;
  durationMs?: number;
  /** B#2 — classification of a non-pass test (drives the drawer banner). */
  failureClass?: 'render' | 'interaction-gated';
  /** Step-0.6 — judge's semantic observability self-classification (authoritative for failureClass when present). */
  observability?: 'observable' | 'not-idle-observable';
  /** B#2 — operator accepted this failure as a known limitation (non-blocking). */
  accepted?: boolean;
}

/** PR-8d — execute-stage lifecycle. Drives ContractGate visibility,
 *  vqa-gallery badge labels, and verdict-strip CTAs. */
export type VqaExecuteStatus =
  | 'never-run'
  | 'queued-contract'
  | 'rejected'
  | 'queued-execute'
  | 'running'
  | 'done';

/** PR-8d — one row in the ContractGate's test table. */
export interface ContractClassifiedTest {
  testId: string;
  storyId: string;
  storyTitle: string;
  epicId: string;
  epicLabel: string;
  criteriaRef?: string;
  description: string;
  expect: string;
  level: VqaTestLevel;
  classifierReason: string;
  estimatedCostUsd: number;
  estimatedWallclockSec: number;
}

export interface ContractWarning {
  refId?: string;
  reason?: string;
  message: string;
}

/** PR-8d — snapshot of the qa-aggregate output scoped for the
 *  ContractGate UI. */
export interface QaContractDraft {
  aggregateJobId: string;
  status: 'pending' | 'approved' | 'rejected';
  totalTests: number;
  byLevel: { L0: number; L1: number; L2: number };
  estimatedCostUsd: number;
  estimatedWallclockSec: number;
  coverageWarnings: ContractWarning[];
  specificityWarnings: ContractWarning[];
  classifiedTests: ContractClassifiedTest[];
  decidedAt?: string;
  decidedBy?: string;
}

export interface VqaRollup {
  verdict: QaPillarVerdict;
  total: number;
  pass: number;
  fail: number;
  pending: number;
  uncertain?: number;
  skippedBudget?: number;
  errored?: number;
  /** B#2 — count of failing tests accepted as known limitations (non-blocking). */
  accepted?: number;
  overviewUrl?: string;
  thumbnails: VqaTestResult[];
  failures: VqaTestResult[];
  results?: VqaTestResult[];
  costUsd?: number;
  wallclockSec?: number;
  executeStatus: VqaExecuteStatus;
  contract?: QaContractDraft;
}

export type GateCheck = 'compile' | 'typecheck' | 'lint' | 'unit' | 'browser' | 'tamper';

export type GateCellStatus = 'pass' | 'fail' | 'pending' | 'skipped';

export interface GateWaveRow {
  epicId: string;
  epicLabel: string;
  waveIndex: number;
  waveLabel: string;
  cells: Partial<Record<GateCheck, GateCellStatus>>;
  jobIds: Partial<Record<GateCheck, string>>;
}

export interface GateRollup {
  verdict: QaPillarVerdict;
  activeChecks: GateCheck[];
  waveRows: GateWaveRow[];
  tamperCountsByStory: Record<string, number>;
}

export interface EpicQaBreakdown {
  epicId: string;
  epicLabel: string;
  title: string;
  qaJobId?: string;
  poJobId?: string;
  qaVerdict: QaPillarVerdict;
  poVerdict: QaPillarVerdict;
  ranAt?: string;
}

export interface AttentionItemRef {
  planId: string;
  itemId: string;
  createdAt: string;
  resolvedAt: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  title: string;
  status: 'open' | 'resolving' | 'resolved';
}

export interface QaReport {
  planId: string;
  rigor: PlanRigor;
  autoRunQa: boolean;
  hasBrowserTests: boolean;
  verdict: PlanQaVerdict;
  blockingReason?: string;
  ac: AcRollup;
  vqa: VqaRollup;
  gate: GateRollup;
  perEpic: EpicQaBreakdown[];
  attentionItems: AttentionItemRef[];
  runHistory: QaRunSummary[];
  generatedAt: string;
}
