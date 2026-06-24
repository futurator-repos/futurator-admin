/**
 * Ultracode-Reverse — frontend type mirror.
 *
 * KEEP IN SYNC with `functions/shared/types/ultracode-run.ts` (the static export does not
 * import backend types directly — same convention as `src/types/scorecard.ts`).
 */

import type { ScorecardSlice } from './scorecard';

export type UltracodeRunStatus =
  | 'QUEUED'
  | 'CAPTURING'
  | 'HALTED'
  | 'SCORING'
  | 'COMPLETE'
  | 'ERROR';
export type UltracodeSideStatus = 'PENDING' | 'RUNNING' | 'HALTED' | 'COMPLETE' | 'ERROR';
export type UltracodeTarget = 'greenfield' | 'brownfield';
export type UltracodeRigor = 'prototype' | 'mvp' | 'production';

export interface UltracodeScorecard {
  structural: { score: number; perMetric: Record<string, number> };
  guardrail?: { uplift: number; sub: Record<string, number> };
  judge?: {
    perAxis: Record<string, { case1: number | null; case2: number | null }>;
    notes: string[];
  };
  slices: ScorecardSlice[];
  verdict?: string;
  observations?: string[];
}

export interface UltracodeRun {
  runId: string;
  operatorId: string;
  status: UltracodeRunStatus;
  intent: string;
  target: UltracodeTarget;
  rigor: UltracodeRigor;
  reps: number;
  jobId?: string;
  case1Status: UltracodeSideStatus;
  case2Status: UltracodeSideStatus;
  case1Pattern?: string;
  case2Pattern?: string;
  structuralScore?: number;
  guardrailUplift?: number;
  verdict?: string;
  scorecard?: UltracodeScorecard;
  confound: string;
  claudeVersion?: string;
  taintedReps?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UltracodeRunSummary {
  runId: string;
  intent: string;
  target: UltracodeTarget;
  rigor: UltracodeRigor;
  reps: number;
  status: UltracodeRunStatus;
  case1Status: UltracodeSideStatus;
  case2Status: UltracodeSideStatus;
  structuralScore?: number;
  guardrailUplift?: number;
  verdict?: string;
  createdAt: string;
}

/** Terminal statuses — the scorecard is only meaningful once a run reaches one. */
export const TERMINAL_STATUSES: ReadonlySet<UltracodeRunStatus> = new Set(['COMPLETE', 'ERROR']);
/** Statuses during which the live-stream poll should stay hot. */
export const ACTIVE_STATUSES: ReadonlySet<UltracodeRunStatus> = new Set([
  'QUEUED',
  'CAPTURING',
  'SCORING',
]);
