/**
 * graph-prune.mjs — F15 delete-aware prune pass (2026-06-18).
 *
 * Additive ingest (`processAstFacts`, `upsertExtractedFacts`) only ever MERGEs
 * nodes — it never removes a node whose source file was deleted. Across many
 * syncs that leaves "zombie" code nodes for files that no longer exist on disk
 * (FINDING F15).
 *
 * This prune marks such nodes `status = 'pruned'` (mirroring the article-prune
 * pattern in graph-sync.mjs — reversible, and already filtered out by the
 * orphan / dead-code queries) rather than hard-deleting them.
 *
 * SAFETY — this MUST only run against a KNOWN-COMPLETE full-project scan (the
 * F14 authoritative scan). Running it on a partial worktree scan would prune
 * every file the story didn't touch. The caller gates on
 * `!isEphemeralScanRoot(facts.root)` and passes the post-F14-union file set.
 *
 * Pure logic lives here so it can be unit-tested against an in-memory
 * GraphStore, no live Memgraph (S1.4, EU migration: Memgraph/bolt is EXCISED,
 * see `lib/graph-store.mjs`); graph-sync.mjs wires it into processAstFacts.
 */

/** `code/<slug>` nodeId for a project-relative file path (matches graph-sync). */
function codeNodeIdFor(relPath) {
  return `code/${relPath.replace(/\//g, '--')}`;
}

/**
 * Prune code nodes whose defining source file is ABSENT from the authoritative
 * full-project scan.
 *
 * Targets:
 *   - `file` nodes (nodeId `code/<slug>`) whose path is not in the scan, AND
 *   - their `function` / `class` children (matched via `parentFile`).
 *
 * Skips:
 *   - any node that carries a live wiki article (`n.summary IS NOT NULL`) — the
 *     Compiler owns those; their lifecycle is the article diff, not the scan.
 *   - already-pruned nodes (idempotent).
 *
 * Note we prune by ABSENCE-FROM-SCAN, never by edge count, so a legitimately
 * edgeless node that still exists on disk (e.g. an untested helper or a test
 * file) is kept — only nodes for genuinely deleted source files are pruned.
 *
 * `parentFile` keyed the function/class-child query in the old Cypher; the
 * GraphStore doesn't round-trip that prop today (`buildNodeItem`'s
 * `SYSTEM_GRAPH_NODE_PROPS` allowlist, `lib/graph-store.mjs`, doesn't include
 * it), so children are found via the `file-index` GSI (`store.queryByFile`,
 * keyed on the same `file` field `processAstFacts` already sets on every
 * function/class node) instead — same "children of this file" result, reached
 * through the primitive the store was actually designed to answer it with.
 *
 * @param {object} store       GraphStore instance (S1.4 — session→store swap)
 * @param {string} projectId
 * @param {string[]} scannedPaths  project-relative paths in the full scan
 * @param {string} today        ISO date stamp (YYYY-MM-DD)
 * @returns {Promise<{prunedFiles:number, prunedSubNodes:number, prunedIds:string[]}>}
 */
export async function pruneDeletedCodeNodes(store, projectId, scannedPaths, today) {
  const liveFileNodeIds = new Set((scannedPaths || []).map(codeNodeIdFor));

  // Which `file` nodes in the graph are NOT in the current full scan and carry
  // no live wiki article? Those are the deleted-source zombies.
  const allNodes = await store.listNodes(projectId);
  const staleFiles = allNodes.filter(
    (n) =>
      n.kind === 'file' &&
      !liveFileNodeIds.has(n.nodeId) &&
      !n.props?.summary &&
      (n.status ?? 'active') !== 'pruned',
  );

  let prunedFiles = 0;
  let prunedSubNodes = 0;
  const prunedIds = [];

  for (const fileNode of staleFiles) {
    // Prune the file node itself.
    await store.setNodeAttrs(projectId, fileNode.nodeId, { status: 'pruned', updated: today });
    prunedFiles++;
    prunedIds.push(fileNode.nodeId);

    // Prune its function/class children — every node sharing this file's
    // `file` field (file-index GSI), excluding the file node itself.
    if (!fileNode.file) continue;
    const siblings = await store.queryByFile(projectId, fileNode.file);
    for (const child of siblings) {
      if (child.nodeId === fileNode.nodeId) continue;
      if (child.kind !== 'function' && child.kind !== 'class') continue;
      if (child.props?.summary) continue;
      if ((child.status ?? 'active') === 'pruned') continue;
      await store.setNodeAttrs(projectId, child.nodeId, { status: 'pruned', updated: today });
      prunedSubNodes++;
      prunedIds.push(child.nodeId);
    }
  }

  return { prunedFiles, prunedSubNodes, prunedIds };
}
