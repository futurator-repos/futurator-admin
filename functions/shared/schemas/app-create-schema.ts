/**
 * app-create-schema.ts — Pipeline v2 Phase 1 / Story 1.4.2.
 *
 * Zod schema for `POST /api/apps`. Extends the legacy App-create payload with
 * the boilerplate-type + BMAD toggle the saga needs.
 *
 * Backward-compat contract (Story 1.4.4 constraints):
 *
 *   The legacy payload `{ appId, displayName, icon?, executionMode? }` (no
 *   `boilerplateType`, no `bmadEnabled`) MUST still parse. Existing callers
 *   are not migrated in this story. Defaults applied server-side:
 *     - `boilerplateType` → `'nextjs'` when omitted (matches the Story 1.8.3
 *       fallback for legacy Apps).
 *     - `bmadEnabled`     → `true` when omitted (matches the modal default
 *       for the only currently-wired type).
 *
 *   The route layer applies the defaults AFTER `safeParse`, so the inferred
 *   input type stays narrow (`boilerplateType?: …`) and clients that opt-out
 *   of a field do not trip the schema.
 *
 * Slug regex: `^[a-z][a-z0-9-]{1,39}$` — matches Story 1.4.1 AC #4 and the
 * existing `githubCreateRepoSchema.name` rule. Slightly stricter than the
 * legacy `appSlugSchema` (which allowed digit-leading) so the App slug, the
 * GitHub repo name, and the URL segment are guaranteed to be the same shape.
 */

import { z } from 'zod';
import { appExecutionModeSchema } from './app-schema';

/**
 * Pipeline v2 slug rule — letter-led kebab-case, 2–40 chars total.
 * Stricter superset of the legacy `APP_SLUG_REGEX` so a saga-created App is
 * also a valid legacy App, but not vice-versa (legacy `123-foo` slugs cannot
 * be re-created via the saga).
 */
export const PV2_APP_SLUG_REGEX = /^[a-z][a-z0-9-]{1,39}$/;

export const boilerplateTypeSchema = z.enum(['nextjs', 'sst', 'vite', 'mobile'], {
  errorMap: () => ({
    message: "boilerplateType must be one of: 'nextjs', 'sst', 'vite', 'mobile'",
  }),
});

export const appCreateInputSchema = z
  .object({
    appId: z
      .string()
      .regex(
        PV2_APP_SLUG_REGEX,
        'appId must match ^[a-z][a-z0-9-]{1,39}$ (kebab-case, 2–40 chars, starts with a letter)',
      ),
    displayName: z.string().trim().min(1).max(80),
    icon: z.string().min(1).max(8).optional(),
    executionMode: appExecutionModeSchema.optional(),
    /** Optional during the migration window — defaults to `'nextjs'` server-side. */
    boilerplateType: boilerplateTypeSchema.optional(),
    /** Optional during the migration window — defaults to `true` server-side. */
    bmadEnabled: z.boolean().optional(),
  })
  .strict();

export type AppCreateInput = z.infer<typeof appCreateInputSchema>;
