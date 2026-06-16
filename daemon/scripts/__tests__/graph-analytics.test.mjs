/**
 * graph-analytics.test.mjs — Epic 3 architectural X-ray, now computed in-process
 * (Brandes betweenness + label-propagation communities, no MAGE dependency).
 */

import { describe, it, expect } from 'vitest';
import {
  betweennessCentrality,
  detectCommunities,
  topGodNodes,
  communityCounts,
  surprisingFromMetrics,
  buildInsightsDoc,
  runAnalytics,
} from '../graph-analytics.mjs';

/** Undirected adjacency from {from,to} edges. */
function adjacency(ids, edges) {
  const adj = new Map(ids.map((id) => [id, new Set()]));
  for (const e of edges) {
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  }
  return adj;
}

describe('betweennessCentrality (Brandes)', () => {
  it('puts the bridge node on top of a path a–b–c', () => {
    const ids = ['a', 'b', 'c'];
    const cb = betweennessCentrality(ids, adjacency(ids, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]));
    expect(cb.get('b')).toBe(1); // the only a–c shortest path runs through b
    expect(cb.get('a')).toBe(0);
    expect(cb.get('c')).toBe(0);
  });

  it('makes the hub of a star the god-node', () => {
    const ids = ['hub', 's1', 's2', 's3'];
    const cb = betweennessCentrality(
      ids,
      adjacency(ids, [{ from: 'hub', to: 's1' }, { from: 'hub', to: 's2' }, { from: 'hub', to: 's3' }]),
    );
    expect(cb.get('hub')).toBe(3); // all 3 spoke-pairs route through the hub
    expect(cb.get('s1')).toBe(0);
  });
});

describe('detectCommunities (label propagation)', () => {
  it('separates two disconnected triangles into two communities', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges = [
      { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' },
      { from: 'd', to: 'e' }, { from: 'e', to: 'f' }, { from: 'f', to: 'd' },
    ];
    const comm = detectCommunities(ids, adjacency(ids, edges));
    expect(comm.get('a')).toBe(comm.get('b'));
    expect(comm.get('a')).toBe(comm.get('c'));
    expect(comm.get('d')).toBe(comm.get('e'));
    expect(comm.get('a')).not.toBe(comm.get('d'));
  });
});

describe('topGodNodes', () => {
  it('ranks by centrality desc, drops centrality 0, respects top-N', () => {
    const metrics = [
      { id: 'a', kind: 'file', centrality: 0.9 },
      { id: 'b', kind: 'lambda', centrality: 0.5 },
      { id: 'leaf', kind: 'file', centrality: 0 },
    ];
    expect(topGodNodes(metrics, 15).map((g) => g.id)).toEqual(['a', 'b']);
    expect(topGodNodes(metrics, 1)).toHaveLength(1);
  });
});

describe('surprisingFromMetrics (Story 3.3)', () => {
  const byId = new Map([
    ['api', { id: 'api', title: 'GET /x', centrality: 0.8, community: 0 }],
    ['tbl', { id: 'tbl', title: 'Orders', centrality: 0.7, community: 1 }],
    ['util', { id: 'util', title: 'util.ts', centrality: 0.05, community: 0 }],
  ]);

  it('surfaces a cross-community edge between two high-centrality nodes', () => {
    const sc = surprisingFromMetrics([{ s: 'api', t: 'tbl', type: 'READS' }], byId, 0.1);
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatchObject({ source: 'api', target: 'tbl', type: 'READS', sourceCommunity: 0, targetCommunity: 1 });
  });

  it('ignores same-community + low-centrality edges', () => {
    const sc = surprisingFromMetrics(
      [{ s: 'api', t: 'util', type: 'IMPORTS' }], // same community (0)
      byId,
      0.1,
    );
    expect(sc).toEqual([]);
  });
});

describe('runAnalytics (in-process, against a fake read session)', () => {
  function makeSession({ nodes, edges }) {
    const writes = [];
    return {
      writes,
      async run(q, p) {
        if (/RETURN n\.nodeId AS id/.test(q)) return { records: nodes.map((n) => ({ get: (k) => n[k] })) };
        if (/RETURN a\.nodeId AS s/.test(q)) return { records: edges.map((e) => ({ get: (k) => e[k] })) };
        if (/UNWIND \$rows/.test(q)) { writes.push(p.rows); return { records: [] }; }
        return { records: [] };
      },
      async close() {},
    };
  }

  it('computes centrality + communities, writes them back, and ranks god-nodes', async () => {
    const session = makeSession({
      nodes: [
        { id: 'hub', kind: 'file', title: 'hub' },
        { id: 's1', kind: 'function', title: 's1' },
        { id: 's2', kind: 'function', title: 's2' },
        { id: 's3', kind: 'function', title: 's3' },
      ],
      edges: [
        { s: 'hub', t: 's1', type: 'DEFINES' },
        { s: 'hub', t: 's2', type: 'DEFINES' },
        { s: 'hub', t: 's3', type: 'DEFINES' },
      ],
    });
    const a = await runAnalytics(session, 'p');
    expect(a.mageAvailable).toBe(true);
    expect(a.engine).toBe('node');
    expect(a.godNodes[0].id).toBe('hub');
    expect(session.writes[0]).toHaveLength(4); // metrics written back
  });

  it('returns empty, well-formed results for an empty project (graceful)', async () => {
    const a = await runAnalytics(makeSession({ nodes: [], edges: [] }), 'empty');
    expect(a.mageAvailable).toBe(false);
    expect(a.godNodes).toEqual([]);
    expect(a.metrics).toEqual([]);
  });
});

describe('buildInsightsDoc', () => {
  it('shapes the per-node metric map the UI overlay reads', () => {
    const analytics = {
      mageAvailable: true,
      centralityAvailable: true,
      communityAvailable: true,
      engine: 'node',
      metrics: [{ id: 'hub', kind: 'file', centrality: 0.9, community: 2 }],
      godNodes: [{ id: 'hub', kind: 'file', title: 'hub', centrality: 0.9 }],
      communities: [{ community: 2, count: 1 }],
      surprising: [],
    };
    const doc = buildInsightsDoc({ projectId: 'p', generatedAt: 't', analytics, threshold: 0 });
    expect(doc.nodeMetrics.hub).toEqual({ centrality: 0.9, community: 2 });
    expect(doc.mageAvailable).toBe(true);
    expect(doc.engine).toBe('node');
  });
});
