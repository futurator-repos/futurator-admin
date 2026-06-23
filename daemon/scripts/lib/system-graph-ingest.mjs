/**
 * System Graph Ingest — graph-sync's entrypoint for extractor envelopes.
 * Story SG-1.1 (foundation); extended by SG-1.6 (env-join / CALLS_ENDPOINT).
 *
 * `graph-sync.mjs` runs a CLI `main()` on import, so it can't be unit-tested
 * directly. Following the same reasoning that moved import resolution into
 * `lib/import-resolver.mjs`, the system-graph ingest logic lives here as pure,
 * session-driven functions that tests can drive with a fake session.
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
 * Idempotently ingest one extractor envelope into Memgraph.
 *
 * Nodes are MERGE'd on `nodeId` (additive — re-running produces no duplicates).
 * Edges are MERGE'd between already-matched endpoints; a missing endpoint yields
 * zero rows (no throw) and is surfaced later by the orphan invariant rather than
 * silently inventing a node.
 *
 * @param {object} session   Memgraph session (or a compatible fake in tests)
 * @param {string} projectId
 * @param {object} doc       an extractor envelope ({ nodes, edges, ... })
 * @param {string} today     ISO date stamp (YYYY-MM-DD)
 * @returns {Promise<{nodeUpserts:number, edgeUpserts:number, skippedEdges:Array}>}
 */
export async function upsertExtractedFacts(session, projectId, doc, today) {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc?.edges) ? doc.edges : [];

  let nodeUpserts = 0;
  let edgeUpserts = 0;
  const skippedEdges = [];

  // ── Nodes ────────────────────────────────────────────────────────────
  for (const n of nodes) {
    if (!n || !n.nodeId || !n.kind) {
      skippedEdges.push({ reason: 'node-missing-id-or-kind', node: n?.nodeId ?? null });
      continue;
    }

    const params = {
      nodeId: n.nodeId,
      kind: n.kind,
      label: n.label ?? n.nodeId,
      projectId,
      today,
    };

    // Dynamic SET — only allowlisted props that are actually present, so we
    // never clobber an existing value with null on a partial re-extraction.
    const setFragments = [
      'n.kind = $kind',
      'n.label = $label',
      'n.projectId = $projectId',
      "n.status = 'active'",
      'n.updated = $today',
    ];
    for (const prop of SYSTEM_GRAPH_NODE_PROPS) {
      if (n[prop] !== undefined && n[prop] !== null) {
        setFragments.push(`n.${prop} = $${prop}`);
        params[prop] = n[prop];
      }
    }

    await session.run(
      `MERGE (n:Node {nodeId: $nodeId}) SET ${setFragments.join(', ')}`,
      params,
    );
    nodeUpserts++;
  }

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

    // MATCH both endpoints; MERGE the rel. If either endpoint is missing the
    // query matches nothing and creates nothing — no error, surfaced by the
    // orphan check (Epic 2) instead of a guessed node.
    await session.run(
      `MATCH (a:Node {nodeId: $s}) MATCH (b:Node {nodeId: $t})
       MERGE (a)-[r:${e.type}]->(b) SET r.updated = $today`,
      { s: e.source, t: e.target, today },
    );
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
 * @param {object} infraDoc       infra-extract envelope (nodes + envJoin)
 * @param {object} envRefsByFile  ast-extract map { relPath: { env:[], resource:[] } }
 */
export async function upsertEnvReads(session, projectId, infraDoc, envRefsByFile, today) {
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

    // Direct READS on the file where the reference literally lives.
    for (const [t, via] of targets) {
      await session.run(
        `MATCH (f:Node {nodeId: $f}) MATCH (t:Node {nodeId: $t})
         MERGE (f)-[r:READS]->(t) SET r.via = $via, r.updated = $today`,
        { f: fileNodeId, t, via, today },
      );
      directReads++;
    }

    // W4 accessor hop: attribute READS to inbound importers (the real consumers).
    const imp = await session.run(
      `MATCH (c:Node)-[:IMPORTS]->(f:Node {nodeId: $f}) RETURN c.nodeId AS id`,
      { f: fileNodeId },
    );
    const importers = imp.records.map((rec) => rec.get('id')).filter(Boolean);
    for (const c of importers) {
      for (const [t, via] of targets) {
        await session.run(
          `MATCH (c:Node {nodeId: $c}) MATCH (t:Node {nodeId: $t})
           MERGE (c)-[r:READS]->(t) SET r.via = $via, r.updated = $today`,
          { c, t, via: `${fileNodeId} (${via})`, today },
        );
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
export async function upsertCallsEndpoint(session, projectId, calls, endpoints, today, opts = {}) {
  const { edges, ambiguous } = matchCallsToEndpoints(calls, endpoints, opts);
  let edgeUpserts = 0;
  for (const e of edges) {
    await session.run(
      `MATCH (a:Node {nodeId: $s}) MATCH (b:Node {nodeId: $t})
       MERGE (a)-[r:CALLS_ENDPOINT]->(b) SET r.updated = $today`,
      { s: e.source, t: e.target, today },
    );
    edgeUpserts++;
  }
  return { edgeUpserts, ambiguous };
}
