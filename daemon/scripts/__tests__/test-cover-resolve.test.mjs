import { describe, it, expect } from 'vitest';
import {
  isTestFile,
  resolveRelImport,
  resolveTestCoverEdges,
  buildTestCoverFacts,
} from '../lib/test-cover-resolve.mjs';

describe('isTestFile', () => {
  it('matches .test/.spec across js/ts variants', () => {
    for (const p of ['a.test.ts', 'a.spec.tsx', 'x/y.test.mjs', 'z.spec.js']) expect(isTestFile(p)).toBe(true);
    for (const p of ['a.ts', 'testutil.ts', 'spec.md']) expect(isTestFile(p)).toBe(false);
  });
});

describe('resolveRelImport', () => {
  const known = new Set(['src/login.ts', 'src/util/index.ts']);
  it('resolves ./sibling with extension inference', () => {
    expect(resolveRelImport('src/login.test.ts', './login', known)).toBe('src/login.ts');
  });
  it('resolves a directory to its index', () => {
    expect(resolveRelImport('src/login.test.ts', './util', known)).toBe('src/util/index.ts');
  });
  it('ignores bare (node_module) imports', () => {
    expect(resolveRelImport('src/login.test.ts', 'vitest', known)).toBeNull();
  });
});

describe('resolveTestCoverEdges', () => {
  const facts = {
    files: [
      { path: 'src/login.test.ts', imports: [{ source: './login' }, { source: 'vitest' }] },
      { path: 'src/login.ts', imports: [] },
      { path: 'src/other.ts', imports: [] },
    ],
  };
  it('emits a TESTS edge test-file → imported source file, deterministically', () => {
    const edges = resolveTestCoverEdges(facts);
    expect(edges).toEqual([{ from: 'src/login.test.ts', to: 'src/login.ts', type: 'TESTS' }]);
  });
  it('skips imports that do not resolve to a known project file', () => {
    const e = resolveTestCoverEdges({ files: [{ path: 'a.test.ts', imports: [{ source: './missing' }] }] });
    expect(e).toEqual([]);
  });
  it('buildTestCoverFacts wraps edges in a versioned envelope', () => {
    expect(buildTestCoverFacts(facts).schema).toBe('futurator.test-cover/v1');
    expect(buildTestCoverFacts(facts).edges).toHaveLength(1);
  });
  it('tolerates empty/absent facts', () => {
    expect(resolveTestCoverEdges(undefined)).toEqual([]);
    expect(resolveTestCoverEdges({ files: [] })).toEqual([]);
  });
});
