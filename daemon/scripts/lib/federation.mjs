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
 * graph-sync `--global` path feeds it contract rows read from Memgraph and
 * writes the resulting contract nodes + CONSUMES_CONTRACT edges back.
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

// ── Session-taking ingest (graph-sync --global path) ────────────────────────

/**
 * Read every contract-bearing node across ALL project subgraphs in the
 * federated graph, grouped into the `projects` shape `federateContracts` wants.
 */
export async function readContracts(session) {
  const r = await session.run(
    `MATCH (n:Node) WHERE n.kind IN $kinds
     RETURN n.projectId AS projectId, n.nodeId AS nodeId, n.kind AS kind,
            n.arn AS arn, n.fields AS fields, n.primaryIndex AS primaryIndex,
            n.method AS method, n.path AS path,
            coalesce(n.title, n.label, n.nodeId) AS label`,
    { kinds: CONTRACT_KINDS },
  );
  const byProject = new Map();
  for (const rec of r.records) {
    const pid = rec.get('projectId');
    if (!pid) continue;
    if (!byProject.has(pid)) byProject.set(pid, { projectId: pid, contracts: [] });
    byProject.get(pid).contracts.push({
      nodeId: rec.get('nodeId'),
      kind: rec.get('kind'),
      arn: rec.get('arn') ?? null,
      fields: rec.get('fields') ?? null,
      primaryIndex: rec.get('primaryIndex') ?? null,
      method: rec.get('method') ?? null,
      path: rec.get('path') ?? null,
      label: rec.get('label'),
    });
  }
  return [...byProject.values()];
}

/**
 * Write the federation result back to the graph: a shared `contract` node per
 * group (projectId `_global`, DERIVED provenance) and a `CONSUMES_CONTRACT`
 * edge from each consuming `service` node. Additive MERGEs — never deletes.
 */
export async function writeFederation(session, result) {
  for (const c of result.contractNodes) {
    await session.run(
      `MERGE (n:Node {nodeId: $nodeId})
       SET n.kind = $kind, n.title = $label, n.projectId = '_global',
           n.provenance = 'DERIVED', n.consumerCount = $consumerCount, n.status = 'active'`,
      { nodeId: c.nodeId, kind: c.kind, label: c.label, consumerCount: c.consumerCount },
    );
  }
  for (const e of result.consumes) {
    await session.run(
      `MERGE (s:Node {nodeId: $service})
         ON CREATE SET s.kind = 'service', s.projectId = $projectId,
                       s.title = $projectId, s.status = 'active'
       WITH s
       MATCH (c:Node {nodeId: $contract})
       MERGE (s)-[rel:CONSUMES_CONTRACT]->(c)
       SET rel.via = $via`,
      { service: e.service, projectId: e.projectId, contract: e.contract, via: e.via },
    );
  }
  return { contractNodes: result.contractNodes.length, consumes: result.consumes.length };
}
