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
 *   MEMGRAPH_URI       — Bolt URI (default: bolt://localhost:7687)
 *   MEMGRAPH_USER      — Optional; if set, basic auth is enabled
 *   MEMGRAPH_PASSWORD  — Paired with MEMGRAPH_USER
 *   VOYAGE_API_KEY     — Required for embedding
 */

import { readdir, readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDriver } from './lib/memgraph-driver.mjs';
import { embedBatch, getUsageStats, resetUsageStats } from './lib/voyage-embed.mjs';
import { backupToS3 } from './lib/s3-backup.mjs';
import { loadAliasMap, resolveImportSource } from './lib/import-resolver.mjs';

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
    await processAstFacts(config);
    await writeGraphSnapshot(config);
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
  const driver = createDriver();

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

  // ── Step 8.4: AST grounding (Slice B) ────────────────────────────
  await processAstFacts(config);

  // ── Step 8.5: Graph snapshot for in-app visualization ────────────
  await writeGraphSnapshot(config);

  // ── Step 9: S3 Backup (non-blocking) ─────────────────────────────
  if (!config.skipBackup) {
    await runS3Backup(config);
  }

  // ── Summary ──────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Sync complete in ${elapsed}s`);
}

// ── Slice B: AST → Memgraph translation ────────────────────────────────

/**
 * Convert a file path (e.g. `src/game/dino.ts`) to the same `code/<slug>`
 * nodeId convention the wiki articles use (`code/src--game--dino.ts`). Keeps
 * sub-file nodes consistent with their parent file's nodeId.
 */
function fileToCodeNodeId(relPath) {
  return `code/${relPath.replace(/\//g, '--')}`;
}

/** Composite nodeId for a sub-file entity. */
function subNodeId(fileNodeId, kind, name) {
  return `${fileNodeId}#${kind}:${name}`;
}

/**
 * Import resolution lives in ./lib/import-resolver.mjs (G1, 2026-06-12):
 * tsconfig path-alias support (`@/` etc.) + on-disk candidate fallback so
 * imports of UNCHANGED files resolve too. Extracted to a lib because this
 * module's import runs the CLI (untestable directly).
 */

/**
 * Read .mycelium/ast-facts.json and MERGE :Function / :Class nodes and
 * :DEFINES / :IMPORTS / :CALLS edges. Co-exists with the file-level wiki
 * nodes already upserted by the main flow — sub-file nodes use a composite
 * nodeId (`<file-nodeId>#function:<name>`) so they don't collide with
 * anything else.
 *
 * The kind field on :Node disambiguates:
 *   - "file" → wiki-article nodes (existing behaviour)
 *   - "function" / "class" → AST-derived sub-file nodes
 *
 * Wiki nodes (already upserted in this session) do not have `kind` set yet;
 * we set kind="file" on every file-level node we know about from AST_FACTS
 * so the graph snapshot can distinguish them.
 */
