/**
 * Reflection types — Pipeline v2 Phase 3 / Story 3-E-3-1 (PR-76).
 *
 * Shape of a single REFLECTOR proposal as it lives in DynamoDB +
 * traverses the API surface. Derived from `ReflectionProposalSchema` in
 * `../pipelines/reflector-pipeline.ts` plus the operator-side fields
 * (status, createdAt, decidedAt, decisionMadeBy) the inbox needs.
 *
 * Lifecycle states per v2.5 §49:
 *   pending   — REFLECTOR proposed; awaits operator decision
 *   confirmed — operator confirmed; daemon ran REFLECTOR-APPLY
 *   declined  — operator declined; REFLECTOR will not re-propose
 *   deferred  — operator postponed; can revisit any time
 *
 * Pre-flight flag (Story 3-E-9-1) lives at the top level; REFLECTOR-
 * REVIEWER verdict (Story 3-E-10-1, defer-after-baseline) at `reviewerVerdict`.
 */

export type ReflectionTarget =
  | 'project-claude-md'
  | 'project-skill'
  | 'agent-persona'
  | 'org-skill'
  | 'pipeline-config'
  | 'tool-wrapper';

export type ReflectionAction =
  | 'append-section'
  | 'replace-section'
  | 'append-line'
  | 'create'
  | 'promote-from-project'
  | 'tune'
  | 'propose';

export type ReflectionStatus = 'pending' | 'confirmed' | 'declined' | 'deferred';

export type ReflectionScope = 'story' | 'wave' | 'plan' | 'brownfield-cycle';

export type ReflectorReviewerVerdict = 'pass' | 'flag' | 'reject';

/**
 * Stored row. `projectSlug` is the DDB partition key; `id` is the sort key.
 * `createdAt` is also indexed via a GSI for cross-project chronological
 * listing in `/labs/reflections`.
 */
export interface ReflectionRow {
  /** DDB partition key. */
  projectSlug: string;
  /** DDB sort key — ULID-shape for chronological ordering. */
  id: string;
  /** ISO timestamp the proposal was first stored. */
  createdAt: string;
  /** ISO timestamp the operator confirmed / declined / deferred. */
  decidedAt?: string;

  /** Provenance back to the REFLECTOR run. */
  planId: string;
  scope: ReflectionScope;

  /** The proposal body (per ReflectionProposalSchema). */
  target: ReflectionTarget;
  action: ReflectionAction;
  section?: string;
  skillName?: string;
  personaName?: string;
  content: string;
  rationale: string;
  evidence: string[];
  confidence: number;

  /** Lifecycle. */
  status: ReflectionStatus;

  /** Story 3-E-9-1 — pre-flight allowlist check. */
  flaggedForManualReview?: boolean;
  flaggedReason?: string;

  /** Story 3-E-10-1 (defer-after-baseline) — REFLECTOR-REVIEWER Haiku verdict. */
  reviewerVerdict?: ReflectorReviewerVerdict;
  reviewerReasoning?: string;

  /**
   * Skills Institution Story 1.2 — REFLECTOR-APPLY landing record. Stamped by
   * the daemon's reflection-apply poller AFTER it runs `applyReflection` on a
   * `confirmed` row. Presence of `appliedAt` is the idempotency guard: the
   * poller skips any confirmed row already stamped, so a row is applied once.
   */
  appliedAt?: string;
  appliedCommitSha?: string;
  /** Outcome of the apply step (mirrors applyReflection's status). */
  applyOutcome?: 'applied' | 'failed' | 'deferred' | 'noop';
  applyError?: string;
}

/**
 * Wire shape returned by GET /api/reflections. Same as ReflectionRow.
 */
export type ReflectionItem = ReflectionRow;

/**
 * The three operator actions exposed by the inbox UI. v2.5 §49.
 */
export type ReflectionDecision = 'confirm' | 'decline' | 'defer';
