// Timer Intelligence — Zod schema for GET /api/timing/cohort query params (Story 1.8.3)
import { z } from 'zod';

/**
 * BoilerplateType mirrors the union from `functions/shared/boilerplates/registry.ts`.
 * Duplicated here to keep this schema self-contained and avoid a cross-module import
 * inside the Zod schema file (the registry imports BoilerplateMetadata which has
 * side-effects from registry.ts initialization). Story 1.3.3 owns the canonical
 * definition; this schema stays in sync via the string literal union.
 *
 * PR-13 (2026-05-04) — added the four nextjs-* starter pack subtypes that
 * inherit from nextjs-base. `nextjs` is kept for legacy App rows pre-rename.
 */
export const boilerplateTypeSchema = z.enum([
  'nextjs',
  'nextjs-base',
  'nextjs-canvas-game',
  'nextjs-form-app',
  'nextjs-dashboard',
  'sst',
  'vite',
  'mobile',
]);

/**
 * PlanKind mirrors `PlanKind` from `functions/shared/types/plan.ts`.
 * Duplicated here for the same reason as above.
 */
export const cohortPlanKindSchema = z.enum(['initial', 'change', 'experiment']);

/**
 * Query-param schema for GET /api/timing/cohort.
 *
 * All three params are required. `epicCount` comes in as a string (URL query
 * params are always strings) so we coerce with z.coerce.number() before
 * applying the min constraint.
 */
export const timingCohortQuerySchema = z.object({
  /** The boilerplate type of the App (e.g. 'nextjs'). */
  templateType: boilerplateTypeSchema,
  /** The kind of plan to compare against. */
  planKind: cohortPlanKindSchema,
  /**
   * The number of epics in the plan being evaluated. Used to filter cohort
   * members to those within ±25% of this value.
   */
  epicCount: z.coerce.number().int().min(1, 'epicCount must be at least 1'),
});

export type TimingCohortQuery = z.infer<typeof timingCohortQuerySchema>;