async function processAstFacts(config) {
  const factsPath = join(config.knowledgeDir, '..', '.mycelium', 'ast-facts.json');
  if (!existsSync(factsPath)) {
    log('AST facts not found, skipping AST → graph translation');
    return;
  }
  const raw = await readFile(factsPath, 'utf-8');
  let facts;
  try {
    facts = JSON.parse(raw);
  } catch (err) {
    logError(`AST facts JSON malformed: ${err.message}`);
    return;
  }
  if (!facts || !Array.isArray(facts.files) || facts.files.length === 0) {
    return;
  }

  // Build a set of file paths we have facts for, so we can resolve imports.
  const knownFiles = new Set(facts.files.map((f) => f.path));
  // G1 — alias map + project root for on-disk candidate resolution.
  const rootDir = join(config.knowledgeDir, '..');
  const aliasMap = loadAliasMap(rootDir);

  const driver = createDriver();
  const session = driver.session();
  let funcUpserts = 0;
  let classUpserts = 0;
  let definesEdges = 0;
  let importsEdges = 0;
  let callsEdges = 0;

  try {
  for (const file of facts.files) {
    if (file.parseError) continue;
    const fileNodeId = fileToCodeNodeId(file.path);

    // Mark the parent file node as kind="file" — idempotent SET.
    // The file's :Node may not exist yet if Compiler hasn't written a wiki
    // article for it (e.g. AST_FACTS covers more files than article diff).
    // MERGE-without-SET-on-create would create incomplete nodes; we only
    // SET kind on existing ones.
    await session.run(
      `MATCH (n:Node {nodeId: $nodeId, projectId: $projectId})
       WHERE n.kind IS NULL OR n.kind = ''
       SET n.kind = 'file'`,
      { nodeId: fileNodeId, projectId: config.project }
    );

    // Functions
    for (const fn of file.functions || []) {
      const fnNodeId = subNodeId(fileNodeId, 'function', fn.name);
      await session.run(
        `MERGE (n:Node {nodeId: $nodeId})
         SET n.projectId = $projectId, n.kind = 'function',
             n.name = $name, n.fnKind = $fnKind,
             n.exported = $exported, n.params = $params,
             n.line = $line, n.endLine = $endLine,
             n.parentFile = $parentFile, n.className = $className,
             n.title = $title,
             n.type = 'code', n.status = 'active', n.phase = 'implementation'`,
        {
          nodeId: fnNodeId,
          projectId: config.project,
          name: fn.name,
          fnKind: fn.kind || 'function',
          exported: !!fn.exported,
          params: Array.isArray(fn.params) ? fn.params : [],
          line: fn.line ?? 0,
          endLine: fn.endLine ?? 0,
          parentFile: fileNodeId,
          className: fn.className ?? '',
          title: fn.className ? `${fn.className}.${fn.name}()` : `${fn.name}()`,
        }
      );
      funcUpserts++;

      // file -[:DEFINES]-> function
      await session.run(
        `MATCH (f:Node {nodeId: $fileId, projectId: $projectId})
         MATCH (fn:Node {nodeId: $fnId})
         MERGE (f)-[:DEFINES]->(fn)`,
        { fileId: fileNodeId, fnId: fnNodeId, projectId: config.project }
      );
      definesEdges++;
    }

    // Classes
    for (const cls of file.classes || []) {
      const clsNodeId = subNodeId(fileNodeId, 'class', cls.name);
      await session.run(
        `MERGE (n:Node {nodeId: $nodeId})
         SET n.projectId = $projectId, n.kind = 'class',
             n.name = $name, n.extends = $extendsName,
             n.line = $line, n.endLine = $endLine,
             n.parentFile = $parentFile,
             n.title = $title,
             n.type = 'code', n.status = 'active', n.phase = 'implementation'`,
        {
          nodeId: clsNodeId,
          projectId: config.project,
          name: cls.name,
          extendsName: cls.extends ?? '',
          line: cls.line ?? 0,
          endLine: cls.endLine ?? 0,
          parentFile: fileNodeId,
          title: `class ${cls.name}`,
        }
      );
      classUpserts++;

      await session.run(
        `MATCH (f:Node {nodeId: $fileId, projectId: $projectId})
         MATCH (c:Node {nodeId: $clsId})
         MERGE (f)-[:DEFINES]->(c)`,
        { fileId: fileNodeId, clsId: clsNodeId, projectId: config.project }
      );
      definesEdges++;
    }

    // Imports — file → file edges for relative imports we can resolve.
    for (const imp of file.imports || []) {
      const resolved = resolveImportSource(file.path, imp.source, knownFiles, { aliasMap, rootDir });
      if (!resolved) continue; // external or unresolvable — skip silently
      const targetNodeId = fileToCodeNodeId(resolved);
      // Only create the edge if both endpoints exist as :Node already.
      // If the target file doesn't have a wiki article yet we skip — Slice
      // C (brownfield bootstrap) will seed orphan files later.
      const r = await session.run(
        `MATCH (a:Node {nodeId: $fromId, projectId: $projectId})
         MATCH (b:Node {nodeId: $toId, projectId: $projectId})
         MERGE (a)-[:IMPORTS]->(b)
         RETURN 1`,
        { fromId: fileNodeId, toId: targetNodeId, projectId: config.project }
      );
      if (r.records.length > 0) importsEdges++;
    }

    // Calls — same-file resolution only for v1. Cross-file calls need
    // import-resolved callees, which requires another pass; deferred.
    const functionsInFile = new Map(
      (file.functions || []).map((fn) => [fn.name, subNodeId(fileNodeId, 'function', fn.name)])
    );
    for (const call of file.calls || []) {
      if (!call.fromFunction) continue;
      const callerId = functionsInFile.get(call.fromFunction);
      const calleeId = functionsInFile.get(call.callee);
      if (!callerId || !calleeId) continue;
      await session.run(
        `MATCH (caller:Node {nodeId: $callerId})
         MATCH (callee:Node {nodeId: $calleeId})
         MERGE (caller)-[:CALLS]->(callee)`,
        { callerId, calleeId }
      );
      callsEdges++;
    }
  }

  log(
    `AST grounding: ${funcUpserts} functions, ${classUpserts} classes, ${definesEdges} DEFINES, ${importsEdges} IMPORTS, ${callsEdges} CALLS`
  );
  } finally {
    await session.close();
    await driver.close();
  }
}

