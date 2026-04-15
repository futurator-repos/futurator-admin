/**
 * Pruning Scan & Node Archival — MY-3.4
 *
 * Queries Memgraph for superseded nodes with no active dependents, then
 * archives the wiki articles and removes nodes from the graph.
 *
 * Modes:
 *   - Default: lists candidates for confirmation
 *   - --auto: archives all candidates without confirmation (deployment pipeline)
 *   - --confirm: proceeds with archival after listing
 *   - --node-ids id1,id2: selectively prune specific nodes
 *
 * Usage:
 *   node pruning-scan.mjs --project <projectId> --knowledge-dir <dir>
 *   node pruning-scan.mjs --project <projectId> --knowledge-dir <dir> --auto
 *   node pruning-scan.mjs --project <projectId> --knowledge-dir <dir> --confirm
 *   node pruning-scan.mjs --project <projectId> --knowledge-dir <dir> --node-ids code/old--file.tsx,decisions/old-adr
 *
 * [Source: docs/concepts/mycelium-labs-architecture.md#5.2-GraphRAG-Query-Patterns]
 * [Source: docs/concepts/mycelium-labs-architecture.md#6.1-Node-Status-Lifecycle]
 */

import neo4j from 'neo4j-driver';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';

// ── Config ──

const BOLT_URI = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';

// ── CLI Args ──

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const projectId = getArg('project');
const knowledgeDir = getArg('knowledge-dir');
const autoMode = args.includes('--auto');
const confirmMode = args.includes('--confirm');
const nodeIdsArg = getArg('node-ids');
const specificNodeIds = nodeIdsArg ? nodeIdsArg.split(',').map(s => s.trim()) : null;

if (!projectId || !knowledgeDir) {
  console.error('Usage: node pruning-scan.mjs --project <id> --knowledge-dir <dir> [--auto] [--confirm] [--node-ids id1,id2]');
  process.exit(1);
}

// Ensure archive directory exists
const archiveDir = join(knowledgeDir, 'archive');
if (!existsSync(archiveDir)) {
  mkdirSync(archiveDir, { recursive: true });
}

// ── Helpers ──

function today() {
  return new Date().toISOString().split('T')[0];
}

function toStr(val) {
  if (val == null) return '';
  return String(val);
}

/**
 * Resolves the disk path for a given nodeId.
 * nodeId format: "{phase}/{slug}" e.g. "code/src--auth.tsx"
 * Disk path: knowledge/{phase}/{slug}.md
 */
function nodeIdToPath(nodeId) {
  return join(knowledgeDir, `${nodeId}.md`);
}

/**
 * Converts a nodeId to an archive filename.
 * e.g. "code/src--auth.tsx" -> "code--src--auth.tsx.md"
 */
