/**
 * federation.mjs — Cross-project contract spine (Epic 5, PRD §7.1–7.3, §12).
 *
 * Siblings share a backend CONTRACT, not code. In the `--global` federated
 * graph each project (a `service` node) emits `CONSUMES_CONTRACT → contract`
 * for every shared table/endpoint/event it uses, so a change to a shared
 * contract is visibly consumed by each sibling (PRD §7.2).
 *
 * The join is selectable by config (PRD §12 / W9):
 *   - 'resource-identity' — siblings share the SAME deployed backend, so a
 *     shared ARN (table/bucket/queue) ⇒ the same contract node. Cheap.
 *   - 'schema-shape' — siblings are separate deployments of the same schema, so
 *     the join is on shape: table `fields` + `primaryIndex`, endpoint
 *     `method`+`path`, event name. Uses props already captured in Epic 1.
 *
 * Pure + deterministic (no crypto, no clock) so it unit-tests directly; the
 * graph-sync `--global` path feeds it contract rows read from the GraphStore
 * (S1.4 — session→store swap; Memgraph/bolt EXCISED, see `lib/graph-store.mjs`)
 * and writes the resulting contract nodes + CONSUMES_CONTRACT edges back.
 *
 * The GraphStore is project-partitioned BY DESIGN (S0.2 — no query ever
 * crosses projects), but federation is inherently a CROSS-project read. There
 * is no store primitive to enumerate "every project" today, so `readContracts`
 * takes an explicit `projectIds` list from the caller instead of scanning
 * everything; a project-registry-backed enumeration is a follow-on capability,
 * not solved here. All federation artifacts (shared `contract` nodes, `service`
 * nodes, `CONSUMES_CONTRACT` edges) are written into one synthetic `_global`
 * store partition — mirroring the old code's own choice of `projectId:'_global'`
 * for contract nodes, and sidestepping the fact that a GraphStore edge's two
 * endpoints must share one partition (a service in project A can't otherwise
 * link to a contract that lives in project B's partition). Each service node's
 * real project id is still recoverable from its nodeId (`service/<projectId>`).
 */

/** Contract kinds that participate in the shared spine. */
export const CONTRACT_KINDS = ['table', 'endpoint', 'eventSource', 'topic', 'queue', 'bucket'];

export function serviceNodeId(projectId) {
  return `service/${projectId}`;
}

/** Stable, dependency-free hash → base36 (djb2). For schema-shape contract ids. */
export function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Compute the join key for one contract row under a strategy. Returns null when
 * the row lacks the props the strategy needs (it then can't be federated —
 * surfaced by the caller, not silently dropped into a wrong group).
 */
export function contractKey(contract, strategy) {
  const kind = contract.kind;
  if (strategy === 'resource-identity') {
    return contract.arn ? `${kind}:${contract.arn}` : null;
  }
  // schema-shape
  if (kind === 'endpoint') {
    if (!contract.method || !contract.path) return null;
    return `endpoint:${contract.method.toUpperCase()} ${contract.path}`;
  }
  if (kind === 'table') {
    const fields = normalizeFields(contract.fields);
    if (!fields) return null;
    return `table:${hashStr(`${fields}|pk:${contract.primaryIndex ?? ''}`)}`;
  }
  // events/topics/queues/buckets join by their (shared) name/label
  const name = contract.label || contract.name;
  return name ? `${kind}:${name}` : null;
}

function normalizeFields(fields) {
  if (!fields) return null;
  let names;
  if (Array.isArray(fields)) {
    names = fields.map((f) => (typeof f === 'string' ? f : `${f.name}:${f.type ?? ''}`));
  } else if (typeof fields === 'object') {
    names = Object.entries(fields).map(([k, v]) => `${k}:${v ?? ''}`);
  } else {
    return null;
  }
  return [...names].sort().join(',');
}

/** Canonical, human-readable contract nodeId for a join key. */
export function canonicalContractId(kind, key) {
  // key already namespaced as `${kind}:...`; make it a slug-ish nodeId.
  const tail = key.slice(key.indexOf(':') + 1);
  return `contract/${kind}/${tail.replace(/[^A-Za-z0-9._\- ]/g, '_').replace(/\s+/g, '_')}`;
}

/**
 * Federate sibling subgraphs into a shared contract spine.
 *
 * @param {Array<{projectId:string, contracts:Array<object>}>} projects
 * @param {{strategy?: 'resource-identity'|'schema-shape'}} [opts]
 * @returns {{
 *   strategy: string,
 *   contractNodes: Array<{nodeId,kind,label,key,consumerCount}>,
 *   consumes: Array<{service,projectId,contract,kind,via}>,
 *   unjoinable: Array<{projectId,nodeId,kind,reason}>
 * }}
 */
