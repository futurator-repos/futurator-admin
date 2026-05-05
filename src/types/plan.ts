/**
 * Client-side Plan types, mirroring functions/shared/types/plan.ts.
 */

export type PlanStatus =
  | 'concept'
  | 'developing'
  | 'fixing' // legacy
  | 'review'
  | 'delivered'
  | 'abandoned' // App/Plan v1
  | 'archived'; // legacy

/** App/Plan v1 — Plan kind. */
export type PlanKind = 'initial' | 'change' | 'experiment';

export type PlanExecutionMode = 'pipeline' | 'orchestrator';

export type PlanRigor = 'prototype' | 'mvp' | 'production';

export interface PlanTestingProfile {
  hasBrowserTests?: boolean;
  viewport?: string;
  interactionModel?: string;
}

export interface Plan {
  planId: string;
  /** App/Plan v1 — FK to parent App. Optional during migration. */
  appId?: string;
  /** App/Plan v1 — Plan kind. */
  kind?: PlanKind;
  /** App/Plan v1 — short label like "v1.1 — mobile pass". */
  iterationLabel?: string;
  /** App/Plan v1 — file paths/globs the iteration must NOT modify. */
  noTouchPaths?: string[];
  name: string;
  /** Human-readable display label. Falls back to `name` when absent. */
  displayName?: string;
  intent: string;
  description: string;
  status: PlanStatus;
  epicIds: string[];
  workingDir: string;
  deployUrl?: string;
  devModel?: string;
  devEffort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  testModel?: string;
  yoloMode?: boolean;
  executionMode: PlanExecutionMode;
  rigor?: PlanRigor;
  testingProfile?: PlanTestingProfile;
  /** QA auto-enqueue toggle. Default derived from rigor at creation. */
  autoRunQa?: boolean;
  /** Party Mode (BMAD) enabled at creation. Default true. */
  bmadEnabled?: boolean;
  acApproval?: { approvedAt: string; approvedBy: string };
  deployJobIds?: string[];
  totalCostUsd: number;
  totalStories: number;
  doneStories: number;
  startedAt?: string;
  reviewAt?: string;
  planBuildJobId?: string;
  /**
   * Pipeline v2.0 PR-8a — plan-scoped Visual QA EXECUTE job. Mirror of
   * `functions/shared/types/plan.ts`.
   */
  qaJobId?: string;
  /** PR-8d — aggregate-stage job (contract-review draft producer). */
  qaAggregateJobId?: string;
  /** PR-8d — operator-gated contract status. */
  qaContractStatus?: 'pending' | 'approved' | 'rejected';
  qaContractDecidedAt?: string;
  qaContractDecidedBy?: string;
  /** PR-8e — plan-level QA cost ceiling in USD. */
  qaCostBudgetUsd?: number;
  preArchiveStatus?: PlanStatus;
  archivedAt?: string;
  archivePath?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface PlanSummary {
  planId: string;
  name: string;
  displayName?: string;
  intent: string;
  status: PlanStatus;
  totalStories: number;
  doneStories: number;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deployUrl?: string;
}

export interface PlanCreateInput {
  name: string;
  displayName?: string;
  intent: string;
  devModel?: string;
  devEffort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  testModel?: string;
  yoloMode?: boolean;
  executionMode?: PlanExecutionMode;
  rigor?: PlanRigor;
  testingProfile?: PlanTestingProfile;
  autoRunQa?: boolean;
  /** Install BMAD at creation — default true, enables Party Mode. */
  bmadEnabled?: boolean;
}
