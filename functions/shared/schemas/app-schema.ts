import { z } from 'zod';

/**
 * App slug rule: kebab-case, 1–40 chars, no leading/trailing hyphens,
 * no double-hyphens. The slug is the URL segment under
 * `futurator.ai/apps/<appId>/` AND the EC2 working-dir folder name.
 */
export const APP_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Slugs the App namespace can NEVER use because they collide with reserved
 * paths in the public S3 bucket (`futurator-ai-website`) that the homepage
 * project owns. Per CLAUDE.md the admin may write to scoped paths
 * (`apps/`, `media/`, `data/`, `knowledge-live/`); using one of those as an
 * App slug would conflict with the homepage's data and break futurator.ai.
 */
export const RESERVED_APP_IDS = new Set<string>([
  'data',
  'media',
  'apps',
  'knowledge-live',
  'admin',
  'api',
]);

export const appSlugSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    APP_SLUG_REGEX,
    'App slug must be kebab-case lowercase (letters, digits, single hyphens between segments, no leading/trailing hyphen).',
  )
  .refine((s) => !RESERVED_APP_IDS.has(s), {
    message: 'App slug is reserved (collides with homepage S3 paths).',
  });

export const appExecutionModeSchema = z.enum(['pipeline', 'orchestrator']);

export const appWorkingTreeStatusSchema = z.enum([
  'clean',
  'dirty-from-abandoned-plan',
]);

export const appDerivedStatusSchema = z.enum([
  'live',
  'building',
  'dirty-tree',
  'no-deploy',
]);

/** Full App record schema (mirrors `App` interface in `types/app.ts`). */
export const appSchema = z.object({
  appId: appSlugSchema,
  displayName: z.string().trim().min(1).max(80),
  icon: z.string().min(1).max(8).optional(),
  workingDir: z
    .string()
    .startsWith(
      '/home/ubuntu/projects/',
      'workingDir must be under /home/ubuntu/projects/',
    ),
  executionMode: appExecutionModeSchema,
  currentlyDeployedPlanId: z.string().nullable(),
  deployJobIds: z.array(z.string()),
  workingTreeStatus: appWorkingTreeStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Input to `POST /api/apps` — create a new App. */
export const createAppInputSchema = z.object({
  appId: appSlugSchema,
  displayName: z.string().trim().min(1).max(80),
  icon: z.string().min(1).max(8).optional(),
  executionMode: appExecutionModeSchema.optional(),
});
export type CreateAppInput = z.infer<typeof createAppInputSchema>;

/** Input to `PATCH /api/apps/:appId` — update mutable fields only. */
export const updateAppInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    icon: z.string().min(1).max(8).optional(),
    executionMode: appExecutionModeSchema.optional(),
    workingTreeStatus: appWorkingTreeStatusSchema.optional(),
  })
  .strict();
export type UpdateAppInput = z.infer<typeof updateAppInputSchema>;
