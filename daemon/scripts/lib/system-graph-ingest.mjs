/**
 * System Graph Ingest — graph-sync's entrypoint for extractor envelopes.
 * Story SG-1.1 (foundation); extended by SG-1.6 (env-join / CALLS_ENDPOINT).
 *
 * `graph-sync.mjs` runs a CLI `main()` on import, so it can't be unit-tested
 * directly. Following the same reasoning that moved import resolution into
 * `lib/import-resolver.mjs`, the system-graph ingest logic lives here as pure,
 * store-driven functions that tests can drive with an in-memory GraphStore
 * (S1.2, EU-migration: Memgraph/bolt is EXCISED — see `lib/graph-store.mjs`).
 *
 * Every system-graph node flows through the existing `:Node {nodeId}` model —
 * NO schema rewrite. New `kind` values (table | lambda | cron | secret | bucket
 * | bucketPath | cloudfront | iamRole | endpoint | externalService | topic |
 * queue | bus | eventSource) are just additional discriminator values.
 */

// Relationship types the system-graph extractors may emit. Cypher cannot
// parameterize a relationship type, so the type is interpolated into the query
// string — this allowlist is the injection guard. An edge whose type is not
// here is skipped (and counted), never executed.
export const SYSTEM_GRAPH_EDGE_TYPES = new Set([
  'HANDLED_BY', // lambda/cron/endpoint → file
  'USES', // lambda → table/secret/service
  'WRITES', // lambda → bucketPath
  'REPRESENTS', // secret → externalService
  'ROUTES', // endpoint → lambda
  'CALLS_SERVICE', // file → externalService
  'TRIGGERS', // eventSource/topic/cron → lambda
  'SUBSCRIBES', // lambda → topic/bus
  'EMITS', // file/lambda → topic/bus
  'READS', // file → table (env-join, SG-1.6)
  'CALLS_ENDPOINT', // component → endpoint (SG-1.6)
  'CALLS', // function → function (cross-file, ts-morph semantic-extract)
  'RENDERS', // component → component (JSX usage, ts-morph semantic-extract)
  // ── Concept v2 doc-engine (E6 / Story 6.2) ─────────────────────────────
  'DERIVED_FROM', // document → upstream document (spec-chain lineage, 6.3)
  'REFERENCES', // story → docSection (citation, 6.3)
  'GOVERNS', // docSection / docShard → code node (doc→code, 6.4 + ADC E5)
  'DESCRIBES', // docSection → blast-reachable infra (doc→code, 6.4)
  'SPECIFIES', // document/docSection → plan/epic/story (6.4)
  // ── Agentic Document Center (E5.2) — subsystem god-doc layer ────────────
  'CONTAINS', // godDoc → docShard (the god doc owns its subsystem shards)
  'DEPENDS_ON', // docShard → docShard (shard-level dependency, from imports)
  'PROPOSES', // concept document → godDoc / docShard (intention edge, E6.1)
  // ── W3.3 (P3_TEST_COVER_EDGES) — deterministic test→symbol coverage ─────
  'TESTS', // test-file → exercised symbol (the TDD traceability edge)
  'COVERS', // alias reserved for a future coverage-report-derived edge
]);

// Scalar / string-array node props the ingest is allowed to persist. Memgraph
// property values must be primitives or arrays of primitives — NO nested maps —
// so extractors flatten richer data (e.g. the W10 cost model → `billable` +
// `costUnit`) before emitting. `kind`/`label` are always set in the base clause.
export const SYSTEM_GRAPH_NODE_PROPS = [
  'line', // declaration line in the source config
  'logicalId', // SST logical id (e.g. 'CostsTable')
  'fields', // table data contract (stringified)
  'primaryIndex', // table PK/SK (stringified)
  'method', // endpoint HTTP method
  'path', // endpoint path
  'auth', // endpoint requires authMiddleware?
  'schedule', // cron schedule expression
  'billable', // externalService is paid? (W10)
  'costUnit', // externalService cost unit, e.g. 'token' (W10)
  'handler', // lambda/cron handler file hint
  // ── Concept v2 doc-engine (E6 / Story 6.2) ─────────────────────────────
  'docType', // document/docSection kind: prd | ux | architecture
  'sectionId', // docSection stable slug (manifest id — the join key)
  'contentHash', // document/docSection content hash (stale-cascade key)
  'rev', // document revision
  'sectionCount', // document section count
  'provenance', // EXTRACTED | INFERRED | derived (edge/node provenance)
  // ── Agentic Document Center (E5.2) — docShard / godDoc node props ───────
  'boundary', // docShard module-boundary path (e.g. 'src/auth')
  'members', // docShard member code nodeIds (string[])
  'depends', // docShard depended-on shardKeys (string[])
  'memberCount', // docShard member count
  'shardKey', // docShard / godDoc primary join key ('§sys:<path>')
  'shardKeys', // godDoc contained shardKeys (string[])
];

