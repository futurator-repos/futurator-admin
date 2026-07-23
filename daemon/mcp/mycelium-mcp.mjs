/**
 * Mycelium-MCP — the graph as an agent tool (Epic 4, PRD §5.5 / Appendix D).
 *
 * Pipeline DEV agents query the system graph as MCP tools instead of grepping.
 * The graph source of truth is the DynamoDB-backed `GraphStore` (Story S0.2,
 * EU-migration keystone KD-1) — Memgraph/bolt is EXCISED. The store runs from
 * ANY fleet host (per-server IAM keys) AND from Lambda; bolt never could.
 *
 * Tools:
 *   - query_graph(question, projectId)   → wraps search-cascade.mjs (Story 4.1)
 *   - get_node(nodeId, projectId)        → one node + its incident degree
 *   - neighbors(nodeId, projectId, dir)  → adjacent nodes by edge type
 *   - transitive_reach(files[], projectId) → ≤N-hop cross-stack reach, grouped by
 *       kind, INCLUDING the W5 event edges so async S3/SNS/cron chains are never
 *       a false "all-clear" (was `blast_radius`; alias kept)
 *   - get_file_symbols(file, projectId)  → symbols declared in a file (file-index)
 *   - list_kind(kind, projectId)         → all nodes of a kind (kind-index)
 *   - dependency_subgraph(root, …)       → BFS-out subgraph (depth≤3, cap 500)
 *   - path_between(from, to, …)          → bidirectional meet-in-middle path (≤12)
 *   - god_nodes / orphans / shortest_path                        (Story 4.2)
 *
 * DESIGN (mirrors the Epic 2/3 pure-lib + store pattern):
 *   - The tool LOGIC lives in exported functions that take a `GraphStore`, so
 *     they unit-test against the in-memory store (`graph-store-memory.mjs`) with
 *     no live DynamoDB.
 *   - `TOOL_DEFS` + `dispatchTool` are the transport-agnostic surface.
 *   - The actual MCP **stdio transport** is bootstrapped only when this file is
 *     run as a server; the `@modelcontextprotocol/sdk` import is DYNAMIC so the
 *     core imports/tests without the SDK installed (run the server needs it:
 *     `cd daemon && npm install`).
 *   - Every dispatch is wrapped with telemetry (Story 4.3).
 *
 * Forbidden area (Story 4.1): we WRAP search-cascade.mjs, never fork it.
 */

import { searchCascade } from '../scripts/search-cascade.mjs';
import { createGraphStore } from '../scripts/lib/graph-store.mjs';
import { appendTelemetry, buildTelemetryRecord } from './telemetry.mjs';

// ── blast-radius edge set (Story 4.2 AC / Appendix D) ───────────────────────
// The W5 event edges (TRIGGERS/SUBSCRIBES/EMITS) are MANDATORY — omitting them
// yields a false all-clear for S3/SNS/cron-triggered chains. IMPORTS carries the
// "dependent files" group.
export const BLAST_EDGE_TYPES = [
  'READS', 'USES', 'CALLS', 'DEFINES', 'WRITES',
  'CALLS_SERVICE', 'CALLS_ENDPOINT', 'ROUTES',
  'TRIGGERS', 'SUBSCRIBES', 'EMITS', 'IMPORTS',
];