export function federateContracts(projects, opts = {}) {
  const strategy = opts.strategy ?? 'resource-identity';
  const groups = new Map(); // key → { kind, label, consumers:Set<projectId>, members:[] }
  const consumes = [];
  const unjoinable = [];

  for (const proj of projects ?? []) {
    const service = serviceNodeId(proj.projectId);
    for (const c of proj.contracts ?? []) {
      if (!CONTRACT_KINDS.includes(c.kind)) continue;
      const key = contractKey(c, strategy);
      if (!key) {
        unjoinable.push({
          projectId: proj.projectId,
          nodeId: c.nodeId,
          kind: c.kind,
          reason: `missing props for ${strategy}`,
        });
        continue;
      }
      let g = groups.get(key);
      if (!g) {
        g = { kind: c.kind, label: c.label || c.name || c.nodeId, consumers: new Set(), members: [] };
        groups.set(key, g);
      }
      g.consumers.add(proj.projectId);
      g.members.push(c.nodeId);
      consumes.push({
        service,
        projectId: proj.projectId,
        contract: canonicalContractId(c.kind, key),
        kind: c.kind,
        via: strategy,
      });
    }
  }

  const contractNodes = [...groups.entries()].map(([key, g]) => ({
    nodeId: canonicalContractId(g.kind, key),
    kind: g.kind,
    label: g.label,
    key,
    consumerCount: g.consumers.size,
  }));

  return { strategy, contractNodes, consumes, unjoinable };
}

// ── Store-taking ingest (graph-sync --global path, S1.4) ────────────────────

/**
 * Read every contract-bearing node across the given projects, grouped into the
 * `projects` shape `federateContracts` wants. `projectIds` must be supplied by
 * the caller (see the module doc — the store has no cross-project scan).
 *
 * NOTE: `arn` is not on the `SYSTEM_GRAPH_NODE_PROPS` allowlist today, so it
 * never round-trips through `store.putNodes`/`queryByKind` — `resource-identity`
 * strategy joins will degrade to "unjoinable" until that allowlist is extended
 * (out of S1.4's file scope; graph-store.mjs / system-graph-ingest.mjs own it).
 * `schema-shape` (fields/primaryIndex/method/path — all allowlisted) is
 * unaffected.
 */
export async function readContracts(store, projectIds) {
  const byProject = new Map();
  for (const projectId of projectIds ?? []) {
    // `queryByKind` takes ONE kind; loop the contract kinds instead of a
    // single `kind IN [...]` scan (the store has no such primitive).
    const contracts = [];
    for (const kind of CONTRACT_KINDS) {
      const kindNodes = await store.queryByKind(projectId, kind);
      for (const n of kindNodes) {
        contracts.push({
          nodeId: n.nodeId,
          kind: n.kind,
          arn: n.props?.arn ?? null,
          fields: n.props?.fields ?? null,
          primaryIndex: n.props?.primaryIndex ?? null,
          method: n.props?.method ?? null,
          path: n.props?.path ?? null,
          label: n.title ?? n.label ?? n.nodeId,
        });
      }
    }
    if (contracts.length) byProject.set(projectId, { projectId, contracts });
  }
  return [...byProject.values()];
}

/**
 * Write the federation result back to the graph: a shared `contract` node per
 * group and a `CONSUMES_CONTRACT` edge from each consuming `service` node, all
 * in the synthetic `_global` partition (see module doc). Additive upserts —
 * never deletes; a `service` node's fields are set only ON CREATE (mirrors the
 * old `ON CREATE SET`), so a later run never clobbers it.
 */
export async function writeFederation(store, result) {
  const contractNodes = (result.contractNodes ?? []).map((c) => ({
    nodeId: c.nodeId,
    kind: c.kind,
    title: c.label,
    label: c.label,
    status: 'active',
  }));
  if (contractNodes.length) await store.putNodes('_global', contractNodes);

  let consumes = 0;
  for (const e of result.consumes ?? []) {
    const existingService = await store.getNode('_global', e.service);
    if (!existingService) {
      await store.putNodes('_global', [
        { nodeId: e.service, kind: 'service', title: e.projectId, label: e.projectId, status: 'active' },
      ]);
    }
    // MATCH-only on the contract node (both endpoints must exist).
    const contractNode = await store.getNode('_global', e.contract);
    if (!contractNode) continue;
    await store.putEdges('_global', [
      { type: 'CONSUMES_CONTRACT', from: e.service, to: e.contract, props: { via: e.via } },
    ]);
    consumes++;
  }
  return { contractNodes: contractNodes.length, consumes };
}