/**
 * Idempotently ingest one extractor envelope into the graph store.
 *
 * Nodes are upserted on `nodeId` (full overwrite → re-running produces no
 * duplicates). Edges only form between endpoints that already exist in the
 * store; a missing endpoint yields no edge (no throw) and is surfaced later by
 * the orphan invariant rather than silently inventing a node — the direct heir
 * of the Memgraph `MATCH (a) MATCH (b) MERGE (a)-[r]->(b)` semantics.
 *
 * @param {object} store     GraphStore instance (real Dynamo or in-memory fake)
 * @param {string} projectId
 * @param {object} doc       an extractor envelope ({ nodes, edges, ... })
 * @param {string} today     ISO date stamp (YYYY-MM-DD)
 * @returns {Promise<{nodeUpserts:number, edgeUpserts:number, skippedEdges:Array}>}
 */
export async function upsertExtractedFacts(store, projectId, doc, today) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc?.edges) ? doc.edges : [];

  let nodeUpserts = 0;
  let edgeUpserts = 0;
  const skippedEdges = [];

  // ── Nodes ────────────────────────────────────────────────────────────
  const nodeItems = [];
  for (const n of nodes) {
    if (!n || !n.nodeId || !n.kind) {
      skippedEdges.push({ reason: 'node-missing-id-or-kind', node: n?.nodeId ?? null });
      continue;
    }

    // Only allowlisted props that are actually present, so a partial
    // re-extraction never clobbers an existing value with null. `buildNodeItem`
    // (graph-store.mjs) filters `props` to SYSTEM_GRAPH_NODE_PROPS as well —
    // this pre-filter keeps the persisted shape explicit at the ingest seam.
    const props = {};
    for (const prop of SYSTEM_GRAPH_NODE_PROPS) {
      if (n[prop] !== undefined && n[prop] !== null) props[prop] = n[prop];
    }

    nodeItems.push({
      nodeId: n.nodeId,
      kind: n.kind,
      label: n.label ?? n.nodeId,
      status: 'active',
      updated: today,
      props,
    });
    nodeUpserts++;
  }
  if (nodeItems.length) await store.putNodes(projectId, nodeItems);

  // ── Edges ────────────────────────────────────────────────────────────
  for (const e of edges) {
    if (!e || !e.type || !e.source || !e.target) {
      skippedEdges.push({ reason: 'edge-missing-fields', edge: e ?? null });
      continue;
    }
    if (!SYSTEM_GRAPH_EDGE_TYPES.has(e.type)) {
      skippedEdges.push({ reason: 'edge-type-not-allowlisted', type: e.type });
      continue;
    }

    // Heir of `MATCH (a) MATCH (b) MERGE (a)-[r]->(b)`: the edge only forms when
    // BOTH endpoints already exist. A missing endpoint creates nothing (no
    // error) — surfaced by the orphan check (Epic 2), never a guessed node.
    // `edgeUpserts` counts every allowlisted edge attempted (matching the old
    // one-`.run()`-per-edge count), not only those actually persisted.
    const [a, b] = await Promise.all([
      store.getNode(projectId, e.source),
      store.getNode(projectId, e.target),
    ]);
    if (a && b) {
      await store.putEdges(projectId, [
        { type: e.type, from: e.source, to: e.target, props: { updated: today } },
      ]);
    }
    edgeUpserts++;
  }

  return { nodeUpserts, edgeUpserts, skippedEdges };
}

// ── SG-1.6: env-join — File ─READS→ Table/Secret (W4, W7) ──────────────────

