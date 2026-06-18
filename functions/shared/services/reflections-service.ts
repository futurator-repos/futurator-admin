/**
 * reflections-service.ts — Pipeline v2 Phase 3 / Story 3-E-3-1 (PR-76).
 *
 * Service layer between the API routes and the DDB repository. Handles
 * id generation, validation, decision application, and the (stub) hook
 * to the daemon's REFLECTOR-APPLY pipeline when an operator confirms.
 */

import { randomUUID } from 'node:crypto';
import { ReflectionProposalSchema } from '../pipelines/reflector-pipeline';
import * as repo from '../repositories/reflections-repository';
import type {
  ReflectionRow,
  ReflectionStatus,
  ReflectionDecision,
  ReflectionScope,
} from '../types/reflection';

export async function listReflections(
  args: {
    projectSlug?: string;
    status?: ReflectionStatus;
  } = {},
) {
  return repo.listReflections(args);
}

export async function getReflection(projectSlug: string, id: string) {
  return repo.getReflection(projectSlug, id);
}

/**
 * Create a new pending reflection. Validates the proposal body shape via
 * `ReflectionProposalSchema` before persistence. Used by the daemon
 * reflector-runner once REFLECTOR's output passes `validateReflectionsBlock`.
 */
export async function createReflection(args: {
  projectSlug: string;
  planId: string;
  scope: ReflectionScope;
  proposal: unknown;
  flaggedForManualReview?: boolean;
  flaggedReason?: string;
}): Promise<ReflectionRow> {
  const parsed = ReflectionProposalSchema.safeParse(args.proposal);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `invalid reflection proposal: ${issue?.path?.join('.') || '<root>'} — ${issue?.message ?? 'shape error'}`,
    );
  }

  const row: ReflectionRow = {
    projectSlug: args.projectSlug,
    id: nextId(),
    createdAt: new Date().toISOString(),
    planId: args.planId,
    scope: args.scope,
    target: parsed.data.target,
    action: parsed.data.action,
    section: parsed.data.section,
    skillName: parsed.data.skillName,
    personaName: parsed.data.personaName,
    content: parsed.data.content,
    rationale: parsed.data.rationale,
    evidence: parsed.data.evidence,
    confidence: parsed.data.confidence,
    status: 'pending',
    flaggedForManualReview: args.flaggedForManualReview,
    flaggedReason: args.flaggedReason,
  };
  await repo.createReflection(row);
  return row;
}

/**
 * Apply operator decision. Returns the updated row. On `confirm`, the daemon's
 * REFLECTOR-APPLY pipeline (`daemon/pipelines/reflector-apply.mjs`) is the
 * consumer that actually lands the change on disk with an `Agent: REFLECTOR-APPLY`
 * commit. That apply path is implemented (Epic 6 + Skills Institution Story 1.1:
 * it authors a NEW app-evolved skill from a `project-skill`/`create` reflection's
 * `content`, Gate-1-scanned before commit). This service only records the
 * operator decision (flips status to `confirmed`); the daemon picks confirmed
 * rows up out-of-band.
 */
export async function applyDecision(args: {
  projectSlug: string;
  id: string;
  decision: ReflectionDecision;
}): Promise<ReflectionRow | null> {
  return repo.applyDecision(args);
}

/**
 * ULID-shape monotonic id. Phase 3 doesn't ship the proper ULID dep yet;
 * an ISO-timestamp prefix + UUID suffix sorts chronologically and is good
 * enough for inbox ordering. Replace with @paralleldrive/cuid2 or ulid
 * once a Phase 3 follow-on adds the dep.
 */
function nextId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T.]/g, '')
    .slice(0, 14);
  return `${ts}-${randomUUID().slice(0, 8)}`;
}
