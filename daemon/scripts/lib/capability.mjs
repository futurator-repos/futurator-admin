/**
 * capability.mjs — Capability node layer + coverage-gap detector
 * (Epic 5, Stories 5.2 / 5.3; PRD §7.3, §7.4.2 / W8, Appendix E).
 *
 * Pure-UI parity (no shared backend) can't be tracked by infra edges, so a
 * CURATED, append-only Capability layer links equivalent implementations across
 * substrates (Labs / Mobile / Office):
 *
 *   Capability(WaveGateApproval) ─IMPLEMENTS← {Labs:<WaveGate/>, Mobile:…, Office:…}
 *
 * Story 5.2 ingests `knowledge/_graph/capabilities.json` (Appendix E shape) into
 * `capability` nodes + `IMPLEMENTS` edges, marked DECLARED provenance.
 *
 * Story 5.3 (W8 — "the manual seam must not rot silently") flags components that
 * touch a shared contract but carry NO `IMPLEMENTS → capability` edge: a
 * suspected-but-untagged capability. These are written to capability-gaps.json
 * and shown in the Graph tab so the seam is AUDITED, not trusted.
 *
 * Pure functions are unit-tested directly; the session-taking reader/writer are
 * thin and exercised against a fake.
 */

/**
 * Translate a curated capability seed (Appendix E) into the nodes + IMPLEMENTS
 * edges to MERGE. Pure.
 *
 * @param {Array<object>} seed - capability objects:
 *   { nodeId, label, implementedBy: { labs:[...], mobile:[...], office:[...] },
 *     contract?: { endpoints?:[], tables?:[] } }
 * @returns {{capabilityNodes:Array, implementsEdges:Array}}
 */
export function buildCapabilityIngest(seed) {
  const capabilityNodes = [];
  const implementsEdges = [];
  for (const cap of seed ?? []) {
    if (!cap?.nodeId) continue;
    capabilityNodes.push({
      nodeId: cap.nodeId,
      label: cap.label || cap.nodeId,
      contract: cap.contract ?? { endpoints: [], tables: [] },
      provenance: 'DECLARED',
    });
    const impl = cap.implementedBy ?? {};
    for (const [substrate, components] of Object.entries(impl)) {
      for (const componentNodeId of components ?? []) {
        implementsEdges.push({ from: componentNodeId, to: cap.nodeId, substrate });
      }
    }
  }
  return { capabilityNodes, implementsEdges };
}

/** MERGE capability nodes + IMPLEMENTS edges (additive, DECLARED provenance). */
export async function writeCapabilities(session, ingest) {
  for (const c of ingest.capabilityNodes) {
    await session.run(
      `MERGE (n:Node {nodeId: $nodeId})
       SET n.kind = 'capability', n.title = $label, n.projectId = '_global',
           n.provenance = 'DECLARED', n.status = 'active',
           n.contractEndpoints = $endpoints, n.contractTables = $tables`,
      {
        nodeId: c.nodeId,
        label: c.label,
        endpoints: c.contract.endpoints ?? [],
        tables: c.contract.tables ?? [],
      },
    );
  }
  for (const e of ingest.implementsEdges) {
    await session.run(
      `MATCH (comp:Node {nodeId: $from})
       MATCH (cap:Node {nodeId: $to})
       MERGE (comp)-[rel:IMPLEMENTS]->(cap)
       SET rel.substrate = $substrate`,
      { from: e.from, to: e.to, substrate: e.substrate },
    );
  }
  return { capabilityNodes: ingest.capabilityNodes.length, implementsEdges: ingest.implementsEdges.length };
}

/**
 * Pure gap predicate (Story 5.3 / W8): a component that touches a shared
 * contract but has no capability tag is a coverage gap.
 *
 * @param {Array<{nodeId,title,contractTouches:number,capCount:number}>} rows
 * @returns {Array<{nodeId,title,contractTouches}>}
 */
export function computeCapabilityGaps(rows) {
  return (rows ?? [])
    .filter((r) => (r.contractTouches ?? 0) > 0 && (r.capCount ?? 0) === 0)
    .map((r) => ({ nodeId: r.nodeId, title: r.title ?? r.nodeId, contractTouches: r.contractTouches }))
    .sort((a, b) => b.contractTouches - a.contractTouches || a.nodeId.localeCompare(b.nodeId));
}

/** Read per-component contract-touch + capability-tag counts for a project. */
export async function readCapabilityCoverage(session, projectId) {
  const r = await session.run(
    `MATCH (comp:Node {projectId: $projectId})
     WHERE coalesce(comp.kind,'file') = 'file'
     OPTIONAL MATCH (comp)-[:CALLS_ENDPOINT|READS|CALLS_SERVICE|CONSUMES_CONTRACT]->(c:Node)
       WHERE c.nodeId STARTS WITH 'contract/' OR coalesce(c.consumerCount,0) > 1
     WITH comp, count(DISTINCT c) AS contractTouches
     OPTIONAL MATCH (comp)-[:IMPLEMENTS]->(cap:Node {kind: 'capability'})
     WITH comp, contractTouches, count(DISTINCT cap) AS capCount
     WHERE contractTouches > 0
     RETURN comp.nodeId AS nodeId, coalesce(comp.title, comp.nodeId) AS title,
            contractTouches, capCount`,
    { projectId },
  );
  const toNum = (v) => (v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v) || 0);
  return r.records.map((rec) => ({
    nodeId: rec.get('nodeId'),
    title: rec.get('title'),
    contractTouches: toNum(rec.get('contractTouches')),
    capCount: toNum(rec.get('capCount')),
  }));
}

/** Find capability coverage gaps for a project (read + pure predicate). */
export async function findCapabilityGaps(session, projectId) {
  return computeCapabilityGaps(await readCapabilityCoverage(session, projectId));
}
