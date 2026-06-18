/**
 * Mycelium-MCP — the graph as an agent tool (Epic 4, PRD §5.5 / Appendix D).
 *
 * Pipeline DEV agents query the system graph as MCP tools instead of grepping:
 *
 *   - query_graph(question, projectId)  → wraps search-cascade.mjs (Story 4.1)
 *   - get_node(nodeId, projectId)       → one node + its degree
 *   - neighbors(nodeId, projectId, dir) → adjacent nodes by edge type
 *   - blast_radius(files[], projectId)  → ≤2-hop cross-stack reach, grouped by
 *       kind, INCLUDING the W5 event edges so async S3/SNS/cron chains are never
 *       a false "all-clear" (Story 4.2)
 *   - god_nodes / orphans / shortest_path                        (Story 4.2)
 *
 * DESIGN (mirrors the Epic 2/3 pure-lib + fake-session pattern):
 *   - The tool LOGIC lives in exported functions that take a Bolt `session`, so
 *     they unit-test against a fake graph with no live Memgraph/MAGE.
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
import { createDriver } from '../scripts/lib/memgraph-driver.mjs';
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

// ── Tool implementations (session-injected, unit-testable) ──────────────────

/**
 * query_graph — Story 4.1. Thin wrapper over the 4-layer search cascade. Returns
 * the structured cascade result (graph nodes + wiki + grep + source files).
 * Cold-Memgraph degradation is the cascade's own job (Layer 1 → grep/read).
 *
 * @param {object} ctx - { cascade?, workingDir }. `cascade` is injectable for tests.
 */
