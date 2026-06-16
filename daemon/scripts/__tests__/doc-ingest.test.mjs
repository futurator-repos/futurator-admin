import { describe, it, expect } from 'vitest';
import {
  upsertExtractedFacts,
  SYSTEM_GRAPH_EDGE_TYPES,
  SYSTEM_GRAPH_NODE_PROPS,
} from '../lib/system-graph-ingest.mjs';

// Minimal MERGE-semantics fake (mirrors extractor-envelope.test.mjs).
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

describe('Story 6.2 — ingest allowlists cover document/docSection', () => {
  it('the five doc edge types are allowlisted', () => {
    for (const t of ['DERIVED_FROM', 'REFERENCES', 'GOVERNS', 'DESCRIBES', 'SPECIFIES']) {
      expect(SYSTEM_GRAPH_EDGE_TYPES.has(t)).toBe(true);
    }
  });

  it('docType / sectionId / contentHash props are allowlisted', () => {
    for (const p of ['docType', 'sectionId', 'contentHash', 'rev']) {
      expect(SYSTEM_GRAPH_NODE_PROPS).toContain(p);
    }
  });

  it('document/docSection nodes upsert idempotently + DERIVED_FROM executes', async () => {
    const s = makeFakeSession();
    const doc = {
      nodes: [
        { nodeId: 'doc/prd/app', kind: 'document', label: 'prd', docType: 'prd', contentHash: 'sha256:prd' },
        { nodeId: 'doc/architecture/app', kind: 'document', label: 'architecture', docType: 'architecture', contentHash: 'sha256:arch' },
        { nodeId: 'docSection/architecture/app/state-model', kind: 'docSection', docType: 'architecture', sectionId: 'state-model', contentHash: 'sha256:arch' },
      ],
      edges: [
        { type: 'DERIVED_FROM', source: 'doc/architecture/app', target: 'doc/prd/app' },
      ],
    };
    const r1 = await upsertExtractedFacts(s, 'app', doc, '2026-06-17');
    expect(r1.nodeUpserts).toBe(3);
    expect(r1.edgeUpserts).toBe(1);
    expect(s.edges.has('doc/architecture/app|DERIVED_FROM|doc/prd/app')).toBe(true);
    // Re-run is additive (idempotent) — node set size unchanged.
    await upsertExtractedFacts(s, 'app', doc, '2026-06-18');
    expect(s.nodes.size).toBe(3);
  });

  it('an unknown edge type is counted-and-skipped, never executed', async () => {
    const s = makeFakeSession();
    const doc = {
      nodes: [
        { nodeId: 'doc/prd/app', kind: 'document', docType: 'prd' },
        { nodeId: 'docSection/prd/app/fr-1', kind: 'docSection', docType: 'prd', sectionId: 'fr-1' },
      ],
      edges: [{ type: 'BOGUS_EDGE', source: 'doc/prd/app', target: 'docSection/prd/app/fr-1' }],
    };
    const r = await upsertExtractedFacts(s, 'app', doc, '2026-06-17');
    expect(r.skippedEdges.some((e) => e.reason === 'edge-type-not-allowlisted')).toBe(true);
    expect(s.edges.size).toBe(0);
  });
});
