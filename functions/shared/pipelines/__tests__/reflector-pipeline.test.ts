/**
 * reflector-pipeline.test.ts — Pipeline v2 Phase 3 / Story 3-E-2-1.
 */

import { describe, it, expect } from 'vitest';
import {
  generateReflectorPipeline,
  validateReflectionsBlock,
  ReflectionProposalSchema,
} from '../reflector-pipeline';

const BASE_ARGS = {
  scope: 'plan' as const,
  planId: 'songster-v2-storyboard',
  projectSlug: 'songster',
  boilerplateKind: 'nextjs-base' as const,
  rigor: 'mvp' as const,
  lastSeenSha: 'a3f9c2e' + 'a'.repeat(33),
  lastReflectionAt: '2026-04-26T14:00:00Z',
  newGitLog: 'abc1234 Agent: DEV — "wire chord overlay"',
  projectClaudeMd: '# Project: songster\n\n## Patterns to use\n',
  existingInbox: '---\nlast-seen-sha: a3f9c2e\n---\n',
};

describe('generateReflectorPipeline', () => {
  it('builds a single-step pipeline with the REFLECTOR agent', () => {
    const pipe = generateReflectorPipeline(BASE_ARGS);
    expect(Object.keys(pipe.agents)).toEqual(['REFLECTOR']);
    expect(pipe.steps).toHaveLength(1);
    expect(pipe.steps[0]?.id).toBe('reflector-observe');
  });

  it('REFLECTOR agent gets Sonnet by default', () => {
    const pipe = generateReflectorPipeline(BASE_ARGS);
    expect(pipe.agents.REFLECTOR?.model).toBe('sonnet');
  });

  it('allowedTools restricted to Read + Grep + Glob (no Bash)', () => {
    const pipe = generateReflectorPipeline(BASE_ARGS);
    const allowed = pipe.agents.REFLECTOR?.allowedTools ?? '';
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Grep');
    expect(allowed).toContain('Glob');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Edit');
  });

  it('disallowedTools include Write + Edit + NotebookEdit + Bash + baseline deny', () => {
    const pipe = generateReflectorPipeline(BASE_ARGS);
    const disallowed = pipe.agents.REFLECTOR?.disallowedTools ?? '';
    expect(disallowed).toContain('Write');
    expect(disallowed).toContain('Edit');
    expect(disallowed).toContain('NotebookEdit');
    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('Task');
    expect(disallowed).toContain('Agent');
    expect(disallowed).toContain('WebFetch');
    expect(disallowed).toContain('WebSearch');
  });

  it('maxTurns from rigor matrix', () => {
    const proto = generateReflectorPipeline({ ...BASE_ARGS, rigor: 'prototype' });
    const mvp = generateReflectorPipeline(BASE_ARGS);
    const prod = generateReflectorPipeline({ ...BASE_ARGS, rigor: 'production' });
    expect(proto.agents.REFLECTOR?.maxTurns).toBe(4);
    expect(mvp.agents.REFLECTOR?.maxTurns).toBe(6);
    expect(prod.agents.REFLECTOR?.maxTurns).toBe(8);
  });

  it('step extractor captures between REFLECTION markers', () => {
    const pipe = generateReflectorPipeline(BASE_ARGS);
    const ex = pipe.steps[0]?.extractors?.REFLECTION_JSON;
    expect(ex?.type).toBe('between');
    expect((ex as { startDelimiter: string }).startDelimiter).toBe('---REFLECTION---');
    expect((ex as { endDelimiter: string }).endDelimiter).toBe('---END_REFLECTION---');
  });

  it('prompt includes scope, planId, window context, and git log slice', () => {
    const pipe = generateReflectorPipeline(BASE_ARGS);
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).toContain('SCOPE: plan');
    expect(prompt).toContain('PLAN: songster-v2-storyboard');
    expect(prompt).toContain('songster');
    expect(prompt).toContain('a3f9c2e'); // last-seen sha prefix
    expect(prompt).toContain('abc1234'); // new commit
  });

  it('prompt renders "Full history" on first reflection (lastSeenSha=null)', () => {
    const pipe = generateReflectorPipeline({
      ...BASE_ARGS,
      lastSeenSha: null,
      lastReflectionAt: null,
    });
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).toContain('Full history');
    expect(prompt).toContain('first reflection');
  });

  it('prompt renders "(empty)" placeholders when CLAUDE.md / inbox / git log are blank', () => {
    const pipe = generateReflectorPipeline({
      ...BASE_ARGS,
      newGitLog: '',
      projectClaudeMd: '',
      existingInbox: '',
    });
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).toContain('(empty — no new commits in window)');
    expect(prompt).toContain('(empty — project has no CLAUDE.md yet)');
    expect(prompt).toContain('(empty — first reflection)');
  });

  it.each(['story', 'wave', 'plan', 'brownfield-cycle'] as const)(
    'scope=%s emits the matching guidance block',
    (scope) => {
      const pipe = generateReflectorPipeline({ ...BASE_ARGS, scope });
      const prompt = pipe.steps[0]?.prompt ?? '';
      expect(prompt).toContain(`SCOPE: ${scope}`);
    },
  );
});

