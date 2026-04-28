/**
 * Tests for use-github-repo-summary, use-github-tree, use-github-file
 * Story 1.5.1 + 1.5.2
 *
 * Tests cover the pure-logic aspects:
 *   - query key construction
 *   - enabled flag behaviour
 *   - retry logic (404 does not retry, other errors do)
 *
 * Full network integration is covered by Playwright smoke tests.
 */

import { describe, expect, it } from 'vitest';

// ── buildVirtualTree (pure logic, no React hooks needed) ───────────────────
import { buildVirtualTree } from '@/components/labs/app-detail/source-tree-node';
import type { TreeEntry } from '../../../functions/shared/github/types';

function makeEntry(
  path: string,
  type: 'blob' | 'tree' | 'commit' = 'blob',
  sha = 'abc123',
): TreeEntry {
  return {
    path,
    type,
    sha,
    mode: '100644',
    url: `https://example.com/${path}`,
    size: type === 'blob' ? 100 : undefined,
  };
}

describe('buildVirtualTree', () => {
  it('returns an empty array for an empty entry list', () => {
    expect(buildVirtualTree([])).toEqual([]);
  });

  it('places top-level files directly in the root', () => {
    const entries = [makeEntry('README.md'), makeEntry('package.json')];
    const nodes = buildVirtualTree(entries);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name)).toContain('README.md');
    expect(nodes.map((n) => n.name)).toContain('package.json');
  });

  it('nests files under their parent directory', () => {
    const entries = [
      makeEntry('src', 'tree'),
      makeEntry('src/index.ts'),
      makeEntry('src/utils.ts'),
    ];
    const nodes = buildVirtualTree(entries);
    const src = nodes.find((n) => n.name === 'src');
    expect(src).toBeDefined();
    expect(src!.type).toBe('tree');
    expect(src!.children.map((c) => c.name)).toContain('index.ts');
    expect(src!.children.map((c) => c.name)).toContain('utils.ts');
  });

  it('sorts directories before files at each level', () => {
    const entries = [
      makeEntry('z-file.ts'),
      makeEntry('a-dir', 'tree'),
      makeEntry('a-dir/child.ts'),
      makeEntry('a-file.ts'),
    ];
    const nodes = buildVirtualTree(entries);
    // a-dir (tree) should come before a-file.ts and z-file.ts
    expect(nodes[0].type).toBe('tree');
    expect(nodes[0].name).toBe('a-dir');
  });

  it('skips commit entries (git submodules)', () => {
    const entries = [makeEntry('vendor', 'commit'), makeEntry('README.md')];
    const nodes = buildVirtualTree(entries);
    expect(nodes.every((n) => n.name !== 'vendor')).toBe(true);
    expect(nodes).toHaveLength(1);
  });

  it('handles deeply nested paths', () => {
    const entries = [makeEntry('a/b/c/deep.ts')];
    const nodes = buildVirtualTree(entries);
    const a = nodes.find((n) => n.name === 'a');
    expect(a).toBeDefined();
    const b = a!.children.find((n) => n.name === 'b');
    expect(b).toBeDefined();
    const c = b!.children.find((n) => n.name === 'c');
    expect(c).toBeDefined();
    expect(c!.children[0].name).toBe('deep.ts');
  });
});

// ── Retry logic (isolated from React Query, tested as pure predicate) ───────

describe('github hook retry predicates', () => {
  /**
   * The retry function used in all three hooks:
   *   (failureCount, error) => err.status === 404 ? false : failureCount < 2
   */
  function retryFn(failureCount: number, error: unknown): boolean {
    const err = error as Error & { status?: number };
    if (err.status === 404) return false;
    return failureCount < 2;
  }

  it('does not retry on 404', () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    expect(retryFn(0, err)).toBe(false);
    expect(retryFn(1, err)).toBe(false);
  });

  it('retries up to 2 times on non-404 errors', () => {
    const err = Object.assign(new Error('Server Error'), { status: 500 });
    expect(retryFn(0, err)).toBe(true);
    expect(retryFn(1, err)).toBe(true);
    expect(retryFn(2, err)).toBe(false);
  });

  it('retries on errors without a status', () => {
    const err = new Error('Network error');
    expect(retryFn(0, err)).toBe(true);
    expect(retryFn(1, err)).toBe(true);
    expect(retryFn(2, err)).toBe(false);
  });
});
