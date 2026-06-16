/**
 * blast-radius.test.mjs — Story 4.2. blast_radius returns ≤2-hop cross-stack
 * reach grouped by kind, and — critically — the W5 event edges
 * (TRIGGERS/SUBSCRIBES/EMITS) ARE traversed, so an async S3/SNS/cron chain is
 * never a false "all-clear". Plus god_nodes / orphans / shortest_path.
 */

import { describe, it, expect } from 'vitest';
import {
  blastRadius,
  godNodes,
  orphans,
  shortestPath,
  BLAST_EDGE_TYPES,
} from '../mycelium-mcp.mjs';
import { makeMcpSession } from './helpers/fake-mcp-graph.mjs';

// A cron lambda's source file that (a) writes a table directly and (b) is the
// tail of an async event chain: S3 upload TRIGGERS it, and that same event
// source EMITS to a topic two hops out — reachable ONLY through event edges.
const chain = () =>
  makeMcpSession({
    projectId: 'futurator-admin',
    nodes: [
      { id: 'code/functions--cron--agg.ts', kind: 'file', title: 'cost-aggregator.ts' },
      { id: 'tbl/Costs', kind: 'table', title: 'CostsTable' },
      { id: 'evt/s3/upload', kind: 'eventSource', title: 'S3 upload' },
      { id: 'topic/notify', kind: 'topic', title: 'AttentionTopic' },
      { id: 'svc/anthropic', kind: 'externalService', title: 'Anthropic', billable: true },
      { id: 'code/functions--unrelated.ts', kind: 'file', title: 'unrelated.ts' },
    ],
    edges: [
      { from: 'code/functions--cron--agg.ts', to: 'tbl/Costs', type: 'WRITES' },
      { from: 'evt/s3/upload', to: 'code/functions--cron--agg.ts', type: 'TRIGGERS' },
      { from: 'evt/s3/upload', to: 'topic/notify', type: 'EMITS' },
      { from: 'code/functions--cron--agg.ts', to: 'svc/anthropic', type: 'CALLS_SERVICE' },
    ],
  });

describe('blast_radius (Story 4.2)', () => {
  it('includes the W5 event chain — the cron/S3 topic is NOT a false all-clear', async () => {
    const res = await blastRadius(chain(), {
      files: ['code/functions--cron--agg.ts'],
      projectId: 'futurator-admin',
    });
    const reachedIds = Object.values(res.groups)
      .flat()
      .map((n) => n.id);
    // 1 hop, plain edge
    expect(reachedIds).toContain('tbl/Costs');
    // 1 hop, event edge (TRIGGERS)
    expect(reachedIds).toContain('evt/s3/upload');
    // 2 hops, reachable ONLY via the event chain (TRIGGERS → EMITS)
    expect(reachedIds).toContain('topic/notify');
    // unrelated file is not connected → excluded
    expect(reachedIds).not.toContain('code/functions--unrelated.ts');
  });

  it('groups reachable nodes by kind and flags paid-service exposure', async () => {
    const res = await blastRadius(chain(), {
      files: ['code/functions--cron--agg.ts'],
      projectId: 'futurator-admin',
    });
    expect(res.groups.table.map((n) => n.id)).toEqual(['tbl/Costs']);
    expect(res.groups.eventSource).toBeTruthy();
    expect(res.groups.externalService.map((n) => n.id)).toEqual(['svc/anthropic']);
    expect(res.touchesPaidService).toBe(true);
    expect(res.totalReached).toBe(reachedCount(res));
  });

  it('the edge set mandated by the AC is present (incl. all three event edges)', () => {
    for (const t of ['TRIGGERS', 'SUBSCRIBES', 'EMITS', 'CALLS_ENDPOINT', 'CALLS_SERVICE', 'ROUTES']) {
      expect(BLAST_EDGE_TYPES).toContain(t);
    }
  });
});

describe('supporting graph tools (Story 4.2)', () => {
  const s = () =>
    makeMcpSession({
      projectId: 'p',
      nodes: [
        { id: 'a', kind: 'file', centrality: 0.9 },
        { id: 'b', kind: 'file', centrality: 0.2 },
        { id: 'c', kind: 'file', centrality: 0 },
        { id: 'lonely', kind: 'file' },
        { id: 'tbl/X', kind: 'table' },
      ],
      edges: [
        { from: 'a', to: 'b', type: 'IMPORTS' },
        { from: 'b', to: 'tbl/X', type: 'READS' },
        { from: 'c', to: 'a', type: 'IMPORTS' }, // c is connected (centrality 0, but not orphan)
      ],
    });

  it('god_nodes ranks by centrality and excludes zero-betweenness nodes', async () => {
    const out = await godNodes(s(), { projectId: 'p' });
    expect(out.map((n) => n.id)).toEqual(['a', 'b']); // c (0) excluded, lonely (null) excluded
  });

  it('orphans surfaces degree-0 nodes only', async () => {
    const out = await orphans(s(), { projectId: 'p' });
    expect(out.map((n) => n.id)).toEqual(['lonely']);
  });

  it('shortest_path finds a cross-layer path component → table', async () => {
    const p = await shortestPath(s(), { from: 'a', to: 'tbl/X', projectId: 'p' });
    expect(p.found).toBe(true);
    expect(p.nodes).toEqual(['a', 'b', 'tbl/X']);
    expect(p.edges).toEqual(['IMPORTS', 'READS']);
    expect(p.hops).toBe(2);
  });

  it('shortest_path reports not-found when disconnected', async () => {
    const p = await shortestPath(s(), { from: 'a', to: 'lonely', projectId: 'p' });
    expect(p.found).toBe(false);
  });
});

function reachedCount(res) {
  return Object.values(res.groups).reduce((n, g) => n + g.length, 0);
}
