/**
 * Client-side Plan types, mirroring functions/shared/types/plan.ts.
 */

export type PlanStatus = 'concept' | 'developing' | 'fixing' | 'review' | 'delivered' | 'archived';

export type PlanExecutionMode = 'pipeline' | 'orchestrator';

export type PlanRigor = 'prototype' | 'mvp' | 'production';

export interface PlanTestingProfile {
  hasBrowserTests?: boolean;
  viewport?: string;
  interactionModel?: string;
}

export interface Plan {
  planId: string;
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
  totalCostUsd: number;
  totalStories: number;
  doneStories: number;
  startedAt?: string;
  reviewAt?: string;
  planBuildJobId?: string;
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
}
