/**
 * contract-diff.mjs — Story 6.1 (PRD §7.4.1, Risk 4). The false-positive guard
 * for the PROPAGATOR.
 *
 * A wave changes many nodes; only a FEW touch a shared CONTRACT. This diff
 * isolates contract-shape changes and ignores everything else, so a Labs-internal
 * rename never fires a Mobile story.
 *
 * The defense is that it keys on contract **SHAPE**, never on symbol names:
 *   - table        → its set of `field:type` + `primaryIndex`
 *   - endpoint     → `METHOD path`
 *   - event/topic/queue/bucket → the (shared) channel name/label
 *   - externalService → the service identity (name/host)
 *   - capability   → its declared contract (endpoints + tables)
 *
 * Identity (what makes two nodes "the same contract across the wave") is the
 * stable logical handle — a table's name, an endpoint's method+path. The CHANGE
 * is a shape-signature difference. An internal function rename mutates a `symbol`
 * node, not a contract node, so it produces ZERO contract changes (the negative
 * test). A real field add on a shared table produces one.
 *
 * Pure + deterministic (no clock, no graph) so it unit-tests directly. The
 * append-log (6.2) and the per-sibling report (6.3) consume `diffContracts`.
 */

/** Node kinds that carry a cross-project contract shape. */
export const CONTRACT_NODE_KINDS = [
  'table',
  'endpoint',
  'eventSource',
  'topic',
  'queue',
  'bucket',
  'externalService',
  'capability',
];

const isContractKind = (kind) => CONTRACT_NODE_KINDS.includes(kind);

/**
 * Stable identity for a contract node — the handle that survives a shape change
 * so we can tell "PlansTable gained a field" from "a new table appeared".
 * Deliberately excludes the shape itself.
 */
export function identityKey(node) {
  const kind = node.kind;
  if (kind === 'endpoint') {
    const method = (node.method || 'ANY').toUpperCase();
    return `endpoint:${method} ${node.path ?? node.label ?? node.nodeId}`;
  }
  if (kind === 'table') {
    return `table:${node.name || node.label || node.nodeId}`;
  }
  if (kind === 'externalService') {
    return `externalService:${node.host || node.name || node.label || node.nodeId}`;
  }
  if (kind === 'capability') {
    return `capability:${node.nodeId}`;
  }
  // event/topic/queue/bucket — channels join on their shared name
  return `${kind}:${node.name || node.label || node.nodeId}`;
}

/** name → "name:type" sorted list, so field-order and casing never matter. */
function fieldMap(fields) {
  const map = new Map();
  if (!fields) return map;
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (typeof f === 'string') map.set(f, '');
      else if (f && f.name) map.set(f.name, f.type ?? '');
    }
  } else if (typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields)) map.set(k, v ?? '');
  }
  return map;
}

function sortedContract(contract) {
  const eps = [...(contract?.endpoints ?? [])].map((e) => String(e)).sort();
  const tbls = [...(contract?.tables ?? [])].map((t) => String(t)).sort();
  return `endpoints:[${eps.join(',')}]|tables:[${tbls.join(',')}]`;
}

/**
 * Canonical SHAPE signature for a contract node. Two nodes with the same
 * signature are contract-equivalent; a difference is what triggers a brief.
 */
export function contractShape(node) {
  if (!node || !isContractKind(node.kind)) return null;
  const kind = node.kind;
  if (kind === 'table') {
    const fm = fieldMap(node.fields);
    const fields = [...fm.entries()]
      .map(([n, t]) => `${n}:${t}`)
      .sort()
      .join(',');
    return `table|fields:{${fields}}|pk:${node.primaryIndex ?? ''}`;
  }
  if (kind === 'endpoint') {
    const method = (node.method || 'ANY').toUpperCase();
    return `endpoint|${method} ${node.path ?? ''}`;
  }
  if (kind === 'externalService') {
    return `externalService|${node.host || node.name || ''}|${node.paidTier ?? node.billable ?? ''}`;
  }
  if (kind === 'capability') {
    return `capability|${sortedContract(node.contract)}`;
  }
  return `${kind}|${node.name || node.label || node.nodeId}`;
}

/** A node id for the change record — prefer the explicit nodeId, else identity. */
function changeNodeId(node) {
  return node.nodeId || identityKey(node);
}

/**
 * Field-level change description for a table, e.g. `field +dependsOn:string[]`.
 * Falls back to a generic `pk:…` / `shape changed` note for non-field changes.
 */
function describeTableChange(before, after) {
  const a = fieldMap(before.fields);
  const b = fieldMap(after.fields);
  const parts = [];
  for (const [name, type] of b) {
    if (!a.has(name)) parts.push(`field +${name}${type ? ':' + type : ''}`);
    else if (a.get(name) !== type) parts.push(`field ~${name}:${a.get(name)}→${type}`);
  }
  for (const [name, type] of a) {
    if (!b.has(name)) parts.push(`field -${name}${type ? ':' + type : ''}`);
  }
  if ((before.primaryIndex ?? '') !== (after.primaryIndex ?? '')) {
    parts.push(`pk ${before.primaryIndex ?? '∅'}→${after.primaryIndex ?? '∅'}`);
  }
  return parts.length ? parts.join('; ') : 'shape changed';
}

function describeChange(kind, before, after) {
  if (kind === 'table') return describeTableChange(before, after);
  if (kind === 'capability') return `contract changed`;
  if (kind === 'externalService') return `service shape changed`;
  return `shape changed`;
}

/**
 * Diff two sets of contract nodes (the pre-wave and post-wave snapshots),
 * isolating only contract-shape changes.
 *
 * @param {Array<object>} before - contract nodes before the wave
 * @param {Array<object>} after  - contract nodes after the wave
 * @returns {{
 *   changes: Array<{ node:string, kind:string, change:'new'|'removed'|string,
 *                    shapeBefore:string|null, shapeAfter:string|null }>,
 *   added:number, removed:number, modified:number
 * }}
 */
export function diffContracts(before, after) {
  const beforeNodes = (before ?? []).filter((n) => isContractKind(n.kind));
  const afterNodes = (after ?? []).filter((n) => isContractKind(n.kind));

  const beforeById = new Map(beforeNodes.map((n) => [identityKey(n), n]));
  const afterById = new Map(afterNodes.map((n) => [identityKey(n), n]));

  const changes = [];

  for (const [id, node] of afterById) {
    const prev = beforeById.get(id);
    if (!prev) {
      changes.push({
        node: changeNodeId(node),
        kind: node.kind,
        change: 'new',
        shapeBefore: null,
        shapeAfter: contractShape(node),
      });
      continue;
    }
    const sb = contractShape(prev);
    const sa = contractShape(node);
    if (sb !== sa) {
      changes.push({
        node: changeNodeId(node),
        kind: node.kind,
        change: describeChange(node.kind, prev, node),
        shapeBefore: sb,
        shapeAfter: sa,
      });
    }
  }

  for (const [id, node] of beforeById) {
    if (!afterById.has(id)) {
      changes.push({
        node: changeNodeId(node),
        kind: node.kind,
        change: 'removed',
        shapeBefore: contractShape(node),
        shapeAfter: null,
      });
    }
  }

  // Deterministic order: by node id, then change text.
  changes.sort((a, b) => a.node.localeCompare(b.node) || a.change.localeCompare(b.change));

  return {
    changes,
    added: changes.filter((c) => c.change === 'new').length,
    removed: changes.filter((c) => c.change === 'removed').length,
    modified: changes.filter((c) => c.change !== 'new' && c.change !== 'removed').length,
  };
}