function nodeIdToArchiveName(nodeId) {
  return nodeId.replace(/\//g, '--') + '.md';
}

/**
 * Updates article frontmatter fields in a markdown file.
 * Preserves the rest of the content.
 */
function updateFrontmatter(filePath, updates) {
  if (!existsSync(filePath)) return false;

  let content = readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  let frontmatter = fmMatch[1];
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}:.*$`, 'm');
    if (regex.test(frontmatter)) {
      frontmatter = frontmatter.replace(regex, `${key}: ${value}`);
    } else {
      frontmatter += `\n${key}: ${value}`;
    }
  }

  content = content.replace(/^---\n[\s\S]*?\n---/, `---\n${frontmatter}\n---`);
  writeFileSync(filePath, content);
  return true;
}

// ── Memgraph Connection ──

const driver = neo4j.driver(BOLT_URI);

async function runQuery(cypher, params = {}) {
  const session = driver.session();
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } finally {
    await session.close();
  }
}

// ── Step 1: Find Pruning Candidates ──

async function findPruningCandidates() {
  console.log('Scanning for pruning candidates ...');
  console.log(`  Project: ${projectId}`);
  console.log('');

  // Pruning candidates query from architecture doc section 5.2
  const records = await runQuery(`
    MATCH (n:Node)
    WHERE n.status = 'superseded'
      AND n.projectId = $projectId
      AND NOT (n)<-[:DEPENDS_ON]-(:Node {status: 'active'})
    RETURN n.nodeId AS nodeId, n.title AS title, n.type AS type,
           n.updated AS lastUpdated, n.phase AS phase
    ORDER BY n.updated ASC
  `, { projectId });

  const candidates = [];
  for (const rec of records) {
    const nodeId = toStr(rec.get('nodeId'));

    // Find what superseded this node
    const supersederRecords = await runQuery(`
      MATCH (newer:Node)-[:SUPERSEDES]->(n:Node {nodeId: $nodeId})
      RETURN newer.nodeId AS supersederId
      LIMIT 1
    `, { nodeId });

    const supersededBy = supersederRecords.length > 0
      ? toStr(supersederRecords[0].get('supersederId'))
      : 'unknown';

    candidates.push({
      nodeId,
      title: toStr(rec.get('title')),
      type: toStr(rec.get('type')),
      phase: toStr(rec.get('phase')),
      lastUpdated: toStr(rec.get('lastUpdated')),
      supersededBy,
    });
  }

  return candidates;
}

// ── Step 2: Verification — Double-check no active dependents ──

async function verifyNoDependents(nodeId) {
  const records = await runQuery(`
    MATCH (target:Node {nodeId: $nodeId})
    MATCH path = (target)<-[:DEPENDS_ON|VALIDATES*1..5]-(affected)
    WHERE affected.status = 'active'
    RETURN affected.nodeId AS affectedId, affected.type AS type,
           length(path) AS hops
    ORDER BY hops ASC
  `, { nodeId });

  return records.length === 0;
}

// ── Step 3: Archive Article ──

function archiveArticle(nodeId, supersededBy) {
  const srcPath = nodeIdToPath(nodeId);
  const archiveName = nodeIdToArchiveName(nodeId);
  const destPath = join(archiveDir, archiveName);
  const d = today();

  if (!existsSync(srcPath)) {
    console.log(`  [SKIP] Article file not found: ${srcPath}`);
    return false;
  }

  // Update frontmatter before moving
  updateFrontmatter(srcPath, {
    status: 'pruned',
    prunedAt: d,
    prunedReason: `'No active dependents, superseded by ${supersededBy}'`,
  });

  // Move to archive (rename = atomic on same filesystem)
  renameSync(srcPath, destPath);
  console.log(`  [ARCHIVED] ${nodeId} -> archive/${archiveName}`);
  return true;
}

// ── Step 4: Remove from Memgraph ──

async function deleteFromMemgraph(nodeId) {
  // DETACH DELETE removes the node AND all its edges
  await runQuery(`
    MATCH (n:Node {nodeId: $nodeId})
    DETACH DELETE n
  `, { nodeId });

  // Verify deletion
  const check = await runQuery(`
    MATCH (n:Node {nodeId: $nodeId})
    RETURN n.nodeId
  `, { nodeId });

  if (check.length > 0) {
    console.log(`  [ERROR] Node ${nodeId} still exists after DETACH DELETE`);
    return false;
  }

  console.log(`  [DELETED] ${nodeId} removed from Memgraph`);
  return true;
}

// ── Step 5: Update index.md ──

function updateIndex(prunedNodeIds) {
  const indexPath = join(knowledgeDir, 'index.md');
  if (!existsSync(indexPath)) {
    console.log('  [WARN] index.md not found, skipping index update');
    return;
  }

  let content = readFileSync(indexPath, 'utf-8');
  let removedCount = 0;

  for (const nodeId of prunedNodeIds) {
    // Remove lines referencing the pruned nodeId
    // Match patterns like: - [[nodeId]] — description or | [[nodeId]] | ... |
    const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^.*\\[\\[${escaped}\\]\\].*$\\n?`, 'gm');
    const before = content;
    content = content.replace(regex, '');
    if (content !== before) removedCount++;
  }

  writeFileSync(indexPath, content);
  console.log(`  [INDEX] Removed ${removedCount} entries from index.md`);
}

// ── Step 6: Update log.md ──

function appendToLog(prunedItems) {
  const logPath = join(knowledgeDir, 'log.md');
  const d = today();

  const entries = [];
  for (const item of prunedItems) {
    entries.push(`[PRUNED] ${d} | ${item.nodeId} | Reason: superseded by ${item.supersededBy}, no active dependents`);
  }

  if (entries.length === 0) return;

  const logContent = '\n' + entries.join('\n') + '\n';

  if (existsSync(logPath)) {
    let existing = readFileSync(logPath, 'utf-8');
    existing += logContent;
    writeFileSync(logPath, existing);
  } else {
    writeFileSync(logPath, `# Knowledge Log\n${logContent}`);
  }

  console.log(`  [LOG] Appended ${entries.length} pruning records to log.md`);
}

// ── Step 7: Update pending-work.md ──