describe('validateReflectionsBlock', () => {
  it('parses a well-formed proposal block', () => {
    const raw = JSON.stringify({
      planId: 'songster-v2-storyboard',
      scope: 'plan',
      summary: 'Wave 3 went smoothly; one CLAUDE.md candidate.',
      proposals: [
        {
          target: 'project-claude-md',
          action: 'append-section',
          section: 'Patterns to avoid',
          content: "Don't put React state inside useEffect-only refs.",
          rationale: 'Pattern recurred in stories E2-S3 and E2-S5.',
          evidence: ['abc1234', 'def5678'],
          confidence: 0.9,
        },
      ],
    });
    const result = validateReflectionsBlock(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.proposals).toHaveLength(1);
      expect(result.output.proposals[0].target).toBe('project-claude-md');
    }
  });

  it('accepts empty proposals array (rolls forward last-seen-sha only)', () => {
    const raw = JSON.stringify({
      planId: 'songster-v2-storyboard',
      scope: 'wave',
      summary: 'Nothing notable.',
      proposals: [],
    });
    const result = validateReflectionsBlock(raw);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed JSON', () => {
    const result = validateReflectionsBlock('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/JSON parse/);
  });

  it('rejects unknown target', () => {
    const raw = JSON.stringify({
      planId: 'x',
      scope: 'plan',
      summary: 's',
      proposals: [
        {
          target: 'environment',
          action: 'append-section',
          content: 'c',
          rationale: 'r',
          confidence: 0.5,
        },
      ],
    });
    expect(validateReflectionsBlock(raw).ok).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    const raw = JSON.stringify({
      planId: 'x',
      scope: 'plan',
      summary: 's',
      proposals: [
        {
          target: 'project-skill',
          action: 'create',
          content: 'c',
          rationale: 'r',
          confidence: 1.5,
        },
      ],
    });
    expect(validateReflectionsBlock(raw).ok).toBe(false);
  });

  it('rejects unknown scope', () => {
    const raw = JSON.stringify({
      planId: 'x',
      scope: 'epic',
      summary: 's',
      proposals: [],
    });
    expect(validateReflectionsBlock(raw).ok).toBe(false);
  });
});

describe('ReflectionProposalSchema sanity', () => {
  it('exports an individually-validatable schema', () => {
    const single = {
      target: 'tool-wrapper',
      action: 'propose',
      content: '@futurator/mcp-ecs/describe-deployments',
      rationale: 'pattern repeats 47 times with 18% failure-rate; score 5874 > 5000',
      evidence: ['abc1234'],
      confidence: 0.85,
    };
    expect(ReflectionProposalSchema.safeParse(single).success).toBe(true);
  });
});
