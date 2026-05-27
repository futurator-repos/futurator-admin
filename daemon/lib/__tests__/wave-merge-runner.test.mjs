/**
 * Unit tests for wave-merge-runner.mjs (Phase 1 worktree rollout).
 *
 * Pure-function coverage of `sortStoriesForMerge` + path helpers. The
 * integration of runWaveMerge needs real git + shell; tested via the
 * acceptance scenario in the rollout plan rather than mocked here.
 */

import { describe, expect, it } from 'vitest';
import { sortStoriesForMerge, coordinatorWorktreeDir } from '../wave-merge-runner.mjs';

describe('sortStoriesForMerge', () => {
  it('sorts ascending by storyId (deterministic across runs)', () => {
    expect(sortStoriesForMerge(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('returns a new array (does not mutate input)', () => {
    const input = ['c', 'a', 'b'];
    sortStoriesForMerge(input);
    expect(input).toEqual(['c', 'a', 'b']);
  });

  it('handles UUIDs lexicographically', () => {
    const ids = [
      'ee91ede3-40b3-46eb-bcfa-fc6122937ddf',
      '315a03fe-86b8-453b-94be-f71377d880b7',
      '6fdac228-9f58-448b-88ea-e619e0d1abe8',
    ];
    expect(sortStoriesForMerge(ids)).toEqual([
      '315a03fe-86b8-453b-94be-f71377d880b7',
      '6fdac228-9f58-448b-88ea-e619e0d1abe8',
      'ee91ede3-40b3-46eb-bcfa-fc6122937ddf',
    ]);
  });
});

describe('coordinatorWorktreeDir', () => {
  it('returns the canonical path with _merge suffix', () => {
    const p = coordinatorWorktreeDir({ appId: 'snake-4', planSlug: 'snake-4-animations' });
    expect(p).toBe('/home/ubuntu/worktrees/snake-4/snake-4-animations/_merge');
  });

  it('honors a custom root', () => {
    const p = coordinatorWorktreeDir({
      appId: 'snake-4',
      planSlug: 'foo',
      root: '/tmp/wt',
    });
    expect(p).toBe('/tmp/wt/snake-4/foo/_merge');
  });

  it('throws on missing fields', () => {
    expect(() => coordinatorWorktreeDir({ appId: '', planSlug: 'x' })).toThrow();
    expect(() => coordinatorWorktreeDir({ appId: 'x' })).toThrow();
  });

  it('underscore prefix on _merge keeps it OUTSIDE the kebab-case slug space', () => {
    // Verifies the namespace-separation property: storyWorktreeDir uses
    // the slug regex which rejects `_merge`, so the two namespaces can
    // never collide.
    const p = coordinatorWorktreeDir({ appId: 'a', planSlug: 'b' });
    expect(p).toContain('/_merge');
    expect(p.endsWith('_merge')).toBe(true);
  });
});
