/**
 * Graph Analytics — Architectural X-Ray (Epic 3, PRD §5.4 / Appendix D).
 *
 * A DISTINCT post-sync, read+annotate pass — it never touches the ingest
 * write-path. It computes:
 *
 *   - Story 3.1: god-nodes via betweenness centrality (`n.centrality`)
 *   - Story 3.2: communities via label propagation (`n.community`)
 *   - Story 3.3: "surprising connections" — cross-community edges whose two
 *     endpoints are both high-centrality (the non-obvious architectural bridges)
 *
 * 2026-06-16: computed in NODE rather than via MAGE. MAGE (betweenness/Louvain)
 * isn't installed on the shared Memgraph and installing it would mean a C++
 * source build on a production box that also serves another tenant. Per-project
 * graphs are small (hundreds of nodes), so Brandes' betweenness + label
 * propagation run instantly in JS — and this removes the "MAGE unavailable"
 * failure mode entirely (it now works on ANY Memgraph). The computed metrics are
 * written back to `n.centrality`/`n.community` so the MCP `god_nodes` tool and
 * ad-hoc Cypher see them too.
 *
 * Results are shaped into `knowledge/_graph/insights.json`, which the Graph tab
 * reads to size nodes by centrality, color them by community, and list
 * surprising connections.
 *
 * S1.4 (EU migration): session→store swap. `readProjectGraph`/`writeBackMetrics`
 * now read/write through the GraphStore (Memgraph/bolt EXCISED, see
 * `lib/graph-store.mjs`) instead of Cypher. The write-back also now includes
 * `degree`/`fanIn` (not just `centrality`/`community`) — `degree` feeds the
 * `centrality-index` GSI's `degree=0` orphans filter, `fanIn` is the plain
 * in-degree count (S1.4 scope: `lib/graph-integrity.mjs`'s `reportOrphans`
 * remains the authoritative orphan detector; these are the queryable node-row
 * mirrors of the same signal).
 *
 * Pure algorithms are exported for unit testing; graph-sync wires
 * `processGraphAnalytics` into the flow.
 *
 * 2026-06-17: communities now use the **Leiden** algorithm (ngraph.leiden, pure
 * JS) — it guarantees well-connected communities and beats Louvain/label
 * propagation on quality (Traag et al. 2019). Label propagation is kept as a
 * dependency-free fallback if the Leiden lib ever throws.
 */

import createGraph from 'ngraph.graph';
import { detectClusters } from 'ngraph.leiden';

// ── Read the project subgraph (ids + edges) ─────────────────────────────────

async function readProjectGraph(store, projectId) {
  const [nodeRows, edgeRows] = await Promise.all([
    store.listNodes(projectId),
    store.listEdges(projectId),
  ]);
  const nodes = nodeRows.map((n) => ({
    id: n.nodeId,
    kind: n.kind || 'file',
    title: n.title ?? n.nodeId,
  }));
  const edges = edgeRows.map((e) => ({ s: e.from, t: e.to, type: e.type }));
  return { nodes, edges };
}

/** Directed in/out edge counts per node id. Pure. */
function buildDegreeStats(ids, edges) {
  const outDeg = new Map(ids.map((id) => [id, 0]));
  const inDeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) {
    if (outDeg.has(e.s)) outDeg.set(e.s, outDeg.get(e.s) + 1);
    if (inDeg.has(e.t)) inDeg.set(e.t, inDeg.get(e.t) + 1);
  }
  return { outDeg, inDeg };
}

/** Undirected adjacency map id → Set(neighborId). */
function buildAdjacency(ids, edges) {
  const adj = new Map(ids.map((id) => [id, new Set()]));
  for (const e of edges) {
    if (!adj.has(e.s) || !adj.has(e.t) || e.s === e.t) continue;
    adj.get(e.s).add(e.t);
    adj.get(e.t).add(e.s);
  }
  return adj;
}

// ── Betweenness centrality (Brandes, undirected, unweighted) ────────────────

