/**
 * Client mirror of functions/shared/types/deploy-report.ts. Backend is the
 * source of truth; this file is a structural echo for `GET /api/plans/:id/deploy-report`.
 */

import type { PlanRigor } from './plan';
import type { PlanQaVerdict } from './qa-report';

export type DeployVerdict =
  | 'ready'
  | 'deploying'
  | 'live'
  | 'failed'
  | 'not-ready'
  | 'never-deployed';

export type AgentJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface DeployStepStatus {
  id: 'build' | 'sync' | 'invalidate' | 'verify';
  label: string;
  status: 'pending' | 'running' | 'pass' | 'fail' | 'skipped';
  detail?: string;
  elapsedSec?: number;
}

export interface DeployRecord {
  jobId: string;
  epicId: string;
  status: AgentJobStatus;
  startedAtIso: string;
  finishedAtIso?: string;
  durationSec?: number;
  publicUrl?: string;
  sha?: string;
  steps: DeployStepStatus[];
  detail?: string;
  errorMessage?: string;
}

export interface DeployTarget {
  publicUrl: string;
  s3Bucket: string;
  s3Prefix: string;
  cloudfrontDistributionId?: string;
}

export interface DeployHandoff {
  planName: string;
  displayName?: string;
  rigor: PlanRigor;
  stories: { done: number; total: number };
  costUsd: number;
  qaVerdict: PlanQaVerdict;
  thumbnailUrls: string[];
}

/** Deployment v2.5 — one rung of the dev → staging → production ladder. */
export type DeployEnvironmentName = 'dev' | 'staging' | 'production';
export interface DeployEnvironmentStatus {
  environment: DeployEnvironmentName;
  url?: string;
  status: 'none' | 'deploying' | 'live' | 'failed';
  canPromote: boolean;
}

export interface DeployReport {
  planId: string;
  verdict: DeployVerdict;
  statusReason?: string;
  target: DeployTarget;
  handoff: DeployHandoff;
  /** Deployment v2.5 — the dev → staging → production promotion ladder. */
  environments: DeployEnvironmentStatus[];
  current: DeployRecord | null;
  history: DeployRecord[];
  generatedAt: string;
}
