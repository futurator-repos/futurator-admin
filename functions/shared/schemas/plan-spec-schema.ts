/**
 * plan-spec-schema — the Zod wire validator for the Mycelium → dev contract
 * (development-plan §3 / §5.1). Use `.safeParse` per project convention.
 *
 * EXTENDS the existing `acceptanceCriterionSchema` (via intersection — that
 * schema is a ZodEffects from its superRefine, so `.extend` isn't available)
 * rather than forking it, so legacy PM output and Mycelium output share ONE AC
 * validator. The contract guarantees (global ids, DAG, ≥1 touches, every AC
 * carries a testBinding, contentHash present) are asserted at ingest in
 * `plan-spec-ingest.ts`; the schema enforces shape + the structural ones it can.
 */

import { z } from 'zod';
import { acceptanceCriterionSchema } from './plan-output-schema';

export const PLAN_SPEC_SCHEMA_VERSION = 'plan-spec/1' as const;
export const EPIC_WIDE_TOUCH = '<EPIC_WIDE>';

export const testBindingStatusSchema = z.enum(['unbound', 'bound', 'passing', 'failing']);
export const testKindSchema = z.enum(['unit', 'integration', 'browser', 'manual']);
export const acClassSchema = z.enum(['deterministic', 'advisory-taste', 'advisory-security']);

export const testBindingSchema = z.object({
  status: testBindingStatusSchema.default('unbound'),
  testRef: z.string().optional(),
  testKind: testKindSchema.optional(),
  lastRunSha: z.string().optional(),
  lastRunAt: z.string().optional(),
  detail: z.string().optional(),
});

/** boundAC = legacy AC ∩ { testBinding, acClass, validatesUjId } — extends, not forks. */
export const boundAcceptanceCriterionSchema = z.intersection(
  acceptanceCriterionSchema,
  z.object({
    testBinding: testBindingSchema.default({ status: 'unbound' }),
    acClass: acClassSchema.default('deterministic'),
    validatesUjId: z.string().optional(),
  }),
);

export const specShardRefSchema = z.object({
  shardId: z.string().min(1),
  s3Uri: z.string().min(1),
  contentHash: z.string().min(1), // cache key + drift detector
  section: z.string().optional(),
});

export const storyComplexitySchema = z.enum(['trivial', 'standard', 'complex', 'architectural']);

export const storyNodeSchema = z.object({
  storyId: z.string().min(1),
  cohort: z.object({
    epicId: z.string().min(1),
    epicTitle: z.string().optional(),
    requirementRefs: z.array(z.string()).default([]),
  }),
  title: z.string().min(3),
  intent: z.string().optional(),
  acceptanceCriteria: z
    .array(boundAcceptanceCriterionSchema)
    .min(1, 'Each story must have at least one bound acceptance criterion'),
  depends_on: z.array(z.string()).default([]),
  touches: z.array(z.string().min(1)).min(1, 'Each story must declare at least one touches glob'),
  forbiddenAreas: z.array(z.string().min(1)).default([]),
  specShardRef: specShardRefSchema.optional(),
  complexity: storyComplexitySchema.default('standard'),
  verifyIntent: z.string().optional(),
});

export const planSpecSchema = z.object({
  schemaVersion: z.literal(PLAN_SPEC_SCHEMA_VERSION),
  planId: z.string().min(1),
  appId: z.string().min(1),
  planSlug: z.string().min(1),
  rigor: z.enum(['prototype', 'mvp', 'production']).default('mvp'),
  convergedAt: z.string().min(1),
  myceliumPlanSpecId: z.string().min(1),
  stories: z.array(storyNodeSchema).min(1, 'A plan_spec must have at least one story'),
});

export type ParsedPlanSpec = z.infer<typeof planSpecSchema>;
export type ParsedStoryNode = z.infer<typeof storyNodeSchema>;
