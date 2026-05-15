/**
 * aws-manifest-schema.test.ts — Pipeline v2 Phase 2-D / Story 2-D-2-1 (PR-88).
 */

import { describe, it, expect } from 'vitest';
import {
  AwsManifestSchema,
  emptyAwsManifest,
  hasProductionDeployGate,
  hasProductionSoakScript,
} from '../aws-manifest-schema';

describe('AwsManifestSchema', () => {
  it('parses the empty-manifest skeleton', () => {
    const result = AwsManifestSchema.safeParse(emptyAwsManifest('dino-runner-1'));
    expect(result.success).toBe(true);
  });

  it('parses the v2.5 §25 Songster illustrative manifest', () => {
    const manifest = {
      project: 'songster',
      'manifest-version': 1,
      'generated-by': 'architect@v2.5',
      'last-resolved': '2026-04-26T14:00:00Z',
      'aws-organization': 'futurator',
      'account-strategy': 'shared',
      'primary-region': 'eu-central-1',
      'us-east-1-cert-only': true,
      iac: {
        tool: 'cdk',
        language: 'typescript',
        version: '^2.140.0',
        'bootstrap-qualifier': 'futurator',
        'app-entrypoint': 'deployment/cdk/bin/songster.ts',
      },
      shared: {
        vpc: { strategy: 'shared', subnets: { mode: 'dedicated-subnets' } },
        ecr: { repos: ['songster-api', 'songster-stems-worker'] },
        'secrets-namespace': '/futurator/songster',
      },
      environments: {
        dev: {
          domain: 'songster-dev.futurator.ai',
          'cdk-stacks': ['SongsterSharedStack', 'SongsterDevStack'],
          services: [
            { kind: 'ecs-fargate', name: 'songster-api', cpu: 512, memory: 1024, desired: 1 },
            { kind: 'dynamodb', name: 'songster-sessions', 'partition-key': 'sessionId' },
            { kind: 's3', name: 'songster-stems-dev' },
            {
              kind: 'bedrock-model-access',
              name: 'songster-bedrock',
              models: ['anthropic.claude-sonnet-4-20250514-v1:0'],
            },
          ],
        },
        production: {
          domain: 'songster.futurator.ai',
          'cdk-stacks': ['SongsterSharedStack', 'SongsterProdStack'],
          'deploy-gate': {
            requires: [
              'all-tests-pass',
              'security-audit-clean',
              '24h-staging-soak',
              'operator-approval',
            ],
          },
          'soak-script': 'scripts/soak.sh',
        },
      },
      'webhook-handler-default': 'lambda',
      'cost-envelope': {
        dev: { 'monthly-usd-max': 80 },
        production: { 'monthly-usd-max': 600, 'alert-at': 480 },
        'hard-cap-action': 'page-operator',
      },
      'drift-policy': { detection: 'weekly', 'on-drift': 'file-attention-item' },
    };
    const result = AwsManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects manifest-version != 1', () => {
    const m = { ...emptyAwsManifest('x'), 'manifest-version': 2 };
    expect(AwsManifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects unknown iac.tool', () => {
    const m = emptyAwsManifest('x');
    m.iac.tool = 'opentofu' as never;
    expect(AwsManifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects unknown service kind', () => {
    const m: ReturnType<typeof emptyAwsManifest> = {
      ...emptyAwsManifest('x'),
      environments: {
        dev: {
          services: [{ kind: 'cosmic-database' as never, name: 'oops' }],
        },
      },
    };
    expect(AwsManifestSchema.safeParse(m).success).toBe(false);
  });

  it('accepts service entries with arbitrary kind-specific fields', () => {
    const m: ReturnType<typeof emptyAwsManifest> = {
      ...emptyAwsManifest('x'),
      environments: {
        dev: {
          services: [
            {
              kind: 'ecs-fargate-gpu',
              name: 'stems-worker',
              gpu: 1,
              cpu: 4096,
              memory: 16384,
            },
          ],
        },
      },
    };
    expect(AwsManifestSchema.safeParse(m).success).toBe(true);
  });

  it('defaults webhook-handler-default to lambda', () => {
    const m: Record<string, unknown> = { ...emptyAwsManifest('x') };
    delete (m as { 'webhook-handler-default'?: unknown })['webhook-handler-default'];
    const result = AwsManifestSchema.safeParse(m);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data['webhook-handler-default']).toBe('lambda');
  });

  it('defaults account-strategy to shared', () => {
    const m: Record<string, unknown> = { ...emptyAwsManifest('x') };
    delete (m as { 'account-strategy'?: unknown })['account-strategy'];
    const result = AwsManifestSchema.safeParse(m);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data['account-strategy']).toBe('shared');
  });

  it('defaults drift-policy on-drift to file-attention-item', () => {
    const m = { ...emptyAwsManifest('x'), 'drift-policy': { detection: 'weekly' as const } };
    const result = AwsManifestSchema.safeParse(m);
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data['drift-policy']?.['on-drift']).toBe('file-attention-item');
  });
});

describe('emptyAwsManifest', () => {
  it('passes its own schema', () => {
    expect(AwsManifestSchema.safeParse(emptyAwsManifest('dino')).success).toBe(true);
  });

  it('uses eu-central-1 default region (GDPR)', () => {
    expect(emptyAwsManifest('x')['primary-region']).toBe('eu-central-1');
  });

  it('uses futurator CDK bootstrap qualifier', () => {
    expect(emptyAwsManifest('x').iac['bootstrap-qualifier']).toBe('futurator');
  });
});

describe('hasProductionDeployGate', () => {
  it('returns false when production env missing', () => {
    expect(hasProductionDeployGate(emptyAwsManifest('x'))).toBe(false);
  });

  it('returns true when production deploy-gate has requirements', () => {
    const m: ReturnType<typeof emptyAwsManifest> = {
      ...emptyAwsManifest('x'),
      environments: {
        production: { 'deploy-gate': { requires: ['all-tests-pass'] } },
      },
    };
    expect(hasProductionDeployGate(m)).toBe(true);
  });
});

describe('hasProductionSoakScript', () => {
  it('returns true when production env has soak-script set', () => {
    const m: ReturnType<typeof emptyAwsManifest> = {
      ...emptyAwsManifest('x'),
      environments: { production: { 'soak-script': 'scripts/soak.sh' } },
    };
    expect(hasProductionSoakScript(m)).toBe(true);
  });

  it('returns false when missing', () => {
    expect(hasProductionSoakScript(emptyAwsManifest('x'))).toBe(false);
  });
});
