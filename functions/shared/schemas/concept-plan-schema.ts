import { z } from 'zod';

/**
 * Concept v2 (E7.1) — wire validator for the Concept Router's `conceptPlan`
 * output. Mirrors the `ConceptPlan` types in `functions/shared/concept/concept-plan.ts`.
 */
export const conceptArtifactKindSchema = z.enum(['prd', 'ux', 'architecture']);

export const conceptPlanArtifactSchema = z.object({
  kind: conceptArtifactKindSchema,
  depth: z.enum(['lite', 'light', 'full']),
  dependsOn: z.array(conceptArtifactKindSchema).optional(),
});

export const conceptPlanSchema = z
  .object({
    uiBearing: z.boolean(),
    complexity: z.enum(['low', 'medium', 'high']),
    artifacts: z.array(conceptPlanArtifactSchema).min(1),
    gate: z.enum(['noop', 'light', 'strict']),
    rationale: z.string().min(1),
  })
  .superRefine((plan, ctx) => {
    const kinds = new Set(plan.artifacts.map((a) => a.kind));
    // PRD is the citable root — always present on a routed plan.
    if (!kinds.has('prd')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: 'A routed conceptPlan must include a prd artifact.',
      });
    }
    // UX applies iff uiBearing (the v0.1 flaw this design corrects).
    if (plan.uiBearing !== kinds.has('ux')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: plan.uiBearing
          ? 'A uiBearing plan must include a ux artifact.'
          : 'A non-uiBearing plan must NOT include a ux artifact.',
      });
    }
  });

export type ConceptPlanOutput = z.infer<typeof conceptPlanSchema>;
