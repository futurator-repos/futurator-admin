/**
 * cdk-from-manifest.test.ts — Pipeline v2 Phase 2-D / Story 2-D-7-1 (PR-96).
 */

import { describe, it, expect } from 'vitest';
import {
  generateCdkStack,
  generateCdkBinEntrypoint,
  supportedServiceKinds,
} from '../cdk-from-manifest';
import { emptyAwsManifest, type AwsManifest } from '../../schemas/aws-manifest-schema';

function makeManifest(overrides: Partial<AwsManifest> = {}): AwsManifest {
  return { ...emptyAwsManifest('songster'), ...overrides };
}

describe('supportedServiceKinds', () => {
  it('returns sorted list of generators', () => {
    const kinds = supportedServiceKinds();
    expect(kinds).toContain('s3');
    expect(kinds).toContain('dynamodb');
    expect(kinds).toContain('lambda');
    expect(kinds).toContain('ecs-fargate');
    expect(kinds).toContain('bedrock-model-access');
    expect(kinds).toEqual([...kinds].sort());
  });
});

describe('generateCdkStack', () => {
  it('emits empty-stack note when env missing', () => {
    const stack = generateCdkStack(makeManifest(), 'dev');
    expect(stack).toContain("No 'dev' environment");
  });

  it('emits s3.Bucket for an s3 service entry', () => {
    const manifest = makeManifest({
      environments: { dev: { services: [{ kind: 's3', name: 'songster-stems-dev' }] } },
    });
    const stack = generateCdkStack(manifest, 'dev');
    expect(stack).toContain("new s3.Bucket(this, 'SongsterStemsDev'");
    expect(stack).toContain("bucketName: 'songster-stems-dev'");
    expect(stack).toContain('blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL');
  });

  it('emits dynamodb.Table with partition key', () => {
    const manifest = makeManifest({
      environments: {
        dev: {
          services: [{ kind: 'dynamodb', name: 'songster-sessions', 'partition-key': 'sessionId' }],
        },
      },
    });
    const stack = generateCdkStack(manifest, 'dev');
    expect(stack).toContain("new dynamodb.Table(this, 'SongsterSessions'");
    expect(stack).toContain("partitionKey: { name: 'sessionId'");
    expect(stack).toContain('BillingMode.PAY_PER_REQUEST');
    expect(stack).toContain('pointInTimeRecovery: true');
  });

  it('emits ecs-fargate service', () => {
    const manifest = makeManifest({
      environments: {
        dev: {
          services: [
            { kind: 'ecs-fargate', name: 'songster-api', cpu: 512, memory: 1024, desired: 2 },
          ],
        },
      },
    });
    const stack = generateCdkStack(manifest, 'dev');
    expect(stack).toContain('ecsPatterns.ApplicationLoadBalancedFargateService');
    expect(stack).toContain('cpu: 512');
    expect(stack).toContain('memoryLimitMiB: 1024');
    expect(stack).toContain('desiredCount: 2');
  });

  it('emits bedrock IAM policy with model ARNs', () => {
    const manifest = makeManifest({
      environments: {
        dev: {
          services: [
            {
              kind: 'bedrock-model-access',
              name: 'bedrock',
              models: [
                'anthropic.claude-sonnet-4-20250514-v1:0',
                'anthropic.claude-haiku-4-5-20251001-v1:0',
              ],
            },
          ],
        },
      },
    });
    const stack = generateCdkStack(manifest, 'dev');
    expect(stack).toContain('bedrock:InvokeModel');
    expect(stack).toContain('claude-sonnet-4-20250514-v1:0');
    expect(stack).toContain('claude-haiku-4-5-20251001-v1:0');
  });

  it('flags unsupported service kinds without crashing', () => {
    const manifest = makeManifest({
      environments: {
        dev: {
          // Force an unsupported kind through (it's bypass-typed in tests).
          services: [{ kind: 'eventbridge' as never, name: 'songster-bus' }],
        },
      },
    });
    const stack = generateCdkStack(manifest, 'dev');
    expect(stack).toContain('Unsupported service kinds');
    expect(stack).toContain('eventbridge (songster-bus)');
  });

  it('handles multi-service env', () => {
    const manifest = makeManifest({
      environments: {
        dev: {
          services: [
            { kind: 's3', name: 'a' },
            { kind: 'dynamodb', name: 'b', 'partition-key': 'pk' },
            { kind: 'lambda', name: 'c' },
          ],
        },
      },
    });
    const stack = generateCdkStack(manifest, 'dev');
    expect(stack).toContain('new s3.Bucket');
    expect(stack).toContain('new dynamodb.Table');
    expect(stack).toContain('new lambda.Function');
  });

  it('output is valid TypeScript-ish (no unbalanced braces)', () => {
    const manifest = makeManifest({
      environments: {
        dev: {
          services: [
            { kind: 's3', name: 'a' },
            { kind: 'dynamodb', name: 'b', 'partition-key': 'pk' },
          ],
        },
      },
    });
    const stack = generateCdkStack(manifest, 'dev');
    const opens = (stack.match(/\{/g) || []).length;
    const closes = (stack.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('class name follows <Project><Env>Stack convention', () => {
    const stack = generateCdkStack(
      makeManifest({ environments: { production: { services: [] } } }),
      'production',
    );
    expect(stack).toContain('export class SongsterProductionStack extends cdk.Stack');
  });
});

describe('generateCdkBinEntrypoint', () => {
  it('imports + instantiates each env stack', () => {
    const manifest = makeManifest({
      environments: {
        dev: { services: [] },
        staging: { services: [] },
        production: { services: [] },
      },
    });
    const bin = generateCdkBinEntrypoint(manifest);
    expect(bin).toContain("import { SongsterDevStack } from '../lib/songster-dev-stack';");
    expect(bin).toContain('new SongsterDevStack(app');
    expect(bin).toContain('new SongsterStagingStack(app');
    expect(bin).toContain('new SongsterProductionStack(app');
  });

  it('omits stack import for envs not in manifest', () => {
    const manifest = makeManifest({ environments: { dev: { services: [] } } });
    const bin = generateCdkBinEntrypoint(manifest);
    expect(bin).toContain('SongsterDevStack');
    expect(bin).not.toContain('SongsterProductionStack');
  });
});
