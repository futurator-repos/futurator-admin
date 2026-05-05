/**
 * Deploy report — plan-wide release-management view. Aggregates the plan's
 * deploy jobs (current + history), derives a top-level verdict, packages a
 * "what's shipping" handoff summary, and exposes target environment info.
 *
 * Returned by GET /api/plans/:id/deploy-report.
 *
 * Distinct from the Developing → Deploy sub-tab (which is the *toolkit* —
 * start dev server, run visual QA, publish). This is the *release dashboard*
 * on the Deploy pipeline stage.
 */

import type { PlanRigor } from './plan';
import type { AgentJobStatus } from './agent-orchestrator';
import type { PlanQaVerdict } from './qa-report';

/** Top-level Deploy verdict — drives the status pill + CTA. */
export type DeployVerdict =
  | 'ready' // QA green, no active deploy
  | 'deploying' // an active deploy job is PENDING/RUNNING
  | 'live' // most recent deploy COMPLETED successfully
  | 'failed' // most recent deploy FAILED
  | 'not-ready' // QA not green yet
  | 'never-deployed'; // no deploy jobs on record

export interface DeployStepStatus {
  id: 'build' | 'sync' | 'invalidate' | 'verify';
  label: string;
  status: 'pending' | 'running' | 'pass' | 'fail' | 'skipped';
  /** Short excerpt from the step's log output. */
  detail?: string;
  /** Job time in seconds when available. */
  elapsedSec?: number;
}

export interface DeployRecord {
  jobId: string;
  epicId: string;
  status: AgentJobStatus;
  startedAtIso: string;
  finishedAtIso?: string;
  durationSec?: number;
  /** Public URL this deploy published to. */
  publicUrl?: string;
  /** Commit SHA when the build step emitted one. */
  sha?: string;
  /** Step breakdown (derived from job stepResults). */
  steps: DeployStepStatus[];
  /** DEPLOY_DETAILS var for the final card summary. */
  detail?: string;
  /** Human-readable error if job FAILED. */
  errorMessage?: string;
}

export interface DeployTarget {
  /** `futurator.ai/apps/<slug>/` — computed from plan.name. */
  publicUrl: string;
  /** S3 bucket that hosts `apps/<slug>/`. */
  s3Bucket: string;
  /** S3 key prefix under the bucket. */
  s3Prefix: string;
  /** CloudFront distribution ID (display-only; for operator info). */
  cloudfrontDistributionId?: string;
}

export interface DeployHandoff {
  planName: string;
  displayName?: string;
  rigor: PlanRigor;
  stories: { done: number; total: number };
  costUsd: number;
  qaVerdict: PlanQaVerdict;
  thumbnailUrls: string[]; // up to 3 passing VQA screenshots
}

export interface DeployReport {
  planId: string;
  verdict: DeployVerdict;
  /**
   * Human-readable reason why we're not in `ready`/`live` state. Empty when
   * verdict === 'live' or 'ready'.
   */
  statusReason?: string;

  target: DeployTarget;
  handoff: DeployHandoff;

  /** Current or most recent deploy. Null if never deployed. */
  current: DeployRecord | null;
  /** All past deploys (oldest first, excludes `current`). */
  history: DeployRecord[];

  generatedAt: string;
}
