/**
 * dedup.test.ts — Skills Institution, Story 2.4.
 */

import { describe, it, expect } from 'vitest';
import { findNearDuplicate } from '../dedup';

const existing = [
  { name: 'write-good-tests', description: 'Write good unit tests that are stable and fast' },
  { name: 'deploy-lambda', description: 'Deploy a Lambda function with SST' },
];

describe('findNearDuplicate (heuristic)', () => {
  it('flags a near-duplicate above threshold', () => {
    const m = findNearDuplicate(
      { name: 'write-stable-tests', description: 'Write good stable unit tests that are fast' },
      existing,
      { threshold: 0.4 },
    );
    expect(m?.canonicalName).toBe('write-good-tests');
    expect(m?.similarity).toBeGreaterThanOrEqual(0.4);
  });

  it('returns null when nothing is similar enough', () => {
    expect(
      findNearDuplicate(
        { name: 'paint-pixel-art', description: 'Draw retro dragon sprites' },
        existing,
      ),
    ).toBeNull();
  });

  it('excludes the same name (an update is not a duplicate)', () => {
    expect(
      findNearDuplicate(
        { name: 'write-good-tests', description: 'Write good unit tests that are stable and fast' },
        existing,
      ),
    ).toBeNull();
  });

  it('picks the best match when several pass', () => {
    const m = findNearDuplicate(
      { name: 'unit-test-writer', description: 'write good stable fast unit tests' },
      [
        { name: 'write-good-tests', description: 'Write good unit tests that are stable and fast' },
        { name: 'test-helper', description: 'unit tests helper' },
      ],
      { threshold: 0.2 },
    );
    expect(m?.canonicalName).toBe('write-good-tests');
  });
});

describe('findNearDuplicate (cosine over vectors)', () => {
  it('uses cosine when vectors are supplied for both', () => {
    const m = findNearDuplicate(
      { name: 'a', description: 'x' },
      [{ name: 'b', description: 'y' }],
      {
        threshold: 0.9,
        vectors: { candidate: [1, 0, 0], byName: { b: [0.99, 0.01, 0] } },
      },
    );
    expect(m?.canonicalName).toBe('b');
    expect(m?.similarity).toBeGreaterThan(0.9);
  });

  it('falls back to heuristic when a target has no vector', () => {
    const m = findNearDuplicate(
      { name: 'write-tests', description: 'write good stable unit tests' },
      [{ name: 'write-good-tests', description: 'write good unit tests stable' }],
      { threshold: 0.3, vectors: { candidate: [1, 0], byName: {} } },
    );
    expect(m?.canonicalName).toBe('write-good-tests'); // heuristic path
  });
});