/** Normalize a resource name so GITHUB_PAT (env) and GithubPat (logical id)
 * collapse to the same key — the W7 bridge between process.env.X and
 * Resource.X.value. */
export function normalizeResourceName(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Only these kinds are "readable" targets of a File ─READS→ edge.
const READ_TARGET_KINDS = new Set(['table', 'secret']);

/**
 * Build the lookup the env-join uses to resolve a `process.env.X` / `Resource.X`
 * reference to an infra node:
 *   - byEnvVar:    explicit env→resource bindings from infra-extract's envJoin
 *   - byNormalized: every table/secret node by normalized logical id (the W7
 *                   fallback when there's no explicit env binding)
 */
export function buildResourceIndex(infraDoc) {
  const byEnvVar = {};
  const byNormalized = {};
  for (const [env, res] of Object.entries(infraDoc?.envJoin || {})) {
    if (res && READ_TARGET_KINDS.has(res.kind)) {
      byEnvVar[env] = { nodeId: `infra/${res.kind}/${res.id}`, kind: res.kind };
    }
  }
  for (const n of infraDoc?.nodes || []) {
    if (!READ_TARGET_KINDS.has(n.kind)) continue;
    const id = n.logicalId || n.nodeId.split('/').pop();
    byNormalized[normalizeResourceName(id)] = { nodeId: n.nodeId, kind: n.kind };
  }
  return { byEnvVar, byNormalized };
}

function resolveEnvRef(index, v) {
  return index.byEnvVar[v] || index.byNormalized[normalizeResourceName(v)] || null;
}
function resolveResourceRef(index, x) {
  return index.byNormalized[normalizeResourceName(x)] || null;
}

/**
 * Create File ─READS→ Table/Secret edges from `process.env.X` / `Resource.X`
 * references, accessor-aware (W4): the READS is recorded on the file where the
 * reference lives AND attributed transitively to that file's importers — so a
 * shared accessor (e.g. functions/shared/dynamo-client.ts) doesn't become a
 * false god-node that hides the real consumers. `r.via` records the env-var and
 * the accessor hop. W7: `Resource.GithubPat.value` and `process.env.GITHUB_PAT`
 * both resolve to `infra/secret/GithubPat` via name normalization.
 *
 * @param {object} store           GraphStore instance (real Dynamo or in-memory fake)
 * @param {string} projectId
 * @param {object} infraDoc        infra-extract envelope (nodes + envJoin)
 * @param {object} envRefsByFile   ast-extract map { relPath: { env:[], resource:[] } }
 * @param {string} today           ISO date stamp (YYYY-MM-DD)
 */
export async function upsertEnvReads(store, projectId, infraDoc, envRefsByFile, today) {
  const index = buildResourceIndex(infraDoc);
  let directReads = 0;
  let transitiveReads = 0;
  const ambiguous = [];

  for (const [path, refs] of Object.entries(envRefsByFile || {})) {
    const fileNodeId = `code/${path.replace(/\//g, '--')}`;
    const targets = new Map(); // targetNodeId → via label

    for (const v of refs.env || []) {
      const r = resolveEnvRef(index, v);
      if (r) targets.set(r.nodeId, `env:${v}`);
      else ambiguous.push({ file: path, ref: v, kind: 'env', reason: 'unresolved-env-ref' });
    }
    for (const x of refs.resource || []) {
      const r = resolveResourceRef(index, x);
      if (r) targets.set(r.nodeId, `resource:${x}`);
      else ambiguous.push({ file: path, ref: x, kind: 'resource', reason: 'unresolved-resource-ref' });
    }
    if (targets.size === 0) continue;

    // Direct READS on the file where the reference literally lives. Heir of the
    // `MATCH (f) MATCH (t) MERGE (f)-[r:READS]->(t)` — the edge forms only when
    // both the file node and the target node exist; the counter still tracks
    // every resolved target (matching the old per-target `.run()` count).
    const fileNode = await store.getNode(projectId, fileNodeId);
    for (const [t, via] of targets) {
      const targetNode = fileNode ? await store.getNode(projectId, t) : null;
      if (fileNode && targetNode) {
        await store.putEdges(projectId, [
          { type: 'READS', from: fileNodeId, to: t, props: { via, updated: today } },
        ]);
      }
      directReads++;
    }

    // W4 accessor hop: attribute READS to inbound importers (the real
    // consumers). `(c)-[:IMPORTS]->(f)` → the file's inbound IMPORTS edges;
    // each edge's `from` is the importing consumer.
    const importEdges = await store.inEdges(projectId, fileNodeId, { type: 'IMPORTS' });
    const importers = importEdges.map((e) => e.from).filter(Boolean);
    for (const c of importers) {
      const consumerNode = await store.getNode(projectId, c);
      for (const [t, via] of targets) {
        const targetNode = consumerNode ? await store.getNode(projectId, t) : null;
        if (consumerNode && targetNode) {
          await store.putEdges(projectId, [
            { type: 'READS', from: c, to: t, props: { via: `${fileNodeId} (${via})`, updated: today } },
          ]);
        }
        transitiveReads++;
      }
    }
  }

  return { directReads, transitiveReads, ambiguous };
}

// ── SG-1.6: CALLS_ENDPOINT — component → endpoint (W1) ─────────────────────

/** Normalize an endpoint/request path so `:param` and `${...}` template
 * segments compare equal (`/api/projects/:id` ≡ `/api/projects/${id}`). */
export function normalizeEndpointPath(p) {
  return (
    String(p)
      .replace(/\$\{[^}]+\}/g, '*') // ${id}
      .replace(/:[A-Za-z0-9_]+/g, '*') // :id
      .replace(/\/+$/, '') || '/'
  );
}

