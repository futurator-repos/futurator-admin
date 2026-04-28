import { describe, it, expect } from 'vitest';
import { extractCandidatePaths } from '../file-path-extractor.mjs';

describe('extractCandidatePaths — heuristic file-path miner', () => {
  it('returns [] on empty/non-string input', () => {
    expect(extractCandidatePaths('')).toEqual([]);
    expect(extractCandidatePaths(null)).toEqual([]);
    expect(extractCandidatePaths(undefined)).toEqual([]);
    expect(extractCandidatePaths(42)).toEqual([]);
  });

  describe('backticked paths', () => {
    it('extracts `src/foo.ts`', () => {
      expect(extractCandidatePaths('Edit `src/foo.ts` and add a function.')).toContain('src/foo.ts');
    });

    it('extracts multiple backticked paths', () => {
      const out = extractCandidatePaths(
        'Define types in `src/types.ts` and constants in `src/constants.ts`.',
      );
      expect(out).toContain('src/types.ts');
      expect(out).toContain('src/constants.ts');
    });

    it('extracts `index.html`', () => {
      expect(extractCandidatePaths('Set up `index.html` with a canvas element.')).toContain(
        'index.html',
      );
    });

    it('extracts paths with subdirs', () => {
      const out = extractCandidatePaths('Add `tests/e2e/auth.spec.ts` for the login flow.');
      expect(out).toContain('tests/e2e/auth.spec.ts');
    });

    it('extracts glob patterns', () => {
      const out = extractCandidatePaths('Cover all files under `src/**/*.ts` with tests.');
      expect(out).toContain('src/**/*.ts');
    });
  });

  describe('plain paths in prose', () => {
    it('extracts a slashed path with extension', () => {
      expect(extractCandidatePaths('Create src/components/Button.tsx with a click handler.')).toContain(
        'src/components/Button.tsx',
      );
    });

    it('does NOT extract single-word filenames without a slash (avoid prose false-positives)', () => {
      // "config.json" appearing in prose without a path is too ambiguous.
      expect(extractCandidatePaths('Set the value in config.json.')).toEqual([]);
    });

    it('catches well-known top-level files even without a slash', () => {
      expect(extractCandidatePaths('Update package.json with a new dep.')).toContain('package.json');
      expect(extractCandidatePaths('Edit tsconfig.json paths.')).toContain('tsconfig.json');
      expect(extractCandidatePaths('Modify vite.config.ts.')).toContain('vite.config.ts');
    });
  });

  describe('directory-globs', () => {
    it('extracts `src/**`', () => {
      expect(extractCandidatePaths('Refactor everything under `src/**`.')).toContain('src/**');
    });

    it('extracts `tests/__tests__/`', () => {
      expect(extractCandidatePaths('Add cases to `tests/__tests__/`.')).toContain('tests/__tests__');
    });
  });

  describe('filtering & dedup', () => {
    it('rejects absolute paths', () => {
      expect(extractCandidatePaths('Open `/etc/passwd` (not in scope).')).toEqual([]);
    });

    it('rejects paths with .. parent traversal', () => {
      expect(extractCandidatePaths('See `../config.json` for context.')).toEqual([]);
    });

    it('deduplicates repeated paths', () => {
      const out = extractCandidatePaths('Edit `src/foo.ts`. The file `src/foo.ts` should export.');
      expect(out.filter((p) => p === 'src/foo.ts').length).toBe(1);
    });

    it('sorts longest-first (specific before generic)', () => {
      const out = extractCandidatePaths('Touch `src/components/Button.tsx` and `src/index.ts`.');
      expect(out[0]).toBe('src/components/Button.tsx');
      expect(out[1]).toBe('src/index.ts');
    });
  });

  describe('realistic dino2 story shape', () => {
    it('extracts the AC paths from a vanilla-Vite scaffold story', () => {
      const text = `Create a minimal Vite project (or plain HTML/JS/TS), define core types
(DinoState, Obstacle, GameState) in \`src/types.ts\`, and define game
constants (gravity, jump velocity, game speed, canvas dimensions) in
\`src/constants.ts\`. Set up \`index.html\` with a canvas element.`;
      const out = extractCandidatePaths(text);
      expect(out).toContain('src/types.ts');
      expect(out).toContain('src/constants.ts');
      expect(out).toContain('index.html');
    });

    it('extracts the AC paths from a physics-implementation story', () => {
      const text = `Implement \`applyGravity\`, \`startJump\`, \`endDuck\` in \`src/game/dino.ts\`.
Constants live in \`src/game/constants.ts\`.`;
      const out = extractCandidatePaths(text);
      expect(out).toContain('src/game/dino.ts');
      expect(out).toContain('src/game/constants.ts');
    });

    it('returns [] when the AC mentions no concrete paths', () => {
      const text = `Implement the dino physics system. Use pure functions where possible. Tests should pass.`;
      expect(extractCandidatePaths(text)).toEqual([]);
    });
  });

  describe('false-positive resistance', () => {
    it('does NOT extract from package names like @types/node', () => {
      // The @types pattern doesn't match our regex (needs a `/` AND a recognized ext)
      expect(extractCandidatePaths('Install @types/node for typing.')).toEqual([]);
    });

    it('does NOT extract URLs', () => {
      expect(extractCandidatePaths('See docs at https://example.com/guide.html')).toEqual([]);
    });

    it('does NOT extract version strings like 1.2.3', () => {
      expect(extractCandidatePaths('Bump version to 1.2.3')).toEqual([]);
    });
  });
});
