/**
 * graph-store.test.mjs — Story S0.2 shared interface suite.
 *
 * ONE suite, run against BOTH impls: the in-memory store (always) and — behind
 * an env guard — a live DynamoDB round-trip. If a key is derived differently on
 * write vs read every traversal silently breaks, so this suite is the guard: it
 * exercises idempotent upsert, in/out edge symmetry, project-scoped kind/file
 * queries, single-partition delete, and the 25/50 BatchWrite chunk boundary.
 *
 * Live Dynamo run (optional):
 *   GRAPH_STORE_LIVE_DYNAMO=1 GRAPH_NODES_TABLE=… GRAPH_EDGES_TABLE=… \
 *   AWS_REGION=eu-central-1 npx vitest run daemon/scripts/lib/__tests__/graph-store.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryGraphStore } from '../graph-store-memory.mjs';

let pidCounter = 0;

/**
 * Register the full interface suite for one impl.
 * @param {string} label
 * @param {() => Promise<object>|object} makeStore
 */
function defineSuite(label, makeStore) {
  describe(`GraphStore [${label}]`, () => {
    let store;
    const usedProjects = new Set();

    const P = (name) => {
      const id = `s02-${label}-${name}-${++pidCounter}`;
      usedProjects.add(id);
      return id;
    };

    beforeEach(async () => {
      store = await makeStore();
    });

    afterEach(async () => {
      // Isolate live Dynamo runs across tests (memory stores are already fresh).
      for (const p of usedProjects) {
        try {
          await store.deleteProject(p);
        } catch {
          /* best-effort cleanup */
        }
      }
      usedProjects.clear();
    });

    it('putNodes then getNode round-trips with defaults (centrality 0, status active)', async () => {
      const p = P('rt');
      const written = await store.putNodes(p, [
        { nodeId: 'code/a.ts', kind: 'file', file: 'a.ts', title: 'a.ts' },
      ]);
      expect(written).toBe(1);

      const node = await store.getNode(p, 'code/a.ts');
      expect(node).toMatchObject({
        nodeId: 'code/a.ts',
        kind: 'file',
        file: 'a.ts',
        status: 'active',
        centrality: 0,
      });
      expect(await store.getNode(p, 'code/missing.ts')).toBeNull();
    });

    it('double-put yields the same state (idempotent upsert)', async () => {
      const p = P('idem');
      const node = { nodeId: 'code/x.ts', kind: 'file', file: 'x.ts', title: 'x' };
      await store.putNodes(p, [node]);
      await store.putNodes(p, [node]);

      const all = await store.listNodes(p);
      expect(all).toHaveLength(1);
      expect(all[0].nodeId).toBe('code/x.ts');
    });

    it('filters props to the SYSTEM_GRAPH_NODE_PROPS allowlist', async () => {
      const p = P('props');
      await store.putNodes(p, [
        {
          nodeId: 'ep/GET/health',
          kind: 'endpoint',
          props: { method: 'GET', path: '/health', bogusField: 'drop me', line: 12 },
        },
      ]);
      const node = await store.getNode(p, 'ep/GET/health');
      expect(node.props).toEqual({ method: 'GET', path: '/health', line: 12 });
      expect(node.props.bogusField).toBeUndefined();
    });

    it('in/out edge symmetry (directed)', async () => {
      const p = P('sym');
      await store.putNodes(p, [
        { nodeId: 'A', kind: 'file' },
        { nodeId: 'B', kind: 'file' },
      ]);
      await store.putEdges(p, [{ from: 'A', to: 'B', type: 'IMPORTS' }]);

      const out = await store.outEdges(p, 'A');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ from: 'A', to: 'B', type: 'IMPORTS' });

      const inB = await store.inEdges(p, 'B');
      expect(inB).toHaveLength(1);
      expect(inB[0]).toMatchObject({ from: 'A', to: 'B', type: 'IMPORTS' });

      // Directionality: nothing flows the other way.
      expect(await store.inEdges(p, 'A')).toHaveLength(0);
      expect(await store.outEdges(p, 'B')).toHaveLength(0);
    });

    it('outEdges / inEdges honor the type filter', async () => {
      const p = P('typefilter');
      await store.putNodes(p, [
        { nodeId: 'A', kind: 'file' },
        { nodeId: 'B', kind: 'file' },
        { nodeId: 'C', kind: 'file' },
      ]);
      await store.putEdges(p, [
        { from: 'A', to: 'B', type: 'IMPORTS' },
        { from: 'A', to: 'C', type: 'CALLS' },
      ]);

      const imports = await store.outEdges(p, 'A', { type: 'IMPORTS' });
      expect(imports.map((e) => e.to)).toEqual(['B']);

      const callsIntoC = await store.inEdges(p, 'C', { type: 'CALLS' });
      expect(callsIntoC.map((e) => e.from)).toEqual(['A']);
      expect(await store.inEdges(p, 'C', { type: 'IMPORTS' })).toHaveLength(0);
    });

    it('queryByKind / queryByFile are scoped to a single project', async () => {
      const p1 = P('proj1');
      const p2 = P('proj2');
      await store.putNodes(p1, [{ nodeId: 'code/a.ts', kind: 'file', file: 'a.ts' }]);
      await store.putNodes(p2, [{ nodeId: 'code/a.ts', kind: 'file', file: 'a.ts' }]);

      const byKind1 = await store.queryByKind(p1, 'file');
      expect(byKind1).toHaveLength(1);
      const byKind2 = await store.queryByKind(p2, 'file');
      expect(byKind2).toHaveLength(1);

      const byFile1 = await store.queryByFile(p1, 'a.ts');
      expect(byFile1.map((n) => n.nodeId)).toEqual(['code/a.ts']);
      // A different kind in p1 must not leak into the 'file' query.
      await store.putNodes(p1, [{ nodeId: 'table/Costs', kind: 'table' }]);
      expect(await store.queryByKind(p1, 'file')).toHaveLength(1);
      expect(await store.queryByKind(p1, 'table')).toHaveLength(1);
    });

    it('fileless nodes never appear in queryByFile', async () => {
      const p = P('nofile');
      await store.putNodes(p, [{ nodeId: 'table/Costs', kind: 'table' }]);
      expect(await store.queryByFile(p, 'table/Costs')).toHaveLength(0);
      expect(await store.queryByKind(p, 'table')).toHaveLength(1);
    });

    it('setNodeAttrs updates analytics attrs and status', async () => {
      const p = P('attrs');
      await store.putNodes(p, [{ nodeId: 'A', kind: 'file' }]);
      const ok = await store.setNodeAttrs(p, 'A', {
        centrality: 0.9,
        degree: 4,
        community: 2,
        status: 'flagged',
      });
      expect(ok).toBe(true);

      const node = await store.getNode(p, 'A');
      expect(node).toMatchObject({ centrality: 0.9, degree: 4, community: 2, status: 'flagged' });

      // Missing node → false.
      expect(await store.setNodeAttrs(p, 'ghost', { centrality: 1 })).toBe(false);
    });

    it('deleteProject removes exactly one partition on both tables', async () => {
      const keep = P('keep');
      const drop = P('drop');
      await store.putNodes(keep, [{ nodeId: 'K', kind: 'file' }]);
      await store.putEdges(keep, [{ from: 'K', to: 'K', type: 'CONTAINS' }]);
      await store.putNodes(drop, [
        { nodeId: 'D1', kind: 'file' },
        { nodeId: 'D2', kind: 'file' },
      ]);
      await store.putEdges(drop, [{ from: 'D1', to: 'D2', type: 'IMPORTS' }]);

      const res = await store.deleteProject(drop);
      expect(res).toEqual({ nodes: 2, edges: 1 });

      expect(await store.listNodes(drop)).toHaveLength(0);
      expect(await store.listEdges(drop)).toHaveLength(0);
      // Other project untouched.
      expect(await store.listNodes(keep)).toHaveLength(1);
      expect(await store.listEdges(keep)).toHaveLength(1);
    });

    it('handles the 25/50 BatchWrite chunk boundary', async () => {
      const p = P('chunk');
      const mk = (n) =>
        Array.from({ length: n }, (_, i) => ({
          nodeId: `n${i}`,
          kind: 'file',
          file: `f${i}.ts`,
        }));

      expect(await store.putNodes(p, mk(25))).toBe(25);
      expect(await store.listNodes(p)).toHaveLength(25);

      // 50 (spans exactly two chunks); nodeIds overlap the first 25 → idempotent.
      expect(await store.putNodes(p, mk(50))).toBe(50);
      expect(await store.listNodes(p)).toHaveLength(50);

      const edges = Array.from({ length: 50 }, (_, i) => ({
        from: `n${i}`,
        to: `n${(i + 1) % 50}`,
        type: 'IMPORTS',
      }));
      expect(await store.putEdges(p, edges)).toBe(50);
      expect(await store.listEdges(p)).toHaveLength(50);
    });
  });
}

defineSuite('memory', () => createMemoryGraphStore());

// Optional live-DynamoDB round-trip — only when explicitly enabled with tables.
if (
  process.env.GRAPH_STORE_LIVE_DYNAMO === '1' &&
  process.env.GRAPH_NODES_TABLE &&
  process.env.GRAPH_EDGES_TABLE
) {
  const { createDynamoGraphStore } = await import('../graph-store-dynamo.mjs');
  defineSuite('dynamo', () =>
    createDynamoGraphStore({
      nodesTable: process.env.GRAPH_NODES_TABLE,
      edgesTable: process.env.GRAPH_EDGES_TABLE,
      region: process.env.AWS_REGION ?? 'eu-central-1',
    }),
  );
}
