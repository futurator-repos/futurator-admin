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
  'fixing', // legacy
  'review',
  'delivered',
  'abandoned', // App/Plan v1
  'archived', // legacy
]);

// ─────────────────────────────────────────────────────────────────────
// App/Plan v1 — Plan kind + brownfield-iteration schemas
// ─────────────────────────────────────────────────────────────────────

/** App/Plan v1 — Plan kind enum. */
export const planKindSchema = z.enum(['initial', 'change', 'experiment']);

/**
 * App/Plan v1 — legal Plan status transitions. Used by the API layer
 * (`POST /api/plans/:id/transitions/...`) and by the daemon's atomic abandon.
 *
 * `'fixing'` and `'archived'` are kept as legal targets for legacy callers;
 * App/Plan v1 callers should not produce them.
 */
export const PLAN_LEGAL_TRANSITIONS: Record<
  z.infer<typeof planStatusSchema>,
  ReadonlyArray<z.infer<typeof planStatusSchema>>
> = {
  concept: ['developing', 'abandoned'],
  developing: ['review', 'abandoned'],
  review: ['delivered', 'developing', 'abandoned'],
  delivered: [], // terminal — iterate via a new Plan on the same App
  abandoned: [], // terminal
  fixing: ['developing', 'review', 'archived'], // legacy
  archived: [], // legacy terminal
};

/**
 * App/Plan v1 — input to `POST /api/apps/:appId/plans` (App-aware Plan create).
 *
 * Distinct from the legacy `planCreateInputSchema` above: the new API receives
 * `appId` from the URL path; the body carries the iteration's `kind` + free-text
 * intent + optional execution overrides.
 */
export const createPlanForAppInputSchema = z.object({
  kind: planKindSchema,
  intent: z.string().min(10, 'Intent must be at least 10 characters.').max(2000),
  executionMode: planExecutionModeSchema.optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  rigor: planRigorSchema.optional(),
  /**
   * PR-10 #1 — optional plan slug (kebab-case). When omitted the API
   * auto-generates `${appId}-${kind}-${shortHash}` so multi-plan-per-app
   * stops colliding on the legacy `name` uniqueness constraint. When
   * provided, must satisfy the same kebab-case rule as App slugs and
   * must not be already in use by a non-archived plan.
   */
  name: planNameSchema.optional(),
});
export type CreatePlanForAppInput = z.infer<typeof createPlanForAppInputSchema>;

/** App/Plan v1 — partial update for Plan editing during `concept` review. */
export const updatePlanV1Schema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    iterationLabel: z.string().trim().min(1).max(80).optional(),
    noTouchPaths: z.array(z.string()).optional(),
    intent: z.string().min(10).max(2000).optional(),
  })
  .strict();
export type UpdatePlanV1Input = z.infer<typeof updatePlanV1Schema>;

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
  /** Party Mode (BMAD) install at creation. Default true. */
  bmadEnabled: z.boolean().optional(),
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
  bmadEnabled: z.boolean().optional(),
});
export type PlanPatchInput = z.infer<typeof planPatchSchema>;