/**
 * Write a graph snapshot JSON to `knowledge/_graph/graph-snapshot.json` for the
 * project. The admin UI's Development → Graph tab fetches this from the public
 * S3 bucket (picked up by the existing S3 sync) and renders it with a force
 * graph. Embeddings are intentionally NOT included — the snapshot is for
 * visualization, not search (search lives in graph-search.mjs).
 *
 * Non-blocking: errors are logged but do not fail compile-sync.
 */
async function writeGraphSnapshot(config) {
  try {
    const driver = createDriver();
    const session = driver.session();
    try {
      const nodeResult = await session.run(
        `MATCH (n:Node {projectId: $projectId})
         RETURN n.nodeId AS id, n.type AS type, n.phase AS phase, n.status AS status,
                n.title AS title, n.summary AS summary, n.maturity AS maturity, n.tags AS tags,
                n.createdByStory AS createdByStory, n.lastMutatedByStory AS lastMutatedByStory,
                n.updated AS updated,
                coalesce(n.kind, 'file') AS kind,
                n.name AS astName, n.parentFile AS parentFile,
                n.line AS line, n.endLine AS endLine, n.exported AS exported,
                n.params AS params, n.className AS className,
                n.fnKind AS fnKind, n.extends AS extendsName`,
        { projectId: config.project }
      );
      const edgeResult = await session.run(
        `MATCH (a:Node {projectId: $projectId})-[r]->(b:Node {projectId: $projectId})
         RETURN a.nodeId AS source, b.nodeId AS target, type(r) AS type, r.weight AS weight`,
        { projectId: config.project }
      );

      const toNum = (v) =>
        v && typeof v.toNumber === 'function' ? v.toNumber() : v ?? null;

      const nodes = nodeResult.records.map((rec) => {
        const kind = rec.get('kind') ?? 'file';
        const base = {
          id: rec.get('id'),
          kind,
          type: rec.get('type'),
          phase: rec.get('phase'),
          status: rec.get('status'),
          title: rec.get('title'),
          summary: rec.get('summary'),
          maturity: toNum(rec.get('maturity')) ?? 0,
          tags: rec.get('tags') ?? [],
          createdByStory: rec.get('createdByStory') ?? null,
          lastMutatedByStory: rec.get('lastMutatedByStory') ?? null,
          updated: rec.get('updated') ?? null,
        };
        // Surface AST-specific fields only when present, so wiki-only nodes
        // don't carry empty/null clutter that bloats the snapshot.
        if (kind === 'function') {
          return {
            ...base,
            name: rec.get('astName'),
            parentFile: rec.get('parentFile'),
            line: toNum(rec.get('line')) ?? 0,
            endLine: toNum(rec.get('endLine')) ?? 0,
            exported: rec.get('exported') ?? false,
            params: rec.get('params') ?? [],
            className: rec.get('className') || null,
            fnKind: rec.get('fnKind') || 'function',
          };
        }
        if (kind === 'class') {
          return {
            ...base,
            name: rec.get('astName'),
            parentFile: rec.get('parentFile'),
            line: toNum(rec.get('line')) ?? 0,
            endLine: toNum(rec.get('endLine')) ?? 0,
            extends: rec.get('extendsName') || null,
          };
        }
        return base;
      });

      const edges = edgeResult.records.map((rec) => ({
        source: rec.get('source'),
        target: rec.get('target'),
        type: rec.get('type'),
        weight: toNum(rec.get('weight')) ?? 1.0,
      }));

      const snapshot = {
        projectId: config.project,
        generatedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes,
        edges,
      };

      const snapshotDir = join(config.knowledgeDir, '_graph');
      await mkdir(snapshotDir, { recursive: true });
      const snapshotPath = join(snapshotDir, 'graph-snapshot.json');
      const tmpPath = snapshotPath + '.tmp';
      await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      await rename(tmpPath, snapshotPath);

      log(
        `Wrote graph snapshot: ${nodes.length} nodes, ${edges.length} edges → _graph/graph-snapshot.json`
      );
    } finally {
      await session.close();
      await driver.close();
    }
  } catch (err) {
    logError(`graph-snapshot write failed (non-blocking): ${err.message}`);
  }
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