function removePrunedFromPendingWork(prunedNodeIds) {
  const pendingPath = join(knowledgeDir, 'system', 'pending-work.md');
  if (!existsSync(pendingPath)) return;

  let content = readFileSync(pendingPath, 'utf-8');
  let removedCount = 0;

  for (const nodeId of prunedNodeIds) {
    const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^.*\\[\\[${escaped}\\]\\].*$\\n?`, 'gm');
    const before = content;
    content = content.replace(regex, '');
    if (content !== before) removedCount++;
  }

  if (removedCount > 0) {
    writeFileSync(pendingPath, content);
    console.log(`  [PENDING-WORK] Removed ${removedCount} entries from pending-work.md`);
  }
}

// ── Display Candidates Table ──

function displayCandidates(candidates) {
  if (candidates.length === 0) {
    console.log('No pruning candidates found. Knowledge graph is clean.');
    return;
  }

  console.log(`Found ${candidates.length} pruning candidate(s):\n`);
  console.log('┌─────────────────────────────────┬────────────┬──────────────┬────────────────────────────────┐');
  console.log('│ Node ID                         │ Type       │ Last Updated │ Superseded By                  │');
  console.log('├─────────────────────────────────┼────────────┼──────────────┼────────────────────────────────┤');

  for (const c of candidates) {
    const id = c.nodeId.padEnd(31);
    const type = c.type.padEnd(10);
    const updated = (c.lastUpdated || '-').padEnd(12);
    const by = c.supersededBy.padEnd(30);
    console.log(`│ ${id} │ ${type} │ ${updated} │ ${by} │`);
  }

  console.log('└─────────────────────────────────┴────────────┴──────────────┴────────────────────────────────┘');
  console.log('');
}

// ── Execute Pruning ──

async function executePruning(candidates) {
  console.log(`Pruning ${candidates.length} node(s) ...`);
  console.log('');

  const pruned = [];

  for (const candidate of candidates) {
    // Double-check safety: verify no active dependents
    const safe = await verifyNoDependents(candidate.nodeId);
    if (!safe) {
      console.log(`  [SKIP] ${candidate.nodeId} — active dependents found during verification, skipping`);
      continue;
    }

    // Archive the article file
    const archived = archiveArticle(candidate.nodeId, candidate.supersededBy);

    // Delete from Memgraph
    const deleted = await deleteFromMemgraph(candidate.nodeId);

    if (archived || deleted) {
      pruned.push(candidate);
    }
  }

  if (pruned.length > 0) {
    // Update index.md
    updateIndex(pruned.map(p => p.nodeId));

    // Update log.md
    appendToLog(pruned);

    // Update pending-work.md
    removePrunedFromPendingWork(pruned.map(p => p.nodeId));
  }

  console.log('');
  console.log(`Pruning complete. ${pruned.length} of ${candidates.length} node(s) archived.`);
  return pruned;
}

// ── Main ──

async function main() {
  console.log('=== Pruning Scan ===');
  console.log(`Project: ${projectId}`);
  console.log(`Knowledge dir: ${knowledgeDir}`);
  console.log(`Mode: ${autoMode ? 'auto (deployment pipeline)' : confirmMode ? 'confirm' : 'list only'}`);
  if (specificNodeIds) {
    console.log(`Specific nodes: ${specificNodeIds.join(', ')}`);
  }
  console.log('');

  try {
    // Find candidates
    let candidates = await findPruningCandidates();

    // Filter by specific node IDs if provided
    if (specificNodeIds) {
      candidates = candidates.filter(c => specificNodeIds.includes(c.nodeId));
      if (candidates.length === 0) {
        console.log('None of the specified node IDs are pruning candidates.');
        console.log('A node must be status: superseded with no active DEPENDS_ON dependents to be prunable.');
        return;
      }
    }

    // Display candidates
    displayCandidates(candidates);

    if (candidates.length === 0) {
      return;
    }

    // Auto mode: prune immediately (called from deployment pipeline)
    if (autoMode) {
      console.log('Auto mode enabled — proceeding with archival ...');
      const pruned = await executePruning(candidates);

      // Output summary as JSON for pipeline event reporting
      console.log('');
      console.log('--- PRUNING_RESULT_JSON ---');
      console.log(JSON.stringify({
        scanned: candidates.length,
        pruned: pruned.length,
        items: pruned.map(p => ({ nodeId: p.nodeId, supersededBy: p.supersededBy })),
      }));
      return;
    }

    // Confirm mode: prune after listing
    if (confirmMode) {
      console.log('Confirm mode — proceeding with archival ...');
      await executePruning(candidates);
      return;
    }

    // Default mode: list only
    console.log('To prune these nodes, re-run with --confirm or --auto flag.');
    console.log('To prune specific nodes: --node-ids id1,id2 --confirm');
    console.log('');
    console.log('WARNING: Pruning should only be executed as part of deployment compilation.');
    console.log('Running pruning during active development may remove articles that are');
    console.log('still being referenced by in-progress stories.');

  } catch (err) {
    console.error('Pruning scan error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await driver.close();
  }
}

main();
