/**
 * graph-store.mjs — the GraphStore interface, factory, and shared key derivation.
 *
 * Story S0.2 (EU-migration keystone). Memgraph/bolt is EXCISED (KD-1); the graph
 * source of truth is a pair of DynamoDB tables (`futurator-graph-nodes` +
 * `futurator-graph-edges`, adjacency-list + reverse GSI). Every graph story
 * imports this module — the key derivation here is the single correctness hinge:
 * if a key is built one way on write and another on read, every traversal
 * silently breaks. Both impls (`graph-store-dynamo.mjs`, `graph-store-memory.mjs`)
 * build their rows through `buildNodeItem`/`buildEdgeItem` so there is exactly
 * ONE derivation, and a shared interface suite proves both behave identically.
 *
 * ── Storage schema (mirrored by the sst.config.ts table defs, §2.1) ─────────
 *
 * NODES (`futurator-graph-nodes`): PK `projectId`, SK `nodeId`.
 *   Project-scoped GSIs (no query ever crosses projects):
 *     kind-index       hashKey `kindKey`  (=`${projectId}|${kind}`), rangeKey `nodeId`
 *     file-index       hashKey `fileKey`  (=`${projectId}|${file}`), rangeKey `nodeId`
 *     centrality-index hashKey `projectId`, rangeKey `centrality` (number, default 0)
 *   `centrality`/`degree`/`community`/`fanIn` are analytics attrs written by S1.4
 *   (`setNodeAttrs`); `centrality` defaults to 0 on every put so the GSI is
 *   populated before the back-fill. `props` is an allowlist-filtered
 *   (`SYSTEM_GRAPH_NODE_PROPS`) map of the scalar config props.
 *
 * EDGES (`futurator-graph-edges`): PK `src` (=`${projectId}|${nodeId}`),
 *   SK `sk` (=`${edgeType}|${targetId}`). Mirrors for the traversals:
 *     reverse-index  hashKey `dst` (=`${projectId}|${targetId}`), rangeKey `rsk`
 *                    (=`${edgeType}|${nodeId}`)  → `inEdges`
 *     project-index  hashKey `projectId`, rangeKey `sk`            → `listEdges`
 *
 * ── Interface (both impls) ──────────────────────────────────────────────────
 *   putNodes(projectId, nodes[])         → number written
 *   putEdges(projectId, edges[])         → number written
 *   getNode(projectId, nodeId)           → node | null
 *   outEdges(projectId, nodeId, {type?}) → edge[]
 *   inEdges(projectId, nodeId, {type?})  → edge[]
 *   queryByKind(projectId, kind)         → node[]  (one project only)
 *   queryByFile(projectId, file)         → node[]  (one project only)
 *   listNodes(projectId)                 → node[]
 *   listEdges(projectId)                 → edge[]
 *   setNodeAttrs(projectId, nodeId, attrs) → boolean
 *   deleteProject(projectId)             → {nodes, edges} counts
 *
 * Public node shape: { nodeId, kind, file?, title?, label?, status, centrality,
 *                      degree?, community?, fanIn?, updated?, props }
 * Public edge shape: { from, to, type, props }
 */

import { SYSTEM_GRAPH_NODE_PROPS } from './system-graph-ingest.mjs';

export { SYSTEM_GRAPH_NODE_PROPS };

/** The `|` separator used for every composite key (matches §2.1 schema). */
export const KEY_SEP = '|';

/** Default GSI names — mirror the sst.config.ts table defs (S0.1); overridable. */
export const DEFAULT_INDEXES = Object.freeze({
  kind: 'kind-index', // nodes: kindKey / nodeId
  file: 'file-index', // nodes: fileKey / nodeId
  centrality: 'centrality-index', // nodes: projectId / centrality
  reverse: 'reverse-index', // edges: dst / rsk
  project: 'project-index', // edges: projectId / sk
});

// ── Key derivation (the single source of truth for both impls) ──────────────

export function edgeSrc(projectId, nodeId) {
  return `${projectId}${KEY_SEP}${nodeId}`;
}
export function edgeSk(edgeType, targetId) {
  return `${edgeType}${KEY_SEP}${targetId}`;
}
export function nodeKindKey(projectId, kind) {
  return `${projectId}${KEY_SEP}${kind}`;
}
export function nodeFileKey(projectId, file) {
  return `${projectId}${KEY_SEP}${file}`;
}

const NUM = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Normalize an input node into the persisted DynamoDB item (also used verbatim
 * by the memory impl so key derivation is identical). `nodeId`/`kind` are the
 * only required fields; `id` is accepted as a `nodeId` alias (legacy fake shape).
 * `centrality` always defaults to 0 so the centrality-index is populated before
 * S1.4 back-fills. `fileKey` is only set when a `file` exists (a fileless node
 * simply never appears in `file-index` — correct, not a bug). `props` is filtered
 * to the `SYSTEM_GRAPH_NODE_PROPS` allowlist.
 */
