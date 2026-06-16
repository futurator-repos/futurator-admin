import { describe, it, expect } from 'vitest';
import { generateUxGenPipeline } from '../ux-gen-pipeline';
import { buildUxGenPrompt } from '../../prompts/ux-gen-prompt';

const BASE = {
  intent: 'A habit tracker',
  boilerplateType: 'nextjs-base' as const,
  rigor: 'mvp' as const,
  depth: 'light' as const,
};

describe('ux-gen prompt (Story 2.2 — BMAD UX template + PRD grounding)', () => {
  it('emits the BMAD UX 9-section headings and directs PRD consistency when PRD supplied', () => {
    const p = buildUxGenPrompt({ ...BASE, priorArtifacts: 'APPROVED PRD SECTIONS' });
    for (const h of [
      '## UX Goals & Principles',
      '## Information Architecture',
      '## Key User Journeys',
      '## Screens & Components',
      '## Interaction & State Model',
      '## Accessibility',
      '## Responsiveness & Edge Cases',
    ]) {
      expect(p).toContain(h);
    }
    expect(p).toContain('APPROVED PRD SECTIONS');
    expect(p).toMatch(/consistent with this scope/i);
  });

  it('still emits a valid skeleton when no priorArtifacts are supplied', () => {
    const p = buildUxGenPrompt(BASE);
    expect(p).toContain('## UX Goals & Principles');
    expect(p).toMatch(/No PRD provided/i);
  });
});

describe('ux-gen pipeline (Story 2.2 — extractor/fence parity)', () => {
  it('UX_MD delimiters match the prompt fences byte-for-byte', () => {
    const def = generateUxGenPipeline(BASE);
    const step = def.steps[0];
    const ex = step.extractors!.UX_MD as { startDelimiter: string; endDelimiter: string };
    expect(step.prompt).toContain(ex.startDelimiter);
    expect(step.prompt).toContain(ex.endDelimiter);
    expect(ex.startDelimiter).toBe('---UX_MD---');
    expect(ex.endDelimiter).toBe('---END_UX_MD---');
  });

  it('uses the UX (Sally) DOC_GEN agent', () => {
    const def = generateUxGenPipeline(BASE);
    expect(def.agents.UX.name).toBe('UX (Sally)');
    expect(def.agents.UX.allowedTools).toContain('WebSearch');
  });
});
