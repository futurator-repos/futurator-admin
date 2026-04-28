import { describe, it, expect } from 'vitest';
import {
  inferTouchPoints,
  buildLlmInferencePrompt,
  parseLlmJsonOutput,
} from '../touch-point-inference.mjs';

// In-memory fake fs for path validation.
function fakeFsExists(present) {
  const set = new Set(present);
  return (p) => {
    // Match any path that ends in one of our known-present strings, OR a
    // prefix match for parent-dir checks.
    for (const k of set) {
      if (p === k || p.endsWith('/' + k) || p.endsWith(k)) return true;
    }
    return false;
  };
}

const baseStory = {
  title: 'Scaffold project core types',
  description:
    'Create a minimal Vite project, define core types in `src/types.ts`, and constants in `src/constants.ts`. Set up `index.html` with a canvas element.',
  acceptanceCriteria: '',
};

describe('inferTouchPoints — orchestrator', () => {
  it('returns source=heuristic when AC text mentions explicit paths AND project tree validates them', async () => {
    const result = await inferTouchPoints({
      projectDir: '/proj',
      story: baseStory,
      deps: {
        // src/ exists in the project tree
        fsExists: fakeFsExists(['/proj/src', '/proj/index.html']),
      },
    });
    expect(result.source).toBe('heuristic');
    expect(result.touchPoints).toContain('src/types.ts');
    expect(result.touchPoints).toContain('src/constants.ts');
    expect(result.touchPoints).toContain('index.html');
  });

  it('keeps a heuristic path even when the file does not exist yet (parent dir does)', async () => {
    const result = await inferTouchPoints({
      projectDir: '/proj',
      story: {
        ...baseStory,
        description: 'Add `src/components/NewButton.tsx` (a fresh component).',
      },
      deps: {
        // src/ exists; src/components/NewButton.tsx does not
        fsExists: fakeFsExists(['/proj/src']),
      },
    });
    expect(result.source).toBe('heuristic');
    expect(result.touchPoints).toContain('src/components/NewButton.tsx');
  });

  it('drops a heuristic path when neither the path nor its parent dir exist', async () => {
    const result = await inferTouchPoints({
      projectDir: '/proj',
      story: {
        ...baseStory,
        description: 'Edit `madeup/path/foo.ts`.',
      },
      deps: {
        // empty project — nothing exists
        fsExists: () => false,
        // skipLlm so we get the heuristic-only behavior
      },
      opts: { skipLlm: true },
    });
    expect(result.source).toBe('none');
    expect(result.touchPoints).toEqual([]);
  });

  it('falls back to LLM when heuristic returns 0 paths', async () => {
    let llmCalled = false;
    const result = await inferTouchPoints({
      projectDir: '/proj',
      story: {
        title: 'Vague story',
        description: 'Implement the dino physics. Use pure functions. Tests must pass.',
        acceptanceCriteria: '',
      },
      deps: {
        fsExists: fakeFsExists(['/proj/src']),
        listProjectTree: () => ['src', 'src/foo.ts'],
        runLlmInference: async () => {
          llmCalled = true;
          return { touchPoints: ['src/dino.ts', 'src/dino.test.ts'], raw: '["src/dino.ts","src/dino.test.ts"]' };
        },
      },
    });
    expect(llmCalled).toBe(true);
    expect(result.source).toBe('llm');
    expect(result.touchPoints).toEqual(['src/dino.ts', 'src/dino.test.ts']);
  });

  it('returns source=none with skipLlm when heuristic yields 0 (LLM fallback disabled)', async () => {
    let llmCalled = false;
    const result = await inferTouchPoints({
      projectDir: '/proj',
      story: {
        title: 'Vague story',
        description: 'Implement the dino physics.',
        acceptanceCriteria: '',
      },
      opts: { skipLlm: true },
      deps: {
        fsExists: () => false,
        runLlmInference: async () => {
          llmCalled = true;
          return { touchPoints: ['x'] };
        },
      },
    });
    expect(llmCalled).toBe(false);
    expect(result.source).toBe('none');
    expect(result.touchPoints).toEqual([]);
  });

  it('returns source=none on missing inputs', async () => {
    const r1 = await inferTouchPoints({});
    expect(r1.source).toBe('none');
    const r2 = await inferTouchPoints({ projectDir: '/proj' });
    expect(r2.source).toBe('none');
    const r3 = await inferTouchPoints({ projectDir: '/proj', story: { description: '' } });
    expect(r3.source).toBe('none');
  });

  it('handles LLM failure gracefully (returns source=none, no throw)', async () => {
    const result = await inferTouchPoints({
      projectDir: '/proj',
      story: {
        title: 'Vague',
        description: 'Implement physics.',
        acceptanceCriteria: '',
      },
      deps: {
        fsExists: () => true,
        listProjectTree: () => ['src', 'src/foo.ts'],
        runLlmInference: async () => {
          throw new Error('claude CLI not found');
        },
      },
    });
    expect(result.source).toBe('none');
    expect(result.reason).toContain('llm inference failed');
    expect(result.touchPoints).toEqual([]);
  });

  it('rejects implausible LLM-suggested paths (absolute, .., whitespace)', async () => {
    const result = await inferTouchPoints({
      projectDir: '/proj',
      story: { description: 'vague', acceptanceCriteria: '' },
      deps: {
        fsExists: () => true,
        listProjectTree: () => [],
        runLlmInference: async () => ({
          touchPoints: ['/etc/passwd', '../../escape', 'has spaces.ts', 'src/ok.ts'],
          raw: '...',
        }),
      },
    });
    // Only src/ok.ts should survive the filter
    expect(result.source).toBe('llm');
    expect(result.touchPoints).toEqual(['src/ok.ts']);
  });

  it('caps LLM output at 12 paths', async () => {
    const big = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
    const result = await inferTouchPoints({
      projectDir: '/proj',
      story: { description: 'vague', acceptanceCriteria: '' },
      deps: {
        fsExists: () => true,
        listProjectTree: () => [],
        runLlmInference: async () => ({ touchPoints: big, raw: '...' }),
      },
    });
    expect(result.touchPoints.length).toBeLessThanOrEqual(12);
  });
});