export async function queryGraph({ question, projectId, maxLayer = 4 }, ctx = {}) {
  const run = ctx.cascade ?? searchCascade;
  const workingDir = ctx.workingDir ?? `/home/ubuntu/projects/${projectId}`;
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

/** get_node — one node plus its incident degree. */
export async function getNode(session, { nodeId, projectId }) {
  const r = await session.run(
    `MATCH (n:Node {nodeId: $nodeId, projectId: $projectId})
     OPTIONAL MATCH (n)--(m:Node)
     RETURN n.nodeId AS id, coalesce(n.kind,'file') AS kind, n.title AS title,
            n.centrality AS centrality, n.community AS community,
            count(DISTINCT m) AS degree`,
    { nodeId, projectId },
  );
  if (r.records.length === 0) return null;
  const rec = r.records[0];
  return {
    id: rec.get('id'),
    kind: rec.get('kind') || 'file',
    title: rec.get('title') ?? rec.get('id'),
    centrality: numOrNull(rec.get('centrality')),
    community: intOrNull(rec.get('community')),
    degree: intOrNull(rec.get('degree')) ?? 0,
  };
}

/** neighbors — adjacent nodes by edge type. dir: 'out' | 'in' | 'any' (default). */
export async function neighbors(session, { nodeId, projectId, dir = 'any', limit = 100 }) {
  const arrow =
    dir === 'out' ? '-[rel]->' : dir === 'in' ? '<-[rel]-' : '-[rel]-';
  const r = await session.run(
    `MATCH (n:Node {nodeId: $nodeId, projectId: $projectId})${arrow}(m:Node)
     RETURN type(rel) AS type, m.nodeId AS id, coalesce(m.kind,'file') AS kind,
            coalesce(m.title, m.nodeId) AS title
     LIMIT $limit`,
    { nodeId, projectId, limit: intParam(limit) },
  );
  return r.records.map((rec) => ({
    type: rec.get('type'),
    id: rec.get('id'),
    kind: rec.get('kind') || 'file',
    title: rec.get('title'),
  }));
}

/**
 * blast_radius — Story 4.2. All nodes reachable in ≤2 hops from the changed
 * files via the cross-stack edge set (incl. W5 event edges), grouped by kind.
 *
 * @returns {Promise<{projectId, files, totalReached, groups, touchesPaidService}>}
 */
export async function blastRadius(session, { files, projectId, hops = 2 }) {
  const fileIds = Array.isArray(files) ? files : [files];
  const hopsSafe = Math.max(1, Math.min(4, Math.floor(hops)));
  const relFilter = BLAST_EDGE_TYPES.join('|');
  const r = await session.run(
    `MATCH (f:Node {projectId: $projectId}) WHERE f.nodeId IN $fileIds
     MATCH (f)-[:${relFilter}*1..${hopsSafe}]-(x:Node {projectId: $projectId})
     WHERE NOT x.nodeId IN $fileIds
     RETURN DISTINCT x.nodeId AS id, coalesce(x.kind,'file') AS kind,
            coalesce(x.title, x.nodeId) AS title, x.billable AS billable
     ORDER BY kind, id`,
    { projectId, fileIds },
  );
  const groups = {};
  let touchesPaidService = false;
  for (const rec of r.records) {
    const kind = rec.get('kind') || 'file';
    (groups[kind] ??= []).push({ id: rec.get('id'), title: rec.get('title') });
    if (rec.get('billable') === true) touchesPaidService = true;
  }
  const totalReached = Object.values(groups).reduce((s, g) => s + g.length, 0);
  return { projectId, files: fileIds, totalReached, groups, touchesPaidService };
}

/** god_nodes — top centrality nodes for a project (Epic 3 metric, read-only). */
export async function godNodes(session, { projectId, limit = 15 }) {
  const r = await session.run(
    `MATCH (n:Node {projectId: $projectId})
     WHERE n.centrality IS NOT NULL AND n.centrality > 0
     RETURN n.nodeId AS id, coalesce(n.kind,'file') AS kind,
            coalesce(n.title, n.nodeId) AS title, n.centrality AS centrality
     ORDER BY centrality DESC, id LIMIT $limit`,
    { projectId, limit: intParam(limit) },
  );
  return r.records.map((rec) => ({
    id: rec.get('id'),
    kind: rec.get('kind') || 'file',
    title: rec.get('title'),
    centrality: numOrNull(rec.get('centrality')),
  }));
}

/** orphans — degree-0 active nodes (the "no alone dots" invariant, read-only). */
export async function orphans(session, { projectId, limit = 100 }) {
  const r = await session.run(
    `MATCH (n:Node {projectId: $projectId})
     WHERE NOT (n)--() AND coalesce(n.status,'active') <> 'pruned'
     RETURN n.nodeId AS id, coalesce(n.kind,'file') AS kind,
            coalesce(n.title, n.nodeId) AS title
     LIMIT $limit`,
    { projectId, limit: intParam(limit) },
  );
  return r.records.map((rec) => ({
    id: rec.get('id'),
    kind: rec.get('kind') || 'file',
    title: rec.get('title'),
  }));
}

/** shortest_path — a cross-layer BFS path between two nodes (component→…→table). */
export async function shortestPath(session, { from, to, projectId, maxHops = 8 }) {
  const hopsSafe = Math.max(1, Math.min(12, Math.floor(maxHops)));
  const r = await session.run(
    `MATCH path = (a:Node {nodeId: $from, projectId: $projectId})
                  -[*BFS 1..${hopsSafe}]-
                  (b:Node {nodeId: $to, projectId: $projectId})
     RETURN [n IN nodes(path) | n.nodeId] AS ids,
            [r IN relationships(path) | type(r)] AS types
     LIMIT 1`,
    { from, to, projectId },
  );
  if (r.records.length === 0) return { from, to, found: false, hops: 0, nodes: [], edges: [] };
  const rec = r.records[0];
  const ids = rec.get('ids') ?? [];
  const types = rec.get('types') ?? [];
  return { from, to, found: true, hops: types.length, nodes: ids, edges: types };
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
    name: 'blast_radius',
    description:
      'Everything a set of changed files touches in ≤2 hops across code+infra+services (incl. event/cron chains), grouped by kind. Call BEFORE editing.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        projectId: { type: 'string' },
      },
      required: ['files', 'projectId'],
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
 * Route a tool call to its implementation. `ctx` carries the live `session`
 * (Bolt) and, for query_graph, an optional injectable `cascade` + `workingDir`.
 * Returns the raw structured result (telemetry wrapping is the caller's job).
 */
export async function dispatchTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'query_graph':
      return queryGraph(args, ctx);
    case 'get_node':
      return getNode(ctx.session, args);
    case 'neighbors':
      return neighbors(ctx.session, args);
    case 'blast_radius':
      return blastRadius(ctx.session, args);
    case 'god_nodes':
      return godNodes(ctx.session, args);
    case 'orphans':
      return orphans(ctx.session, args);
    case 'shortest_path':
      return shortestPath(ctx.session, args);
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

// ── neo4j scalar coercion (shared with graph-analytics) ─────────────────────

function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : typeof v === 'object' && v.toNumber ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'object' && 'low' in v) return v.low;
  if (typeof v === 'object' && v.toNumber) return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
/** neo4j-driver wants integers via neo4j.int(); pass-through when unavailable in tests. */
function intParam(v) {
  return Math.max(1, Math.floor(Number(v) || 1));
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

  const driver = createDriver();
  const server = new Server(
    { name: 'mycelium-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const session = driver.session();
    try {
      const result = await dispatchWithTelemetry(name, args, { session });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `mycelium-mcp ${name} failed: ${err.message}` }],
      };
    } finally {
      await session.close();
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
