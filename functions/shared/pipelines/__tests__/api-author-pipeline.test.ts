/**
 * api-author-pipeline.test.ts — Pipeline v2 Phase 2-A / Story 2-A-3-1 (PR-91).
 */

import { describe, it, expect } from 'vitest';
import {
  generateApiAuthorPipeline,
  shouldRunApiAuthor,
  inferModuleDirFromTouchPoints,
} from '../api-author-pipeline';

const BASE_ARGS = {
  storyId: 's1',
  storyTitle: 'wire chord overlay',
  acceptanceCriteria: '- chord overlay renders',
  moduleDir: 'src/components/ChordOverlay',
  existingExports: { types: ['Chord'], constants: [] },
  boilerplateKind: 'nextjs-canvas-game' as const,
  rigor: 'mvp' as const,
};

describe('generateApiAuthorPipeline', () => {
  it('builds single-step pipeline with API_AUTHOR', () => {
    const pipe = generateApiAuthorPipeline(BASE_ARGS);
    expect(Object.keys(pipe.agents)).toEqual(['API_AUTHOR']);
    expect(pipe.steps[0]?.id).toBe('api-author');
  });

  it('API_AUTHOR allowed: Read + Write + Glob + Grep; denies Bash + Edit', () => {
    const pipe = generateApiAuthorPipeline(BASE_ARGS);
    const allowed = pipe.agents.API_AUTHOR?.allowedTools ?? '';
    const disallowed = pipe.agents.API_AUTHOR?.disallowedTools ?? '';
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Write');
    expect(allowed).toContain('Glob');
    expect(allowed).toContain('Grep');
    expect(allowed).not.toContain('Bash');
    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('Edit');
  });

  it('maxTurns is 2 under mvp + production (skipped under prototype via shouldRunApiAuthor gate)', () => {
    expect(generateApiAuthorPipeline(BASE_ARGS).agents.API_AUTHOR?.maxTurns).toBe(2);
    expect(
      generateApiAuthorPipeline({ ...BASE_ARGS, rigor: 'production' }).agents.API_AUTHOR?.maxTurns,
    ).toBe(2);
  });

  it('maxIterations is 1 (single agent invocation, no retry loop)', () => {
    expect(generateApiAuthorPipeline(BASE_ARGS).maxIterations).toBe(1);
  });

  it('prompt includes story + AC + moduleDir + existing exports', () => {
    const pipe = generateApiAuthorPipeline(BASE_ARGS);
    const prompt = pipe.steps[0]?.prompt ?? '';
    expect(prompt).toContain('s1 — wire chord overlay');
    expect(prompt).toContain('chord overlay renders');
    expect(prompt).toContain('src/components/ChordOverlay/index.d.ts');
    expect(prompt).toContain('Chord');
  });

  it('prompt renders "no existing types" placeholder when both empty', () => {
    const pipe = generateApiAuthorPipeline({
      ...BASE_ARGS,
      existingExports: { types: [], constants: [] },
    });
    expect(pipe.steps[0]?.prompt).toContain('no existing types');
  });
});

describe('shouldRunApiAuthor', () => {
  it('false under prototype rigor', () => {
    expect(shouldRunApiAuthor({ rigor: 'prototype', boilerplateKind: 'nextjs-base' })).toBe(false);
  });

  it('false for stub boilerplates', () => {
    expect(shouldRunApiAuthor({ rigor: 'mvp', boilerplateKind: 'sst' })).toBe(false);
    expect(shouldRunApiAuthor({ rigor: 'production', boilerplateKind: 'vite' })).toBe(false);
    expect(shouldRunApiAuthor({ rigor: 'production', boilerplateKind: 'mobile' })).toBe(false);
  });

  it('true for nextjs-* + mvp/production', () => {
    expect(shouldRunApiAuthor({ rigor: 'mvp', boilerplateKind: 'nextjs-base' })).toBe(true);
    expect(shouldRunApiAuthor({ rigor: 'production', boilerplateKind: 'nextjs-canvas-game' })).toBe(
      true,
    );
  });
});

describe('inferModuleDirFromTouchPoints', () => {
  it('common prefix at depth ≥ 2 → unambiguous', () => {
    const result = inferModuleDirFromTouchPoints([
      'src/components/Game/Player.tsx',
      'src/components/Game/Enemy.tsx',
    ]);
    expect(result.moduleDir).toBe('src/components/Game');
    expect(result.ambiguous).toBe(false);
  });

  it('common prefix only at source-root → ambiguous', () => {
    const result = inferModuleDirFromTouchPoints(['src/components/Player.tsx', 'src/api/users.ts']);
    expect(result.ambiguous).toBe(true);
    expect(result.moduleDir).toBe('src');
  });

  it('no common prefix → ambiguous', () => {
    const result = inferModuleDirFromTouchPoints([
      'src/components/Player.tsx',
      'functions/api/users.ts',
    ]);
    expect(result.ambiguous).toBe(true);
    expect(result.moduleDir).toBe('');
  });

  it('empty input → ambiguous', () => {
    expect(inferModuleDirFromTouchPoints([]).ambiguous).toBe(true);
    expect(inferModuleDirFromTouchPoints([''] as never).ambiguous).toBe(true);
  });

  it('strips ./ and trailing slashes', () => {
    expect(
      inferModuleDirFromTouchPoints(['./src/foo/bar/file.ts', 'src/foo/bar/other.ts']).moduleDir,
    ).toBe('src/foo/bar');
  });

  it('handles files in different subdirs but shared deeper prefix', () => {
    const result = inferModuleDirFromTouchPoints([
      'src/components/Game/hooks/useTimer.ts',
      'src/components/Game/render/draw.ts',
    ]);
    expect(result.moduleDir).toBe('src/components/Game');
    expect(result.ambiguous).toBe(false);
  });
});
