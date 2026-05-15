/**
 * aws-manifest-schema.ts — Pipeline v2 Phase 2-D / Story 2-D-2-1 (PR-88).
 *
 * Zod schema for `<project>/.deployment/aws.manifest.yaml` per v2.5 §25.
 * The manifest is the **declared state**; CDK in `deployment/cdk/` is the
 * derived state (generated from this manifest by COMPILER in Phase 2-D
 * Story 2-D-7).
 *
 * This file is the contract for:
 *   - ARCHITECT agent (Story 2-D-6) — reads/writes the manifest
 *   - 3-S-2 24h soak — reads `environments.production.deploy-gate.requires`
 *   - 3-S-3 drift detection — reads `drift-policy`
 *   - 3-F brownfield audit — emits an initial manifest from existing AWS state
 *   - Cost engine — reads `cost-envelope`
 *
 * Schema is deliberately permissive (`passthrough()`) on service entries
 * because the v2.5 §25 illustrative example shows ad-hoc kind-specific
 * fields (gpu, scale-to-zero, etc.) — formally specifying every AWS
 * service is out of scope for the Zod layer; ARCHITECT validates at
 * apply time.
 */

import { z } from 'zod';

// ── Sub-schemas ──────────────────────────────────────────────────────────

const accountStrategySchema = z.enum(['shared', 'dedicated']);

const iacSchema = z.object({
  tool: z.enum(['cdk', 'terraform', 'pulumi', 'sst', 'sam']),
  language: z.enum(['typescript', 'python', 'go', 'csharp']).default('typescript'),
  version: z.string().min(1),
  'bootstrap-qualifier': z.string().min(1).default('futurator'),
  'app-entrypoint': z.string().min(1),
});

const sharedBlockSchema = z
  .object({
    vpc: z
      .object({
        strategy: z.enum(['shared', 'dedicated']),
        subnets: z
          .object({
            'project-prefix': z.string().optional(),
            mode: z.enum(['shared-subnets', 'dedicated-subnets']).optional(),
          })
          .partial()
          .optional(),
        'security-group-prefix': z.string().optional(),
      })
      .partial()
      .optional(),
    ecr: z
      .object({
        repos: z.array(z.string()).default([]),
      })
      .optional(),
    'secrets-namespace': z.string().optional(),
  })
  .partial();

/**
 * Service entry — kind tag + arbitrary kind-specific fields. ARCHITECT
 * branches on `kind` at apply time; the schema only enforces the kind
 * enum + required `name`. Per-kind validation lives in the CDK
 * generators (Phase 2-D Story 2-D-7).
 */
const serviceEntrySchema = z
  .object({
    kind: z.enum([
      'ecs-fargate',
      'ecs-fargate-gpu',
      'dynamodb',
      's3',
      'lambda',
      'api-gateway',
      'cloudfront',
      'bedrock-model-access',
      'secrets-manager',
      'sqs',
      'sns',
      'eventbridge',
      'rds',
      'cognito',
    ]),
    name: z.string().min(1),
  })
  .passthrough();

const deployGateSchema = z.object({
  requires: z.array(z.string()).default([]),
});

const environmentSchema = z
  .object({
    domain: z.string().optional(),
    'cdk-stacks': z.array(z.string()).default([]),
    services: z.array(serviceEntrySchema).default([]),
    'deploy-gate': deployGateSchema.optional(),
    /** Optional in dev/staging; required at production rigor for 3-S-2 soak. */
    'soak-script': z.string().optional(),
  })
  .partial();

const costEnvelopeBlockSchema = z
  .object({
    'monthly-usd-max': z.number().positive(),
    'alert-at': z.number().positive().optional(),
  })
  .partial();

const costEnvelopeSchema = z
  .object({
    dev: costEnvelopeBlockSchema.optional(),
    staging: costEnvelopeBlockSchema.optional(),
    production: costEnvelopeBlockSchema.optional(),
    'hard-cap-action': z.enum(['page-operator', 'pause-deploys', 'log-only']).default('log-only'),
  })
  .partial();

const driftPolicySchema = z.object({
  detection: z.enum(['weekly', 'daily', 'on-deploy']).default('weekly'),
  /** v2.5 §25 forbids auto-revert; default is `file-attention-item`. */
  'on-drift': z.enum(['file-attention-item', 'page-operator']).default('file-attention-item'),
});

// ── Top-level manifest schema ────────────────────────────────────────────

export const AwsManifestSchema = z.object({
  project: z.string().min(1),
  'manifest-version': z.literal(1),
  'generated-by': z.string().min(1),
  'last-resolved': z.string().datetime().optional(),

  'aws-organization': z.string().optional(),
  'account-strategy': accountStrategySchema.default('shared'),
  'account-id': z.string().optional(),
  'account-role-arn': z.string().optional(),

  'primary-region': z.string().min(1),
  'us-east-1-cert-only': z.boolean().default(false),

  iac: iacSchema,
  shared: sharedBlockSchema.optional(),
  environments: z
    .object({
      dev: environmentSchema.optional(),
      staging: environmentSchema.optional(),
      production: environmentSchema.optional(),
    })
    .partial()
    .default({}),

  'webhook-handler-default': z.enum(['lambda', 'ecs']).default('lambda'),
  'cost-envelope': costEnvelopeSchema.optional(),
  'drift-policy': driftPolicySchema.optional(),
});

export type AwsManifest = z.infer<typeof AwsManifestSchema>;
export type AwsServiceEntry = z.infer<typeof serviceEntrySchema>;
export type AwsEnvironment = z.infer<typeof environmentSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal manifest skeleton for a fresh project. ARCHITECT T1 fills in
 * the rest at project init; this is the "no AWS resources yet" baseline.
 */
export function emptyAwsManifest(projectSlug: string): AwsManifest {
  return {
    project: projectSlug,
    'manifest-version': 1,
    'generated-by': 'bootstrap@v2.5',
    'account-strategy': 'shared',
    'primary-region': 'eu-central-1',
    'us-east-1-cert-only': false,
    iac: {
      tool: 'cdk',
      language: 'typescript',
      version: '^2.140.0',
      'bootstrap-qualifier': 'futurator',
      'app-entrypoint': `deployment/cdk/bin/${projectSlug}.ts`,
    },
    environments: {},
    'webhook-handler-default': 'lambda',
  };
}

/** Whether a manifest has a production environment with a non-empty deploy-gate. */
export function hasProductionDeployGate(manifest: AwsManifest): boolean {
  const prodEnv = manifest.environments?.production;
  if (!prodEnv) return false;
  const requires = prodEnv['deploy-gate']?.requires;
  return Array.isArray(requires) && requires.length > 0;
}

/** Whether a manifest has a soak script registered for production. */
export function hasProductionSoakScript(manifest: AwsManifest): boolean {
  return Boolean(manifest.environments?.production?.['soak-script']);
}
