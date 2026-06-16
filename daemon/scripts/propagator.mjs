/**
 * propagator.mjs — The PROPAGATOR engine (Epic 6, PRD §7.4–7.6, §9.7, G6/G7).
 *
 * Turns detected contract drift (6.1 diff + 6.2 revision log) into
 * substrate-targeted port-briefs for each sibling, and — consent-gated — files
 * them as proposed sibling stories. Built up across three stories:
 *
 *   6.3  per-sibling drift report — what each sibling lacks for a change, scoped
 *        by its CONSUMES_CONTRACT edges (N/A where it doesn't consume).
 *   6.4  brief generation — drift translated to the sibling's substrate
 *        (RN hooks/screens for Mobile; Unity/C# prefabs for Office).
 *   6.5  autonomous trigger + consent-gated auto-file — threshold/wave-gate fires
 *        a PROPOSED story; nothing is auto-merged; markers move only on Done.
 *
 * Pure builders unit-test directly; session-taking reads are thin over Memgraph.
 */

import { computeDriftCounts } from './lib/contract-revision.mjs';

/** Source project never briefs itself. */
const NA = 'N/A';

// ── Story 6.3 — per-sibling drift report ─────────────────────────────────────

/**
 * Build a per-sibling drift report. Pure.
 *
 * @param {{
 *   sourceProject: string,
 *   changes: Array<{node:string, change:string}>,
 *   siblings: Array<string>,                 // sibling projectIds
 *   consumes: Array<{projectId:string, contract:string}>, // CONSUMES_CONTRACT edges
 * }} params
 * @returns {Array<{
 *   sibling:string,
 *   changes: Array<{node:string, change:string}>,    // consumed → pending adoption
 *   notApplicable: Array<{node:string, change:string, status:'N/A'}>,
 *   pendingCount:number
 * }>}
 */
export function buildDriftReport({ sourceProject, changes, siblings, consumes }) {
  // contract nodeId → Set(projectId) that consume it.
  const consumersByContract = new Map();
  for (const e of consumes ?? []) {
    if (!consumersByContract.has(e.contract)) consumersByContract.set(e.contract, new Set());
    consumersByContract.get(e.contract).add(e.projectId);
  }

  const report = [];
  for (const sibling of siblings ?? []) {
    if (sibling === sourceProject) continue;
    const pending = [];
    const na = [];
    for (const ch of changes ?? []) {
      const consumers = consumersByContract.get(ch.node);
      if (consumers && consumers.has(sibling)) {
        pending.push({ node: ch.node, change: ch.change });
      } else {
        na.push({ node: ch.node, change: ch.change, status: NA });
      }
    }
    report.push({
      sibling,
      changes: pending,
      notApplicable: na,
      pendingCount: pending.length,
    });
  }
  // Most-affected siblings first; stable by name.
  report.sort((a, b) => b.pendingCount - a.pendingCount || a.sibling.localeCompare(b.sibling));
  return report;
}

// ── Session-taking reads (graph-sync --global / wave-gate path) ──────────────

/** Sibling project ids = every `service` node except the source. */
export async function readSiblings(session, sourceProject) {
  const r = await session.run(
    `MATCH (s:Node {kind: 'service'}) WHERE s.projectId <> $sourceProject
     RETURN DISTINCT s.projectId AS projectId`,
    { sourceProject },
  );
  return r.records.map((rec) => rec.get('projectId')).filter(Boolean);
}

/**
 * CONSUMES_CONTRACT edges for the given contract nodes:
 * which sibling `service` consumes which shared contract.
 */
export async function readConsumers(session, contractNodes) {
  const r = await session.run(
    `MATCH (s:Node {kind: 'service'})-[:CONSUMES_CONTRACT]->(c:Node)
     WHERE c.nodeId IN $contractNodes
     RETURN s.projectId AS projectId, c.nodeId AS contract`,
    { contractNodes: contractNodes ?? [] },
  );
  return r.records.map((rec) => ({ projectId: rec.get('projectId'), contract: rec.get('contract') }));
}

/**
 * Read contract-shape changes from the :ContractRevision append-log (6.2).
 * Deduped by (contractNode, change), newest first — the change-set the briefs
 * are built from. Each revision links `(:Node)-[:REVISED]->(:ContractRevision)`.
 */
