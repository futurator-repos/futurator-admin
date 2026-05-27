/**
 * skill-scout-pipeline.test.ts — Pipeline v2 Phase 3 / Story 3-C-3-1.
 */

import { describe, it, expect } from 'vitest';
import {
  generateSkillScoutPipeline,
  validateSkillProposalsBlock,
  stripToJsonObject,
  SkillProposalSchema,
} from '../skill-scout-pipeline';

const SHA = 'a'.repeat(40);

const BASE_ARGS = {
  trigger: 'T1' as const,
  projectSlug: 'dino-runner-1',
  boilerplateKind: 'nextjs-base' as const,
  rigor: 'mvp' as const,
  currentManifestYaml: 'project: dino-runner-1\nmanifest-version: 1\ncore: []\n',
  federationYaml: 'manifest-version: 1\nsources: []\nrefresh-cadence: weekly\n',
};

describe('generateSkillScoutPipeline', () => {
  it('builds a single-step pipeline with the SKILL_SCOUT agent', () => {
    const pipe = generateSkillScoutPipeline(BASE_ARGS);
    expect(Object.keys(pipe.agents)).toEqual(['SKILL_SCOUT']);
    expect(pipe.steps).toHaveLength(1);
    expect(pipe.steps[0]?.id).toBe('skill-scout-resolve');
    expect(pipe.steps[0]?.agentId).toBe('SKILL_SCOUT');
  });

  it('SKILL_SCOUT agent gets Sonnet by default', () => {
    const pipe = generateSkillScoutPipeline(BASE_ARGS);
    expect(pipe.agents.SKILL_SCOUT?.model).toBe('sonnet');
  });

  it('SKILL_SCOUT agent uses Opus when model override set', () => {
    const pipe = generateSkillScoutPipeline({ ...BASE_ARGS, model: 'opus' });
    expect(pipe.agents.SKILL_SCOUT?.model).toBe('opus');
  });

  it('allowedTools include Bash + Read + Grep + Glob', () => {
    const pipe = generateSkillScoutPipeline(BASE_ARGS);
    const allowed = pipe.agents.SKILL_SCOUT?.allowedTools ?? '';
    expect(allowed).toContain('Bash');
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Grep');
    expect(allowed).toContain('Glob');
  });

  it('disallowedTools include Write + Edit + NotebookEdit + baseline deny', () => {
    const pipe = generateSkillScoutPipeline(BASE_ARGS);
    const disallowed = pipe.agents.SKILL_SCOUT?.disallowedTools ?? '';
    expect(disallowed).toContain('Write');
    expect(disallowed).toContain('Edit');
    expect(disallowed).toContain('NotebookEdit');
    expect(disallowed).toContain('Task');
    expect(disallowed).toContain('Agent');
    expect(disallowed).toContain('WebFetch');
    expect(disallowed).toContain('WebSearch');
  });

  it('maxTurns from rigor matrix: prototype=4 / mvp=6 / production=8', () => {
    const proto = generateSkillScoutPipeline({ ...BASE_ARGS, rigor: 'prototype' });
    const mvp = generateSkillScoutPipeline(BASE_ARGS);
    const prod = generateSkillScoutPipeline({ ...BASE_ARGS, rigor: 'production' });
    expect(proto.agents.SKILL_SCOUT?.maxTurns).toBe(4);
    expect(mvp.agents.SKILL_SCOUT?.maxTurns).toBe(6);
    expect(prod.agents.SKILL_SCOUT?.maxTurns).toBe(8);
  });

  it('step extractor captures between SKILL_PROPOSALS markers', () => {
    const pipe = generateSkillScoutPipeline(BASE_ARGS);
    const ex = pipe.steps[0]?.extractors?.SKILL_PROPOSALS_JSON;
    expect(ex?.type).toBe('between');
    expect((ex as { startDelimiter: string }).startDelimiter).toBe('---SKILL_PROPOSALS---');
    expect((ex as { endDelimiter: string }).endDelimiter).toBe('---END_SKILL_PROPOSALS---');
  });

  it('prompt includes trigger guidance + project slug + intent for T2', () => {
    const pipe = generateSkillScoutPipeline({
      ...BASE_ARGS,
      trigger: 'T2',
      planIntent: 'Add Stripe checkout',
    });
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).toContain('TRIGGER: T2');
    expect(prompt).toContain('dino-runner-1');
    expect(prompt).toContain('Add Stripe checkout');
    expect(prompt).toContain('Plan intent submitted');
  });

  it('prompt omits PLAN INTENT block when planIntent absent (T1/T3)', () => {
    const pipe = generateSkillScoutPipeline({ ...BASE_ARGS, trigger: 'T1' });
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).not.toContain('PLAN INTENT (T2):');
  });
});

