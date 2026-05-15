/**
 * architect-pipeline.test.ts — Pipeline v2 Phase 2-D / Story 2-D-6-1 (PR-90).
 */

import { describe, it, expect } from 'vitest';
import {
  generateArchitectPipeline,
  validateArchitectProposalBlock,
  AwsChangeSchema,
  IntegrationChangeSchema,
  SpeculationHintSchema,
} from '../architect-pipeline';

const BASE_ARGS = {
  trigger: 'T2' as const,
  projectSlug: 'dino-runner-1',
  planIntent: 'Add Stripe checkout',
  boilerplateKind: 'nextjs-base' as const,
  rigor: 'mvp' as const,
  currentAwsManifestYaml: 'project: dino-runner-1\nmanifest-version: 1\n',
  currentIntegrationsManifestYaml:
    'project: dino-runner-1\nmanifest-version: 1\nintegrations: []\n',
};

describe('generateArchitectPipeline', () => {
  it('builds a single-step pipeline with ARCHITECT agent', () => {
    const pipe = generateArchitectPipeline(BASE_ARGS);
    expect(Object.keys(pipe.agents)).toEqual(['ARCHITECT']);
    expect(pipe.steps).toHaveLength(1);
    expect(pipe.steps[0]?.id).toBe('architect-resolve');
  });

  it('ARCHITECT gets Sonnet on T2 by default', () => {
    const pipe = generateArchitectPipeline(BASE_ARGS);
    expect(pipe.agents.ARCHITECT?.model).toBe('sonnet');
  });

  it('ARCHITECT auto-picks Opus for T1 + empty manifest (greenfield)', () => {
    const pipe = generateArchitectPipeline({
      ...BASE_ARGS,
      trigger: 'T1',
      currentAwsManifestYaml: '',
    });
    expect(pipe.agents.ARCHITECT?.model).toBe('opus');
  });

  it('honors explicit model override', () => {
    const pipe = generateArchitectPipeline({ ...BASE_ARGS, model: 'haiku' });
    expect(pipe.agents.ARCHITECT?.model).toBe('haiku');
  });

  it('allowedTools include Bash + Read + Grep + Glob', () => {
    const pipe = generateArchitectPipeline(BASE_ARGS);
    const allowed = pipe.agents.ARCHITECT?.allowedTools ?? '';
    expect(allowed).toContain('Bash');
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Grep');
    expect(allowed).toContain('Glob');
  });

  it('disallowedTools include Write + Edit + NotebookEdit + baseline deny', () => {
    const pipe = generateArchitectPipeline(BASE_ARGS);
    const disallowed = pipe.agents.ARCHITECT?.disallowedTools ?? '';
    expect(disallowed).toContain('Write');
    expect(disallowed).toContain('Edit');
    expect(disallowed).toContain('NotebookEdit');
    expect(disallowed).toContain('WebFetch');
  });

  it('maxTurns from rigor matrix', () => {
    expect(
      generateArchitectPipeline({ ...BASE_ARGS, rigor: 'prototype' }).agents.ARCHITECT?.maxTurns,
    ).toBe(4);
    expect(generateArchitectPipeline(BASE_ARGS).agents.ARCHITECT?.maxTurns).toBe(6);
    expect(
      generateArchitectPipeline({ ...BASE_ARGS, rigor: 'production' }).agents.ARCHITECT?.maxTurns,
    ).toBe(8);
  });

  it('prompt includes trigger + project + intent for T2', () => {
    const pipe = generateArchitectPipeline(BASE_ARGS);
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).toContain('TRIGGER: T2');
    expect(prompt).toContain('dino-runner-1');
    expect(prompt).toContain('Add Stripe checkout');
  });

  it('prompt includes scan block on T3', () => {
    const pipe = generateArchitectPipeline({
      ...BASE_ARGS,
      trigger: 'T3',
      brownfieldResourceScan: 'arn:aws:s3:::songster-existing-bucket',
    });
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).toContain('BROWNFIELD RESOURCE SCAN');
    expect(prompt).toContain('songster-existing-bucket');
  });

  it('step extractor captures between ARCHITECT_PROPOSAL markers', () => {
    const pipe = generateArchitectPipeline(BASE_ARGS);
    const ex = pipe.steps[0]?.extractors?.ARCHITECT_PROPOSAL_JSON;
    expect((ex as { startDelimiter: string }).startDelimiter).toBe('---ARCHITECT_PROPOSAL---');
  });
});