describe('buildLlmInferencePrompt', () => {
  it('includes the tree, story title, and AC text', () => {
    const prompt = buildLlmInferencePrompt({
      tree: ['src', 'src/foo.ts', 'package.json'],
      acText: 'Implement physics.',
      storyTitle: 'Dino physics',
    });
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('Dino physics');
    expect(prompt).toContain('Implement physics.');
    expect(prompt).toContain('JSON array');
  });

  it('truncates oversized inputs', () => {
    const huge = 'X'.repeat(20_000);
    const prompt = buildLlmInferencePrompt({
      tree: [huge],
      acText: huge,
      storyTitle: 'big',
    });
    // Both tree and AC text are truncated; total prompt should be bounded
    expect(prompt.length).toBeLessThan(10_000);
  });
});

describe('parseLlmJsonOutput', () => {
  it('parses a bare JSON array', () => {
    expect(parseLlmJsonOutput('["src/foo.ts","src/bar.ts"]')).toEqual([
      'src/foo.ts',
      'src/bar.ts',
    ]);
  });

  it('strips markdown fences', () => {
    expect(parseLlmJsonOutput('```json\n["src/foo.ts"]\n```')).toEqual(['src/foo.ts']);
  });

  it('extracts an array embedded in chatter', () => {
    expect(parseLlmJsonOutput('Sure! Here you go: ["src/foo.ts"] hope that helps')).toEqual([
      'src/foo.ts',
    ]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseLlmJsonOutput('not json at all')).toEqual([]);
    expect(parseLlmJsonOutput('[')).toEqual([]);
    expect(parseLlmJsonOutput('')).toEqual([]);
  });

  it('returns [] when the model returns a non-array', () => {
    expect(parseLlmJsonOutput('{"oops":true}')).toEqual([]);
    expect(parseLlmJsonOutput('"just a string"')).toEqual([]);
  });
});
