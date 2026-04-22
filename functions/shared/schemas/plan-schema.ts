import { z } from 'zod';

/**
 * Plan name rule: kebab-case, 3-41 chars, starts with a letter.
 *
 * Because this becomes the folder slug on EC2 AND the deploy URL under
 * `futurator.ai/apps/<name>/`, the character set is restricted to `[a-z0-9-]`.
 */
export const PLAN_NAME_REGEX = /^[a-z][a-z0-9-]{2,40}$/;

export const planNameSchema = z
  .string()
  .regex(
    PLAN_NAME_REGEX,
    'Plan name must be kebab-case: start with a letter, 3-41 chars, lowercase + digits + hyphens only.',
  );

export const planExecutionModeSchema = z.enum(['pipeline', 'orchestrator']);

/** Phase C.1: Rigor dial. */
export const planRigorSchema = z.enum(['prototype', 'mvp', 'production']);

/** Phase C.2: Plan-wide testing config. */
export const planTestingProfileSchema = z.object({
  hasBrowserTests: z.boolean().optional(),
  viewport: z.string().optional(),
  interactionModel: z.string().optional(),
});

export const planStatusSchema = z.enum([
  'concept',
  'developing',
  'fixing',
  'review',
  'delivered',
  'archived',
]);

/** Input to `POST /api/plans/from-intent`. */
export const planCreateInputSchema = z.object({
  name: planNameSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
  intent: z.string().min(10, 'Intent must be at least 10 characters.'),
  devModel: z.string().optional(),
  devEffort: z.string().optional(),
  reviewerModel: z.string().optional(),
  reviewerEffort: z.string().optional(),
  testModel: z.string().optional(),
  yoloMode: z.boolean().optional(),
  executionMode: planExecutionModeSchema.optional(),
  rigor: planRigorSchema.optional(),
  testingProfile: planTestingProfileSchema.optional(),
  /** QA auto-enqueue toggle. Default derived from rigor when omitted. */
  autoRunQa: z.boolean().optional(),
});
export type PlanCreateInput = z.infer<typeof planCreateInputSchema>;

/** Input to `PATCH /api/plans/:id`. */
export const planPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  intent: z.string().min(10).optional(),
  description: z.string().optional(),
  devModel: z.string().optional(),
  devEffort: z.string().optional(),
  reviewerModel: z.string().optional(),
  reviewerEffort: z.string().optional(),
  testModel: z.string().optional(),
  yoloMode: z.boolean().optional(),
  executionMode: planExecutionModeSchema.optional(),
  rigor: planRigorSchema.optional(),
  testingProfile: planTestingProfileSchema.optional(),
  autoRunQa: z.boolean().optional(),
});
export type PlanPatchInput = z.infer<typeof planPatchSchema>;
