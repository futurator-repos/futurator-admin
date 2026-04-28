import { describe, it, expect } from 'vitest';
import { extractCandidateExports, checkExportsPresent } from '../ac-export-detector.mjs';

describe('extractCandidateExports — heuristic AC parser', () => {
  it('returns [] on empty/non-string input', () => {
    expect(extractCandidateExports('')).toEqual([]);
    expect(extractCandidateExports(null)).toEqual([]);
    expect(extractCandidateExports(undefined)).toEqual([]);
    expect(extractCandidateExports(42)).toEqual([]);
  });

  it('extracts identifiers from backticked spans', () => {
    const ids = extractCandidateExports('Implements `applyGravity` and `startJump`.');
    expect(ids).toContain('applyGravity');
    expect(ids).toContain('startJump');
  });

  it('extracts identifiers from function-call shape', () => {
    const ids = extractCandidateExports('Add applyGravity(dino) that returns a new dino.');
    expect(ids).toContain('applyGravity');
  });

  it('extracts identifiers from declaration shape', () => {
    const ids = extractCandidateExports('Add a `function applyGravity` and `class Dino`.');
    expect(ids).toContain('applyGravity');
    expect(ids).toContain('Dino');
  });

  it('extracts identifiers from explicit export shape', () => {
    const ids = extractCandidateExports('Should `export function applyGravity`.');
    expect(ids).toContain('applyGravity');
  });

  it('filters common English words and short tokens', () => {
    const ids = extractCandidateExports('and the for with on to be is or in');
    expect(ids).toEqual([]);
  });

  it('filters pure-lowercase short identifiers', () => {
    const ids = extractCandidateExports('Use `xyz`.');
    // `xyz` is short + has no capital — filtered out
    expect(ids).not.toContain('xyz');
  });

  it('keeps PascalCase identifiers', () => {
    const ids = extractCandidateExports('Define `Dino` and `GameStatus`.');
    expect(ids).toContain('Dino');
    expect(ids).toContain('GameStatus');
  });

  it('deduplicates and sorts longest-first', () => {
    const ids = extractCandidateExports('`startJump` `Dino` `applyGravity` `startJump`');
    expect(ids[0]).toBe('applyGravity'); // longest first
    expect(ids).toContain('startJump');
    expect(ids).toContain('Dino');
    // dedupe — startJump appears once
    expect(ids.filter((x) => x === 'startJump').length).toBe(1);
  });

  it('handles realistic dino1 AC text shape', () => {
    const ac = `
- AC-1: \`applyGravity(dino: Dino): Dino\` — pure function applying gravity per tick
- AC-2: \`startJump(dino: Dino): Dino\` — initiates jump; no-op if already jumping
- AC-3: \`startDuck(dino: Dino): Dino\` — shrinks height to DINO_DUCK_HEIGHT
- AC-4: \`endDuck(dino: Dino): Dino\` — restores normal height
`;
    const ids = extractCandidateExports(ac);
    expect(ids).toContain('applyGravity');
    expect(ids).toContain('startJump');
    expect(ids).toContain('startDuck');
    expect(ids).toContain('endDuck');
    expect(ids).toContain('Dino');
  });
});

describe('checkExportsPresent — touchPoint file scanner', () => {
  // Helper to build a fake fs that matches the module's interface.
  function fakeFs(files) {
    return {
      readFile: async (p) => {
        const key = Object.keys(files).find((k) => p.endsWith(k));
        if (!key) throw new Error(`fake-fs: missing ${p}`);
        return files[key];
      },
      exists: async (p) => Object.keys(files).some((k) => p.endsWith(k)),
    };
  }

  it('returns allPresent=false when no candidates', async () => {
    const result = await checkExportsPresent({
      candidates: [],
      touchPoints: ['src/foo.ts'],
      projectDir: '/proj',
      fs: fakeFs({ 'src/foo.ts': 'export function bar() {}' }),
    });
    expect(result.allPresent).toBe(false);
  });

  it('returns allPresent=false when no touchPoints', async () => {
    const result = await checkExportsPresent({
      candidates: ['bar'],
      touchPoints: [],
      projectDir: '/proj',
      fs: fakeFs({}),
    });
    expect(result.allPresent).toBe(false);
  });

  it('detects export function declarations', async () => {
    const result = await checkExportsPresent({
      candidates: ['applyGravity'],
      touchPoints: ['src/dino.ts'],
      projectDir: '/proj',
      fs: fakeFs({
        'src/dino.ts': 'export function applyGravity(dino: Dino): Dino {\n  return dino;\n}',
      }),
    });
    expect(result.allPresent).toBe(true);
    expect(result.present).toEqual(['applyGravity']);
    expect(result.missing).toEqual([]);
  });

  it('detects export const declarations', async () => {
    const result = await checkExportsPresent({
      candidates: ['GRAVITY'],
      touchPoints: ['src/constants.ts'],
      projectDir: '/proj',
      fs: fakeFs({ 'src/constants.ts': 'export const GRAVITY = 0.6;' }),
    });
    expect(result.allPresent).toBe(true);
  });

  it('detects export class declarations', async () => {
    const result = await checkExportsPresent({
      candidates: ['Dino'],
      touchPoints: ['src/types.ts'],
      projectDir: '/proj',
      fs: fakeFs({ 'src/types.ts': 'export class Dino { x: number = 0; }' }),
    });
    expect(result.allPresent).toBe(true);
  });

  it('detects re-exports via `export { foo }`', async () => {
    const result = await checkExportsPresent({
      candidates: ['applyGravity'],
      touchPoints: ['src/index.ts'],
      projectDir: '/proj',
      fs: fakeFs({ 'src/index.ts': "export { applyGravity, startJump } from './dino';" }),
    });
    expect(result.allPresent).toBe(true);
  });

  it('returns missing when an identifier exists but is NOT exported', async () => {
    const result = await checkExportsPresent({
      candidates: ['applyGravity'],
      touchPoints: ['src/dino.ts'],
      projectDir: '/proj',
      fs: fakeFs({ 'src/dino.ts': 'function applyGravity(dino) { return dino; }' }),
    });
    expect(result.allPresent).toBe(false);
    expect(result.missing).toEqual(['applyGravity']);
  });

  it('requires ALL candidates present (conservative)', async () => {
    const result = await checkExportsPresent({
      candidates: ['applyGravity', 'startJump'],
      touchPoints: ['src/dino.ts'],
      projectDir: '/proj',
      fs: fakeFs({ 'src/dino.ts': 'export function applyGravity(d) { return d; }' }),
    });
    expect(result.allPresent).toBe(false);
    expect(result.present).toEqual(['applyGravity']);
    expect(result.missing).toEqual(['startJump']);
  });

  it('skips deep glob touchPoints (returns missing)', async () => {
    const result = await checkExportsPresent({
      candidates: ['Foo'],
      touchPoints: ['src/**/*.ts'],
      projectDir: '/proj',
      fs: fakeFs({ 'src/foo.ts': 'export class Foo {}' }),
    });
    // ** glob → not scanned → conservative miss
    expect(result.allPresent).toBe(false);
    expect(result.filesScanned).toEqual([]);
  });

  it('handles missing files gracefully (skips them)', async () => {
    const result = await checkExportsPresent({
      candidates: ['Foo'],
      touchPoints: ['src/missing.ts', 'src/foo.ts'],
      projectDir: '/proj',
      fs: fakeFs({ 'src/foo.ts': 'export class Foo {}' }),
    });
    expect(result.allPresent).toBe(true);
    expect(result.filesScanned).toEqual(['src/foo.ts']);
  });
});
