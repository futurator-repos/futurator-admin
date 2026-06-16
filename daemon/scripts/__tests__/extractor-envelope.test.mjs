/**
 * extractor-envelope.test.mjs — Story SG-1.1 (System Graph Foundation).
 *
 * Covers the shared extractor harness:
 *   1. the output-envelope contract (buildEnvelope / emptyEnvelope)
 *   2. the single graph-sync ingest entrypoint upsertExtractedFacts —
 *      idempotency, the edge-type allowlist guard, and the
 *      missing-endpoint-is-not-invented behaviour.
 *
 * No real Memgraph: a FakeSession models MERGE semantics on nodeId and on
 * (source,type,target) so "run twice → no duplicates" is a real assertion, not
 * a call-count proxy.
 */

import { describe, it, expect } from 'vitest';
import { buildEnvelope, emptyEnvelope } from '../lib/extractor-envelope.mjs';
import {
  upsertExtractedFacts,
  SYSTEM_GRAPH_EDGE_TYPES,
} from '../lib/system-graph-ingest.mjs';

// ── FakeSession — minimal MERGE-semantics model of a Memgraph session ──────
function makeFakeSession() {
  const nodes = new Map(); // nodeId → props
  const edges = new Map(); // `${s}|${type}|${t}` → props
  const queries = [];

  return {
    nodes,
    edges,
    queries,
    async run(query, params = {}) {
      queries.push({ query, params });

      // Node upsert: `MERGE (n:Node {nodeId: $nodeId}) SET ...`
      if (/MERGE \(n:Node \{nodeId: \$nodeId\}\)/.test(query)) {
        nodes.set(params.nodeId, { ...(nodes.get(params.nodeId) || {}), ...params });
        return { records: [] };
      }

      // Edge upsert: `MATCH (a:Node {nodeId: $s}) MATCH (b:Node {nodeId: $t}) MERGE (a)-[r:TYPE]->(b)`
      const relMatch = query.match(/MERGE \(a\)-\[r:(\w+)\]->\(b\)/);
      if (relMatch) {
        // Models MATCH...MATCH: edge only forms when BOTH endpoints exist.
        if (nodes.has(params.s) && nodes.has(params.t)) {
          edges.set(`${params.s}|${relMatch[1]}|${params.t}`, { ...params });
        }
        return { records: [] };
      }

      return { records: [] };
    },
  };
}

describe('extractor-envelope — output contract', () => {
  it('buildEnvelope fills generatedAt + counts and carries nodes/edges/ambiguous', () => {
    const env = buildEnvelope({
      root: '/tmp/x',
      nodes: [{ nodeId: 'infra/table/A', kind: 'table' }],
      edges: [{ type: 'USES', source: 'infra/lambda/Api', target: 'infra/table/A' }],
      ambiguous: [{ reason: 'dynamic-path' }],
      extra: { config: 'sst.config.ts' },
    });
    expect(env).toMatchObject({
      root: '/tmp/x',
      nodeCount: 1,
      edgeCount: 1,
      config: 'sst.config.ts',
    });
    expect(typeof env.generatedAt).toBe('string');
    expect(env.nodes).toHaveLength(1);
    expect(env.edges).toHaveLength(1);
    expect(env.ambiguous).toHaveLength(1);
    // The exact key set ast-extract's downstream consumers rely on.
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining(['generatedAt', 'root', 'nodeCount', 'edgeCount', 'nodes', 'edges', 'ambiguous']),
    );
  });

  it('emptyEnvelope is a valid zero-count envelope', () => {
    const env = emptyEnvelope({ root: '/tmp/x', extra: { skipped: 'config-not-found' } });
    expect(env.nodeCount).toBe(0);
    expect(env.edgeCount).toBe(0);
    expect(env.nodes).toEqual([]);
    expect(env.edges).toEqual([]);
    expect(env.skipped).toBe('config-not-found');
  });
});

describe('upsertExtractedFacts — idempotent ingest', () => {
  const doc = {
    nodes: [
      { nodeId: 'infra/table/ScoresTable', kind: 'table', label: 'ScoresTable', fields: '{playerName}', primaryIndex: '{hashKey}' },
      { nodeId: 'infra/lambda/Api', kind: 'lambda', label: 'Api' },
      { nodeId: 'endpoint/GET /api/leaderboard', kind: 'endpoint', method: 'GET', path: '/api/leaderboard', auth: false },
    ],
    edges: [
      { type: 'USES', source: 'infra/lambda/Api', target: 'infra/table/ScoresTable' },
      { type: 'ROUTES', source: 'endpoint/GET /api/leaderboard', target: 'infra/lambda/Api' },
    ],
  };

  it('MERGEs nodes + edges, and re-running produces no duplicates', async () => {
    const s = makeFakeSession();

    const r1 = await upsertExtractedFacts(s, 'mini-sst', doc, '2026-06-16');
    expect(r1.nodeUpserts).toBe(3);
    expect(r1.edgeUpserts).toBe(2);
    expect(s.nodes.size).toBe(3);
    expect(s.edges.size).toBe(2);

    // Second identical run — additive MERGE means counts stay flat.
    const r2 = await upsertExtractedFacts(s, 'mini-sst', doc, '2026-06-17');
    expect(r2.nodeUpserts).toBe(3);
    expect(r2.edgeUpserts).toBe(2);
    expect(s.nodes.size).toBe(3); // no duplicate nodes
    expect(s.edges.size).toBe(2); // no duplicate edges
  });

  it('persists allowlisted node props (table data contract) and updates the date', async () => {
    const s = makeFakeSession();
    await upsertExtractedFacts(s, 'mini-sst', doc, '2026-06-16');
    const table = s.nodes.get('infra/table/ScoresTable');
    expect(table.fields).toBe('{playerName}');
    expect(table.primaryIndex).toBe('{hashKey}');
    expect(table.kind).toBe('table');
    expect(table.today).toBe('2026-06-16');
  });

  it('skips edges whose type is not allowlisted (injection guard)', async () => {
    const s = makeFakeSession();
    const bad = {
      nodes: [{ nodeId: 'a', kind: 'file' }, { nodeId: 'b', kind: 'file' }],
      edges: [{ type: 'DROP_ALL; MATCH', source: 'a', target: 'b' }],
    };
    const r = await upsertExtractedFacts(s, 'p', bad, '2026-06-16');
    expect(r.edgeUpserts).toBe(0);
    expect(s.edges.size).toBe(0);
    expect(r.skippedEdges).toContainEqual({ reason: 'edge-type-not-allowlisted', type: 'DROP_ALL; MATCH' });
  });

  it('does NOT invent a node when an edge endpoint is missing', async () => {
    const s = makeFakeSession();
    const partial = {
      nodes: [{ nodeId: 'infra/lambda/Api', kind: 'lambda' }],
      edges: [{ type: 'USES', source: 'infra/lambda/Api', target: 'infra/table/Missing' }],
    };
    await upsertExtractedFacts(s, 'p', partial, '2026-06-16');
    expect(s.nodes.size).toBe(1); // the missing target was NOT created
    expect(s.edges.size).toBe(0); // edge did not form
  });

  it('every allowlisted edge type is a plausible relationship token', () => {
    for (const t of SYSTEM_GRAPH_EDGE_TYPES) {
      expect(t).toMatch(/^[A-Z_]+$/);
    }
  });
});
