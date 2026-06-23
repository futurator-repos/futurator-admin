/**
 * Graph Integrity — containment backbone + the two distinct "no alone dots"
 * queries. Epic 2 (PRD §4.2).
 *
 * Three pieces, deliberately separated:
 *   - `emitContainmentBackbone` (Story 2.1): every file gets a structural
 *     `dir ─CONTAINS→ file` edge by construction, so no code node is ever
 *     degree-0 for purely structural reasons.
 *   - `reportOrphans` (Story 2.2): the tripwire. A degree-0 node is an
 *     *extractor bug*, never a finding. Non-`file` orphans are a hard failure
 *     that blocks the wave gate.
 *   - `reportDeadCode` (Story 2.3): a *different* query. The backbone means a
 *     dead file still carries its `CONTAINS` edge, so dead code is "a file
 *     whose only incident edge is CONTAINS" — a non-blocking finding.
 *
 * W2: these are NOT the same query. The backbone (2.1) is exactly what lets the
 * dead-code detector (2.3) use a different predicate than the orphan invariant
 * (2.2). A dead file appears in dead-code.json and NOT in orphans.json.
 *
 * Pure logic lives here so it can be unit-tested against a FakeSession (no live
 * Memgraph). graph-sync.mjs wires these into the sync flow.
 */

/**
 * Kinds for which a degree-0 orphan is a hard failure (an extractor dropped an
 * edge). `file`/`dir` orphans are soft — a brand-new file with no article yet,
 * or a dir, is not a pipeline-blocking bug.
 */
export const ORPHAN_HARD_FAIL_KINDS = new Set([
  'function',
  'class',
  'table',
  'lambda',
  'endpoint',
  'externalService',
]);

/**
 * Kinds for which a degree-0 node is a LEGITIMATE floater, not an extractor bug
 * — the soft "warning" bucket, never a hard-fail. `file`/`dir` are soft by
 * construction (a brand-new file with no article yet, or a dir). The doc-engine
 * adds `document`/`docSection` (a narrative section cited by no story is
 * legitimate). The Agentic Document Center adds `docShard`/`godDoc`: a god doc
 * whose CONTAINS edges haven't been ingested yet, or a shard governing nothing
 * live, is a legitimately-unlinked state — it warns + exits 0, it does NOT trip
 * the non-`file` degree-0 tripwire.
 *
 * This is the inverse view of `ORPHAN_HARD_FAIL_KINDS` (the actual gate is keyed
 * off the hard-fail set so an UNKNOWN/fabricated kind still hard-fails — the
 * tripwire is NARROWED here for these named soft kinds, not DISABLED).
 */
export const SOFT_ORPHAN_KINDS = new Set([
  'file',
  'dir',
  'document',
  'docSection',
  'docShard',
  'godDoc',
]);

/** `src/components` → `dir/src--components`; root → `dir/.`. */
export function dirNodeId(dirPath) {
  if (!dirPath || dirPath === '.' || dirPath === '') return 'dir/.';
  return `dir/${dirPath.replace(/\//g, '--')}`;
}

/** The directory portion of a relative file path (`a/b/c.ts` → `a/b`, `x.ts` → `.`). */
export function parentDir(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '.' : relPath.slice(0, i);
}

/**
 * Emit the containment backbone: a `dir` node per directory and a
 * `dir ─CONTAINS→ file` edge for every file, unconditionally (PRD §4.2.1).
 *
 * MATCH-only on the file node (we never invent file nodes here — that stays the
 * responsibility of the article/AST path), so a file already in the graph gains
 * its structural edge and can never be degree-0. `dir` nodes are cheap and
 * idempotent (`MERGE`); each carries ≥1 outgoing CONTAINS so is itself never an
 * orphan.
 *
 * @param {string[]} filePaths  project-relative file paths (e.g. `src/app/x.ts`)
 * @returns {Promise<{dirNodes:number, containsEdges:number}>}
 */
export async function emitContainmentBackbone(session, projectId, filePaths, today) {
  let dirNodes = 0;
  let containsEdges = 0;
  const seenDirs = new Set();

  for (const relPath of filePaths) {
    const fileNodeId = `code/${relPath.replace(/\//g, '--')}`;
    const dir = parentDir(relPath);
    const dNodeId = dirNodeId(dir);

    if (!seenDirs.has(dNodeId)) {
      seenDirs.add(dNodeId);
      await session.run(
        `MERGE (d:Node {nodeId: $nodeId})
         SET d.kind = 'dir', d.projectId = $projectId, d.label = $label,
             d.status = 'active', d.updated = $today,
             d.title = coalesce(d.title, $title)`,
        { nodeId: dNodeId, projectId, label: dir, title: dir === '.' ? '/' : dir, today },
      );
      dirNodes++;
    }

    const r = await session.run(
      `MATCH (d:Node {nodeId: $dirId})
       MATCH (f:Node {nodeId: $fileId, projectId: $projectId})
       MERGE (d)-[rel:CONTAINS]->(f) SET rel.updated = $today
       RETURN 1`,
      { dirId: dNodeId, fileId: fileNodeId, projectId, today },
    );
    if (r.records.length > 0) containsEdges++;
  }

  return { dirNodes, containsEdges };
}