// ── small helpers (plain JS — no neo4j scalar coercion any more) ─────────────

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function intOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}
/** Positive integer with a default fallback (replaces the old neo4j `intParam`). */
function clampInt(v, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const shape = (n, id) => ({
  id,
  kind: n?.kind || 'file',
  title: n?.title ?? id,
});

/** Undirected adjacency of a node: both out- and in-edges, as {id, type}. */
async function undirectedAdj(store, projectId, id) {
  const [out, inc] = await Promise.all([
    store.outEdges(projectId, id),
    store.inEdges(projectId, id),
  ]);
  const adj = [];
  for (const e of out) adj.push({ id: e.to, type: e.type });
  for (const e of inc) adj.push({ id: e.from, type: e.type });
  return adj;
}

// ── Tool implementations (store-injected, unit-testable) ─────────────────────

/**
 * query_graph — Story 4.1. Thin wrapper over the 4-layer search cascade. Returns
 * the structured cascade result (graph nodes + wiki + grep + source files).
 * Cold-store degradation is the cascade's own job (Layer 1 → grep/read).
 *
 * @param {object} ctx - { cascade?, workingDir }. `cascade` is injectable for tests.
 */
export async function queryGraph({ question, projectId, maxLayer = 4 }, ctx = {}) {
  const run = ctx.cascade ?? searchCascade;
  const workingDir = ctx.workingDir ?? `projects/${projectId}`;
  const result = await run(projectId, question, workingDir, { maxLayer });
  return {
    projectId,
    question,
    graphResults: result.graphResults ?? [],
    wikiArticles: (result.wikiArticles ?? []).map((a) => ({
      nodeId: a.nodeId,
      title: a.title,
      purpose: a.purpose,
    })),
    sourceFiles: (result.sourceFiles ?? []).map((f) => ({ path: f.path, size: f.size })),
    grepMatchCount: (result.grepMatches ?? []).reduce((s, m) => s + (m.matchCount ?? 0), 0),
    fallbackUsed: (result.graphResults ?? []).length === 0,
  };
}

/** get_node — one node plus its incident (undirected) degree. */
export async function getNode(store, { nodeId, projectId }) {
  const node = await store.getNode(projectId, nodeId);
  if (!node) return null;
  const [out, inc] = await Promise.all([
    store.outEdges(projectId, nodeId),
    store.inEdges(projectId, nodeId),
  ]);
  const neighborIds = new Set();
  for (const e of out) neighborIds.add(e.to);
  for (const e of inc) neighborIds.add(e.from);
  return {
    id: node.nodeId,
    kind: node.kind || 'file',
    title: node.title ?? node.nodeId,
    centrality: numOrNull(node.centrality),
    community: intOrNull(node.community),
    degree: neighborIds.size,
  };
}

/** neighbors — adjacent nodes by edge type. dir: 'out' | 'in' | 'any' (default). */
export async function neighbors(store, { nodeId, projectId, dir = 'any', limit = 100 }) {
  const lim = clampInt(limit, 100);
  let raw = [];
  if (dir === 'out') {
    for (const e of await store.outEdges(projectId, nodeId)) raw.push({ type: e.type, id: e.to });
  } else if (dir === 'in') {
    for (const e of await store.inEdges(projectId, nodeId)) raw.push({ type: e.type, id: e.from });
  } else {
    for (const e of await store.outEdges(projectId, nodeId)) raw.push({ type: e.type, id: e.to });
    for (const e of await store.inEdges(projectId, nodeId)) raw.push({ type: e.type, id: e.from });
  }
  raw = raw.slice(0, lim);
  const ids = [...new Set(raw.map((r) => r.id))];
  const hydrated = new Map();
  await Promise.all(ids.map(async (id) => hydrated.set(id, await store.getNode(projectId, id))));
  return raw.map((r) => ({ type: r.type, ...shape(hydrated.get(r.id), r.id) }));
}

/**
 * transitive_reach (was blast_radius) — Story 4.2. All nodes reachable in ≤N hops
 * (default 2, max 4) from the changed files via the cross-stack edge set (incl.
 * the W5 event edges), grouped by kind, undirected. `touchesPaidService` reads
 * the W10 `billable` prop off any reached node.
 *
 * @returns {Promise<{projectId, files, totalReached, groups, touchesPaidService}>}
 */
export async function transitiveReach(store, { files, projectId, hops = 2 }) {
  const fileIds = Array.isArray(files) ? files : [files];
  const hopsSafe = Math.max(1, Math.min(4, Math.floor(Number(hops) || 2)));
  const blast = new Set(BLAST_EDGE_TYPES);
  const seed = new Set(fileIds);
  const visited = new Set(fileIds);
  const reached = new Set();
  let frontier = [...fileIds];

  for (let h = 0; h < hopsSafe && frontier.length; h++) {
    const next = [];
    await Promise.all(
      frontier.map(async (id) => {
        const [out, inc] = await Promise.all([
          store.outEdges(projectId, id),
          store.inEdges(projectId, id),
        ]);
        const nbrs = [];
        for (const e of out) if (blast.has(e.type)) nbrs.push(e.to);
        for (const e of inc) if (blast.has(e.type)) nbrs.push(e.from);
        for (const nid of nbrs) {
          if (visited.has(nid)) continue;
          visited.add(nid);
          next.push(nid);
          if (!seed.has(nid)) reached.add(nid);
        }
      }),
    );
    frontier = next;
  }

  const reachedIds = [...reached].sort();
  const nodes = await Promise.all(reachedIds.map((id) => store.getNode(projectId, id)));
  const groups = {};
  let touchesPaidService = false;
  for (let i = 0; i < reachedIds.length; i++) {
    const id = reachedIds[i];
    const n = nodes[i];
    const kind = n?.kind || 'file';
    (groups[kind] ??= []).push({ id, title: n?.title ?? id });
    if (n?.props?.billable === true) touchesPaidService = true;
  }
  const totalReached = Object.values(groups).reduce((s, g) => s + g.length, 0);
  return { projectId, files: fileIds, totalReached, groups, touchesPaidService };
}

/** Backwards-compatible alias for the renamed tool. */
export const blastRadius = transitiveReach;

/** get_file_symbols — every node declared in a file (file-index / queryByFile). */
export async function getFileSymbols(store, { file, projectId }) {
  const nodes = await store.queryByFile(projectId, file);
  return nodes.map((n) => ({ ...shape(n, n.nodeId), centrality: numOrNull(n.centrality) }));
}

/** list_kind — all nodes of a given kind for a project (kind-index / queryByKind). */
export async function listKind(store, { kind, projectId, limit = 200 }) {
  const lim = clampInt(limit, 200);
  const nodes = await store.queryByKind(projectId, kind);
  return nodes
    .slice(0, lim)
    .map((n) => ({ ...shape(n, n.nodeId), centrality: numOrNull(n.centrality) }));
}

/**
 * dependency_subgraph — BFS OUT-edges from a root, depth ≤3, node cap 500.
 * Returns the collected nodes + the traversed edges, and a `truncated` flag when
 * the cap is hit. Directed (dependencies flow along out-edges).
 */
export async function dependencySubgraph(store, { root, projectId, depth = 3, cap = 500 }) {
  const depthSafe = Math.max(1, Math.min(3, Math.floor(Number(depth) || 3)));
  const capSafe = Math.max(1, Math.min(500, Math.floor(Number(cap) || 500)));
  const visited = new Set([root]);
  const nodeIds = [root];
  const edges = [];
  let frontier = [root];
  let truncated = false;

  for (let d = 0; d < depthSafe && frontier.length && !truncated; d++) {
    const next = [];
    for (const id of frontier) {
      const out = await store.outEdges(projectId, id);
      for (const e of out) {
        edges.push({ from: e.from, to: e.to, type: e.type });
        if (!visited.has(e.to)) {
          if (nodeIds.length >= capSafe) {
            truncated = true;
            break;
          }
          visited.add(e.to);
          nodeIds.push(e.to);
          next.push(e.to);
        }
      }
      if (truncated) break;
    }
    frontier = next;
  }

  const hydrated = await Promise.all(nodeIds.map((id) => store.getNode(projectId, id)));
  const nodes = nodeIds.map((id, i) => shape(hydrated[i], id));
  return {
    root,
    projectId,
    depth: depthSafe,
    cap: capSafe,
    truncated,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
  };
}

/**
 * god_nodes — top centrality nodes for a project (Epic 3 metric, read-only).
 * The GraphStore interface (S0.2) does not expose the centrality-index GSI as a
 * query method, so we rank client-side over `listNodes`; the ordering matches the
 * GSI-3 descending contract. Zero/absent centrality is excluded.
 */
export async function godNodes(store, { projectId, limit = 15 }) {
  const lim = clampInt(limit, 15);
  const nodes = await store.listNodes(projectId);
  return nodes
    .filter((n) => typeof n.centrality === 'number' && n.centrality > 0)
    .sort((a, b) => b.centrality - a.centrality || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    .slice(0, lim)
    .map((n) => ({ ...shape(n, n.nodeId), centrality: numOrNull(n.centrality) }));
}

/**
 * orphans — degree-0 active nodes (the "no alone dots" invariant, read-only).
 * A node is an orphan when it appears on neither end of any edge and is not
 * pruned. Computed live from `listNodes` + `listEdges`.
 */
export async function orphans(store, { projectId, limit = 100 }) {
  const lim = clampInt(limit, 100);
  const [nodes, edges] = await Promise.all([
    store.listNodes(projectId),
    store.listEdges(projectId),
  ]);
  const referenced = new Set();
  for (const e of edges) {
    referenced.add(e.from);
    referenced.add(e.to);
  }
  return nodes
    .filter((n) => !referenced.has(n.nodeId) && (n.status ?? 'active') !== 'pruned')
    .slice(0, lim)
    .map((n) => shape(n, n.nodeId));
}

// ── path finding (bidirectional meet-in-the-middle BFS over undirected edges) ──

/** Walk a parent map from `node` toward its root; returns nodes+edges root-inclusive. */
function pathToRoot(prevMap, node) {
  const nodes = [];
  const edges = [];
  let cur = node;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    nodes.push(cur);
    const p = prevMap.get(cur);
    if (!p) break;
    edges.push(p.type);
    cur = p.prev;
  }
  return { nodes, edges }; // nodes: [node … root]
}

function reconstructPath(meet, from, to, fPrev, tPrev) {
  const f = pathToRoot(fPrev, meet); // [meet … from]
  const fNodes = [...f.nodes].reverse(); // [from … meet]
  const fEdges = [...f.edges].reverse();
  const t = pathToRoot(tPrev, meet); // [meet … to]
  const tNodes = t.nodes.slice(1); // drop meet → [… to]
  const tEdges = t.edges; // meet → … → to
  const nodes = [...fNodes, ...tNodes];
  const edges = [...fEdges, ...tEdges];
  return { from, to, found: true, hops: edges.length, nodes, edges };
}

async function findPath(store, { from, to, projectId, maxHops }) {
  const cap = Math.max(1, Math.min(12, Math.floor(Number(maxHops) || 12)));
  if (from === to) return { from, to, found: true, hops: 0, nodes: [from], edges: [] };

  const fPrev = new Map([[from, null]]);
  const tPrev = new Map([[to, null]]);
  let fLayer = [from];
  let tLayer = [to];
  let expansions = 0;

  while (fLayer.length && tLayer.length && expansions < cap) {
    const expandF = fLayer.length <= tLayer.length;
    const layer = expandF ? fLayer : tLayer;
    const selfPrev = expandF ? fPrev : tPrev;
    const otherPrev = expandF ? tPrev : fPrev;
    const next = [];
    let meet = null;

    for (const id of layer) {
      const adj = await undirectedAdj(store, projectId, id);
      for (const { id: nid, type } of adj) {
        if (!selfPrev.has(nid)) {
          selfPrev.set(nid, { prev: id, type });
          next.push(nid);
        }
        if (otherPrev.has(nid)) {
          meet = nid;
          break;
        }
      }
      if (meet) break;
    }

    if (meet) {
      const built = reconstructPath(meet, from, to, fPrev, tPrev);
      return built.hops <= cap ? built : { from, to, found: false, hops: 0, nodes: [], edges: [] };
    }
    if (expandF) fLayer = next;
    else tLayer = next;
    expansions++;
  }
  return { from, to, found: false, hops: 0, nodes: [], edges: [] };
}

/** shortest_path — a cross-layer path between two nodes (component→…→table). */
export async function shortestPath(store, { from, to, projectId, maxHops = 8 }) {
  return findPath(store, { from, to, projectId, maxHops });
}

/** path_between — bidirectional meet-in-the-middle path, up to 12 hops. */
export async function pathBetween(store, { from, to, projectId, maxHops = 12 }) {
  return findPath(store, { from, to, projectId, maxHops });
}

// ── Tool registry + dispatch (transport-agnostic) ───────────────────────────

export const TOOL_DEFS = [
  {
    name: 'query_graph',
    description:
      'Search the system graph for a project (4-layer cascade: vector+structural → wiki → grep → source). Use to locate where something lives.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural-language query' },
        projectId: { type: 'string' },
      },
      required: ['question', 'projectId'],
    },
  },
  {
    name: 'get_node',
    description: 'Fetch one graph node (kind, title, centrality, community, degree) by nodeId.',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, projectId: { type: 'string' } },
      required: ['nodeId', 'projectId'],
    },
  },
  {
    name: 'neighbors',
    description: 'List nodes adjacent to a node, by edge type. dir = out|in|any.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        projectId: { type: 'string' },
        dir: { type: 'string', enum: ['out', 'in', 'any'] },
      },
      required: ['nodeId', 'projectId'],
    },
  },
  {
    name: 'transitive_reach',
    description:
      'Everything a set of changed files touches in ≤N hops across code+infra+services (incl. event/cron chains), grouped by kind. Call BEFORE editing. (Formerly blast_radius.)',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        projectId: { type: 'string' },
        hops: { type: 'number', description: 'Hop radius (1–4, default 2)' },
      },
      required: ['files', 'projectId'],
    },
  },
  {
    name: 'get_file_symbols',
    description: 'List the graph nodes (functions/classes/symbols) declared in a source file.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, projectId: { type: 'string' } },
      required: ['file', 'projectId'],
    },
  },
  {
    name: 'list_kind',
    description: 'List all nodes of a given kind (e.g. table, endpoint, externalService, file).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        projectId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['kind', 'projectId'],
    },
  },
  {
    name: 'dependency_subgraph',
    description:
      'Directed out-edge subgraph rooted at a node (depth ≤3, capped at 500 nodes). Use to see what a node depends on, transitively.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        projectId: { type: 'string' },
        depth: { type: 'number', description: 'BFS depth (1–3, default 3)' },
        cap: { type: 'number', description: 'Max nodes (≤500)' },
      },
      required: ['root', 'projectId'],
    },
  },
  {
    name: 'path_between',
    description:
      'A path between two nodes via bidirectional meet-in-the-middle search (≤12 hops).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        projectId: { type: 'string' },
        maxHops: { type: 'number' },
      },
      required: ['from', 'to', 'projectId'],
    },
  },
  {
    name: 'god_nodes',
    description: 'Top structurally-critical nodes by betweenness centrality.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, limit: { type: 'number' } },
      required: ['projectId'],
    },
  },
  {
    name: 'orphans',
    description: 'Degree-0 (unreferenced) nodes — possible dead code / extractor gaps.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, limit: { type: 'number' } },
      required: ['projectId'],
    },
  },
  {
    name: 'shortest_path',
    description: 'A cross-layer path between two nodes (e.g. component → endpoint → table).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        projectId: { type: 'string' },
      },
      required: ['from', 'to', 'projectId'],
    },
  },
];

