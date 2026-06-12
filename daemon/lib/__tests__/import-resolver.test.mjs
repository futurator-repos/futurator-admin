/**
 * G1 (pacman1 graph audit, 2026-06-12) — import resolution for the AST →
 * Memgraph edge translation. Pins the two disconnected-dots diseases:
 * alias blindness (`@/` imports dropped) and changed-files-only blindness
 * (imports of unchanged files dropped).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAliasMap, resolveImportSource } from '../../scripts/lib/import-resolver.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'g1-resolver-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadAliasMap', () => {
  it('reads compilerOptions.paths from tsconfig.json (JSONC tolerated)', () => {
    writeFileSync(
      join(root, 'tsconfig.json'),
      `{
        // Next.js style config with comments
        "compilerOptions": {
          /* block comment */
          "baseUrl": ".",
          "paths": {
            "@/*": ["./src/*"],
            "#lib/*": ["./packages/lib/*"],
          },
        },
      }`,
    );
    const map = loadAliasMap(root);
    expect(map).toContainEqual({ prefix: '@/', targetPrefix: 'src/' });
    expect(map).toContainEqual({ prefix: '#lib/', targetPrefix: 'packages/lib/' });
    // Longest prefix first (deterministic matching).
    expect(map[0].prefix.length).toBeGreaterThanOrEqual(map[map.length - 1].prefix.length);
  });

  it('falls back to @/ → src/ when tsconfig is absent or has no paths', () => {
    expect(loadAliasMap(root)).toEqual([{ prefix: '@/', targetPrefix: 'src/' }]);
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    expect(loadAliasMap(root)).toEqual([{ prefix: '@/', targetPrefix: 'src/' }]);
  });
});

describe('resolveImportSource', () => {
  const aliasMap = [{ prefix: '@/', targetPrefix: 'src/' }];

  it('still resolves relative imports against the AST-facts set', () => {
    const known = new Set(['src/game/types.ts', 'src/game/dino.ts']);
    expect(resolveImportSource('src/game/dino.ts', './types', known)).toBe('src/game/types.ts');
    expect(resolveImportSource('src/game/dino.ts', '../game/types', known)).toBe(
      'src/game/types.ts',
    );
  });

  it('ALIAS FIX: resolves @/ imports (the pacman1 disconnected-dots disease)', () => {
    const known = new Set(['src/game/maze.ts']);
    expect(resolveImportSource('src/app/page.tsx', '@/game/maze', known, { aliasMap })).toBe(
      'src/game/maze.ts',
    );
  });

  it('external packages stay null', () => {
    const known = new Set(['src/a.ts']);
    expect(resolveImportSource('src/a.ts', 'react', known, { aliasMap })).toBeNull();
    expect(resolveImportSource('src/a.ts', 'lodash/merge', known, { aliasMap })).toBeNull();
  });

  it('CHANGED-FILES FIX: falls back to on-disk existence for unchanged files', () => {
    // The story only changed page.tsx — maze.ts is NOT in the AST facts,
    // but it exists in the worktree. Pre-fix this import produced no edge.
    mkdirSync(join(root, 'src', 'game'), { recursive: true });
    writeFileSync(join(root, 'src', 'game', 'maze.ts'), 'export const m = 1;');
    const known = new Set(['src/app/page.tsx']);
    expect(
      resolveImportSource('src/app/page.tsx', '@/game/maze', known, { aliasMap, rootDir: root }),
    ).toBe('src/game/maze.ts');
    // Relative import of an unchanged file resolves the same way.
    expect(
      resolveImportSource('src/game/dino.ts', './maze', known, { aliasMap, rootDir: root }),
    ).toBe('src/game/maze.ts');
  });

  it('index convention + explicit-extension imports work through aliases', () => {
    mkdirSync(join(root, 'src', 'lib', 'utils'), { recursive: true });
    writeFileSync(join(root, 'src', 'lib', 'utils', 'index.ts'), 'export {};');
    expect(
      resolveImportSource('src/app/page.tsx', '@/lib/utils', new Set(), {
        aliasMap,
        rootDir: root,
      }),
    ).toBe('src/lib/utils/index.ts');
    expect(
      resolveImportSource('src/app/page.tsx', '@/lib/utils/index.ts', new Set(), {
        aliasMap,
        rootDir: root,
      }),
    ).toBe('src/lib/utils/index.ts');
  });
});
