/**
 * ast-facts-reconcile.test.mjs — F14 refuse-to-narrow safety net.
 *
 * A partial diff-manifest scan (per-story / wave-candidate worktree) must never
 * shrink the project's known file set. These cover the path detection + the
 * additive union that keeps the full-project file set intact.
 */

import { describe, it, expect } from 'vitest';
import {
  isEphemeralScanRoot,
  unionAstFiles,
} from '../lib/ast-facts-reconcile.mjs';

describe('isEphemeralScanRoot', () => {
  it('flags per-story worktree roots', () => {
    expect(isEphemeralScanRoot('/home/ubuntu/worktrees/songster/plan-x/story-3')).toBe(true);
  });
  it('flags wave-candidate / coordinator worktree roots', () => {
    expect(isEphemeralScanRoot('/home/ubuntu/worktrees/app/plan/_cand/job-9')).toBe(true);
    expect(isEphemeralScanRoot('/home/ubuntu/worktrees/app/plan/_merge')).toBe(true);
    expect(isEphemeralScanRoot('/home/ubuntu/worktrees/app/plan/_party')).toBe(true);
    expect(isEphemeralScanRoot('/home/ubuntu/worktrees/app/plan/_assist')).toBe(true);
  });
  it('treats the integrated project tree as authoritative (not ephemeral)', () => {
    expect(isEphemeralScanRoot('/home/ubuntu/projects/songster')).toBe(false);
  });
  it('is null-safe', () => {
    expect(isEphemeralScanRoot(undefined)).toBe(false);
    expect(isEphemeralScanRoot(null)).toBe(false);
  });
});

describe('unionAstFiles — refuse to narrow', () => {
  const full = {
    files: [
      { path: 'src/a.ts', functions: [{ name: 'a' }] },
      { path: 'src/b.ts', functions: [{ name: 'b' }] },
      { path: 'src/c.ts', functions: [{ name: 'c' }] },
    ],
  };

  it('a partial scan never shrinks the file set', () => {
    const partial = { files: [{ path: 'src/b.ts', functions: [{ name: 'b2' }] }] };
    const merged = unionAstFiles(partial, full);
    expect(merged.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('fresh per-file facts from the partial scan win for covered files', () => {
    const partial = { files: [{ path: 'src/b.ts', functions: [{ name: 'b2' }] }] };
    const merged = unionAstFiles(partial, full);
    const b = merged.find((f) => f.path === 'src/b.ts');
    expect(b.functions).toEqual([{ name: 'b2' }]);
  });

  it('untouched files keep their full-scan facts', () => {
    const partial = { files: [{ path: 'src/b.ts', functions: [{ name: 'b2' }] }] };
    const merged = unionAstFiles(partial, full);
    expect(merged.find((f) => f.path === 'src/a.ts').functions).toEqual([{ name: 'a' }]);
  });

  it('brand-new files introduced by the partial scan are added', () => {
    const partial = { files: [{ path: 'src/new.ts', functions: [] }] };
    const merged = unionAstFiles(partial, full);
    expect(merged.map((f) => f.path).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/new.ts',
    ]);
  });

  it('handles a missing/empty full doc gracefully', () => {
    const partial = { files: [{ path: 'src/x.ts' }] };
    expect(unionAstFiles(partial, {}).map((f) => f.path)).toEqual(['src/x.ts']);
    expect(unionAstFiles(partial, null).map((f) => f.path)).toEqual(['src/x.ts']);
  });
});