describe('validateSkillProposalsBlock', () => {
  it('parses a well-formed proposal block', () => {
    const raw = JSON.stringify({
      trigger: 'T1',
      projectSlug: 'dino-runner-1',
      proposals: [
        {
          kind: 'add',
          source: 'anthropic-official',
          skill: 'frontend-design',
          manifestBucket: 'core',
          version: `sha:${SHA}`,
          rationale: 'Core formatting primitive every project needs.',
          verifyNotes: 'MIT licence; description specific; no manifest collision.',
          confidence: 0.95,
        },
      ],
    });
    const result = validateSkillProposalsBlock(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.proposals).toHaveLength(1);
      expect(result.output.proposals[0].skill).toBe('frontend-design');
    }
  });

  it('accepts empty proposals array (no card surfaces)', () => {
    const raw = JSON.stringify({
      trigger: 'T2',
      projectSlug: 'dino-runner-1',
      proposals: [],
    });
    const result = validateSkillProposalsBlock(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.proposals).toHaveLength(0);
  });

  it('rejects malformed JSON', () => {
    const result = validateSkillProposalsBlock('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/JSON parse/);
  });

  // 2026-05-27 (brick-breaker-11 Bug 2) — the daemon `between` extractor
  // slices [startDelimiter .. endDelimiter] INCLUSIVE, so the validator
  // receives `---SKILL_PROPOSALS---\n{...}\n---END_SKILL_PROPOSALS---`.
  // Pre-fix this failed with "No number after minus sign at position 1".
  it('tolerates the inclusive between-extractor delimiter framing (Bug 2 regression)', () => {
    const inner = JSON.stringify({
      trigger: 'T1',
      projectSlug: 'brick-breaker-11',
      proposals: [
        {
          kind: 'add',
          source: 'anthropic-official',
          skill: 'skill-creator',
          manifestBucket: 'core',
          version: `sha:${SHA}`,
          rationale: 'Project authoring primitive.',
          verifyNotes: 'MIT; specific; no collision.',
          confidence: 0.92,
        },
      ],
    });
    const framed = `---SKILL_PROPOSALS---\n${inner}\n---END_SKILL_PROPOSALS---`;
    const result = validateSkillProposalsBlock(framed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.proposals[0].skill).toBe('skill-creator');
  });

  it('stripToJsonObject extracts the object from delimiter framing', () => {
    const inner = '{"trigger":"T2","projectSlug":"x","proposals":[]}';
    expect(stripToJsonObject(`---SKILL_PROPOSALS---\n${inner}\n---END_SKILL_PROPOSALS---`)).toBe(
      inner,
    );
  });

  it('rejects bad version format', () => {
    const raw = JSON.stringify({
      trigger: 'T1',
      projectSlug: 'x',
      proposals: [
        {
          kind: 'add',
          source: 's',
          skill: 'k',
          manifestBucket: 'core',
          version: 'v1.0.0', // missing sha:/tag: prefix
          rationale: 'r',
          verifyNotes: 'v',
          confidence: 0.5,
        },
      ],
    });
    const result = validateSkillProposalsBlock(raw);
    expect(result.ok).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    const raw = JSON.stringify({
      trigger: 'T1',
      projectSlug: 'x',
      proposals: [
        {
          kind: 'add',
          source: 's',
          skill: 'k',
          manifestBucket: 'core',
          version: `sha:${SHA}`,
          rationale: 'r',
          verifyNotes: 'v',
          confidence: 1.5,
        },
      ],
    });
    const result = validateSkillProposalsBlock(raw);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown manifestBucket', () => {
    const raw = JSON.stringify({
      trigger: 'T1',
      projectSlug: 'x',
      proposals: [
        {
          kind: 'add',
          source: 's',
          skill: 'k',
          manifestBucket: 'misc',
          version: `sha:${SHA}`,
          rationale: 'r',
          verifyNotes: 'v',
          confidence: 0.5,
        },
      ],
    });
    const result = validateSkillProposalsBlock(raw);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown trigger value', () => {
    const raw = JSON.stringify({
      trigger: 'T9',
      projectSlug: 'x',
      proposals: [],
    });
    const result = validateSkillProposalsBlock(raw);
    expect(result.ok).toBe(false);
  });

  it.each(['T4', 'T5', 'T6', 'T7', 'T8'] as const)(
    '%s is an accepted trigger value (Story 3-C-5)',
    (trigger) => {
      const raw = JSON.stringify({
        trigger,
        projectSlug: 'x',
        proposals: [],
      });
      expect(validateSkillProposalsBlock(raw).ok).toBe(true);
    },
  );
});

describe('SkillProposalSchema sanity', () => {
  it('exports an individually-validatable schema', () => {
    const single = {
      kind: 'upgrade',
      source: 'vercel-web',
      skill: 'vercel-react-best-practices',
      manifestBucket: 'stack',
      version: 'tag:v2.4.1',
      rationale: 'New version improves App Router metadata story.',
      verifyNotes: 'Same license; description unchanged; no collision.',
      confidence: 0.8,
    };
    expect(SkillProposalSchema.safeParse(single).success).toBe(true);
  });
});
