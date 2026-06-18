/**
 * skill-proposal-schema.ts — Skills Institution, Story 3.1 (2026-06-17).
 *
 * A `skill-proposal` is one item in the curation Inbox — a candidate skill that
 * has passed THROUGH the gate (merge → scan → label → version) and now awaits a
 * human ratify/reject/defer (the Phase-2 synthesis step that stays human, per the
 * Hermes governance line). It is the durable handoff between the automated gate
 * and the operator.
 *
 * Every entry path converges here: a reflection that graduates to a global skill
 * (`reflect-graduate`), a hand-written skill (`create`), a pasted URL
 * (`paste-url`), and bulk acquisition (`bulk`, Phase 3). The inbox renders the
 * unified diff from `proposedBody` vs the current registry body.
 */

import { z } from 'zod';
import {
  SkillIndexEntrySchema,
  SecurityStatusSchema,
  QualityGradeSchema,
  SkillLineageSchema,
} from './skill-index-entry-schema';

/** How a proposal entered the gate. */
export const ProposalSourceSchema = z.enum([
  'reflect-graduate', // a confirmed app reflection promoted to a global skill (FR1)
  'create', // operator hand-authored (FR8 / Story 3.4)
  'paste-url', // operator pasted a URL, extracted to SKILL.md shape (Story 3.4)
  'bulk', // bulk acquisition from a source registry (Phase 3)
]);
export type ProposalSource = z.infer<typeof ProposalSourceSchema>;

/**
 * Lifecycle of a proposal in the inbox. `pending` = ratifiable; `quarantined` =
 * Gate-1 blocked it (ratify requires an explicit override, Story 3.2);
 * `ratified|rejected|deferred` are terminal-ish operator decisions.
 */
export const ProposalStatusSchema = z.enum([
  'pending',
  'quarantined',
  'ratified',
  'rejected',
  'deferred',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** One Gate-1 pattern hit (mirrors `skill-gate/security-scan.ts::PatternHit`). */
export const PatternHitSchema = z.object({
  id: z.string(),
  category: z.string(),
  severity: z.enum(['blocking', 'advisory']),
  description: z.string(),
  evidence: z.string(),
  location: z.string(),
});
export type PatternHit = z.infer<typeof PatternHitSchema>;

/** The deterministic Gate-1 verdict stored on the proposal. */
export const ScanReportSchema = z.object({
  securityStatus: z.enum(['clean', 'flagged', 'quarantined']),
  patternsHit: z.array(PatternHitSchema),
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

/** Advisory Gate-2 LLM verdict (on-demand, Story 2.5). Never auto-admits/blocks. */
export const LlmReviewSchema = z.object({
  verdict: z.enum(['approve', 'concerns', 'reject']),
  summary: z.string(),
  reviewedAt: z.string(),
  model: z.string().optional(),
});
export type LlmReview = z.infer<typeof LlmReviewSchema>;

/** Near-duplicate annotation from the dedup step (Story 2.4). */
export const DedupAnnotationSchema = z.object({
  /** Existing skill this proposal most resembles. */
  canonicalName: z.string(),
  /** Similarity score in [0,1]. */
  similarity: z.number(),
});
export type DedupAnnotation = z.infer<typeof DedupAnnotationSchema>;

export const SkillProposalSchema = z.object({
  /** ULID — PK. Sort-friendly so the GSI orders newest-last by id too. */
  proposalId: z.string().min(1),
  source: ProposalSourceSchema,
  skillName: z.string().min(1),
  kind: z.string().default('core'),
  /** The candidate SKILL.md body the curator will diff + ratify. */
  proposedBody: z.string(),
  /** The extended index entry to write on ratify. */
  proposedEntry: SkillIndexEntrySchema,
  /** One-line gist for the inbox row. */
  gist: z.string().default(''),
  securityStatus: SecurityStatusSchema,
  scanReport: ScanReportSchema.optional(),
  qualityGrade: QualityGradeSchema.default('ungraded'),
  /** Cluster id for curate-by-cluster (Phase 3). */
  clusterId: z.string().optional(),
  dedup: DedupAnnotationSchema.optional(),
  llmReview: LlmReviewSchema.optional(),
  status: ProposalStatusSchema.default('pending'),
  /** GSI range key — ISO timestamp. */
  createdAt: z.string(),
  ratifiedBy: z.string().optional(),
  ratifiedAt: z.string().optional(),
  rejectedReason: z.string().optional(),
  lineage: SkillLineageSchema.optional(),
});
export type SkillProposal = z.infer<typeof SkillProposalSchema>;

/** Validate a row read from DynamoDB; returns null on a malformed item. */
export function parseSkillProposal(raw: unknown): SkillProposal | null {
  const r = SkillProposalSchema.safeParse(raw);
  return r.success ? r.data : null;
}