/** @returns {Map<string, number>} id → betweenness centrality. Pure. */
export function betweennessCentrality(ids, adj) {
  const CB = new Map(ids.map((id) => [id, 0]));
  for (const s of ids) {
    const S = [];
    const P = new Map(ids.map((id) => [id, []]));
    const sigma = new Map(ids.map((id) => [id, 0]));
    const dist = new Map(ids.map((id) => [id, -1]));
    sigma.set(s, 1);
    dist.set(s, 0);
    const Q = [s];
    while (Q.length) {
      const v = Q.shift();
      S.push(v);
      for (const w of adj.get(v) ?? []) {
        if (dist.get(w) < 0) {
          Q.push(w);
          dist.set(w, dist.get(v) + 1);
        }
        if (dist.get(w) === dist.get(v) + 1) {
          sigma.set(w, sigma.get(w) + sigma.get(v));
          P.get(w).push(v);
        }
      }
    }
    const delta = new Map(ids.map((id) => [id, 0]));
    while (S.length) {
      const w = S.pop();
      for (const v of P.get(w)) {
        delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w)));
      }
      if (w !== s) CB.set(w, CB.get(w) + delta.get(w));
    }
  }
  // Undirected → each shortest path counted twice.
  for (const id of ids) CB.set(id, CB.get(id) / 2);
  return CB;
}

// ── Communities via Leiden (preferred) ─────────────────────────────────────

/**
 * Community detection via the Leiden algorithm — guarantees connected
 * communities, modularity-optimising, deterministic (fixed seed). Throws if the
 * library can't run, so the caller can fall back to label propagation.
 *
 * @returns {Map<string, number>} id → small-int community.
 */
export function detectCommunitiesLeiden(ids, edges) {
  const g = createGraph();
  for (const id of ids) g.addNode(id);
  for (const e of edges) {
    if (e.s !== e.t) g.addLink(e.s, e.t); // undirected — adapter symmetrizes
  }
  const result = detectClusters(g, { randomSeed: 42 });
  // Remap raw community ids → 0,1,2… by first appearance (stable for coloring).
  const remap = new Map();
  const out = new Map();
  for (const id of [...ids].sort()) {
    const raw = result.getClass(id);
    if (!remap.has(raw)) remap.set(raw, remap.size);
    out.set(id, remap.get(raw));
  }
  return out;
}

// ── Communities via label propagation (deterministic fallback) ──────────────

