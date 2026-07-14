import { describe, it, expect } from 'vitest';
import { detectInRepoMock, resolveMockSpec } from '../no-mock-check.mjs';

describe('detectInRepoMock', () => {
  it('flags a relative in-repo mock', () => {
    const r = detectInRepoMock(`vi.mock('./levels');\nimport x from './levels';`);
    expect(r.violation).toBe(true);
    expect(r.hits).toEqual(['./levels']);
  });

  it('flags @/ and ~/ repo-alias mocks', () => {
    expect(detectInRepoMock(`vi.mock('@/game/state')`).violation).toBe(true);
    expect(detectInRepoMock(`vi.mock('~/lib/util')`).violation).toBe(true);
    expect(detectInRepoMock(`vi.mock('@/game/state')`).hits).toEqual(['@/game/state']);
  });

  it('flags jest.mock the same way', () => {
    expect(detectInRepoMock(`jest.mock('../store')`).violation).toBe(true);
    expect(detectInRepoMock(`jest.mock('../store')`).hits).toEqual(['../store']);
  });

  it('is clean for bare external packages and node builtins', () => {
    expect(detectInRepoMock(`vi.mock('react')`).violation).toBe(false);
    expect(detectInRepoMock(`vi.mock('node:fs')`).violation).toBe(false);
    expect(detectInRepoMock(`vi.mock('@scope/pkg')`).violation).toBe(false);
    expect(detectInRepoMock(`jest.mock('lodash')`).violation).toBe(false);
  });

  it('collects multiple distinct in-repo hits, dedup', () => {
    const src = `vi.mock('./a')\nvi.mock('./b')\nvi.mock('./a')\nvi.mock('react')`;
    const r = detectInRepoMock(src);
    expect(r.hits).toEqual(['./a', './b']);
  });

  it('handles double and backtick quotes', () => {
    expect(detectInRepoMock(`vi.mock("./x")`).hits).toEqual(['./x']);
    expect(detectInRepoMock('vi.mock(`./y`)').hits).toEqual(['./y']);
  });

  it('tolerates whitespace between mock and paren', () => {
    expect(detectInRepoMock(`vi . mock ( './z' )`).violation).toBe(false); // "vi . mock" is not vi.mock
    expect(detectInRepoMock(`vi.mock (  './z' )`).violation).toBe(true);
  });

  it('non-string input is clean', () => {
    expect(detectInRepoMock(undefined)).toEqual({ violation: false, hits: [] });
    expect(detectInRepoMock(null)).toEqual({ violation: false, hits: [] });
    expect(detectInRepoMock(42)).toEqual({ violation: false, hits: [] });
  });

  // Back-compat guard: an empty/scopeless opts still runs STRICT (fail-safe
  // toward the self-validation invariant — never a silent narrowing hole).
  it('opts with neither testFilePath nor a non-empty underTest stays STRICT', () => {
    expect(detectInRepoMock(`vi.mock('../maze')`, {}).violation).toBe(true);
    expect(detectInRepoMock(`vi.mock('../maze')`, { underTest: [] }).violation).toBe(true);
  });
});

describe('resolveMockSpec — spec → repo-relative module id', () => {
  const testFile = 'src/game/systems/collisions.test.ts';

  it("resolves a relative '../' spec against the test file dir", () => {
    expect(resolveMockSpec('../maze', testFile)).toBe('src/game/maze');
  });

  it("resolves a './' sibling spec", () => {
    expect(resolveMockSpec('./collisions', testFile)).toBe('src/game/systems/collisions');
  });

  it('resolves @/ and ~/ aliases to src/…', () => {
    expect(resolveMockSpec('@/game/maze', testFile)).toBe('src/game/maze');
    expect(resolveMockSpec('~/game/maze', testFile)).toBe('src/game/maze');
  });

  it('is extension-insensitive (spec may carry .ts / .tsx)', () => {
    expect(resolveMockSpec('../maze.ts', testFile)).toBe('src/game/maze');
    expect(resolveMockSpec('./collisions.tsx', testFile)).toBe('src/game/systems/collisions');
  });

  it('returns null for a bare external package', () => {
    expect(resolveMockSpec('react', testFile)).toBeNull();
    expect(resolveMockSpec('node:fs', testFile)).toBeNull();
    expect(resolveMockSpec('@scope/pkg', testFile)).toBeNull();
  });
});

