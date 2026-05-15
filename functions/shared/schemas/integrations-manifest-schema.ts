/**
 * integrations-manifest-schema.ts — Pipeline v2 Phase 2-D / Story 2-D-3-1 (PR-89).
 *
 * Zod schema for `<project>/.deployment/integrations.manifest.yaml` per
 * v2.5 §26. Sibling to `aws.manifest.yaml`, intentionally looser per
 * v2.5 §26.1 — third-party vendor configs change shape unpredictably
 * (Stripe rotates auth styles, Moises adds endpoint variants) and the
 * schema accepts ad-hoc fields via `passthrough()` on the integration
 * body.
 *
 * Strict where it matters:
 *   - `id` slug constraint (kebab-case)
 *   - `vendor` string required
 *   - `secret-path` shape — `/futurator/<project>/{env}/<service>/<key>` template
 *   - `rotation-cadence` enum (matches v2.5 §26.5 rotation cadence table)
 *
 * Loose elsewhere — `endpoints` is a string→string map; per-vendor
 * specifics live in the wrapper skills (Phase 3-C federation).
 */

import { z } from 'zod';

const SLUG_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

const rotationCadenceSchema = z.enum(['30d', '60d', '90d', '180d', '365d', 'on-deploy', 'never']);

const integrationEntrySchema = z
  .object({
    id: z.string().regex(SLUG_RE, { message: 'id must be kebab-case slug' }),
    vendor: z.string().min(1),
    purpose: z.string().min(1),
    'rigor-min': z.enum(['prototype', 'mvp', 'production']).default('prototype'),
    /** Path template — accepts `{env}` placeholder. */
    'secret-path': z
      .string()
      .regex(
        /^\/futurator\/[a-z][a-z0-9-]*\/(\{env\}|[a-z][a-z0-9-]*)\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/,
        {
          message:
            'secret-path must match /futurator/<project>/{env|dev|staging|production}/<service>/<key>',
        },
      ),
    'rotation-cadence': rotationCadenceSchema.optional(),
    endpoints: z.record(z.string(), z.string()).default({}),
    /** Optional webhook config for inbound vendor events (v2.5 §26.4). */
    webhook: z
      .object({
        path: z.string().min(1),
        events: z.array(z.string()).default([]),
        'signature-header': z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

export const IntegrationsManifestSchema = z.object({
  project: z.string().min(1),
  'manifest-version': z.literal(1),
  'rotation-cadence-default': rotationCadenceSchema.default('90d'),
  integrations: z.array(integrationEntrySchema).default([]),
});

export type IntegrationsManifest = z.infer<typeof IntegrationsManifestSchema>;
export type IntegrationEntry = z.infer<typeof integrationEntrySchema>;
export type RotationCadence = z.infer<typeof rotationCadenceSchema>;

/** Empty manifest scaffold for a fresh project. */
export function emptyIntegrationsManifest(projectSlug: string): IntegrationsManifest {
  return {
    project: projectSlug,
    'manifest-version': 1,
    'rotation-cadence-default': '90d',
    integrations: [],
  };
}

/**
 * Resolve effective rotation cadence per v2.5 §26.5: integration's own
 * override wins; else the manifest-level default.
 */
export function effectiveRotationCadence(
  integration: IntegrationEntry,
  manifest: IntegrationsManifest,
): RotationCadence {
  return integration['rotation-cadence'] ?? manifest['rotation-cadence-default'];
}

/**
 * Expand `{env}` placeholder in a secret-path template against a concrete
 * environment name.
 */
export function resolveSecretPath(template: string, env: string): string {
  return template.replace(/\{env\}/g, env);
}
