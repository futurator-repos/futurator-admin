/**
 * embedding-knn.test.mjs — semantic-neighbour precompute for the snapshot.
 */

import { describe, it, expect } from 'vitest';
import { cosineSimilarity, computeSimilarTo } from '../lib/embedding-knn.mjs';

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, handles zero vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('computeSimilarTo', () => {
  it('links each node to its nearest neighbours above the threshold', () => {
    const items = [
      { id: 'a', embedding: [1, 0, 0] },
      { id: 'a2', embedding: [0.98, 0.1, 0] }, // ~a
      { id: 'b', embedding: [0, 1, 0] }, // orthogonal to a
    ];
    const sim = computeSimilarTo(items, { k: 5, minScore: 0.5 });
    expect(sim.get('a')?.[0].id).toBe('a2'); // a's nearest is a2
    expect(sim.get('a')?.some((s) => s.id === 'b')).toBe(false); // b filtered (below 0.5)
  });

  it('respects k and skips nodes without embeddings', () => {
    const items = [
      { id: 'x', embedding: [1, 1, 1] },
      { id: 'y', embedding: [1, 1, 0.9] },
      { id: 'z', embedding: [1, 0.9, 1] },
      { id: 'noemb', embedding: null },
    ];
    const sim = computeSimilarTo(items, { k: 1, minScore: 0.1 });
    expect(sim.get('x')).toHaveLength(1);
    expect(sim.has('noemb')).toBe(false);
  });

  it('returns an empty map above the node cap (bounded cost)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, embedding: [i, 1] }));
    expect(computeSimilarTo(items, { maxNodes: 5 }).size).toBe(0);
  });
});
