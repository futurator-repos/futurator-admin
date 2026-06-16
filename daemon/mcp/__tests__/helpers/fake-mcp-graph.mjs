/**
 * fake-mcp-graph.mjs — hermetic Memgraph stand-in for Mycelium-MCP tests.
 *
 * Models a directed node/edge store and interprets exactly the Cypher the MCP
 * tools issue (get_node, neighbors, blast_radius, god_nodes, orphans,
 * shortest_path). blast_radius + shortest_path are traversed for real (BFS over
 * the edge set, undirected, honoring the hop bound parsed from the query) so the
 * "event chain is not missed" AC (W5) is genuinely exercised.
 *
 * NOT a test file (no `.test.`), so the vitest collector ignores it.
 */

export function makeMcpSession({ nodes = [], edges = [], projectId = 'p' } = {}) {
  const N = new Map(
    nodes.map((n) => [
      n.id,
      { kind: 'file', status: 'active', projectId, centrality: null, community: null, ...n },
    ]),
  );
  const E = edges.map((e) => ({ ...e }));

  const rows = (arr) => ({ records: arr });
  const rec = (obj) => ({ get: (k) => (k in obj ? obj[k] : null) });
  const inProject = (id, pid) => {
    const n = N.get(id);
    return n && n.projectId === pid;
  };

  /** Undirected adjacency honoring an optional set of edge types. */
  function adj(id, types) {
    const out = [];
    for (const e of E) {
      if (types && !types.includes(e.type)) continue;
      if (e.from === id) out.push({ to: e.to, type: e.type });
      else if (e.to === id) out.push({ to: e.from, type: e.type });
    }
    return out;
  }

  /** BFS reach within `hops`, honoring edge types + project, excluding seeds. */
  function reach(seeds, hops, types, pid) {
    const seen = new Set(seeds);
    let frontier = [...seeds];
    const reached = new Set();
    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const id of frontier) {
        for (const { to } of adj(id, types)) {
          if (!inProject(to, pid)) continue;
          if (!seen.has(to)) {
            seen.add(to);
            reached.add(to);
            next.push(to);
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    for (const s of seeds) reached.delete(s);
    return [...reached];
  }

  /** Shortest undirected path (BFS) between two nodes, ≤ maxHops. */
  function shortest(from, to, maxHops, pid) {
    if (!inProject(from, pid) || !inProject(to, pid)) return null;
    const prev = new Map([[from, null]]);
    const prevType = new Map();
    let frontier = [from];
    for (let h = 0; h < maxHops && frontier.length; h++) {
      const next = [];
      for (const id of frontier) {
        for (const { to: nbr, type } of adj(id)) {
          if (!inProject(nbr, pid) || prev.has(nbr)) continue;
          prev.set(nbr, id);
          prevType.set(nbr, type);
          if (nbr === to) {
            const ids = [];
            const types = [];
            let cur = to;
            while (cur != null) {
              ids.unshift(cur);
              if (prevType.has(cur)) types.unshift(prevType.get(cur));
              cur = prev.get(cur);
            }
            return { ids, types };
          }
          next.push(nbr);
        }
      }
      frontier = next;
    }
    return null;
  }

  return {
    nodes: N,
    edges: E,
    async run(query, params = {}) {
      // ── get_node ──────────────────────────────────────────────────────
      if (/RETURN n\.nodeId AS id/.test(query) && /count\(DISTINCT m\) AS degree/.test(query)) {
        const n = N.get(params.nodeId);
        if (!n || n.projectId !== params.projectId) return rows([]);
        const degree = new Set(adj(n.id).map((a) => a.to)).size;
        return rows([
          rec({
            id: n.id,
            kind: n.kind,
            title: n.title ?? n.id,
            centrality: n.centrality,
            community: n.community,
            degree,
          }),
        ]);
      }
      // ── neighbors ─────────────────────────────────────────────────────
      if (/RETURN type\(rel\) AS type, m\.nodeId AS id/.test(query)) {
        const dir = /-\[rel\]->\(m/.test(query)
          ? 'out'
          : /<-\[rel\]-\(m/.test(query)
            ? 'in'
            : 'any';
        const out = [];
        for (const e of E) {
          let nbr = null;
          if (dir === 'out' && e.from === params.nodeId) nbr = e.to;
          else if (dir === 'in' && e.to === params.nodeId) nbr = e.from;
          else if (dir === 'any' && (e.from === params.nodeId || e.to === params.nodeId))
            nbr = e.from === params.nodeId ? e.to : e.from;
          if (nbr == null || !inProject(nbr, params.projectId)) continue;
          const m = N.get(nbr);
          out.push(rec({ type: e.type, id: m.id, kind: m.kind, title: m.title ?? m.id }));
        }
        return rows(out);
      }
      // ── blast_radius ──────────────────────────────────────────────────
      if (/x\.billable AS billable/.test(query)) {
        const hops = Number((query.match(/\*1\.\.(\d+)/) || [])[1] || 2);
        const types = parseRelTypes(query);
        const ids = reach(params.fileIds, hops, types, params.projectId);
        const out = ids
          .map((id) => N.get(id))
          .filter(Boolean)
          .sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || a.id.localeCompare(b.id))
          .map((n) => rec({ id: n.id, kind: n.kind, title: n.title ?? n.id, billable: n.billable ?? null }));
        return rows(out);
      }
      // ── god_nodes ─────────────────────────────────────────────────────
      if (/n\.centrality IS NOT NULL AND n\.centrality > 0/.test(query)) {
        const out = [...N.values()]
          .filter((n) => n.projectId === params.projectId && typeof n.centrality === 'number' && n.centrality > 0)
          .sort((a, b) => b.centrality - a.centrality || a.id.localeCompare(b.id))
          .slice(0, params.limit ?? 15)
          .map((n) => rec({ id: n.id, kind: n.kind, title: n.title ?? n.id, centrality: n.centrality }));
        return rows(out);
      }
      // ── orphans ───────────────────────────────────────────────────────
      if (/WHERE NOT \(n\)--\(\)/.test(query)) {
        const out = [...N.values()]
          .filter((n) => n.projectId === params.projectId && (n.status ?? 'active') !== 'pruned')
          .filter((n) => adj(n.id).length === 0)
          .map((n) => rec({ id: n.id, kind: n.kind, title: n.title ?? n.id }));
        return rows(out);
      }
      // ── shortest_path ─────────────────────────────────────────────────
      if (/\*BFS/.test(query)) {
        const maxHops = Number((query.match(/\*BFS 1\.\.(\d+)/) || [])[1] || 8);
        const p = shortest(params.from, params.to, maxHops, params.projectId);
        if (!p) return rows([]);
        return rows([rec({ ids: p.ids, types: p.types })]);
      }
      return rows([]);
    },
    async close() {},
  };
}

/** Extract the rel types from a `-[:A|B|C*1..2]-` clause. */
function parseRelTypes(query) {
  const m = query.match(/\[:([A-Z_|]+)\*/);
  if (!m) return null;
  return m[1].split('|');
}
