import { describe, it, expect } from 'vitest';
import {
  upsertExtractedFacts,
  SYSTEM_GRAPH_EDGE_TYPES,
  SYSTEM_GRAPH_NODE_PROPS,
} from '../lib/system-graph-ingest.mjs';
import { SOFT_ORPHAN_KINDS } from '../lib/graph-integrity.mjs';

// Minimal MERGE-semantics fake (mirrors doc-ingest.test.mjs / extractor-envelope.test.mjs).
function makeFakeSession() {
  const nodes = new Map();
  const edges = new Map();
  return {
    nodes,
    edges,
    async run(query, params = {}) {
      if (/MERGE \(n:Node \{nodeId: \$nodeId\}\)/.test(query)) {
        nodes.set(params.nodeId, { ...(nodes.get(params.nodeId) || {}), ...params });
        return { records: [] };
      }
      const rel = query.match(/MERGE \(a\)-\[r:(\w+)\]->\(b\)/);
      if (rel) {
        if (nodes.has(params.s) && nodes.has(params.t)) {
          edges.set(`${params.s}|${rel[1]}|${params.t}`, { ...params });
        }
        return { records: [] };
      }
      return { records: [] };
    },
  };
}

describe('Agentic Document Center (E5.2) — ingest allowlist extension', () => {
  it('the new ADC edge types are allowlisted', () => {
    for (const t of ['CONTAINS', 'DEPENDS_ON', 'PROPOSES', 'GOVERNS']) {
      expect(SYSTEM_GRAPH_EDGE_TYPES.has(t)).toBe(true);
    }
  });

  it('the new docShard/godDoc node props are allowlisted', () => {
    for (const p of ['boundary', 'members', 'depends', 'memberCount', 'shardKey', 'shardKeys']) {
      expect(SYSTEM_GRAPH_NODE_PROPS).toContain(p);
    }
  });

  it('docShard nodes upsert with members/depends; DEPENDS_ON executes; idempotent', async () => {
    const s = makeFakeSession();
    const doc = {
      nodes: [
        {
          nodeId: '§sys:src--auth',
          kind: 'docShard',
          label: 'src/auth',
          boundary: 'src/auth',
          members: ['code/src--auth--login.ts'],
          depends: ['§sys:lib'],
          memberCount: 1,
        },
        { nodeId: '§sys:lib', kind: 'docShard', label: 'lib', boundary: 'lib', members: ['code/lib--crypto.ts'], memberCount: 1 },
      ],
      edges: [{ type: 'DEPENDS_ON', source: '§sys:src--auth', target: '§sys:lib' }],
    };
    const r1 = await upsertExtractedFacts(s, 'app', doc, '2026-06-22');
    expect(r1.nodeUpserts).toBe(2);
    expect(r1.edgeUpserts).toBe(1);
    expect(s.edges.has('§sys:src--auth|DEPENDS_ON|§sys:lib')).toBe(true);
    // The allowlisted array props persisted onto the node.
    expect(s.nodes.get('§sys:src--auth').members).toEqual(['code/src--auth--login.ts']);
    expect(s.nodes.get('§sys:src--auth').depends).toEqual(['§sys:lib']);
    // Re-run is additive (idempotent).
    await upsertExtractedFacts(s, 'app', doc, '2026-06-23');
    expect(s.nodes.size).toBe(2);
  });

  it('godDoc CONTAINS docShard + concept-doc PROPOSES godDoc execute through the same path', async () => {
    const s = makeFakeSession();
    const doc = {
      nodes: [
        { nodeId: 'godDoc/architecture/app', kind: 'godDoc', label: 'architecture', shardKeys: ['§sys:src--auth'] },
        { nodeId: '§sys:src--auth', kind: 'docShard', label: 'src/auth' },
        { nodeId: 'doc/architecture/app', kind: 'document', docType: 'architecture' },
      ],
      edges: [
        { type: 'CONTAINS', source: 'godDoc/architecture/app', target: '§sys:src--auth' },
        { type: 'PROPOSES', source: 'doc/architecture/app', target: 'godDoc/architecture/app' },
      ],
    };
    const r = await upsertExtractedFacts(s, 'app', doc, '2026-06-22');
    expect(r.edgeUpserts).toBe(2);
    expect(s.edges.has('godDoc/architecture/app|CONTAINS|§sys:src--auth')).toBe(true);
    expect(s.edges.has('doc/architecture/app|PROPOSES|godDoc/architecture/app')).toBe(true);
  });

  it('an unknown edge type is still counted-and-skipped (closed-set guard intact)', async () => {
    const s = makeFakeSession();
    const doc = {
      nodes: [
        { nodeId: '§sys:a', kind: 'docShard' },
        { nodeId: '§sys:b', kind: 'docShard' },
      ],
      edges: [{ type: 'NOT_A_REAL_EDGE', source: '§sys:a', target: '§sys:b' }],
    };
    const r = await upsertExtractedFacts(s, 'app', doc, '2026-06-22');
    expect(r.skippedEdges.some((e) => e.reason === 'edge-type-not-allowlisted')).toBe(true);
    expect(s.edges.size).toBe(0);
  });

  it('a prop not on the allowlist is dropped, not persisted', async () => {
    const s = makeFakeSession();
    const doc = {
      nodes: [{ nodeId: '§sys:a', kind: 'docShard', boundary: 'a', notAllowed: 'leak' }],
      edges: [],
    };
    await upsertExtractedFacts(s, 'app', doc, '2026-06-22');
    expect(s.nodes.get('§sys:a').boundary).toBe('a');
    expect(s.nodes.get('§sys:a').notAllowed).toBeUndefined();
  });
});

describe('Agentic Document Center (E5.4) — soft-orphan kind set', () => {
  it('docShard + godDoc are soft-orphan kinds (warning, not hard-fail)', () => {
    expect(SOFT_ORPHAN_KINDS.has('docShard')).toBe(true);
    expect(SOFT_ORPHAN_KINDS.has('godDoc')).toBe(true);
    // The tripwire is narrowed, not disabled — a genuine hard-fail kind is NOT soft.
    expect(SOFT_ORPHAN_KINDS.has('lambda')).toBe(false);
    expect(SOFT_ORPHAN_KINDS.has('function')).toBe(false);
  });
});
