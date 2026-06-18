/**
 * contract-revision.mjs — Story 6.2 (W6, PRD §7.5 / Appendix E). The temporal
 * source the stateless graph lacks.
 *
 * Memgraph holds CURRENT state (`status: active|pruned`), so you cannot read
 * "3 contract changes since commitY" from a snapshot. Each contract-shape change
 * detected by the diff (6.1) is therefore APPENDED as a `:ContractRevision`
 * node — `{ contractNode, change, atCommit, atWave, ts }` — linked
 * `(:Node)-[:REVISED]->(:ContractRevision)`.
 *
 * `driftSince[sibling]` is then a COUNT: the number of revisions on a contract
 * whose `atCommit` is AFTER the sibling's `lastPropagatedTo` marker. Ordering of
 * commits is resolved against a caller-supplied `commitOrder` (oldest→newest,
 * e.g. `git log --reverse`); when a marker commit isn't in that order we count
 * conservatively (re-brief rather than silently drop a change). The log doubles
 * as the audit trail for "why did this brief fire?".
 *
 * Pure builders + drift math unit-test directly; the session-taking append/read
 * are thin and exercised against a fake.
 *
 * Forbidden area (per Story 6.2): node `status` semantics — a revision is a NEW
 * node kind, never a status mutation of the contract node.
 */

/** Lower-kebab slug of a change description for a stable, readable revision id. */
export function revisionSlug(change) {
  return (
    String(change ?? 'change')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'change'
  );
}

function shortName(contractNode) {
  const s = String(contractNode ?? 'contract');
  const tail = s.slice(s.lastIndexOf('/') + 1);
  return tail.replace(/[^A-Za-z0-9._\- ]/g, '_').replace(/\s+/g, '_') || 'contract';
}

/**
 * Build one `:ContractRevision` node from a detected change (Appendix E shape).
 * Pure — `ts`, `atCommit`, `atWave` are supplied by the caller (no clock here).
 *
 * @param {{node:string, change:string}} change - a diffContracts() change
 * @param {{atCommit:string, atWave:string, ts:string}} ctx
 */
export function buildRevisionNode(change, { atCommit, atWave, ts }) {
  const contractNode = change.node;
  return {
    nodeId: `rev/${shortName(contractNode)}/${ts}/${revisionSlug(change.change)}`,
    kind: 'contractRevision',
    contractNode,
    change: change.change,
    atCommit: atCommit ?? null,
    atWave: atWave ?? null,
    ts: ts ?? null,
  };
}

/** Build revision nodes for every change in a diff result. */
export function buildRevisions(diff, ctx) {
  return (diff?.changes ?? []).map((c) => buildRevisionNode(c, ctx));
}

/**
 * Is `revCommit` strictly AFTER the sibling's `marker` commit?
 *  - no marker (never propagated) → every revision counts.
 *  - both commits located in commitOrder → compare positions.
 *  - marker unknown → conservative: count it (re-brief, don't drop).
 *  - rev unknown but marker known → don't count (can't prove it's newer).
 */
function isAfter(revCommit, marker, orderIndex) {
  if (!marker) return true;
  const mi = orderIndex.get(marker);
  const ri = orderIndex.get(revCommit);
  if (mi === undefined) return true; // marker not in history → conservative
  if (ri === undefined) return false; // rev not locatable → don't over-count
  return ri > mi;
}

/**
 * Pure drift math: per sibling, count the contract revisions newer than its
 * `lastPropagatedTo` marker.
 *
 * @param {Array<{atCommit:string}>} revisions - revisions for ONE contract
 * @param {Record<string,string|null>} lastPropagatedTo - sibling → commit
 * @param {Array<string>} [commitOrder] - commit shas oldest→newest
 * @returns {Record<string, number>} sibling → pending count
 */
export function computeDriftCounts(revisions, lastPropagatedTo, commitOrder = []) {
  const orderIndex = new Map(commitOrder.map((sha, i) => [sha, i]));
  const out = {};
  for (const [sibling, marker] of Object.entries(lastPropagatedTo ?? {})) {
    out[sibling] = (revisions ?? []).filter((r) => isAfter(r.atCommit, marker, orderIndex)).length;
  }
  return out;
}

// ── Session-taking append / read (graph-sync wave-gate path) ─────────────────

/**
 * Append revision nodes + `(:Node {nodeId:contractNode})-[:REVISED]->(rev)`.
 * Additive MERGEs; never touches the contract node's `status` (forbidden area).
 */
export async function appendRevisions(session, revisions) {
  for (const rev of revisions ?? []) {
    await session.run(
      `MERGE (rev:Node {nodeId: $nodeId})
         SET rev.kind = 'contractRevision', rev.projectId = $projectId,
             rev.contractNode = $contractNode, rev.change = $change,
             rev.atCommit = $atCommit, rev.atWave = $atWave, rev.ts = $ts,
             rev.status = 'active'
       WITH rev
       MATCH (c:Node {nodeId: $contractNode})
       MERGE (c)-[:REVISED]->(rev)`,
      {
        nodeId: rev.nodeId,
        projectId: rev.projectId ?? '_global',
        contractNode: rev.contractNode,
        change: rev.change,
        atCommit: rev.atCommit,
        atWave: rev.atWave,
        ts: rev.ts,
      },
    );
  }
  return { revisions: (revisions ?? []).length };
}

/** Read every revision appended to a contract node (newest fields included). */
export async function readRevisions(session, contractNode) {
  const r = await session.run(
    `MATCH (c:Node {nodeId: $contractNode})-[:REVISED]->(rev:Node {kind: 'contractRevision'})
     RETURN rev.nodeId AS nodeId, rev.change AS change, rev.atCommit AS atCommit,
            rev.atWave AS atWave, rev.ts AS ts
     ORDER BY rev.ts`,
    { contractNode },
  );
  return r.records.map((rec) => ({
    nodeId: rec.get('nodeId'),
    change: rec.get('change'),
    atCommit: rec.get('atCommit'),
    atWave: rec.get('atWave'),
    ts: rec.get('ts'),
  }));
}

/** driftSince[sibling] for one contract: read revisions, then compute. */
export async function driftSince(session, contractNode, lastPropagatedTo, commitOrder = []) {
  const revisions = await readRevisions(session, contractNode);
  return computeDriftCounts(revisions, lastPropagatedTo, commitOrder);
}