export function buildNodeItem(projectId, node) {
  if (!projectId) throw new Error('graph-store: projectId is required');
  if (!node || typeof node !== 'object') throw new Error('graph-store: node must be an object');
  const nodeId = node.nodeId ?? node.id;
  if (!nodeId) throw new Error('graph-store: node.nodeId is required');
  const kind = node.kind ?? 'file';

  const item = {
    projectId,
    nodeId,
    kind,
    kindKey: nodeKindKey(projectId, kind),
    centrality: NUM(node.centrality) ?? 0,
    status: node.status ?? 'active',
  };

  if (node.file != null && node.file !== '') {
    item.file = node.file;
    item.fileKey = nodeFileKey(projectId, node.file);
  }
  if (node.title != null) item.title = node.title;
  if (node.label != null) item.label = node.label;
  if (NUM(node.degree) !== undefined) item.degree = node.degree;
  if (node.community != null) item.community = node.community;
  if (NUM(node.fanIn) !== undefined) item.fanIn = node.fanIn;
  if (node.updated != null) item.updated = node.updated;

  const raw = node.props && typeof node.props === 'object' ? node.props : {};
  const props = {};
  for (const k of SYSTEM_GRAPH_NODE_PROPS) {
    if (raw[k] !== undefined && raw[k] !== null) props[k] = raw[k];
  }
  if (Object.keys(props).length) item.props = props;

  return item;
}

/** Normalize an input edge into the persisted item with all four key mirrors. */
export function buildEdgeItem(projectId, edge) {
  if (!projectId) throw new Error('graph-store: projectId is required');
  if (!edge || typeof edge !== 'object') throw new Error('graph-store: edge must be an object');
  const from = edge.from ?? edge.src ?? edge.source;
  const to = edge.to ?? edge.target ?? edge.dst;
  const type = edge.type ?? edge.edgeType;
  if (!from || !to || !type) {
    throw new Error('graph-store: edge requires from, to, and type');
  }

  const item = {
    src: edgeSrc(projectId, from),
    sk: edgeSk(type, to),
    dst: edgeSrc(projectId, to),
    rsk: edgeSk(type, from),
    projectId,
    from,
    to,
    type,
  };
  if (edge.props && typeof edge.props === 'object' && Object.keys(edge.props).length) {
    item.props = { ...edge.props };
  }
  return item;
}

/** Persisted node item → public node shape (drops internal composite keys). */
export function toNode(item) {
  if (!item) return null;
  const node = {
    nodeId: item.nodeId,
    kind: item.kind,
    status: item.status ?? 'active',
    centrality: NUM(item.centrality) ?? 0,
  };
  if (item.file != null) node.file = item.file;
  if (item.title != null) node.title = item.title;
  if (item.label != null) node.label = item.label;
  if (item.degree != null) node.degree = item.degree;
  if (item.community != null) node.community = item.community;
  if (item.fanIn != null) node.fanIn = item.fanIn;
  if (item.updated != null) node.updated = item.updated;
  node.props = item.props ? { ...item.props } : {};
  return node;
}

/** Persisted edge item → public edge shape. */
export function toEdge(item) {
  if (!item) return null;
  return {
    from: item.from,
    to: item.to,
    type: item.type,
    props: item.props ? { ...item.props } : {},
  };
}

/**
 * The mutable attrs `setNodeAttrs` accepts (analytics back-fill + prune status
 * flip). `kind`/`file` recompute their composite keys when supplied so the GSIs
 * stay coherent.
 */
export const MUTABLE_NODE_ATTRS = Object.freeze([
  'centrality',
  'degree',
  'community',
  'fanIn',
  'status',
  'title',
  'label',
]);

/**
 * Factory: returns the DynamoDB-backed store when table names resolve (opts or
 * `GRAPH_NODES_TABLE`/`GRAPH_EDGES_TABLE` env), otherwise the in-memory store.
 * The "table env missing → degrade" posture lives in the *consumers* (they
 * decide whether to skip a graph feature); this factory just picks an impl.
 * Dynamic imports keep the aws-sdk out of the memory path.
 *
 * @returns {Promise<object>} a GraphStore
 */
export async function createGraphStore(opts = {}) {
  const nodesTable = opts.nodesTable ?? process.env.GRAPH_NODES_TABLE;
  const edgesTable = opts.edgesTable ?? process.env.GRAPH_EDGES_TABLE;
  if (nodesTable && edgesTable) {
    const { createDynamoGraphStore } = await import('./graph-store-dynamo.mjs');
    return createDynamoGraphStore({ ...opts, nodesTable, edgesTable });
  }
  const { createMemoryGraphStore } = await import('./graph-store-memory.mjs');
  return createMemoryGraphStore(opts);
}
