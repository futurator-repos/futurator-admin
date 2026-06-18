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

/** Concept v2 (W11) — interactivity axis. Mirrors `ConceptInteraction` in types/plan.ts. */
export const conceptInteractionSchema = z.enum(['interactive', 'autopilot']);

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

/**
 * Plan kind enum.
 *
 * App/Plan v1 (Phase 1) shipped with three kinds: `initial | change | experiment`.
 *
 * Pipeline v2 Phase 2-A Story 2-A-7-1 (PR-39) extends per v2.5 §5 with seven
 * additional kinds. Existing rows keep their existing kind (no backfill); new
 * plans select from the full set.
 *
 * | Kind                  | Phase introduced | Use case                                                                                                  |
 * | --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
 * | `initial`             | Phase 1          | First plan against a fresh App — sets up the project.                                                     |
 * | `change`              | Phase 1          | Brownfield modification of an existing App.                                                                |
 * | `experiment`          | Phase 1          | Speculative work that may not ship; lives outside the App's main lineage.                                  |
 * | `feature`             | Phase 2 (PR-39)  | New user-facing capability on top of an existing App. Default for most v2 plans.                            |
 * | `bugfix`              | Phase 2 (PR-39)  | Targeted fix for a defect; PM emits a regression-test story by default.                                    |
 * | `maintenance`         | Phase 2 (PR-39)  | Refactor / dependency-bump / cleanup with no user-facing surface change.                                    |
 * | `prototype-on-top`    | Phase 2 (PR-39)  | Experiment branch that pivots off main — `experiment/<plan-slug>` namespace (Phase 2-B-8).                  |
 * | `hotfix`              | Phase 2 (PR-39)  | Branches off the production semver tag (Phase 2-B-8); skips PO/QA gates per v2.5 §50.4.                     |
 * | `rigor-upgrade`       | Phase 2 (PR-39)  | Promotes an App's rigor (prototype → mvp → production); auto-generates the brownfield-audit epic.           |
 * | `implementation-spec` | Phase 2 (PR-39)  | Auto-generated at App creation — runs ARCHITECT T1 + manifest commit + CDK bootstrap (Phase 2-D-6).        |
 *
 * The new kinds are wired into:
 * - PM prompt (boilerplate-aware) — chooses an appropriate template per kind.
 * - Plan-build / wave-build branching — `hotfix` skips PO/QA stub-gates;
 *   `experiment` + `prototype-on-top` never auto-merge (Phase 2-B).
 * - Branch namespace selection (Phase 2-B-8) — drives `wip/` vs
 *   `experiment/<plan-slug>` vs `hotfix/<issue-slug>`.
 */
export const planKindSchema = z.enum([
  // Phase 1 (App/Plan v1)
  'initial',
  'change',
  'experiment',
  // Phase 2-A Story 2-A-7-1 (PR-39)
  'feature',
  'bugfix',
  'maintenance',
  'prototype-on-top',
  'hotfix',
  'rigor-upgrade',
  'implementation-spec',
]);
export type PlanKind = z.infer<typeof planKindSchema>;

/**
 * Phase 1 kinds — preserved for legacy callers and migration code paths.
 */
export const LEGACY_PLAN_KINDS = ['initial', 'change', 'experiment'] as const;

/**
 * Phase 2 kinds — added by PR-39. New plans should prefer these where
 * applicable; the PM prompt + UI surface them as the primary options.
 */
export const PHASE_2_PLAN_KINDS = [
  'feature',
  'bugfix',
  'maintenance',
  'prototype-on-top',
  'hotfix',
  'rigor-upgrade',
  'implementation-spec',
] as const;

/**
 * Kinds that branch off something other than `main` (Phase 2-B-8 — branch
 * namespace selection). Daemon's git-init step uses this to pick the
 * branch base + namespace.
 *
 *   - `experiment`        → `experiment/<plan-slug>` off main
 *   - `prototype-on-top`  → `experiment/<plan-slug>` off main
 *   - `hotfix`            → `hotfix/<plan-slug>` off the latest production semver tag
 *
 * All other kinds → `wip/<storyId>` off main (or off the previous wave's
 * merge SHA for non-first waves).
 */
export const NON_MAIN_PLAN_KINDS: ReadonlyArray<PlanKind> = [
  'experiment',
  'prototype-on-top',
  'hotfix',
];

/**
 * Kinds that skip the PO/QA gate stubs (per v2.5 §50.4 hotfix). Today these
 * gates aren't fully implemented; the field is here so PR-44 + Phase 3
 * gate enforcement can branch on it without re-deriving the rule.
 */
export const SKIP_PO_QA_GATES_KINDS: ReadonlyArray<PlanKind> = ['hotfix'];

/**
 * Type guard — narrows `string` to `PlanKind`.
 */
export function isPlanKind(value: unknown): value is PlanKind {
  return planKindSchema.safeParse(value).success;
}

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
  /** Concept v2 (W11) — interactivity axis; default resolved when omitted. */
  conceptInteraction: conceptInteractionSchema.optional(),
  /**
   * YOLO — auto-advance between phases. At creation it also seeds
   * `conceptInteraction` (YOLO on → autopilot, auto-approving the whole concept
   * chain) when the client doesn't send `conceptInteraction` explicitly.
   */
  yoloMode: z.boolean().optional(),
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
    /** Concept v2 (W11) — editable during `concept` review (immutable after first artifact job). */
    conceptInteraction: conceptInteractionSchema.optional(),
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
  /** Concept v2 (W11) — interactivity axis; default resolved when omitted. */
  conceptInteraction: conceptInteractionSchema.optional(),
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
  // Concept v2 (E4.5d) — editable pre-start; the PATCH handler mode-locks it
  // once the concept chain has begun (conceptChainStarted predicate).
  conceptInteraction: conceptInteractionSchema.optional(),
  testingProfile: planTestingProfileSchema.optional(),
  autoRunQa: z.boolean().optional(),
  bmadEnabled: z.boolean().optional(),
});
export type PlanPatchInput = z.infer<typeof planPatchSchema>;
