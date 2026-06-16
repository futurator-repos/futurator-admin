/**
 * fake-analytics-graph.mjs — hermetic Memgraph+MAGE stand-in for Epic 3 tests.
 *
 * It does NOT recompute betweenness/Louvain (that's MAGE's job and not what we
 * test). Instead the test SEEDS each node's `centrality`/`community`, and this
 * fake interprets exactly the queries graph-analytics.mjs issues:
 *   - the MAGE CALLs (betweenness_centrality / community_detection) — which we
 *     can make "unavailable" to test graceful degradation
 *   - the per-project metric read-back
 *   - the surprising-connections predicate (cross-community + both endpoints
 *     above the threshold), ranked by summed centrality, top 25
 *
 * Pass `mage: { centrality: false }` (etc.) to simulate a missing procedure.
 * NOT a test file (no `.test.`), so the vitest collector ignores it.
 */

export function makeAnalyticsSession({ nodes = [], edges = [], projectId = 'p', mage = {} } = {}) {
  const N = new Map(
    nodes.map((n) => [
      n.id,
      { kind: 'file', status: 'active', projectId, centrality: null, community: null, ...n },
    ]),
  );
  const E = edges.map((e) => ({ ...e }));
  const centralityOk = mage.centrality !== false;
  const communityOk = mage.community !== false;

  const rows = (arr) => ({ records: arr });
  const rec = (obj) => ({ get: (k) => (k in obj ? obj[k] : null) });

  return {
    nodes: N,
    edges: E,
    async run(query, params = {}) {
      // ── MAGE: betweenness centrality (annotates node.centrality) ──────
      if (/betweenness_centrality\.get\(\)/.test(query)) {
        if (!centralityOk) throw new Error('procedure betweenness_centrality not found');
        // values are pre-seeded; nothing to recompute.
        return rows([]);
      }
      // ── MAGE: Louvain community detection ─────────────────────────────
      if (/community_detection\.get\(\)/.test(query)) {
        if (!communityOk) throw new Error('procedure community_detection not found');
        return rows([]);
      }
      // ── Read back per-project metrics ─────────────────────────────────
      if (/n\.centrality IS NOT NULL OR n\.community IS NOT NULL/.test(query)) {
        const recs = [];
        for (const n of N.values()) {
          if (n.projectId !== params.projectId) continue;
          const c = centralityOk ? n.centrality : null;
          const comm = communityOk ? n.community : null;
          if (c == null && comm == null) continue;
          recs.push(rec({ id: n.id, kind: n.kind, title: n.title ?? n.id, centrality: c, community: comm }));
        }
        return rows(recs);
      }
      // ── Surprising connections ────────────────────────────────────────
      if (/a\.community <> b\.community/.test(query)) {
        const c = params.c ?? 0;
        const out = [];
        for (const e of E) {
          const a = N.get(e.from);
          const b = N.get(e.to);
          if (!a || !b) continue;
          if (a.projectId !== params.projectId || b.projectId !== params.projectId) continue;
          if (a.community == null || b.community == null) continue;
          if (a.community === b.community) continue;
          if (!(a.centrality > c) || !(b.centrality > c)) continue;
          out.push({
            source: a.id,
            sourceTitle: a.title ?? a.id,
            type: e.type,
            target: b.id,
            targetTitle: b.title ?? b.id,
            sourceCommunity: a.community,
            targetCommunity: b.community,
            score: a.centrality + b.centrality,
          });
        }
        out.sort((x, y) => y.score - x.score);
        return rows(out.slice(0, 25).map(rec));
      }
      return rows([]);
    },
    async close() {},
  };
}
