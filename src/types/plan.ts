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

/** Concept v2 (W11) — interactivity axis. Mirror of functions/shared/types/plan.ts. */
export type ConceptInteraction = 'interactive' | 'autopilot';

/** Concept v2 (§3.2) — the Concept Router's applicability DAG. Mirror of functions/shared/concept/concept-plan.ts. */
export type ConceptArtifactKind = 'prd' | 'ux' | 'architecture';
export interface ConceptPlanArtifact {
  kind: ConceptArtifactKind;
  depth: 'lite' | 'light' | 'full';
  dependsOn?: ConceptArtifactKind[];
}
export interface ConceptPlan {
  uiBearing: boolean;
  complexity: 'low' | 'medium' | 'high';
  artifacts: ConceptPlanArtifact[];
  gate: 'noop' | 'light' | 'strict';
  rationale: string;
}

/** Concept v2 — live per-artifact status. Mirror of functions/shared/concept/artifact-version.ts. */
export type ConceptArtifactStatus = 'draft' | 'approved' | 'stale';
export interface ConceptArtifact {
  kind: ConceptArtifactKind;
  rev: number;
  contentHash: string;
  status: ConceptArtifactStatus;
  dependsOn?: ConceptArtifactKind[];
}

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
  /** QA-Review — clickable DEV preview (dev.futurator.ai/<appId>/), harness ON. */
  devUrl?: string;
  /** QA-Review — clickable STAGING preview. */
  stagingUrl?: string;
  devModel?: string;
  devEffort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  testModel?: string;
  yoloMode?: boolean;
  executionMode: PlanExecutionMode;
  rigor?: PlanRigor;
  /** Concept v2 (W11) — interactivity axis (interactive | autopilot). */
  conceptInteraction?: ConceptInteraction;
  /** Concept v2 (§3.2) — Router applicability DAG; absent for prototype/legacy. */
  conceptPlan?: ConceptPlan;
  /** Concept v2 — live per-artifact status registry (draft/approved/stale). */
  conceptArtifacts?: ConceptArtifact[];
  /** Concept v2 — FK to the concept-route job (mvp/production). */
  conceptRouteJobId?: string;
  /** Concept v2 — per-artifact generator job FKs (for live streaming the active agent). */
  conceptArtifactJobIds?: Partial<Record<ConceptArtifactKind, string>>;
  /** Concept v2 — the grounded pm-plan job the chain enqueues once all specs approve. */
  conceptPmPlanJobId?: string;
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