describe('detectInRepoMock — NARROW (module-under-test only, Incident D)', () => {
  const testFile = 'src/game/systems/collisions.test.ts'; // sibling impl = src/game/systems/collisions

  it('mocking a DEPENDENCY (../maze) is NOT a violation under scope', () => {
    const src = `vi.mock('../maze')\nimport { stepCollisions } from './collisions'`;
    const r = detectInRepoMock(src, { testFilePath: testFile, underTest: [] });
    expect(r.violation).toBe(false);
    expect(r.hits).toEqual([]);
  });

  it('mocking the SIBLING implementation IS a violation (self-validation preserved)', () => {
    const src = `vi.mock('./collisions')`;
    const r = detectInRepoMock(src, { testFilePath: testFile, underTest: [] });
    expect(r.violation).toBe(true);
    expect(r.hits).toEqual(['./collisions']);
  });

  it("mocking the sibling via an @/ alias is also a violation", () => {
    const r = detectInRepoMock(`vi.mock('@/game/systems/collisions')`, { testFilePath: testFile });
    expect(r.violation).toBe(true);
  });

  it('mocking a `touches` entry IS a violation (module under test)', () => {
    const src = `vi.mock('../maze')`;
    const r = detectInRepoMock(src, { testFilePath: testFile, underTest: ['src/game/maze.ts'] });
    expect(r.violation).toBe(true);
    expect(r.hits).toEqual(['../maze']);
  });

  it('external packages are never flagged even under scope', () => {
    const src = `vi.mock('react')\nvi.mock('node:fs')`;
    expect(detectInRepoMock(src, { testFilePath: testFile, underTest: ['src/game/collisions.ts'] }).violation).toBe(false);
  });

  it('mixes: sibling flagged, dependency clean — only the sibling is a hit', () => {
    const src = `vi.mock('../maze')\nvi.mock('./collisions')\nvi.mock('react')`;
    const r = detectInRepoMock(src, { testFilePath: testFile });
    expect(r.hits).toEqual(['./collisions']);
  });

  // Incident D review: `touches` may be a GLOB (the planner is allowed to emit
  // patterns like 'src/game/systems/*.ts'). Exact Set-membership missed it and
  // reopened the self-validation hole for glob-touched stories.
  describe('GLOB `touches` entries (planner-permitted patterns)', () => {
    // A test whose filename does NOT match the module it verifies, so the
    // sibling-impl fallback does NOT fire — only the glob touch can catch it.
    const integrationTest = 'src/game/systems/integration.test.ts';

    it('mocking a module MATCHED by a glob touch IS a violation (self-validation hole closed)', () => {
      const src = `vi.mock('./collisions')`;
      const r = detectInRepoMock(src, { testFilePath: integrationTest, underTest: ['src/game/systems/*.ts'] });
      expect(r.violation).toBe(true);
      expect(r.hits).toEqual(['./collisions']);
    });

    it('mocking a DEPENDENCY OUTSIDE a glob touch is NOT a violation (legitimate isolation)', () => {
      const src = `vi.mock('../maze')`; // resolves to src/game/maze, NOT under src/game/systems/*
      const r = detectInRepoMock(src, { testFilePath: integrationTest, underTest: ['src/game/systems/*.ts'] });
      expect(r.violation).toBe(false);
      expect(r.hits).toEqual([]);
    });

    it('a `**` glob touch matches a module under test', () => {
      const src = `vi.mock('./collisions')`;
      const r = detectInRepoMock(src, { testFilePath: integrationTest, underTest: ['src/game/**'] });
      expect(r.violation).toBe(true);
    });

    it('extensionless directory glob (e.g. src/game/systems/*) matches', () => {
      const src = `vi.mock('./collisions')`;
      const r = detectInRepoMock(src, { testFilePath: integrationTest, underTest: ['src/game/systems/*'] });
      expect(r.violation).toBe(true);
    });
  });
});
