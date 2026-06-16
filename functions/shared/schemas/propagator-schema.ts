import { z } from 'zod';

/**
 * Propagator schemas — Epic 6, Story 6.5. Validate the consent-gated proposal
 * ingest + operator decisions. The daemon files proposals (built by
 * `daemon/scripts/propagator.mjs`); operators approve/reject from the UI.
 */

export const propagatorTriggerSchema = z.enum(['wave-gate', 'drift-threshold']);

export const propagatorContractChangeSchema = z.object({
  node: z.string().min(1),
  change: z.string().min(1),
});

export const propagatorProposedStorySchema = z.object({
  title: z.string().min(1),
  epic: z.string().min(1),
});

/** Ingest one proposal (the daemon's brief → a PROPOSED sibling story). */
export const createPropagatorProposalSchema = z.object({
  proposalId: z.string().min(1),
  sourceProject: z.string().min(1),
  sibling: z.string().min(1),
  trigger: propagatorTriggerSchema,
  brief: z.string().min(1),
  contractChanges: z.array(propagatorContractChangeSchema).min(1),
  proposedStory: propagatorProposedStorySchema,
  atCommit: z.string().nullish(),
});

/** Bulk ingest (a wave gate may produce several sibling proposals at once). */
export const ingestPropagatorProposalsSchema = z.object({
  proposals: z.array(createPropagatorProposalSchema).min(1),
});

/** Operator reject — reason becomes context for any future re-proposal. */
export const rejectPropagatorProposalSchema = z.object({
  reason: z.string().min(3).max(2000),
});

export type CreatePropagatorProposalInput = z.infer<typeof createPropagatorProposalSchema>;
export type IngestPropagatorProposalsInput = z.infer<typeof ingestPropagatorProposalsSchema>;
export type RejectPropagatorProposalInput = z.infer<typeof rejectPropagatorProposalSchema>;
