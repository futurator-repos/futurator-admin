/**
 * fake-graph.mjs — a hermetic in-memory Memgraph stand-in for Epic 2 tests.
 *
 * Models a real node/edge store and interprets exactly the queries that
 * lib/graph-integrity.mjs issues:
 *   - the containment-backbone MERGEs (dir node + dir─CONTAINS→file)
 *   - the orphan invariant (degree-0, not pruned)
 *   - the dead-code detector (file whose only incident edge is CONTAINS)
 *
 * Edges are directed (`from`→`to`); the helpers below distinguish directed vs
 * undirected predicates the way the Cypher does. NOT a test file (no `.test.`),
 * so the vitest collector ignores it.
 */

export function makeGraphSession({ nodes = [], edges = [] } = {}) {
  // nodes: [{ id, kind, status?, updated?, title? }]
  const N = new Map(nodes.map((n) => [n.id, { kind: 'file', status: 'active', ...n }]));
  // edges: [{ from, to, type }]
  const E = edges.map((e) => ({ ...e }));

  const incident = (id) => E.filter((e) => e.from === id || e.to === id);
  const hasType = (id, types, dir) =>
    E.some((e) => {
      if (!types.includes(e.type)) return false;
      if (dir === 'out') return e.from === id;
      if (dir === 'in') return e.to === id;
      return e.from === id || e.to === id; // undirected
    });

  return {
    nodes: N,
    edges: E,
    async run(query, params = {}) {
      // ── Containment backbone: MERGE dir node ──────────────────────────
      if (/d\.kind = 'dir'/.test(query)) {
        if (!N.has(params.nodeId)) {
          N.set(params.nodeId, { id: params.nodeId, kind: 'dir', status: 'active' });
        }
        return { records: [] };
      }
      // ── Containment backbone: MATCH file + MERGE CONTAINS ─────────────
      if (/MERGE \(d\)-\[rel:CONTAINS\]->\(f\)/.test(query)) {
        if (N.has(params.dirId) && N.has(params.fileId)) {
          // idempotent: don't duplicate an existing CONTAINS
          if (!E.some((e) => e.type === 'CONTAINS' && e.from === params.dirId && e.to === params.fileId)) {
            E.push({ from: params.dirId, to: params.fileId, type: 'CONTAINS' });
          }
          return { records: [{ get: () => 1 }] };
        }
        return { records: [] };
      }
      // ── Orphan invariant: degree-0, not pruned ────────────────────────
      if (/WHERE NOT \(n\)--\(\)/.test(query)) {
        const recs = [];
        for (const n of N.values()) {
          if ((n.status ?? 'active') === 'pruned') continue;
          if (incident(n.id).length === 0) {
            recs.push({ get: (k) => (k === 'id' ? n.id : k === 'kind' ? n.kind : null) });
          }
        }
        return { records: recs };
      }
      // ── Dead-code detector: file with only CONTAINS ───────────────────
      if (/kind: 'file'/.test(query) && /NOT \(f\)-\[:IMPORTS\|CALLS\|READS/.test(query)) {
        const liveTypes = [
          'IMPORTS', 'CALLS', 'READS', 'WRITES',
          'CALLS_SERVICE', 'CALLS_ENDPOINT', 'HANDLED_BY', 'ROUTES',
        ];
        const inboundTypes = ['IMPORTS', 'CALLS', 'HANDLED_BY', 'ROUTES'];
        const recs = [];
        for (const n of N.values()) {
          if (n.kind !== 'file') continue;
          if ((n.status ?? 'active') === 'pruned') continue;
          if (hasType(n.id, liveTypes, 'any')) continue; // any live edge, either direction
          if (hasType(n.id, inboundTypes, 'in')) continue; // imported/called/routed into
          // DEFINES → symbol ← CALLS  (defines something that's actually called)
          const defined = E.filter((e) => e.type === 'DEFINES' && e.from === n.id).map((e) => e.to);
          const calledSymbol = defined.some((sym) =>
            E.some((e) => e.type === 'CALLS' && e.to === sym),
          );
          if (calledSymbol) continue;
          recs.push({
            get: (k) =>
              k === 'id' ? n.id : k === 'updated' ? (n.updated ?? null) : k === 'title' ? (n.title ?? n.id) : null,
          });
        }
        return { records: recs };
      }
      return { records: [] };
    },
    async close() {},
  };
}
