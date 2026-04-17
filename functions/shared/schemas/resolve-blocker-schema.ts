import { z } from 'zod';

const complexityEnum = z.enum(['trivial', 'standard', 'complex', 'architectural']);
const reviewRigorEnum = z.enum(['light', 'standard', 'strict']);

const acceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  needsBrowser: z.boolean(),
});

const amendFieldsSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    criteria: z.array(acceptanceCriterionSchema).min(1).optional(),
    touchPoints: z.array(z.string().min(1)).min(1).optional(),
    complexity: complexityEnum.optional(),
    reviewRigor: reviewRigorEnum.optional(),
    dependsOn: z.array(z.string()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be amended',
  });

export const resolveBlockerSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('amend'),
    amendedStory: amendFieldsSchema,
    reason: z.string().min(1).max(1000),
    expectedBlockerReportedAt: z.string().optional(),
  }),
  z.object({
    action: z.literal('skip'),
    reason: z.string().min(1).max(1000),
    expectedBlockerReportedAt: z.string().optional(),
  }),
  z.object({
    action: z.literal('retry'),
    reason: z.string().min(1).max(1000),
    resumeImmediately: z.boolean().default(true),
    expectedBlockerReportedAt: z.string().optional(),
  }),
]);

export type ResolveBlockerInput = z.infer<typeof resolveBlockerSchema>;
export type AmendFieldsInput = z.infer<typeof amendFieldsSchema>;