describe('validateArchitectProposalBlock', () => {
  it('parses a well-formed proposal', () => {
    const raw = JSON.stringify({
      trigger: 'T2',
      projectSlug: 'dino',
      awsChanges: [
        {
          kind: 'add',
          scope: 'environments.dev',
          service: { kind: 'dynamodb', name: 'dino-sessions' },
          rationale: 'session store',
          monthlyCostUsd: 0.5,
          'implies-skills': [],
          confidence: 0.8,
        },
      ],
      integrationChanges: [],
      speculations: [],
    });
    const result = validateArchitectProposalBlock(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.awsChanges).toHaveLength(1);
    }
  });

  it('accepts empty arrays (no proposal warranted)', () => {
    const raw = JSON.stringify({
      trigger: 'T2',
      projectSlug: 'dino',
      awsChanges: [],
      integrationChanges: [],
      speculations: [],
    });
    expect(validateArchitectProposalBlock(raw).ok).toBe(true);
  });

  it('rejects unknown trigger', () => {
    const raw = JSON.stringify({
      trigger: 'T9',
      projectSlug: 'x',
      awsChanges: [],
      integrationChanges: [],
      speculations: [],
    });
    expect(validateArchitectProposalBlock(raw).ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    expect(validateArchitectProposalBlock('{not json').ok).toBe(false);
  });

  it('rejects unknown awsChange.scope', () => {
    const raw = JSON.stringify({
      trigger: 'T2',
      projectSlug: 'x',
      awsChanges: [
        {
          kind: 'add',
          scope: 'environments.preview',
          service: {},
          rationale: 'r',
          monthlyCostUsd: 0,
          confidence: 0.5,
        },
      ],
      integrationChanges: [],
      speculations: [],
    });
    expect(validateArchitectProposalBlock(raw).ok).toBe(false);
  });

  it('rejects speculation with < 2 approaches', () => {
    const raw = JSON.stringify({
      trigger: 'T2',
      projectSlug: 'x',
      awsChanges: [],
      integrationChanges: [],
      speculations: [
        {
          id: 's1',
          description: 'lambda vs fargate',
          approaches: [{ id: 'l', description: 'lambda', 'rough-monthlyCostUsd': 1 }],
        },
      ],
    });
    expect(validateArchitectProposalBlock(raw).ok).toBe(false);
  });
});

describe('sub-schema sanity', () => {
  it('AwsChangeSchema validates independently', () => {
    expect(
      AwsChangeSchema.safeParse({
        kind: 'remove',
        scope: 'environments.production',
        service: { kind: 's3', name: 'old-bucket' },
        rationale: 'unused',
        monthlyCostUsd: 0,
        confidence: 0.6,
      }).success,
    ).toBe(true);
  });

  it('IntegrationChangeSchema validates independently', () => {
    expect(
      IntegrationChangeSchema.safeParse({
        kind: 'add',
        integration: { id: 'stripe', vendor: 'stripe', purpose: 'payments' },
        rationale: 'r',
        confidence: 0.9,
      }).success,
    ).toBe(true);
  });

  it('SpeculationHintSchema validates independently', () => {
    expect(
      SpeculationHintSchema.safeParse({
        id: 'compute-shape',
        description: 'Lambda vs ECS',
        approaches: [
          { id: 'lambda', description: 'serverless', 'rough-monthlyCostUsd': 5 },
          { id: 'ecs', description: 'fargate', 'rough-monthlyCostUsd': 30 },
        ],
      }).success,
    ).toBe(true);
  });
});
