/**
 * Graph Analytics — Architectural X-Ray (Epic 3, PRD §5.4 / Appendix D).
 *
 * A DISTINCT post-sync, read+annotate pass — it never touches the ingest
 * write-path. It computes, via Memgraph + MAGE:
 *
 *   - Story 3.1: god-nodes via betweenness centrality (`n.centrality`)
 *   - Story 3.2: communities via Louvain (`n.community`)
 *   - Story 3.3: "surprising connections" — cross-community edges whose two
 *     endpoints are both high-centrality (the non-obvious architectural bridges)
 *
 * Results are written as node properties (per the ACs) AND shaped into
 * `knowledge/_graph/insights.json`, which the admin Graph tab reads to size
 * nodes by centrality, color them by community, and list surprising connections.
 *
 * GRACEFUL DEGRADATION (3.1 AC): MAGE may not be installed on a given Memgraph.
 * Each procedure call is guarded; if a CALL throws, the pass logs + skips that
 * dimension and still writes a well-formed insights.json (with the relevant
 * `*Available` flag false). It must NEVER crash the sync.
 *
 * Because Epic 1/2 graphs are partitioned by `projectId` with no cross-project
 * edges, the global MAGE procedures compute per-component (≈ per-project) values;
 * we read them back scoped to the project.
 *
 * Pure logic lives here so it can be unit-tested against a fake session (no live
 * Memgraph/MAGE). graph-sync.mjs wires `processGraphAnalytics` into the flow.
 */

// ── MAGE procedure calls (Appendix D) ──────────────────────────────────────

/** Betweenness centrality → `node.centrality`. Throws if MAGE is absent. */
const CENTRALITY_CYPHER = `
  CALL betweenness_centrality.get()
  YIELD node, betweenness_centrality
  SET node.centrality = betweenness_centrality`;

/** Louvain community detection → `node.community`. Throws if MAGE is absent. */
const COMMUNITY_CYPHER = `
  CALL community_detection.get()
  YIELD node, community_id
  SET node.community = community_id`;

/**
 * Run a MAGE procedure, returning true on success and false if it is
 * unavailable (or otherwise fails). Never throws — graceful degradation.
 */
async function tryCall(session, cypher, label, logger) {
  try {
    await session.run(cypher);
    return true;
  } catch (err) {
    logger?.(`MAGE ${label} unavailable — skipping (${err.message})`);
    return false;
  }
}

/**
 * Read back per-node centrality + community for one project after the MAGE
 * passes have annotated the graph.
 *
 * @returns {Promise<Array<{id,kind,title,centrality,community}>>}
 */
async function readMetrics(session, projectId) {
  const r = await session.run(
    `MATCH (n:Node {projectId: $projectId})
     WHERE n.centrality IS NOT NULL OR n.community IS NOT NULL
     RETURN n.nodeId AS id, coalesce(n.kind, 'file') AS kind, n.title AS title,
            n.centrality AS centrality, n.community AS community`,
    { projectId },
  );
  return r.records.map((rec) => ({
    id: rec.get('id'),
    kind: rec.get('kind') || 'file',
    title: rec.get('title') ?? rec.get('id'),
    centrality: numOrNull(rec.get('centrality')),
    community: intOrNull(rec.get('community')),
  }));
}

/**
 * Surprising-connections query (Appendix D / Story 3.3): directed edges whose
 * endpoints are in DIFFERENT communities and BOTH have centrality above the
 * threshold `$c`, ranked by summed endpoint centrality. Top 25.
 *
 * @returns {Promise<Array<object>>}
 */
export async function surprisingConnections(session, projectId, threshold = 0) {
  const r = await session.run(
    `MATCH (a:Node {projectId: $projectId})-[rel]->(b:Node {projectId: $projectId})
     WHERE a.community IS NOT NULL AND b.community IS NOT NULL
       AND a.community <> b.community
       AND a.centrality > $c AND b.centrality > $c
     RETURN a.nodeId AS source, coalesce(a.title, a.nodeId) AS sourceTitle,
            type(rel) AS type,
            b.nodeId AS target, coalesce(b.title, b.nodeId) AS targetTitle,
            a.community AS sourceCommunity, b.community AS targetCommunity,
            a.centrality + b.centrality AS score
     ORDER BY score DESC LIMIT 25`,
    { projectId, c: threshold },
  );
  return r.records.map((rec) => ({
    source: rec.get('source'),
    sourceTitle: rec.get('sourceTitle'),
    type: rec.get('type'),
    target: rec.get('target'),
    targetTitle: rec.get('targetTitle'),
    sourceCommunity: intOrNull(rec.get('sourceCommunity')),
    targetCommunity: intOrNull(rec.get('targetCommunity')),
    score: numOrNull(rec.get('score')),
  }));
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
    mageAvailable: analytics.mageAvailable,
    centralityAvailable: analytics.centralityAvailable,
    communityAvailable: analytics.communityAvailable,
    threshold,
    godNodes: analytics.godNodes,
    communities: analytics.communities,
    surprisingConnections: analytics.surprising,
    nodeMetrics,
  };
}

/**
 * Orchestrate the three analytics dimensions against a session. Each MAGE call
 * degrades gracefully; surprising connections only run when BOTH centrality and
 * community succeeded (they depend on both properties).
 *
 * @returns {Promise<{mageAvailable,centralityAvailable,communityAvailable,metrics,godNodes,communities,surprising}>}
 */
export async function runAnalytics(session, projectId, opts = {}) {
  const threshold = opts.threshold ?? 0;
  const topN = opts.topN ?? 15;
  const logger = opts.logger;

  const centralityAvailable = await tryCall(session, CENTRALITY_CYPHER, 'betweenness_centrality', logger);
  const communityAvailable = await tryCall(session, COMMUNITY_CYPHER, 'community_detection', logger);

  const metrics = centralityAvailable || communityAvailable ? await readMetrics(session, projectId) : [];
  const godNodes = centralityAvailable ? topGodNodes(metrics, topN) : [];
  const communities = communityAvailable ? communityCounts(metrics) : [];
  const surprising =
    centralityAvailable && communityAvailable
      ? await surprisingConnections(session, projectId, threshold)
      : [];

  return {
    mageAvailable: centralityAvailable || communityAvailable,
    centralityAvailable,
    communityAvailable,
    metrics,
    godNodes,
    communities,
    surprising,
  };
}

function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  if (v == null) return null;
  // Memgraph integers may arrive as {low, high} (neo4j Integer) or numbers.
  if (typeof v === 'object' && 'low' in v) return v.low;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