export async function readRecentChanges(session) {
  const r = await session.run(
    `MATCH (:Node)-[:REVISED]->(rev:Node {kind: 'contractRevision'})
     RETURN rev.contractNode AS node, rev.change AS change,
            rev.atCommit AS atCommit, rev.ts AS ts
     ORDER BY rev.ts DESC`,
  );
  const seen = new Set();
  const out = [];
  for (const rec of r.records) {
    const node = rec.get('node');
    const change = rec.get('change');
    const key = `${node}|${change}`;
    if (!node || seen.has(key)) continue;
    seen.add(key);
    out.push({ node, change, atCommit: rec.get('atCommit') ?? null, ts: rec.get('ts') ?? null });
  }
  return out;
}

/**
 * Produce the per-sibling drift report from the graph for a set of contract
 * changes detected this wave (reads siblings + consumers, then the pure build).
 */
export async function perSiblingDrift(session, { sourceProject, changes }) {
  const contractNodes = [...new Set((changes ?? []).map((c) => c.node))];
  const [siblings, consumes] = await Promise.all([
    readSiblings(session, sourceProject),
    readConsumers(session, contractNodes),
  ]);
  return buildDriftReport({ sourceProject, changes, siblings, consumes });
}

// ── Story 6.4 — substrate-targeted brief generation ──────────────────────────

/**
 * Substrate descriptors — the translation table that makes a brief a BRIEF
 * (a generic diff isn't). Each sibling pipeline gets its own framing.
 */
export const SUBSTRATES = {
  mobile: { name: 'Mobile', framework: 'React Native', unit: 'hook/screen', equivalent: 'RN hook + screen' },
  office: { name: 'Office', framework: 'Unity', unit: 'C# prefab', equivalent: 'Unity prefab + C# script' },
};

export function substrateFor(sibling) {
  return (
    SUBSTRATES[sibling] ?? {
      name: sibling,
      framework: sibling,
      unit: 'component',
      equivalent: `${sibling} equivalent`,
    }
  );
}

/** Last path segment of a node id (e.g. `contract/table/Plans` → `Plans`). */
function tail(nodeId) {
  const s = String(nodeId ?? '');
  return s.slice(s.lastIndexOf('/') + 1);
}

/** Bare component name from a capability nodeId path (drops dir prefixes). */
function componentName(nodeId) {
  const t = tail(nodeId);
  return t.replace(/^code--/, '').replace(/--/g, '/');
}

/**
 * Find the curated capability whose declared contract references this change's
 * contract node — that capability's per-substrate implementation IS the concrete
 * port target. Deterministic substring match on the short contract name.
 */
function capabilityForChange(change, capabilities) {
  const short = tail(change.node).toLowerCase();
  if (!short) return null;
  return (
    (capabilities ?? []).find((cap) => {
      const c = cap.contract ?? {};
      const hay = [...(c.tables ?? []), ...(c.endpoints ?? [])].join(' ').toLowerCase();
      return hay.includes(short);
    }) ?? null
  );
}

/**
 * Build ONE substrate-targeted port-brief for a sibling. Pure.
 *
 * Names the concrete port target (the sibling's implementing component, or a
 * `<new …>` placeholder where the sibling lacks one — exactly the gap) and the
 * RN/Unity equivalent of the source component, per Appendix E output shape.
 */
export function buildBrief({ sourceProject, sibling, changes, trigger, capabilities }) {
  const sub = substrateFor(sibling);
  const targets = new Set();
  const sourceComponents = new Set();
  let capLabel = null;

  for (const ch of changes ?? []) {
    const cap = capabilityForChange(ch, capabilities);
    if (cap) {
      capLabel = capLabel ?? cap.label ?? tail(cap.nodeId);
      const impl = cap.implementedBy ?? {};
      for (const c of impl[sourceProject] ?? impl.labs ?? []) sourceComponents.add(componentName(c));
      const sibImpl = impl[sibling] ?? [];
      if (sibImpl.length) for (const c of sibImpl) targets.add(componentName(c));
      else targets.add(`<new ${sub.unit}>`);
    } else {
      targets.add(`<new ${sub.unit}>`);
    }
  }

  const changeSummary = (changes ?? []).map((c) => `${tail(c.node)} (${c.change})`).join('; ');
  const targetList = [...targets].join(', ') || `<new ${sub.unit}>`;
  const sourceList = [...sourceComponents].join(', ') || `${sourceProject} component`;

  return {
    sibling,
    trigger,
    contractChanges: (changes ?? []).map((c) => ({ node: c.node, change: c.change })),
    brief: `${targetList} needs to adopt: ${changeSummary}. ${sub.framework} equivalent of ${sourceList}.`,
    proposedStory: {
      title: `Port ${capLabel ?? changeSummary} to ${sub.name}`,
      epic: `${sourceProject}-parity`,
    },
    requiresApproval: true,
  };
}

