/**
 * graph-analytics.test.mjs — Epic 3 Stories 3.1 (god-nodes / centrality) and
 * 3.3 (surprising connections), plus graceful MAGE degradation.
 */

import { describe, it, expect } from 'vitest';
import { makeAnalyticsSession } from './helpers/fake-analytics-graph.mjs';
import {
  runAnalytics,
  topGodNodes,
  surprisingConnections,
  buildInsightsDoc,
} from '../graph-analytics.mjs';

describe('topGodNodes (Story 3.1)', () => {
  it('ranks by centrality desc and keeps only path-bearing nodes (centrality > 0)', () => {
    const metrics = [
      { id: 'a', kind: 'file', centrality: 0.9 },
      { id: 'b', kind: 'lambda', centrality: 0.5 },
      { id: 'leaf', kind: 'file', centrality: 0 }, // on no shortest path — excluded
    ];
    const god = topGodNodes(metrics, 15);
    expect(god.map((g) => g.id)).toEqual(['a', 'b']);
    expect(god[0]).toMatchObject({ id: 'a', kind: 'file', centrality: 0.9 });
  });

  it('respects the top-N cap', () => {
    const metrics = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      kind: 'file',
      centrality: i + 1,
    }));
    expect(topGodNodes(metrics, 5)).toHaveLength(5);
    expect(topGodNodes(metrics, 5)[0].id).toBe('n29');
  });
});

describe('runAnalytics — centrality + god-nodes (Story 3.1)', () => {
  it('sets centrality and produces a top-N god-node list', async () => {
    const session = makeAnalyticsSession({
      nodes: [
        { id: 'hub', kind: 'file', centrality: 1.0, community: 0 },
        { id: 'spoke', kind: 'function', centrality: 0.1, community: 0 },
      ],
    });
    const a = await runAnalytics(session, 'p');
    expect(a.centralityAvailable).toBe(true);
    expect(a.mageAvailable).toBe(true);
    expect(a.godNodes[0].id).toBe('hub');
  });

  it('degrades gracefully when MAGE is unavailable — never throws, empty results', async () => {
    const session = makeAnalyticsSession({
      nodes: [{ id: 'hub', kind: 'file', centrality: 1.0, community: 0 }],
      mage: { centrality: false, community: false },
    });
    const a = await runAnalytics(session, 'p');
    expect(a.mageAvailable).toBe(false);
    expect(a.centralityAvailable).toBe(false);
    expect(a.godNodes).toEqual([]);
    expect(a.surprising).toEqual([]);
    expect(a.metrics).toEqual([]);
  });
});

describe('surprisingConnections (Story 3.3)', () => {
  const nodes = [
    { id: 'api', kind: 'endpoint', title: 'GET /x', centrality: 0.8, community: 0 },
    { id: 'tbl', kind: 'table', title: 'Orders', centrality: 0.7, community: 1 },
    { id: 'util', kind: 'file', title: 'util.ts', centrality: 0.05, community: 0 },
    { id: 'helper', kind: 'file', title: 'helper.ts', centrality: 0.05, community: 1 },
  ];

  it('surfaces a cross-community edge between two high-centrality endpoints', async () => {
    const session = makeAnalyticsSession({
      nodes,
      edges: [{ from: 'api', to: 'tbl', type: 'READS' }],
    });
    const sc = await surprisingConnections(session, 'p', 0.1);
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatchObject({
      source: 'api',
      target: 'tbl',
      type: 'READS',
      sourceCommunity: 0,
      targetCommunity: 1,
    });
  });

  it('ignores same-community edges and low-centrality endpoints', async () => {
    const session = makeAnalyticsSession({
      nodes,
      edges: [
        { from: 'api', to: 'util', type: 'IMPORTS' }, // same community (0)
        { from: 'util', to: 'helper', type: 'CALLS' }, // both below threshold
      ],
    });
    const sc = await surprisingConnections(session, 'p', 0.1);
    expect(sc).toEqual([]);
  });
});

describe('buildInsightsDoc (Story 3.4 contract)', () => {
  it('shapes the per-node metric map the UI overlay reads', () => {
    const analytics = {
      mageAvailable: true,
      centralityAvailable: true,
      communityAvailable: true,
      metrics: [{ id: 'hub', kind: 'file', centrality: 0.9, community: 2 }],
      godNodes: [{ id: 'hub', kind: 'file', title: 'hub', centrality: 0.9 }],
      communities: [{ community: 2, count: 1 }],
      surprising: [],
    };
    const doc = buildInsightsDoc({ projectId: 'p', generatedAt: 't', analytics, threshold: 0 });
    expect(doc.nodeMetrics.hub).toEqual({ centrality: 0.9, community: 2 });
    expect(doc.godNodes[0].id).toBe('hub');
    expect(doc.mageAvailable).toBe(true);
  });
});
