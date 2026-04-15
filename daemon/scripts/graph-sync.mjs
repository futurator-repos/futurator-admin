/**
 * Graph Sync Script — Embed + Memgraph Upsert
 * Story MY-1.5 + MY-1.6 (S3 backup integration)
 *
 * Reads wiki articles from knowledge/ dir, parses frontmatter,
 * diffs against compile-state.json hashes, embeds changed articles
 * via Voyage AI, upserts nodes into Memgraph, creates edges from
 * [[wikilinks]], and backs up to S3.
 *
 * Usage:
 *   node graph-sync.mjs --project spyhunter --knowledge-dir /path/to/knowledge
 *   node graph-sync.mjs --project spyhunter --knowledge-dir /path/to/knowledge --full-resync
 *   node graph-sync.mjs --project spyhunter --knowledge-dir /path/to/knowledge --skip-backup
 *
 * Environment:
 *   MEMGRAPH_URI     — Bolt URI (default: bolt://localhost:7687)
 *   VOYAGE_API_KEY   — Required for embedding
 */

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import { embedBatch, getUsageStats, resetUsageStats } from './lib/voyage-embed.mjs';
import { backupToS3 } from './lib/s3-backup.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── CLI Argument Parsing ─────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    project: null,
    knowledgeDir: null,
    stateFile: null,
    fullResync: false,
    skipBackup: false,
    skipEmbed: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--project':
        parsed.project = args[++i];
        break;
      case '--knowledge-dir':
        parsed.knowledgeDir = args[++i];
        break;
      case '--state-file':
        parsed.stateFile = args[++i];
        break;
      case '--full-resync':
        parsed.fullResync = true;
        break;
      case '--skip-backup':
        parsed.skipBackup = true;
        break;
      case '--skip-embed':
        parsed.skipEmbed = true;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        console.error(`[graph-sync] Unknown argument: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  // Validate required args
  if (!parsed.project || !parsed.knowledgeDir) {
    console.error('[graph-sync] ERROR: --project and --knowledge-dir are required');
    printUsage();
    process.exit(1);
  }

  // Default state file path
  if (!parsed.stateFile) {
    parsed.stateFile = join(parsed.knowledgeDir, '..', '.mycelium', 'compile-state.json');
  }

  return parsed;
}

function printUsage() {
  console.log(`
Usage: node graph-sync.mjs [options]

Required:
  --project <id>          Project identifier (e.g., spyhunter)
  --knowledge-dir <path>  Path to the knowledge/ directory

Optional:
  --state-file <path>     Path to compile-state.json (default: ../mycelium/compile-state.json)
  --full-resync           Re-process all articles regardless of hash
  --skip-backup           Skip S3 backup step
  --skip-embed            Skip Voyage AI embedding (use existing embeddings)
  --dry-run               Show what would change without making changes
  --help                  Show this help message
`);
}

// ── Edge Type Configuration ──────────────────────────────────────────

/** Maps wiki section headers to edge types, directions, and weights */
const SECTION_EDGE_MAP = {
  'dependencies': { type: 'DEPENDS_ON', direction: 'outgoing', weight: 1.0 },
  'dependents': { type: 'DEPENDS_ON', direction: 'incoming', weight: 1.0 },
  'derived from': { type: 'DERIVED_FROM', direction: 'outgoing', weight: 0.7 },
  'informs': { type: 'INFORMS', direction: 'outgoing', weight: 0.3 },
  'refines': { type: 'REFINES', direction: 'outgoing', weight: 0.5 },
  'validates': { type: 'VALIDATES', direction: 'outgoing', weight: 0.6 },
  'supersedes': { type: 'SUPERSEDES', direction: 'outgoing', weight: 0.8 },
  'conflicts with': { type: 'CONFLICTS_WITH', direction: 'bidirectional', weight: 0.9 },
  'enables': { type: 'ENABLES', direction: 'outgoing', weight: 0.5 },
};

// ── Helper Functions ─────────────────────────────────────────────────

function log(msg) {
  console.log(`[graph-sync] ${msg}`);
}

function logError(msg) {
  console.error(`[graph-sync] ERROR: ${msg}`);
}

/**
 * Recursively find all .md files in a directory (excluding archive/).
 */
async function findMarkdownFiles(dir, baseDir = dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip archive directory
      const relDir = relative(baseDir, fullPath);
      if (relDir === 'archive' || relDir.startsWith('archive/')) {
        continue;
      }
      files.push(...(await findMarkdownFiles(fullPath, baseDir)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Compute MD5 hash of article content, excluding date-only frontmatter changes.
 * Strips 'updated:' line from frontmatter to avoid unnecessary re-embeds.
 */
function computeContentHash(content) {
  // Strip the 'updated:' frontmatter field to avoid hash changes on date-only updates
  const normalized = content.replace(/^updated:\s*.+$/m, '');
  return createHash('md5').update(normalized).digest('hex');
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { frontmatter: {}, body: string }.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlText = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of yamlText.split('\n')) {
    const kvMatch = line.match(/^([\w]+):\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let value = kvMatch[2].trim();

      // Parse arrays: [a, b, c]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      // Parse numbers
      else if (/^-?\d+(\.\d+)?$/.test(value)) {
        value = parseFloat(value);
      }

      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/**
 * Extract [[wikilinks]] from article body, grouped by section.
 * Returns array of { edgeType, direction, weight, target } objects.
 */
function extractWikilinks(body) {
  const edges = [];
  let currentSection = null;

  for (const line of body.split('\n')) {
    // Check for section headers
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim().toLowerCase();
      continue;
    }

    // Find [[wikilinks]] in this line
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(line)) !== null) {
      const target = linkMatch[1].trim();

      // Look up edge type from section
      if (currentSection && SECTION_EDGE_MAP[currentSection]) {
        const { type, direction, weight } = SECTION_EDGE_MAP[currentSection];
        edges.push({ type, direction, weight, target });
      }
    }
  }

  return edges;
}

/**
 * Prepare embeddable text from an article.
 * Concatenates title + purpose + key exports for a representative summary.
 */
function prepareEmbeddingText(frontmatter, body) {
  const parts = [];

  if (frontmatter.title) {
    parts.push(frontmatter.title);
  }

  // Extract Purpose section
  const purposeMatch = body.match(/## Purpose\n([\s\S]*?)(?=\n##|\n*$)/);
  if (purposeMatch) {
    parts.push(purposeMatch[1].trim());
  }

  // Extract Key Exports section
  const exportsMatch = body.match(/## Key Exports\n([\s\S]*?)(?=\n##|\n*$)/);
  if (exportsMatch) {
    parts.push(exportsMatch[1].trim());
  }

  // If no specific sections, use the full body
  if (parts.length <= 1) {
    parts.push(body.slice(0, 2000));
  }

  return parts.join('\n\n');
}

/**
 * Derive nodeId from article path relative to knowledge dir.
 * e.g., /path/to/knowledge/code/src--components--auth.tsx.md -> code/src--components--auth.tsx
 */
function deriveNodeId(articlePath, knowledgeDir) {
  const rel = relative(knowledgeDir, articlePath);
  // Remove .md extension
  return rel.replace(/\.md$/, '');
}

/**
 * Extract first 200 chars of Purpose section as summary.
 */
function extractSummary(body) {
  const purposeMatch = body.match(/## Purpose\n([\s\S]*?)(?=\n##|\n*$)/);
  if (purposeMatch) {
    return purposeMatch[1].trim().slice(0, 200);
  }
  return body.trim().slice(0, 200);
}

// ── Read compile-state.json ──────────────────────────────────────────

async function readCompileState(stateFilePath) {
  try {
    const content = await readFile(stateFilePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    log('No existing compile-state.json found, starting fresh');
    return {};
  }
}

/**
 * Write compile-state.json atomically (write to temp, then rename).
 */
async function writeCompileState(stateFilePath, state) {
  const tmpPath = stateFilePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmpPath, stateFilePath);
}

// ── Main Sync Logic ──────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  const startTime = Date.now();

  log(`Starting sync for project: ${config.project}`);
  log(`Knowledge dir: ${config.knowledgeDir}`);
  log(`State file: ${config.stateFile}`);
  if (config.fullResync) log('Mode: FULL RESYNC (all articles will be re-processed)');
  if (config.dryRun) log('Mode: DRY RUN (no changes will be made)');

  // ── Step 1: Read previous state ──────────────────────────────────
  const previousState = config.fullResync ? {} : await readCompileState(config.stateFile);

  // ── Step 2: Scan articles ────────────────────────────────────────
  const articlePaths = await findMarkdownFiles(config.knowledgeDir);
  log(`Found ${articlePaths.length} markdown files in knowledge/`);

  // ── Step 3: Diff articles ────────────────────────────────────────
  const newArticles = [];
  const changedArticles = [];
  const unchangedArticles = [];
  const currentHashes = {};

  for (const articlePath of articlePaths) {
    const nodeId = deriveNodeId(articlePath, config.knowledgeDir);
    const content = await readFile(articlePath, 'utf-8');
    const hash = computeContentHash(content);
    currentHashes[nodeId] = hash;

    if (!previousState[nodeId]) {
      newArticles.push({ nodeId, articlePath, content, hash });
    } else if (previousState[nodeId] !== hash) {
      changedArticles.push({ nodeId, articlePath, content, hash });
    } else {
      unchangedArticles.push({ nodeId, articlePath, content, hash });
    }
  }

  // Detect deleted articles (in state but not on disk)
  const currentNodeIds = new Set(Object.keys(currentHashes));
  const deletedNodeIds = Object.keys(previousState).filter((id) => !currentNodeIds.has(id));

  log(
    `Found ${newArticles.length} new, ${changedArticles.length} changed, ${deletedNodeIds.length} deleted, ${unchangedArticles.length} unchanged`
  );

  const articlesToProcess = [...newArticles, ...changedArticles];

  if (articlesToProcess.length === 0 && deletedNodeIds.length === 0) {
    log('Nothing to sync — all articles up to date');
    if (!config.skipBackup) {
      await runS3Backup(config);
    }
    return;
  }

  if (config.dryRun) {
    log('DRY RUN — would process:');
    for (const a of newArticles) log(`  NEW: ${a.nodeId}`);
    for (const a of changedArticles) log(`  CHANGED: ${a.nodeId}`);
    for (const d of deletedNodeIds) log(`  DELETED: ${d}`);
    return;
  }

  // ── Step 4: Parse frontmatter and wikilinks ──────────────────────
  const parsedArticles = articlesToProcess.map((article) => {
    const { frontmatter, body } = parseFrontmatter(article.content);
    const wikilinks = extractWikilinks(body);
    const embeddingText = prepareEmbeddingText(frontmatter, body);
    const summary = extractSummary(body);
    return { ...article, frontmatter, body, wikilinks, embeddingText, summary };
  });

  // ── Step 5: Embed changed articles ───────────────────────────────
  let embeddings = [];
  if (!config.skipEmbed && parsedArticles.length > 0) {
    log(`Embedding ${parsedArticles.length} articles via Voyage AI...`);
    resetUsageStats();

    const texts = parsedArticles.map((a) => a.embeddingText);
    try {
      embeddings = await embedBatch(texts, 'document');
      const stats = getUsageStats();
      log(`Embedded ${texts.length} articles, ${stats.totalTokens} tokens, ~$${stats.totalCost.toFixed(6)}`);
    } catch (err) {
      logError(`Embedding failed: ${err.message}`);
      logError('Continuing without embeddings — nodes will be upserted without vectors');
      embeddings = parsedArticles.map(() => null);
    }
  } else {
    embeddings = parsedArticles.map(() => null);
  }

  // ── Step 6: Upsert nodes into Memgraph ───────────────────────────
  const BOLT_URI = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';
  const driver = neo4j.driver(BOLT_URI);

  try {
    const session = driver.session();
    let upsertCount = 0;
    let pruneCount = 0;
    let edgeCreateCount = 0;
    let edgeRemoveCount = 0;

    try {
      // Upsert changed/new nodes
      for (let i = 0; i < parsedArticles.length; i++) {
        const article = parsedArticles[i];
        const embedding = embeddings[i];
        const fm = article.frontmatter;

        const params = {
          nodeId: article.nodeId,
          projectId: config.project,
          type: fm.type || 'unknown',
          phase: fm.phase || 'unknown',
          status: fm.status || 'active',
          maturity: typeof fm.maturity === 'number' ? fm.maturity : 0.1,
          title: fm.title || article.nodeId,
          summary: article.summary,
          tags: Array.isArray(fm.tags) ? fm.tags : [],
          createdByEpic: fm.createdByEpic || '',
          createdByStory: fm.createdByStory || '',
          lastMutatedByStory: fm.lastMutatedByStory || '',
          created: fm.created || new Date().toISOString().split('T')[0],
          updated: fm.updated || new Date().toISOString().split('T')[0],
        };

        // Build SET clause dynamically based on whether we have an embedding
        let setClause = `
          SET n.projectId = $projectId, n.type = $type, n.phase = $phase,
              n.status = $status, n.maturity = $maturity, n.title = $title,
              n.summary = $summary, n.tags = $tags,
              n.createdByEpic = $createdByEpic, n.createdByStory = $createdByStory,
              n.lastMutatedByStory = $lastMutatedByStory,
              n.created = $created, n.updated = $updated`;

        if (embedding) {
          setClause += ', n.embedding = $embedding';
          params.embedding = embedding;
        }

        await session.run(`MERGE (n:Node {nodeId: $nodeId}) ${setClause}`, params);
        upsertCount++;
      }

      log(`Upserted ${upsertCount} nodes`);

      // Prune deleted articles (mark as pruned, don't delete)
      for (const deletedId of deletedNodeIds) {
        await session.run(
          `MATCH (n:Node {nodeId: $nodeId}) SET n.status = 'pruned', n.updated = $today`,
          { nodeId: deletedId, today: new Date().toISOString().split('T')[0] }
        );
        pruneCount++;
      }

      if (pruneCount > 0) {
        log(`Pruned ${pruneCount} nodes`);
      }

      // ── Step 7: Create/update edges from wikilinks ───────────────
      for (const article of parsedArticles) {
        // First, remove existing outgoing edges from this node that we manage
        // (to handle removed wikilinks)
        const existingEdgesResult = await session.run(
          `MATCH (a:Node {nodeId: $nodeId})-[r]->(b:Node)
           WHERE a.projectId = $projectId
           RETURN type(r) AS edgeType, b.nodeId AS targetId, id(r) AS edgeId`,
          { nodeId: article.nodeId, projectId: config.project }
        );

        const existingEdges = new Set(
          existingEdgesResult.records.map(
            (r) => `${r.get('edgeType')}:${r.get('targetId')}`
          )
        );

        const desiredEdges = new Set();

        for (const link of article.wikilinks) {
          if (link.direction === 'outgoing') {
            // Current article -> target
            desiredEdges.add(`${link.type}:${link.target}`);
            await session.run(
              `MATCH (a:Node {nodeId: $sourceId}), (b:Node {nodeId: $targetId})
               MERGE (a)-[r:${link.type}]->(b)
               SET r.weight = $weight`,
              { sourceId: article.nodeId, targetId: link.target, weight: link.weight }
            );
            edgeCreateCount++;
          } else if (link.direction === 'incoming') {
            // Target -> current article (reverse edge)
            await session.run(
              `MATCH (a:Node {nodeId: $targetId}), (b:Node {nodeId: $sourceId})
               MERGE (a)-[r:${link.type}]->(b)
               SET r.weight = $weight`,
              { sourceId: article.nodeId, targetId: link.target, weight: link.weight }
            );
            edgeCreateCount++;
          } else if (link.direction === 'bidirectional') {
            // Both directions
            desiredEdges.add(`${link.type}:${link.target}`);
            await session.run(
              `MATCH (a:Node {nodeId: $sourceId}), (b:Node {nodeId: $targetId})
               MERGE (a)-[r1:${link.type}]->(b)
               SET r1.weight = $weight
               WITH a, b
               MERGE (b)-[r2:${link.type}]->(a)
               SET r2.weight = $weight`,
              { sourceId: article.nodeId, targetId: link.target, weight: link.weight }
            );
            edgeCreateCount += 2;
          }
        }

        // Remove stale outgoing edges (edges that exist in DB but not in current wikilinks)
        for (const existing of existingEdges) {
          if (!desiredEdges.has(existing)) {
            const colonIdx = existing.indexOf(':');
            const edgeType = existing.slice(0, colonIdx);
            const targetId = existing.slice(colonIdx + 1);
            try {
              await session.run(
                `MATCH (a:Node {nodeId: $sourceId})-[r:${edgeType}]->(b:Node {nodeId: $targetId})
                 DELETE r`,
                { sourceId: article.nodeId, targetId }
              );
              edgeRemoveCount++;
            } catch {
              // Edge type may not be a managed type — ignore
            }
          }
        }
      }

      log(`Created/updated ${edgeCreateCount} edges, removed ${edgeRemoveCount} stale edges`);
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }

  // ── Step 8: Update compile-state.json ────────────────────────────
  const newState = { ...currentHashes };
  // Remove deleted articles from state
  for (const deletedId of deletedNodeIds) {
    delete newState[deletedId];
  }
  await writeCompileState(config.stateFile, newState);
  log(`Updated compile-state.json (${Object.keys(newState).length} entries)`);

  // ── Step 9: S3 Backup (non-blocking) ─────────────────────────────
  if (!config.skipBackup) {
    await runS3Backup(config);
  }

  // ── Summary ──────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Sync complete in ${elapsed}s`);
}

/**
 * Run S3 backup as a non-blocking step.
 * Errors are logged but do not fail the pipeline.
 */
async function runS3Backup(config) {
  try {
    log('Starting S3 backup...');
    await backupToS3(config.project, config.knowledgeDir);
  } catch (err) {
    logError(`S3 backup failed (non-blocking): ${err.message}`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────

main().catch((err) => {
  logError(err.message);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