/** @returns {Map<string, number>} id → small-int community. Pure. */
export function detectCommunities(ids, adj, maxIter = 20) {
  const sorted = [...ids].sort();
  const label = new Map(sorted.map((id) => [id, id]));
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const id of sorted) {
      const nbrs = adj.get(id);
      if (!nbrs || nbrs.size === 0) continue;
      const counts = new Map();
      for (const n of nbrs) {
        const l = label.get(n);
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      // Most frequent neighbour label; ties broken by smallest label string.
      let best = label.get(id);
      let bestCount = -1;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Remap raw labels → 0,1,2… by first appearance (stable for coloring).
  const remap = new Map();
  const out = new Map();
  for (const id of sorted) {
    const raw = label.get(id);
    if (!remap.has(raw)) remap.set(raw, remap.size);
    out.set(id, remap.get(raw));
  }
  return out;
}

/**
 * Persist computed metrics back onto each node row (best-effort). GraphStore
 * has no batch-SET primitive (unlike the old `UNWIND ... SET`), so this is a
 * sequential `setNodeAttrs` per node — still best-effort: the caller wraps the
 * whole pass in try/catch (graceful degradation, never fails the sync).
 */
async function writeBackMetrics(store, projectId, metrics) {
  for (const m of metrics) {
    await store.setNodeAttrs(projectId, m.id, {
      centrality: m.centrality,
      community: m.community,
      degree: m.degree,
      fanIn: m.fanIn,
    });
  }
}

// ── Pure shaping helpers (testable without a session) ───────────────────────

/** Top-N nodes by centrality (Story 3.1), only those that lie on some path. */
export function topGodNodes(metrics, n = 15) {
  return metrics
    .filter((m) => typeof m.centrality === 'number' && m.centrality > 0)
    .sort((a, b) => b.centrality - a.centrality || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((m) => ({ id: m.id, kind: m.kind, title: m.title ?? m.id, centrality: m.centrality }));
}

/** Community membership counts (Story 3.2), largest first. */
export function communityCounts(metrics) {
  const counts = new Map();
  for (const m of metrics) {
    if (m.community == null) continue;
    counts.set(m.community, (counts.get(m.community) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([community, count]) => ({ community, count }))
    .sort((a, b) => b.count - a.count || a.community - b.community);
}

/**
 * Surprising connections (Story 3.3): edges whose endpoints are in DIFFERENT
 * communities and BOTH above the centrality threshold, ranked by summed
 * endpoint centrality. Top 25. Pure (computed from metrics + edges).
 */
export function surprisingFromMetrics(edges, metricsById, threshold = 0) {
  const out = [];
  const seen = new Set();
  for (const e of edges) {
    const a = metricsById.get(e.s);
    const b = metricsById.get(e.t);
    if (!a || !b) continue;
    if (a.community == null || b.community == null || a.community === b.community) continue;
    if (!(a.centrality > threshold && b.centrality > threshold)) continue;
    const key = `${e.s}|${e.t}|${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: e.s,
      sourceTitle: a.title ?? e.s,
      type: e.type,
      target: e.t,
      targetTitle: b.title ?? e.t,
      sourceCommunity: a.community,
      targetCommunity: b.community,
      score: a.centrality + b.centrality,
    });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 25);
}

/** Build the `insights.json` document from a finished analytics run. Pure. */
export function buildInsightsDoc({ projectId, generatedAt, analytics, threshold }) {
  const nodeMetrics = {};
  for (const m of analytics.metrics) {
    nodeMetrics[m.id] = {
      centrality: m.centrality ?? null,
      community: m.community ?? null,
    };
  }
  return {
    projectId,
    generatedAt,
    // Kept for the UI's overlay gate; analytics now run in-process, so this is
    // true whenever the pass computed metrics.
    mageAvailable: analytics.mageAvailable,
    centralityAvailable: analytics.centralityAvailable,
    communityAvailable: analytics.communityAvailable,
    engine: analytics.engine ?? 'node',
    threshold,
    godNodes: analytics.godNodes,
    communities: analytics.communities,
    surprisingConnections: analytics.surprising,
    nodeMetrics,
  };
}

/**
 * Compute the three analytics dimensions in-process. Reads the project subgraph,
 * runs betweenness + label propagation, writes metrics back, and shapes the
 * god-node / community / surprising lists. Never throws — on any failure it
 * returns an empty, well-formed result (graceful degradation).
 */
export async function runAnalytics(store, projectId, opts = {}) {
  const threshold = opts.threshold ?? 0;
  const topN = opts.topN ?? 15;
  const logger = opts.logger;

  try {
    const { nodes, edges } = await readProjectGraph(store, projectId);
    if (nodes.length === 0) {
      return emptyAnalytics();
    }
    const ids = nodes.map((n) => n.id);
    const adj = buildAdjacency(ids, edges);
    const cb = betweennessCentrality(ids, adj);
    const { outDeg, inDeg } = buildDegreeStats(ids, edges);

    // Communities: Leiden (best quality), with a dependency-free fallback.
    let comm;
    let communityEngine = 'leiden';
    try {
      comm = detectCommunitiesLeiden(ids, edges);
    } catch (err) {
      logger?.(`Leiden unavailable — falling back to label propagation (${err.message})`);
      comm = detectCommunities(ids, adj);
      communityEngine = 'label-propagation';
    }

    const metrics = nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      centrality: cb.get(n.id) ?? 0,
      community: comm.get(n.id) ?? null,
      degree: (outDeg.get(n.id) ?? 0) + (inDeg.get(n.id) ?? 0),
      fanIn: inDeg.get(n.id) ?? 0,
    }));
    const metricsById = new Map(metrics.map((m) => [m.id, m]));

    try {
      await writeBackMetrics(store, projectId, metrics);
    } catch (err) {
      logger?.(`analytics write-back skipped (${err.message})`);
    }

    return {
      mageAvailable: true,
      centralityAvailable: true,
      communityAvailable: true,
      engine: `brandes+${communityEngine}`,
      metrics,
      godNodes: topGodNodes(metrics, topN),
      communities: communityCounts(metrics),
      surprising: surprisingFromMetrics(edges, metricsById, threshold),
    };
  } catch (err) {
    logger?.(`graph analytics failed — empty insights (${err.message})`);
    return emptyAnalytics();
  }
}

function emptyAnalytics() {
  return {
    mageAvailable: false,
    centralityAvailable: false,
    communityAvailable: false,
    engine: 'node',
    metrics: [],
    godNodes: [],
    communities: [],
    surprising: [],
  };
}
