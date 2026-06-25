/**
 * privacy-detectors.test.mjs — locks the shared detection tables used by BOTH
 * the internal privacy scanner AND the graph role-tagging (one source of truth).
 *
 * Invariants:
 *   1. residency-aware AI detection (Claude API external vs Bedrock in-account)
 *   2. db / infra / thirdParty import classification
 *   3. path-based IaC detection (.tf, sst.config, schema.prisma…)
 *   4. classifyFile merges path + specifier detections, deduped
 *   5. primaryRole precedence: infra > db > ai > thirdParty
 */

import { describe, it, expect } from 'vitest';
import {
  classifyImport,
  classifyPath,
  classifyFile,
  primaryRole,
} from '../privacy-detectors.mjs';

describe('classifyImport — AI residency awareness', () => {
  it('flags Anthropic Claude API as external', () => {
    expect(classifyImport('@anthropic-ai/sdk')).toMatchObject({
      kind: 'ai',
      residency: 'external',
    });
    expect(classifyImport('anthropic')).toMatchObject({ kind: 'ai', residency: 'external' });
  });

  it('flags AWS Bedrock as in-account (stays in the operator cloud)', () => {
    expect(classifyImport('@aws-sdk/client-bedrock-runtime')).toMatchObject({
      kind: 'ai',
      residency: 'in-account',
    });
  });

  it('flags OpenAI as external', () => {
    expect(classifyImport('openai')).toMatchObject({ kind: 'ai', residency: 'external' });
  });
});

describe('classifyImport — db / infra / thirdParty', () => {
  it('classifies databases', () => {
    expect(classifyImport('@aws-sdk/client-dynamodb')?.kind).toBe('db');
    expect(classifyImport('@prisma/client')?.kind).toBe('db');
    expect(classifyImport('@supabase/supabase-js')).toMatchObject({
      kind: 'db',
      residency: 'external',
    });
  });

  it('classifies IaC packages as infra', () => {
    expect(classifyImport('@pulumi/aws')?.kind).toBe('infra');
    expect(classifyImport('sst')?.kind).toBe('infra');
    expect(classifyImport('aws-cdk-lib')?.kind).toBe('infra');
  });

  it('classifies 3rd-party / analytics services', () => {
    expect(classifyImport('stripe')?.kind).toBe('thirdParty');
    expect(classifyImport('posthog-js')?.kind).toBe('thirdParty');
    expect(classifyImport('@clerk/nextjs')?.kind).toBe('thirdParty');
  });

  it('returns null for an unknown / benign import', () => {
    expect(classifyImport('react')).toBeNull();
    expect(classifyImport('lodash')).toBeNull();
  });
});

describe('classifyPath — IaC + schema files', () => {
  it('detects terraform / pulumi / sst / serverless / prisma by path', () => {
    expect(classifyPath('infra/main.tf')).toMatchObject({ kind: 'infra' });
    expect(classifyPath('Pulumi.prod.yaml')).toMatchObject({ kind: 'infra' });
    expect(classifyPath('sst.config.ts')).toMatchObject({ kind: 'infra' });
    expect(classifyPath('serverless.yml')).toMatchObject({ kind: 'infra' });
    expect(classifyPath('prisma/schema.prisma')).toMatchObject({ kind: 'db' });
  });

  it('returns null for an ordinary source file', () => {
    expect(classifyPath('src/components/button.tsx')).toBeNull();
  });
});

describe('classifyFile — merge + dedup', () => {
  it('merges path detection with specifier detections', () => {
    const { kinds, detections } = classifyFile('sst.config.ts', [
      '@anthropic-ai/sdk',
      '@aws-sdk/client-dynamodb',
    ]);
    expect(kinds.sort()).toEqual(['ai', 'db', 'infra']);
    expect(detections).toHaveLength(3);
  });

  it('dedups repeated providers', () => {
    const { detections } = classifyFile('x.ts', ['openai', 'openai', '@openai/foo']);
    // both map to the OpenAI provider → one detection
    expect(detections.filter((d) => d.provider === 'OpenAI')).toHaveLength(1);
  });

  it('yields no detections for a benign file', () => {
    const { kinds, detections } = classifyFile('src/util.ts', ['react', 'clsx']);
    expect(kinds).toEqual([]);
    expect(detections).toEqual([]);
  });
});

describe('primaryRole precedence', () => {
  it('infra > db > ai > thirdParty', () => {
    expect(primaryRole(['thirdParty', 'ai', 'db', 'infra'])).toBe('infra');
    expect(primaryRole(['thirdParty', 'ai', 'db'])).toBe('db');
    expect(primaryRole(['thirdParty', 'ai'])).toBe('ai');
    expect(primaryRole(['thirdParty'])).toBe('thirdParty');
    expect(primaryRole([])).toBeNull();
  });
});
