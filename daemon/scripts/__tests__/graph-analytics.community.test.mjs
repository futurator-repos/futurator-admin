/**
 * graph-analytics.community.test.mjs — Epic 3 Story 3.2 (Louvain communities).
 */

import { describe, it, expect } from 'vitest';
import { runAnalytics, communityCounts } from '../graph-analytics.mjs';

describe('communityCounts (Story 3.2)', () => {
  it('counts membership per community, largest first', () => {
    const metrics = [
      { id: 'a', community: 0 },
      { id: 'b', community: 0 },
      { id: 'c', community: 1 },
      { id: 'd', community: null }, // unassigned — ignored
    ];
    expect(communityCounts(metrics)).toEqual([
      { community: 0, count: 2 },
      { community: 1, count: 1 },
    ]);
  });

  it('breaks count ties by community id for stable UI coloring', () => {
    const metrics = [
      { id: 'a', community: 5 },
      { id: 'b', community: 2 },
    ];
    expect(communityCounts(metrics).map((c) => c.community)).toEqual([2, 5]);
  });
});

describe('runAnalytics — communities (in-process Leiden)', () => {
  function makeSession({ nodes, edges }) {
    return {
      async run(q) {
        if (/RETURN n\.nodeId AS id/.test(q)) return { records: nodes.map((n) => ({ get: (k) => n[k] })) };
        if (/RETURN a\.nodeId AS s/.test(q)) return { records: edges.map((e) => ({ get: (k) => e[k] })) };
        return { records: [] };
      },
      async close() {},
    };
  }

  it('detects communities from the graph (two clusters → ≥2 communities)', async () => {
    const session = makeSession({
      nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, kind: 'file', title: id })),
      edges: [
        { s: 'a', t: 'b', type: 'IMPORTS' }, { s: 'b', t: 'c', type: 'IMPORTS' }, { s: 'c', t: 'a', type: 'IMPORTS' },
        { s: 'd', t: 'e', type: 'IMPORTS' }, { s: 'e', t: 'f', type: 'IMPORTS' }, { s: 'f', t: 'd', type: 'IMPORTS' },
      ],
    });
    const a = await runAnalytics(session, 'p');
    expect(a.communityAvailable).toBe(true);
    expect(a.communities.length).toBeGreaterThanOrEqual(2);
  });
});