/**
 * Route a tool call to its implementation. `ctx` carries the live `store`
 * (GraphStore) and, for query_graph, an optional injectable `cascade` +
 * `workingDir`. Returns the raw structured result (telemetry wrapping is the
 * caller's job). `blast_radius` is kept as an alias for `transitive_reach`.
 */
export async function dispatchTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'query_graph':
      return queryGraph(args, ctx);
    case 'get_node':
      return getNode(ctx.store, args);
    case 'neighbors':
      return neighbors(ctx.store, args);
    case 'transitive_reach':
    case 'blast_radius': // alias (renamed)
      return transitiveReach(ctx.store, args);
    case 'get_file_symbols':
      return getFileSymbols(ctx.store, args);
    case 'list_kind':
      return listKind(ctx.store, args);
    case 'dependency_subgraph':
      return dependencySubgraph(ctx.store, args);
    case 'path_between':
      return pathBetween(ctx.store, args);
    case 'god_nodes':
      return godNodes(ctx.store, args);
    case 'orphans':
      return orphans(ctx.store, args);
    case 'shortest_path':
      return shortestPath(ctx.store, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Dispatch + emit a telemetry record (Story 4.3). `tokensIn/Out` are estimated
 * from arg/result size when the transport doesn't supply real counts; the sink
 * is `knowledge/_graph/mcp-telemetry.jsonl`. Never lets a telemetry-write error
 * fail the tool call.
 */
export async function dispatchWithTelemetry(name, args = {}, ctx = {}) {
  let result;
  let fallbackUsed = false;
  try {
    result = await dispatchTool(name, args, ctx);
    fallbackUsed = !!result?.fallbackUsed;
    return result;
  } finally {
    try {
      const record = buildTelemetryRecord({
        tool: name,
        projectId: args.projectId,
        storyId: ctx.storyId ?? null,
        argsSize: JSON.stringify(args).length,
        resultSize: result ? JSON.stringify(result).length : 0,
        fallbackUsed,
        ts: ctx.now ?? new Date().toISOString(),
      });
      await appendTelemetry(record, ctx.telemetryPath, ctx.sink);
    } catch {
      /* telemetry must never break the tool */
    }
  }
}

// ── stdio MCP transport bootstrap (server-only; dynamic SDK import) ──────────

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('mycelium-mcp.mjs') || process.argv[1].endsWith('mycelium-mcp'));

export async function startServer() {
  // Dynamic import keeps the SDK off the unit-test / core path.
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );

  // One GraphStore for the process lifetime. Resolves to the DynamoDB store when
  // GRAPH_NODES_TABLE/GRAPH_EDGES_TABLE are set (fleet host / Lambda with IAM),
  // otherwise the in-memory store — no bolt, so this boots on ANY host.
  const store = await createGraphStore();
  const server = new Server(
    { name: 'mycelium-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await dispatchWithTelemetry(name, args, { store });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `mycelium-mcp ${name} failed: ${err.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mycelium-mcp] stdio server ready');
}

if (isMain) {
  startServer().catch((err) => {
    console.error(`[mycelium-mcp] fatal: ${err.message}`);
    process.exit(1);
  });
}