/**
 * Group orphans by kind and split out the hard-failures. Pure — testable with
 * no session at all.
 */
export function classifyOrphans(orphans) {
  const byKind = {};
  for (const o of orphans) {
    (byKind[o.kind] ||= []).push(o.id);
  }
  const hardFail = orphans.filter((o) => ORPHAN_HARD_FAIL_KINDS.has(o.kind));
  return { byKind, hardFail };
}

/**
 * Genuine-orphan count (F16) — the signal the pipeline actually cares about.
 *
 * `orphans` is every degree-0 node. The `hardFail` subset (non-`file`/`dir`
 * kinds) is a dropped-edge extractor bug. The remainder are *legitimate
 * floaters* the operator should NOT be paged about: a brand-new `file` with no
 * article yet, a test file with no inbound edge, a deleted-source zombie pending
 * pruning (F15), or a decision doc awaiting plan-doc linking — all of which
 * carry/await a soft edge rather than signalling a regression.
 *
 * Returns the genuine count, the legitimate-floater count, and (given the prior
 * count) the delta — so a single new genuine orphan stands out even when a noisy
 * floater backlog exists. Pure; testable with no session.
 *
 * @param {Array<{id:string,kind:string}>} orphans
 * @param {{previousGenuine?:number, attentionThreshold?:number}} [opts]
 */
export function classifyGenuineOrphans(orphans, opts = {}) {
  const { previousGenuine = null, attentionThreshold = 1 } = opts;
  const { byKind, hardFail } = classifyOrphans(orphans);
  const legitimate = orphans.filter((o) => !ORPHAN_HARD_FAIL_KINDS.has(o.kind));
  const genuineOrphanCount = hardFail.length;
  const delta = previousGenuine == null ? null : genuineOrphanCount - previousGenuine;
  return {
    byKind,
    genuine: hardFail,
    legitimate,
    genuineOrphanCount,
    legitimateFloaterCount: legitimate.length,
    delta,
    needsAttention: genuineOrphanCount >= attentionThreshold,
  };
}

/**
 * Orphan invariant (PRD §4.2.3a) — the extractor-bug tripwire. Any node with
 * literally zero incident edges (and not pruned). Because of the containment
 * backbone, a code node here should be impossible; a non-`file` survivor means
 * an extractor dropped an edge.
 *
 * @returns {Promise<{orphans:Array<{id,kind}>, byKind:Object, hardFail:Array}>}
 */
export async function reportOrphans(session, projectId) {
  const r = await session.run(
    `MATCH (n:Node {projectId: $projectId})
     WHERE NOT (n)--() AND coalesce(n.status,'active') <> 'pruned'
     RETURN n.nodeId AS id, n.kind AS kind`,
    { projectId },
  );
  const orphans = r.records.map((rec) => ({
    id: rec.get('id'),
    kind: rec.get('kind') || 'file',
  }));
  return { orphans, ...classifyOrphans(orphans) };
}

/**
 * Dead-code detector (PRD §4.2.3b, W2) — a DIFFERENT query from the orphan
 * invariant. A `file` whose only incident edge is `CONTAINS`: nothing imports
 * it, it imports/reads/writes/calls nothing live, and it defines nothing that
 * is called. Advisory only — dead code is a human decision, never auto-pruned.
 *
 * @returns {Promise<Array<{id,updated,title}>>}
 */
export async function reportDeadCode(session, projectId) {
  const r = await session.run(
    `MATCH (f:Node {projectId: $projectId, kind: 'file'})
     WHERE coalesce(f.status,'active') <> 'pruned'
       AND NOT (f)-[:IMPORTS|CALLS|READS|WRITES|CALLS_SERVICE|CALLS_ENDPOINT|HANDLED_BY|ROUTES]-()
       AND NOT (:Node)-[:IMPORTS|CALLS|HANDLED_BY|ROUTES]->(f)
       AND NOT (f)-[:DEFINES]->(:Node)<-[:CALLS]-(:Node)
     RETURN f.nodeId AS id, f.updated AS updated, f.title AS title`,
    { projectId },
  );
  return r.records.map((rec) => ({
    id: rec.get('id'),
    updated: rec.get('updated') ?? null,
    title: rec.get('title') ?? rec.get('id'),
  }));
}