/**
 * Build one brief per sibling that has pending drift (skips all-N/A siblings).
 *
 * @param {Array} driftReport - output of buildDriftReport (6.3)
 * @param {{sourceProject:string, trigger:string, capabilities?:Array}} opts
 * @returns {Array} briefs (Appendix E output shape), each requiresApproval:true
 */
export function buildBriefs(driftReport, { sourceProject, trigger, capabilities }) {
  return (driftReport ?? [])
    .filter((r) => r.pendingCount > 0)
    .map((r) =>
      buildBrief({ sourceProject, sibling: r.sibling, changes: r.changes, trigger, capabilities }),
    );
}

// ── Story 6.5 — autonomous trigger + consent-gated proposals + marker ────────

/**
 * Should the PROPAGATOR fire? Pure decision.
 *  - 'wave-gate'       → always (the default trigger; runs at every wave gate).
 *  - 'drift-threshold' → only when some sibling's pending drift ≥ threshold.
 *
 * @param {{trigger:'wave-gate'|'drift-threshold', driftCounts?:Record<string,number>, threshold?:number}} p
 */
export function shouldPropagate({ trigger, driftCounts = {}, threshold = 1 }) {
  if (trigger === 'wave-gate') return true;
  if (trigger === 'drift-threshold') {
    return Object.values(driftCounts).some((n) => (n ?? 0) >= threshold);
  }
  return false;
}

/** Stable proposal id (no clock of its own — atCommit/ts supplied). */
function proposalId(sourceProject, sibling, stamp) {
  const s = String(stamp ?? 'pending').replace(/[^A-Za-z0-9._-]/g, '_');
  return `prop/${sourceProject}->${sibling}/${s}`;
}

/**
 * Turn substrate briefs (6.4) into CONSENT-GATED proposal records. Each is a
 * PROPOSED story for the sibling pipeline: `status:'proposed'`,
 * `requiresApproval:true`. Nothing here is auto-merged — these are filed into
 * the queue and a human approves. Pure.
 *
 * @param {Array} briefs - output of buildBriefs (6.4)
 * @param {{sourceProject:string, atCommit?:string, ts:string}} ctx
 */
export function buildProposals(briefs, { sourceProject, atCommit = null, ts }) {
  return (briefs ?? []).map((b) => ({
    proposalId: proposalId(sourceProject, b.sibling, atCommit ?? ts),
    sourceProject,
    sibling: b.sibling,
    trigger: b.trigger,
    status: 'proposed',
    requiresApproval: true,
    brief: b.brief,
    contractChanges: b.contractChanges,
    proposedStory: b.proposedStory,
    atCommit,
    createdAt: ts,
  }));
}

/** Flattened, query-safe marker property name (Cypher keys can't be params). */
function markerProp(sibling) {
  return 'lastPropagatedTo_' + String(sibling).replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * The marker update to apply when a sibling's port story reaches Done — derived
 * from a proposal. Pure. (The write is `applyMarkerUpdate`.)
 */
export function markerUpdateFor(proposal) {
  return {
    sibling: proposal.sibling,
    atCommit: proposal.atCommit ?? null,
    contractNodes: [...new Set((proposal.contractChanges ?? []).map((c) => c.node))],
  };
}

/**
 * Stamp `lastPropagatedTo[sibling] = atCommit` on each shared-contract node.
 * Called ONLY when the sibling's port story is Done — this is what stops the
 * same change from re-briefing forever. Additive SET; never auto-applies code.
 */
export async function applyMarkerUpdate(session, { sibling, contractNodes, atCommit }) {
  const prop = markerProp(sibling);
  for (const node of contractNodes ?? []) {
    await session.run(`MATCH (c:Node {nodeId: $node}) SET c.\`${prop}\` = $atCommit`, {
      node,
      atCommit: atCommit ?? null,
    });
  }
  return { sibling, prop, updated: (contractNodes ?? []).length };
}

// Re-export the drift math so callers can compute counts without reaching into
// the revision lib directly.
export { computeDriftCounts };
