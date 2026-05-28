/**
 * Unit tests for wave-merge-runner.mjs (Phase 1 worktree rollout).
 *
 * Pure-function coverage of `sortStoriesForMerge` + path helpers. The
 * integration of runWaveMerge needs real git + shell; tested via the
 * acceptance scenario in the rollout plan rather than mocked here.
 */

import { describe, expect, it } from 'vitest';
import {
  sortStoriesForMerge,
  coordinatorWorktreeDir,
  isNoOpTestExit,
} from '../wave-merge-runner.mjs';

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

// 2026-05-28 — the wave-build gate must not treat a no-op test command
// (no `test` script, or a runner that found zero test files) as a
// failure. A types/scaffold wave legitimately ships no runtime tests.
describe('isNoOpTestExit', () => {
  it('matches npm "Missing script: test"', () => {
    expect(isNoOpTestExit('npm error Missing script: "test"')).toBe(true);
    expect(isNoOpTestExit('Missing script: test')).toBe(true);
  });

  it('matches the npm default "no test specified" fallback', () => {
    expect(isNoOpTestExit('Error: no test specified')).toBe(true);
  });

  it('matches vitest "No test files found"', () => {
    expect(isNoOpTestExit('No test files found, exiting with code 1')).toBe(true);
  });

  it('matches jest "No tests found"', () => {
    expect(isNoOpTestExit('No tests found, exiting with code 1')).toBe(true);
  });

  it('does NOT match a real test failure', () => {
    expect(
      isNoOpTestExit('FAIL src/game/maze.test.ts\n  ✗ computes tile index\n  1 failed'),
    ).toBe(false);
  });

  it('does NOT match a real build/compile error', () => {
    expect(
      isNoOpTestExit("src/game/types.ts(12,3): error TS2322: Type 'string' is not assignable"),
    ).toBe(false);
  });

  it('returns false for empty / undefined output', () => {
    expect(isNoOpTestExit('')).toBe(false);
    expect(isNoOpTestExit(undefined)).toBe(false);
  });
});
