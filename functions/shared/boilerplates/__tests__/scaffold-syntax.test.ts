// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { transformSync } from 'esbuild';
import { BOILERPLATE_REGISTRY } from '../registry';

/**
 * Scaffold files ship as template-string contents inside registry.ts, so `tsc`
 * never parses them — a brace/paren slip in a scaffold is invisible until a
 * generated app fails to build (breaking EVERY new app of that boilerplate).
 *
 * This guard esbuild-transforms every shipped .ts/.tsx scaffold to catch SYNTAX
 * errors (not type errors) at unit-test time. Added with the VQA v3 Phase 2b
 * seam edits (forceStatus/dispatch/__force/events) to registry.ts.
 */
describe('boilerplate scaffolds — syntax (esbuild transform)', () => {
  const files: Array<{ boilerplate: string; path: string; content: string }> = [];
  for (const [boilerplate, meta] of Object.entries(BOILERPLATE_REGISTRY)) {
    for (const f of meta.augmentFiles ?? []) {
      if (/\.tsx?$/.test(f.path)) files.push({ boilerplate, path: f.path, content: f.content });
    }
  }

  it('has scaffold files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('$boilerplate · $path parses', ({ path, content }) => {
    expect(() =>
      transformSync(content, {
        loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
        // syntax-only: don't resolve imports or check types
      }),
    ).not.toThrow();
  });
});
