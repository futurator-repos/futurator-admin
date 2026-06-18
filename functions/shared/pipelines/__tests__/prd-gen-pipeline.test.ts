import { describe, it, expect } from 'vitest';
import { generatePrdGenPipeline } from '../prd-gen-pipeline';
import { buildPrdGenPrompt } from '../../prompts/prd-gen-prompt';

const BASE = {
  intent: 'A task tracker with reminders',
  boilerplateType: 'nextjs-base' as const,
};

describe('prd-gen prompt (Story 2.1 — depth scaling)', () => {
  it('light (mvp) requires Scope + Functional Requirements and omits NFR/Domain', () => {
    const p = buildPrdGenPrompt({ ...BASE, rigor: 'mvp', depth: 'light' });
    expect(p).toContain('## Scope (MVP → Growth → Vision)');
    expect(p).toContain('## Functional Requirements');
    expect(p).not.toContain('## Non-Functional Requirements');
    expect(p).not.toContain('## Domain Requirements');
  });

  it('full (production) additionally requires NFR + Domain Requirements', () => {
    const p = buildPrdGenPrompt({ ...BASE, rigor: 'production', depth: 'full' });
    expect(p).toContain('## Scope (MVP → Growth → Vision)');
    expect(p).toContain('## Functional Requirements');
    expect(p).toContain('## Non-Functional Requirements');
    expect(p).toContain('## Domain Requirements');
  });

  it('inlines priorArtifacts when supplied, omits the block when absent', () => {
    const withPrior = buildPrdGenPrompt({
      ...BASE,
      rigor: 'mvp',
      depth: 'light',
      priorArtifacts: 'GROUNDING TEXT',
    });
    expect(withPrior).toContain('GROUNDING TEXT');
    const without = buildPrdGenPrompt({ ...BASE, rigor: 'mvp', depth: 'light' });
    expect(without).not.toContain('Prior context');
  });
});

describe('prd-gen pipeline (Story 2.1 — extractor/fence parity)', () => {
  it('extractor delimiters match the prompt fences byte-for-byte', () => {
    const def = generatePrdGenPipeline({ ...BASE, rigor: 'mvp', depth: 'light' });
    const step = def.steps[0];
    const ex = step.extractors!.PRD_MD;
    expect(ex.type).toBe('between');
    const start = (ex as { startDelimiter: string }).startDelimiter;
    const end = (ex as { endDelimiter: string }).endDelimiter;
    // Both delimiters must appear verbatim in the prompt the agent sees.
    expect(step.prompt).toContain(start);
    expect(step.prompt).toContain(end);
    expect(start).toBe('---PRD_MD---');
    expect(end).toBe('---END_PRD_MD---');
  });

  it('uses the DOC_GEN role (WebSearch-capable) at model sonnet by default', () => {
    const def = generatePrdGenPipeline({ ...BASE, rigor: 'mvp', depth: 'light' });
    const agent = def.agents.PRD;
    expect(agent.name).toBe('PRD (John)');
    expect(agent.model).toBe('sonnet');
    expect(agent.allowedTools).toContain('WebSearch');
  });
});
