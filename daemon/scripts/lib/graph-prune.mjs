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
 * Pure logic lives here so it can be unit-tested against a FakeSession with no
 * live Memgraph; graph-sync.mjs wires it into processAstFacts.
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
 * @param {object} session     Memgraph session (or FakeSession in tests)
 * @param {string} projectId
 * @param {string[]} scannedPaths  project-relative paths in the full scan
 * @param {string} today        ISO date stamp (YYYY-MM-DD)
 * @returns {Promise<{prunedFiles:number, prunedSubNodes:number, prunedIds:string[]}>}
 */
export async function pruneDeletedCodeNodes(session, projectId, scannedPaths, today) {
  const liveFileNodeIds = (scannedPaths || []).map(codeNodeIdFor);

  // Which `file` nodes in the graph are NOT in the current full scan and carry
  // no live wiki article? Those are the deleted-source zombies.
  const r = await session.run(
    `MATCH (f:Node {projectId: $projectId, kind: 'file'})
     WHERE NOT f.nodeId IN $liveFileNodeIds
       AND f.summary IS NULL
       AND coalesce(f.status,'active') <> 'pruned'
     RETURN f.nodeId AS id`,
    { projectId, liveFileNodeIds },
  );
  const staleFileIds = r.records.map((rec) => rec.get('id')).filter(Boolean);

  let prunedFiles = 0;
  let prunedSubNodes = 0;
  const prunedIds = [];

  for (const fileId of staleFileIds) {
    // Prune the file node itself.
    await session.run(
      `MATCH (n:Node {nodeId: $nodeId}) SET n.status = 'pruned', n.updated = $today`,
      { nodeId: fileId, today },
    );
    prunedFiles++;
    prunedIds.push(fileId);

    // Prune its function/class children (keyed on parentFile = the file nodeId).
    const sub = await session.run(
      `MATCH (c:Node {projectId: $projectId, parentFile: $fileId})
       WHERE c.kind IN ['function','class']
         AND c.summary IS NULL
         AND coalesce(c.status,'active') <> 'pruned'
       SET c.status = 'pruned', c.updated = $today
       RETURN c.nodeId AS id`,
      { projectId, fileId, today },
    );
    for (const rec of sub.records) {
      const id = rec.get('id');
      if (id) {
        prunedSubNodes++;
        prunedIds.push(id);
      }
    }
  }

  return { prunedFiles, prunedSubNodes, prunedIds };
}
