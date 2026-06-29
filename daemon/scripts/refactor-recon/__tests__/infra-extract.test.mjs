/**
 * infra-extract.test.mjs — locks the Infrastructure inventory: AWS service
 * detection, db/ai/3rd-party classification with residency, IaC detection, and
 * the `external` list that feeds the compliance / EU-AI-Act authorities.
 */

import { describe, it, expect } from 'vitest';
import { buildInfraInventory, detectAwsService } from '../infra-extract.mjs';

describe('detectAwsService', () => {
  it('maps @aws-sdk/client-* to services + categories', () => {
    expect(detectAwsService('@aws-sdk/client-dynamodb')).toMatchObject({ service: 'DynamoDB', category: 'database', dataStore: true });
    expect(detectAwsService('@aws-sdk/lib-dynamodb')).toMatchObject({ service: 'DynamoDB' });
    expect(detectAwsService('@aws-sdk/client-cloudfront')).toMatchObject({ service: 'CloudFront', category: 'network/cdn' });
    expect(detectAwsService('@aws-sdk/client-lambda')).toMatchObject({ service: 'Lambda', category: 'compute' });
    expect(detectAwsService('@aws-sdk/client-cognito-identity-provider')).toMatchObject({ service: 'Cognito', dataStore: true });
    expect(detectAwsService('react')).toBeNull();
  });
});

describe('buildInfraInventory', () => {
  const files = [
    { rel: 'src/db/users.ts', specifiers: ['@aws-sdk/client-dynamodb'], isClient: false },
    { rel: 'src/lib/storage.ts', specifiers: ['@aws-sdk/client-s3'], isClient: false },
    { rel: 'src/lib/ai/claude.ts', specifiers: ['@anthropic-ai/sdk'], isClient: false },
    { rel: 'src/lib/ai/bedrock.ts', specifiers: ['@aws-sdk/client-bedrock-runtime'], isClient: false },
    { rel: 'src/app/page.tsx', specifiers: ['openai'], isClient: true },
    { rel: 'src/lib/auth.ts', specifiers: ['next-auth'], isClient: false },
    { rel: 'sst.config.ts', specifiers: [], isClient: false },
  ];

  it('inventories AWS services, databases, AI, 3rd-party, and IaC', () => {
    const inv = buildInfraInventory(files);
    expect(inv.aws.map((a) => a.service).sort()).toEqual(['Bedrock', 'DynamoDB', 'S3']);
    expect(inv.ai.map((a) => a.provider).sort()).toEqual(['Anthropic (Claude API)', 'OpenAI']);
    expect(inv.thirdParty.some((t) => /Auth0|NextAuth/.test(t.provider))).toBe(true);
    expect(inv.iac.some((i) => i.provider === 'SST')).toBe(true);
    expect(inv.summary.dataStoreCount).toBeGreaterThanOrEqual(2); // DynamoDB + S3
  });

  it('residency-aware: Bedrock in-account, Claude/OpenAI external', () => {
    const inv = buildInfraInventory(files);
    const bedrock = inv.aws.find((a) => a.service === 'Bedrock');
    expect(bedrock.residency).toBe('in-account');
    const claude = inv.ai.find((a) => a.provider === 'Anthropic (Claude API)');
    expect(claude.external).toBe(true);
  });

  it('builds the `external` list (what feeds GDPR transfers + EU AI Act)', () => {
    const inv = buildInfraInventory(files);
    const providers = inv.external.map((e) => e.provider).sort();
    // Claude + OpenAI are external AI; NextAuth external 3rd-party. Bedrock (in-account) excluded.
    expect(providers).toContain('Anthropic (Claude API)');
    expect(providers).toContain('OpenAI');
    expect(inv.external.every((e) => e.provider !== 'Bedrock')).toBe(true);
    expect(inv.summary.externalProcessorCount).toBe(inv.external.length);
  });

  it('counts the client/server boundary (front-end ↔ infra security surface)', () => {
    const inv = buildInfraInventory(files);
    expect(inv.boundaries.clientFiles).toBe(1); // page.tsx
    expect(inv.boundaries.serverFiles).toBe(6);
    expect(inv.boundaries.externalTouchingFiles).toBeGreaterThanOrEqual(1); // page.tsx imports openai
  });
});
