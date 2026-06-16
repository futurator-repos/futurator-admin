/**
 * graph-analytics.community.test.mjs — Epic 3 Story 3.2 (Louvain communities).
 */

import { describe, it, expect } from 'vitest';
import { makeAnalyticsSession } from './helpers/fake-analytics-graph.mjs';
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

describe('runAnalytics — communities (Story 3.2)', () => {
  it('populates community membership counts when Louvain is available', async () => {
    const session = makeAnalyticsSession({
      nodes: [
        { id: 'a', centrality: 0.5, community: 0 },
        { id: 'b', centrality: 0.4, community: 0 },
        { id: 'c', centrality: 0.3, community: 1 },
      ],
    });
    const a = await runAnalytics(session, 'p');
    expect(a.communityAvailable).toBe(true);
    expect(a.communities).toEqual([
      { community: 0, count: 2 },
      { community: 1, count: 1 },
    ]);
  });

  it('still computes centrality god-nodes when only Louvain is missing', async () => {
    const session = makeAnalyticsSession({
      nodes: [{ id: 'hub', centrality: 1.0, community: 0 }],
      mage: { community: false },
    });
    const a = await runAnalytics(session, 'p');
    expect(a.centralityAvailable).toBe(true);
    expect(a.communityAvailable).toBe(false);
    expect(a.godNodes[0].id).toBe('hub');
    expect(a.communities).toEqual([]);
    // surprising connections need BOTH dimensions — skipped here
    expect(a.surprising).toEqual([]);
  });
});