/** Regex-scan a frontend file for api-client calls → [{ method, path, fromFile }]. */
export function extractApiCalls(rel, src) {
  const fromFile = `code/${rel.replace(/\//g, '--')}`;
  const calls = [];
  const RE = /\b(?:api|apiClient|client)\.(get|post|put|delete|patch)\(\s*[`'"]([^`'"]+)[`'"]/g;
  let m;
  while ((m = RE.exec(src))) {
    calls.push({ method: m[1].toUpperCase(), path: m[2], fromFile });
  }
  return calls;
}

/**
 * Match frontend api-client calls to extracted endpoint nodes. `basePath` is
 * prepended to call paths that don't already carry it (api-client mounts under
 * `/api`). Unmatched calls → ambiguous (endpoint typo or untracked route — a
 * useful finding in itself).
 */
export function matchCallsToEndpoints(calls, endpoints, { basePath = '' } = {}) {
  const idx = new Map();
  for (const e of endpoints) {
    idx.set(`${e.method} ${normalizeEndpointPath(e.path)}`, e.nodeId);
  }
  const edges = [];
  const ambiguous = [];
  const seen = new Set();
  for (const c of calls) {
    let path = c.path;
    if (basePath && !path.startsWith(basePath)) path = basePath + path;
    const key = `${c.method.toUpperCase()} ${normalizeEndpointPath(path)}`;
    const target = idx.get(key);
    if (target) {
      const dedupe = `${c.fromFile}|${target}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        edges.push({ type: 'CALLS_ENDPOINT', source: c.fromFile, target });
      }
    } else {
      ambiguous.push({ fromFile: c.fromFile, method: c.method, path: c.path, reason: 'no-matching-endpoint' });
    }
  }
  return { edges, ambiguous };
}

/**
 * Persist CALLS_ENDPOINT edges. Endpoints come from route-extract; calls from a
 * frontend scan (extractApiCalls). A component→endpoint edge only forms when
 * both endpoints exist — same safety as upsertExtractedFacts.
 */
export async function upsertCallsEndpoint(store, projectId, calls, endpoints, today, opts = {}) {
  const { edges, ambiguous } = matchCallsToEndpoints(calls, endpoints, opts);
  let edgeUpserts = 0;
  for (const e of edges) {
    // Same endpoint-existence safety as upsertExtractedFacts: the edge forms
    // only when both the component and the endpoint node already exist.
    const [a, b] = await Promise.all([
      store.getNode(projectId, e.source),
      store.getNode(projectId, e.target),
    ]);
    if (a && b) {
      await store.putEdges(projectId, [
        { type: 'CALLS_ENDPOINT', from: e.source, to: e.target, props: { updated: today } },
      ]);
    }
    edgeUpserts++;
  }
  return { edgeUpserts, ambiguous };
}
