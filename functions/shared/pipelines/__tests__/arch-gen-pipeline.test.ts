import { describe, it, expect } from 'vitest';
import { generateArchGenPipeline } from '../arch-gen-pipeline';
import { buildArchGenPrompt } from '../../prompts/arch-gen-prompt';

const BASE = {
  intent: 'A multiplayer drawing game',
  boilerplateType: 'nextjs-canvas-game' as const,
  rigor: 'production' as const,
};

const SEVEN_CATEGORIES = [
  'naming',
  'structure',
  'format',
  'communication',
  'lifecycle',
  'location',
  'consistency',
];

describe('arch-gen prompt (Story 2.3 — BMAD architecture sections + depth)', () => {
  it('uiBearing=true requires matching the UX model and the 7-category Implementation Patterns', () => {
    const p = buildArchGenPrompt({ ...BASE, depth: 'full', uiBearing: true });
    expect(p).toContain('## Implementation Patterns');
    for (const cat of SEVEN_CATEGORIES) expect(p.toLowerCase()).toContain(cat);
    expect(p).toMatch(/UX spec/i);
    expect(p).toMatch(/component \/ state \/ routing|component\/state\/routing/i);
  });

  it('depth=lite requires only Decision Summary Table + key patterns (trims the rest)', () => {
    const p = buildArchGenPrompt({ ...BASE, rigor: 'mvp', depth: 'lite', uiBearing: false });
    expect(p).toContain('## Decision Summary Table');
    expect(p).toContain('## Implementation Patterns');
    expect(p).not.toContain('## Data Architecture');
    expect(p).not.toContain('## API Contracts');
  });

  it('depth=full requires the full section set', () => {
    const p = buildArchGenPrompt({ ...BASE, depth: 'full', uiBearing: true });
    for (const h of [
      '## Project Structure',
      '## Tech Stack',
      '## Epic Mapping',
      '## Consistency Rules',
      '## Data Architecture',
      '## API Contracts',
    ]) {
      expect(p).toContain(h);
    }
  });

  it('forbids hardcoded versions and points the agent at WebSearch', () => {
    const p = buildArchGenPrompt({ ...BASE, depth: 'full', uiBearing: false });
    expect(p).toMatch(/do not hardcode/i);
    expect(p).toContain('WebSearch');
  });

  it('injects a ground_truth block only when supplied (brownfield)', () => {
    const cold = buildArchGenPrompt({ ...BASE, depth: 'full', uiBearing: false });
    expect(cold).not.toContain('Ground truth');
    const warm = buildArchGenPrompt({
      ...BASE,
      depth: 'full',
      uiBearing: false,
      groundTruth: 'PlansTable, api-lambda, /api/plans',
    });
    expect(warm).toContain('Ground truth');
    expect(warm).toContain('PlansTable');
  });
});

describe('arch-gen pipeline (Story 2.3 — role grants WebSearch)', () => {
  it('the Architect agent can actually WebSearch (DOC_GEN role)', () => {
    const def = generateArchGenPipeline({ ...BASE, depth: 'full', uiBearing: true });
    const agent = def.agents.ARCHITECT;
    expect(agent.name).toBe('Architect (Winston)');
    expect(agent.allowedTools).toContain('WebSearch');
    expect(agent.disallowedTools).not.toContain('WebSearch');
  });

  it('extractor delimiters match the prompt fences byte-for-byte', () => {
    const def = generateArchGenPipeline({ ...BASE, depth: 'full', uiBearing: true });
    const step = def.steps[0];
    const ex = step.extractors!.ARCHITECTURE_MD as { startDelimiter: string; endDelimiter: string };
    expect(step.prompt).toContain(ex.startDelimiter);
    expect(step.prompt).toContain(ex.endDelimiter);
  });
});
