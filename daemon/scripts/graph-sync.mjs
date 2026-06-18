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

import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDriver } from './lib/memgraph-driver.mjs';
import { embedBatch, getUsageStats, resetUsageStats } from './lib/voyage-embed.mjs';
import { backupToS3 } from './lib/s3-backup.mjs';
import { loadAliasMap, resolveImportSource } from './lib/import-resolver.mjs';
import { isEphemeralScanRoot, unionAstFiles } from './lib/ast-facts-reconcile.mjs';
import { pruneDeletedCodeNodes } from './lib/graph-prune.mjs';
import { extractWikilinks, isLivingDoc } from './lib/doc-references.mjs';
import {
  upsertExtractedFacts,
  upsertEnvReads,
  upsertCallsEndpoint,
} from './lib/system-graph-ingest.mjs';
import {
  emitContainmentBackbone,
  reportOrphans,
  reportDeadCode,
  classifyGenuineOrphans,
} from './lib/graph-integrity.mjs';
import { runAnalytics, buildInsightsDoc } from './graph-analytics.mjs';
import { readContracts, federateContracts, writeFederation } from './lib/federation.mjs';
import {
  buildCapabilityIngest,
  writeCapabilities,
  findCapabilityGaps,
} from './lib/capability.mjs';
import { computeSimilarTo } from './lib/embedding-knn.mjs';
import { diffContracts, CONTRACT_NODE_KINDS } from './contract-diff.mjs';
import { buildRevisions, appendRevisions } from './lib/contract-revision.mjs';
import {
  readRecentChanges,
  perSiblingDrift,
  buildBriefs,
  buildProposals,
  shouldPropagate,
  applyMarkerUpdate,
  markerUpdateFor,
} from './propagator.mjs';
import {
  ingestToDynamo,
  defaultDocClient,
  readDoneProposals,
  markProposalApplied,
} from './propagator-ingest.mjs';

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
    centralityThreshold: 0,
    global: false,
    federationConfig: join(__dirname, '..', 'config', 'federation.json'),
    waveGate: null,
    atCommit: null,
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
      case '--centrality-threshold':
        parsed.centralityThreshold = Number(args[++i]) || 0;
        break;
      case '--global':
        parsed.global = true;
        break;
      case '--federation-config':
        parsed.federationConfig = args[++i];
        break;
      case '--wave-gate':
        parsed.waveGate = args[++i];
        break;
      case '--at-commit':
        parsed.atCommit = args[++i];
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
  --centrality-threshold <n>  Surprising-connections centrality floor (Epic 3, default 0)
  --global                Federate the cross-project contract spine (Epic 5):
                          CONSUMES_CONTRACT + capability ingest + coverage gaps
  --federation-config <path>  Join-strategy config (default: daemon/config/federation.json)
  --wave-gate <id>        Wave-gate id stamped onto appended :ContractRevision nodes (Epic 6.2)
  --at-commit <sha>       Commit stamped onto appended revisions (default: git HEAD of the repo)
  --help                  Show this help message
`);
}

// SECTION_EDGE_MAP + extractWikilinks now live in ./lib/doc-references.mjs so
// the wikilink → edge logic (and the living-doc REFERENCES layer) is unit-tested
// independently of this script's top-level main().

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
    await processSystemGraphFacts(config);
    await processGraphIntegrity(config);
    await writeGraphSnapshot(config);
    await writeGitGraphSnapshotLocal(config);
    await processGraphAnalytics(config);
    await processContractRevisions(config);
    await processFederation(config);
    await processPropagator(config);
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
    // Living docs (architecture, components, decisions, index, system) get inline
    // [[links]] resolved to REFERENCES edges so they connect to the code they
    // describe. Plan-run docs (a plan's PRD/epics/stories) are left out — wired
    // deliberately later. See lib/doc-references.mjs.
    const wikilinks = extractWikilinks(body, {
      inlineRefs: isLivingDoc(frontmatter, article.nodeId),
    });
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

  // ── Step 8.45: System graph grounding (Pipeline v3 / Epic 1) ─────
  await processSystemGraphFacts(config);

  // ── Step 8.47: Graph integrity — orphans + dead code (Epic 2) ────
  await processGraphIntegrity(config);

  // ── Step 8.5: Graph snapshot for in-app visualization ────────────
  await writeGraphSnapshot(config);

  // ── Step 8.55: git-graph snapshot (GitGraph fallback — always fresh) ─
  await writeGitGraphSnapshotLocal(config);

  // ── Step 8.6: Architectural X-Ray analytics — insights.json (Epic 3) ─
  await processGraphAnalytics(config);

  // ── Step 8.7: Cross-project contract spine — federation (Epic 5, --global) ─
  await processFederation(config);

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
  const myceliumDir = join(config.knowledgeDir, '..', '.mycelium');
  const factsPath = join(myceliumDir, 'ast-facts.json');
  const fullFactsPath = join(myceliumDir, 'ast-facts.full.json');
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

  // F14 refuse-to-narrow: reconcile partial worktree scans against the last
  // preserved full-project scan so the known file set can only grow.
  // F15 gate: only an authoritative (non-ephemeral) full-project scan is
  // trustworthy enough to PRUNE deleted-source nodes. A partial worktree scan
  // (even after the F14 union) must never drive deletions.
  const isAuthoritativeFullScan = !isEphemeralScanRoot(facts.root);
  if (isEphemeralScanRoot(facts.root) && existsSync(fullFactsPath)) {
    try {
      const fullDoc = JSON.parse(await readFile(fullFactsPath, 'utf-8'));
      if (fullDoc && Array.isArray(fullDoc.files)) {
        const merged = unionAstFiles(facts, fullDoc);
        const grew = merged.length - fullDoc.files.length;
        log(
          `AST facts: partial worktree scan (root=${facts.root}) — refusing to narrow; ` +
            `unioned ${facts.files.length} scanned + ${fullDoc.files.length} preserved → ${merged.length} files (+${grew} new)`,
        );
        facts = { ...facts, files: merged };
      }
    } catch (err) {
      logError(`AST facts full-scan union failed (using partial as-is): ${err.message}`);
    }
  } else if (!isEphemeralScanRoot(facts.root)) {
    // Authoritative full-project scan — preserve it as the union baseline for
    // any later partial worktree scans. Best-effort; never blocks grounding.
    try {
      await writeFile(fullFactsPath, JSON.stringify(facts), 'utf-8');
    } catch (err) {
      logError(`AST facts full-scan snapshot failed (non-blocking): ${err.message}`);
    }
  }

  // Build a set of file paths we have facts for, so we can resolve imports.
  const knownFiles = new Set(facts.files.map((f) => f.path));
  // G1 — alias map + project root for on-disk candidate resolution.
  const rootDir = join(config.knowledgeDir, '..');
  const aliasMap = loadAliasMap(rootDir);

  const driver = createDriver();
  const session = driver.session();
  const today = new Date().toISOString().split('T')[0];
  let funcUpserts = 0;
  let classUpserts = 0;
  let definesEdges = 0;
  let importsEdges = 0;
  let callsEdges = 0;
  const backboneFiles = [];

  try {
  for (const file of facts.files) {
    if (file.parseError) continue;
    const fileNodeId = fileToCodeNodeId(file.path);
    backboneFiles.push(file.path);

    // Ensure the parent file node EXISTS (kind="file"). It may not yet if the
    // Compiler hasn't written a wiki article for it — AST_FACTS covers more
    // files than the article diff (test files, .feature.tsx, bare components).
    // Previously we only SET kind on an existing node, which left every
    // function in an article-less file with NO file→function DEFINES edge —
    // i.e. orphaned. MERGE the file node so DEFINES always links; the Compiler
    // enriches title/summary later. Matches the function-node MERGE pattern.
    //
    // projectId is OVERWRITTEN (not coalesced) to the canonical slug: early
    // ingestion sometimes stamped a job/plan UUID as projectId, stranding the
    // file node in a phantom partition so the DEFINES MATCH (which filters on
    // projectId) silently missed and the function stayed orphaned forever.
    // code/* nodeIds are project-unique (no cross-project collisions), and we
    // are iterating THIS project's own scanned files, so normalizing to
    // $projectId here is safe and self-heals stale UUID stamps on every sync.
    await session.run(
      `MERGE (n:Node {nodeId: $nodeId})
       ON CREATE SET n.projectId = $projectId, n.kind = 'file', n.type = 'code',
                     n.status = 'active', n.phase = 'implementation', n.title = $title
       ON MATCH SET n.kind = CASE WHEN n.kind IS NULL OR n.kind = '' THEN 'file' ELSE n.kind END,
                    n.projectId = $projectId`,
      { nodeId: fileNodeId, projectId: config.project, title: file.path }
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

  // ── Story 2.1: containment backbone (dir ─CONTAINS→ file) ──────────────
  // Emitted unconditionally so no file node is ever degree-0 for purely
  // structural reasons — and so the dead-code detector (2.3) can use a
  // different query than the orphan invariant (2.2).
  const { dirNodes, containsEdges } = await emitContainmentBackbone(
    session,
    config.project,
    backboneFiles,
    today,
  );
  log(`Containment backbone: ${dirNodes} dir nodes, ${containsEdges} CONTAINS edges`);

  // ── F15: delete-aware prune (gated to the authoritative full-project scan) ─
  // Additive ingest leaves zombie code nodes for files deleted on disk. Only an
  // authoritative full scan (NOT a partial worktree scan) has a trustworthy
  // complete file set, so the prune is gated on isAuthoritativeFullScan. We
  // prune by absence-from-scan (never by edge count), so legitimately edgeless
  // nodes that still exist on disk (e.g. test files) are preserved.
  if (isAuthoritativeFullScan) {
    const { prunedFiles, prunedSubNodes, prunedIds } = await pruneDeletedCodeNodes(
      session,
      config.project,
      backboneFiles,
      today,
    );
    if (prunedFiles > 0 || prunedSubNodes > 0) {
      log(
        `AST prune (deleted source): ${prunedFiles} file node(s), ${prunedSubNodes} sub-node(s) marked pruned`,
      );
      for (const id of prunedIds.slice(0, 20)) log(`  PRUNED: ${id}`);
    }
  } else {
    log('AST prune skipped — partial worktree scan is not authoritative for deletions');
  }
  } finally {
    await session.close();
    await driver.close();
  }
}

// ── Pipeline v3: System graph (infra / route / service) ingest ─────────────

/**
 * System-graph extractor envelopes are written to `<root>/.mycelium/` by the
 * wave-gate slot (see bootstrap-ast.mjs / the extractor scripts), one JSON file
 * per extractor. This reads whichever are present and feeds each through the
 * single ingest entrypoint `upsertExtractedFacts`. Co-exists with the AST
 * grounding above — same `:Node {nodeId}` model, additive `MERGE`, no schema
 * change. Non-blocking: a missing/malformed envelope is logged and skipped.
 *
 * Story SG-1.1 (ingest); SG-1.2/1.4/1.5 produce the envelopes; SG-1.6 adds the
 * env-join + CALLS_ENDPOINT passes.
 */
async function processSystemGraphFacts(config) {
  const myceliumDir = join(config.knowledgeDir, '..', '.mycelium');
  const readJson = async (file) => {
    const p = join(myceliumDir, file);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(await readFile(p, 'utf-8'));
    } catch (err) {
      logError(`system-graph ${file} malformed: ${err.message}`);
      return null;
    }
  };

  const infraDoc = await readJson('infra-facts.json');
  const routeDoc = await readJson('route-facts.json');
  const serviceDoc = await readJson('service-facts.json');
  const astDoc = await readJson('ast-facts.json');
  const apiCallsDoc = await readJson('api-calls.json');
  // Cross-file CALLS edges from the ts-morph semantic pass (edges-only).
  const semanticDoc = await readJson('semantic-facts.json');

  const factDocs = [
    ['infra', infraDoc],
    ['route', routeDoc],
    ['service', serviceDoc],
    ['semantic', semanticDoc],
  ].filter(([, d]) => d);

  if (factDocs.length === 0) {
    log('No system-graph extractor facts found, skipping system-graph grounding');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const driver = createDriver();
  const session = driver.session();
  let totalNodes = 0;
  let totalEdges = 0;

  try {
    // 1) Ingest infra / route / service nodes + edges (idempotent).
    for (const [name, doc] of factDocs) {
      const { nodeUpserts, edgeUpserts, skippedEdges } = await upsertExtractedFacts(
        session,
        config.project,
        doc,
        today,
      );
      totalNodes += nodeUpserts;
      totalEdges += edgeUpserts;
      if (skippedEdges.length > 0) {
        log(`system-graph ${name}: ${skippedEdges.length} edges/nodes skipped (unresolved or not allowlisted)`);
      }
    }
    log(`System graph grounding: ${totalNodes} nodes, ${totalEdges} edges from ${factDocs.length} extractor(s)`);

    // 2) Env-join — File ─READS→ Table/Secret (W4 accessor-aware, W7 Resource.*).
    if (infraDoc && astDoc?.envRefsByFile) {
      const { directReads, transitiveReads } = await upsertEnvReads(
        session,
        config.project,
        infraDoc,
        astDoc.envRefsByFile,
        today,
      );
      log(`System graph env-join: ${directReads} direct + ${transitiveReads} transitive READS`);
    }

    // 3) CALLS_ENDPOINT — component → endpoint (W1), api-client paths under /api.
    if (routeDoc?.nodes && apiCallsDoc?.calls) {
      const endpoints = routeDoc.nodes.filter((n) => n.kind === 'endpoint');
      const { edgeUpserts } = await upsertCallsEndpoint(
        session,
        config.project,
        apiCallsDoc.calls,
        endpoints,
        today,
        { basePath: '/api' },
      );
      log(`System graph CALLS_ENDPOINT: ${edgeUpserts} edges`);
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

// ── Epic 2: "No Alone Dots" — graph integrity (orphans + dead code) ────────

/**
 * Run the two distinct post-sync integrity queries (PRD §4.2) and write their
 * reports to `knowledge/_graph/`:
 *
 *   - orphans.json   — the extractor-bug tripwire (Story 2.2). Degree-0 nodes
 *                      grouped by kind. A non-`file` orphan means an extractor
 *                      dropped an edge; it is a HARD FAILURE that blocks the
 *                      wave gate (graph-sync exits non-zero).
 *   - dead-code.json — genuine dead code (Story 2.3). Files whose only edge is
 *                      CONTAINS. A non-blocking, advisory finding.
 *
 * These are deliberately different queries (W2): a dead file carries its
 * CONTAINS edge so it appears in dead-code.json and NOT in orphans.json.
 *
 * Non-blocking on infrastructure errors (missing Memgraph, etc.) — those are
 * logged and skipped. The ONLY thing that fails the step is a real non-`file`
 * orphan, which is a genuine extractor regression.
 */
/**
 * F16: read the genuine-orphan count from the previously-written orphans.json so
 * the next run can report a delta. Best-effort — a missing/old/corrupt report
 * (first run, pre-F16 format) yields `null` ("no prior baseline").
 */
async function readPreviousGenuineOrphans(graphDir) {
  try {
    const raw = await readFile(join(graphDir, 'orphans.json'), 'utf-8');
    const prev = JSON.parse(raw);
    return typeof prev.genuineOrphanCount === 'number' ? prev.genuineOrphanCount : null;
  } catch {
    return null;
  }
}

async function processGraphIntegrity(config) {
  const graphDir = join(config.knowledgeDir, '_graph');
  const writeReport = async (name, doc) => {
    await mkdir(graphDir, { recursive: true });
    const p = join(graphDir, name);
    const tmp = p + '.tmp';
    await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8');
    await rename(tmp, p);
  };

  let driver;
  try {
    driver = createDriver();
    const session = driver.session();
    try {
      const generatedAt = new Date().toISOString();

      // ── Story 2.2: orphan invariant ──────────────────────────────────
      const { orphans } = await reportOrphans(session, config.project);

      // F16: the genuine-orphan signal — orphans MINUS legitimate floaters
      // (new/test/zombie files + decision docs awaiting linking). Read the prior
      // genuine count so a single NEW genuine orphan is visible as a +delta even
      // when a noisy floater backlog exists.
      const previousGenuine = await readPreviousGenuineOrphans(graphDir);
      const attentionThreshold = Number(process.env.GRAPH_ORPHAN_ATTENTION_THRESHOLD ?? 1);
      const {
        byKind,
        genuine: hardFail,
        legitimate,
        genuineOrphanCount,
        legitimateFloaterCount,
        delta,
        needsAttention,
      } = classifyGenuineOrphans(orphans, { previousGenuine, attentionThreshold });
      const blocked = genuineOrphanCount > 0;
      await writeReport('orphans.json', {
        projectId: config.project,
        generatedAt,
        status: blocked ? 'fail' : 'pass',
        orphanCount: orphans.length,
        // F16: genuine vs legitimate split, surfaced for the wave gate.
        genuineOrphanCount,
        legitimateFloaterCount,
        previousGenuineOrphanCount: previousGenuine,
        genuineOrphanDelta: delta,
        attentionThreshold,
        needsAttention,
        hardFailCount: hardFail.length,
        byKind,
        orphans,
        legitimateFloaters: legitimate,
        hardFail,
      });

      // F16: a compact wave-gate field the pipeline can consume without parsing
      // the full orphan list. The compile-sync step / wave gate reads this.
      await writeReport('orphan-signal.json', {
        projectId: config.project,
        generatedAt,
        genuineOrphanCount,
        legitimateFloaterCount,
        previousGenuineOrphanCount: previousGenuine,
        delta,
        attentionThreshold,
        needsAttention,
        status: blocked ? 'fail' : 'pass',
      });

      // ── Story 2.3: dead-code detector ────────────────────────────────
      const deadCode = await reportDeadCode(session, config.project);
      await writeReport('dead-code.json', {
        projectId: config.project,
        generatedAt,
        count: deadCode.length,
        candidates: deadCode,
      });

      const deltaStr =
        delta == null ? 'no prior baseline' : `${delta >= 0 ? '+' : ''}${delta} vs prior`;
      if (blocked) {
        // Wave-gate gating hook: a non-`file` orphan is an extractor bug, not a
        // finding. Surface it loudly and fail the step (the compile-sync shell
        // step maps a non-zero exit → pipeline failure → blocked wave gate).
        const summary = hardFail
          .map((o) => `${o.kind}:${o.id}`)
          .slice(0, 20)
          .join(', ');
        logError(
          `Orphan invariant FAILED — ${genuineOrphanCount} genuine orphan(s) (${deltaStr}; ` +
            `${legitimateFloaterCount} legitimate floater(s) excluded; extractor dropped an edge): ${summary}`,
        );
        // F16: above-threshold genuine orphans warrant an operator attention
        // signal, distinct from the generic non-zero exit, so the wave gate /
        // operator dashboard can route it.
        if (needsAttention) {
          logError(
            `[operator-attention] graph knowledge-compile: ${genuineOrphanCount} genuine orphan(s) ` +
              `≥ threshold ${attentionThreshold} (${deltaStr}) — see _graph/orphan-signal.json`,
          );
        }
        process.exitCode = 3;
      } else {
        log(
          `Graph integrity OK: ${genuineOrphanCount} genuine orphan(s), ` +
            `${legitimateFloaterCount} legitimate floater(s), ${deadCode.length} dead-code candidate(s)`,
        );
      }
    } finally {
      await session.close();
      await driver.close();
    }
  } catch (err) {
    // Infrastructure failure (no Memgraph, etc.) — non-blocking, like the
    // snapshot/backup steps. A real extractor bug surfaces via the orphan query
    // above, not here.
    logError(`graph-integrity check failed (non-blocking): ${err.message}`);
    if (driver) {
      try {
        await driver.close();
      } catch {
        /* already closed */
      }
    }
  }
}

// ── Epic 3: Architectural X-Ray — centrality, communities, surprising links ─

/**
 * Run the MAGE analytics pass (PRD §5.4 / Appendix D) and write
 * `knowledge/_graph/insights.json` for the Graph tab:
 *
 *   - Story 3.1: god-nodes via betweenness centrality (`n.centrality`)
 *   - Story 3.2: communities via Louvain (`n.community`)
 *   - Story 3.3: surprising connections (cross-community high-centrality edges)
 *
 * A DISTINCT, post-sync read+annotate pass — it never touches the ingest
 * write-path. Fully non-blocking: a missing MAGE install (or no Memgraph at all)
 * degrades to a well-formed insights.json with the dimension's `*Available` flag
 * false, and never fails the sync.
 */
async function processGraphAnalytics(config) {
  const graphDir = join(config.knowledgeDir, '_graph');
  const threshold = config.centralityThreshold ?? 0;

  let driver;
  try {
    driver = createDriver();
    const session = driver.session();
    try {
      const generatedAt = new Date().toISOString();
      const analytics = await runAnalytics(session, config.project, { threshold, logger: log });
      const doc = buildInsightsDoc({ projectId: config.project, generatedAt, analytics, threshold });

      await mkdir(graphDir, { recursive: true });
      const p = join(graphDir, 'insights.json');
      const tmp = p + '.tmp';
      await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8');
      await rename(tmp, p);

      if (analytics.mageAvailable) {
        log(
          `Graph analytics: ${analytics.godNodes.length} god-node(s), ` +
            `${analytics.communities.length} communit${analytics.communities.length === 1 ? 'y' : 'ies'}, ` +
            `${analytics.surprising.length} surprising connection(s)`,
        );
      } else {
        log('Graph analytics: MAGE unavailable — wrote empty insights.json (overlay disabled in UI)');
      }
    } finally {
      await session.close();
      await driver.close();
    }
  } catch (err) {
    logError(`graph-analytics pass failed (non-blocking): ${err.message}`);
    if (driver) {
      try {
        await driver.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/** Best-effort current commit of the project repo (for revision provenance). */
function headCommit(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

/** Read this project's contract-bearing nodes with their shape props. */
async function readProjectContracts(session, projectId) {
  const r = await session.run(
    `MATCH (n:Node {projectId: $projectId}) WHERE n.kind IN $kinds
     RETURN n.nodeId AS nodeId, n.kind AS kind, n.name AS name,
            coalesce(n.title, n.label, n.nodeId) AS label,
            n.fields AS fields, n.primaryIndex AS primaryIndex,
            n.method AS method, n.path AS path, n.host AS host`,
    { projectId, kinds: CONTRACT_NODE_KINDS },
  );
  return r.records.map((rec) => ({
    nodeId: rec.get('nodeId'),
    kind: rec.get('kind'),
    name: rec.get('name') ?? null,
    label: rec.get('label'),
    fields: rec.get('fields') ?? null,
    primaryIndex: rec.get('primaryIndex') ?? null,
    method: rec.get('method') ?? null,
    path: rec.get('path') ?? null,
    host: rec.get('host') ?? null,
  }));
}

/**
 * Epic 6 — Story 6.2 (W6). The :ContractRevision append-log. A DISTINCT,
 * post-sync per-project pass: diff this sync's contract shapes against the
 * previous snapshot (`knowledge/_graph/contract-snapshot.json`), append one
 * `:ContractRevision` per shape change linked `(:Node)-[:REVISED]->(rev)`, and
 * persist the new snapshot as the next "before". The snapshot file IS the
 * temporal source the stateless graph lacks.
 *
 * First run (no prior snapshot) only records the baseline — it never floods the
 * log with "everything is new". Fully non-blocking; never mutates contract-node
 * `status` (forbidden area).
 */
async function processContractRevisions(config) {
  const graphDir = join(config.knowledgeDir, '_graph');
  const snapPath = join(graphDir, 'contract-snapshot.json');

  let driver;
  try {
    driver = createDriver();
    const session = driver.session();
    try {
      const after = await readProjectContracts(session, config.project);

      // Load the previous snapshot ("before"); first run → baseline only.
      let before = null;
      try {
        before = JSON.parse(await readFile(snapPath, 'utf-8')).contracts ?? [];
      } catch {
        before = null;
      }

      await mkdir(graphDir, { recursive: true });
      const snapDoc = { projectId: config.project, generatedAt: new Date().toISOString(), contracts: after };
      const stmp = snapPath + '.tmp';
      await writeFile(stmp, JSON.stringify(snapDoc, null, 2), 'utf-8');
      await rename(stmp, snapPath);

      if (before === null) {
        log(`Contract revisions: baseline recorded (${after.length} contract node(s)); no revisions on first run`);
        return;
      }

      const diff = diffContracts(before, after);
      if (diff.changes.length === 0) {
        log('Contract revisions: no contract-shape changes this wave');
        return;
      }

      const atCommit =
        config.atCommit ?? (await headCommit(join(config.knowledgeDir, '..')));
      const ts = new Date().toISOString();
      const revisions = buildRevisions(diff, { atCommit, atWave: config.waveGate ?? null, ts }).map(
        (rev) => ({ ...rev, projectId: config.project }),
      );
      const appended = await appendRevisions(session, revisions);
      log(
        `Contract revisions: appended ${appended.revisions} (${diff.added} new, ` +
          `${diff.removed} removed, ${diff.modified} modified)` +
          (config.waveGate ? ` at ${config.waveGate}` : ''),
      );
    } finally {
      await session.close();
      await driver.close();
    }
  } catch (err) {
    logError(`contract-revision pass failed (non-blocking): ${err.message}`);
    if (driver) {
      try {
        await driver.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Epic 5 — Cross-project contract spine (`--global` only). A DISTINCT,
 * post-sync federation pass over the SHARED federated graph; the single-project
 * write-path above is untouched (forbidden area). Three additive steps:
 *
 *   5.1  CONSUMES_CONTRACT — join each sibling `service` subgraph to shared
 *        contract nodes (resource-identity or schema-shape, per config).
 *   5.2  Capability ingest — MERGE the curated `capabilities.json` seed into
 *        `capability` nodes + IMPLEMENTS edges (DECLARED provenance).
 *   5.3  Capability coverage gaps — flag components touching a shared contract
 *        with no capability tag → `knowledge/_graph/capability-gaps.json` (W8).
 *
 * Fully non-blocking: any infra/Memgraph error is logged and skipped.
 */
async function processFederation(config) {
  if (!config.global) return;
  const graphDir = join(config.knowledgeDir, '_graph');

  // Load the join strategy (5.4) — default resource-identity on any read error.
  let strategy = 'resource-identity';
  try {
    const cfg = JSON.parse(await readFile(config.federationConfig, 'utf-8'));
    if (cfg.strategy) strategy = cfg.strategy;
  } catch (err) {
    log(`Federation: using default strategy 'resource-identity' (${err.message})`);
  }

  let driver;
  try {
    driver = createDriver();
    const session = driver.session();
    try {
      // 5.1 — federate contract spine
      const projects = await readContracts(session);
      const result = federateContracts(projects, { strategy });
      const fed = await writeFederation(session, result);
      log(
        `Federation [${strategy}]: ${fed.contractNodes} shared contract node(s), ` +
          `${fed.consumes} CONSUMES_CONTRACT edge(s) across ${projects.length} project(s)` +
          (result.unjoinable.length ? `; ${result.unjoinable.length} unjoinable` : ''),
      );

      // 5.2 — capability ingest (curated seed)
      try {
        const seedRaw = await readFile(join(graphDir, 'capabilities.json'), 'utf-8');
        const seed = JSON.parse(seedRaw).capabilities ?? [];
        const cap = await writeCapabilities(session, buildCapabilityIngest(seed));
        log(`Capabilities: ${cap.capabilityNodes} node(s), ${cap.implementsEdges} IMPLEMENTS edge(s)`);
      } catch (err) {
        log(`Capabilities: no seed ingested (${err.message})`);
      }

      // 5.3 — capability coverage gaps (W8)
      const gaps = await findCapabilityGaps(session, config.project);
      await mkdir(graphDir, { recursive: true });
      const gapsDoc = {
        projectId: config.project,
        generatedAt: new Date().toISOString(),
        gapCount: gaps.length,
        gaps,
      };
      const gp = join(graphDir, 'capability-gaps.json');
      const gtmp = gp + '.tmp';
      await writeFile(gtmp, JSON.stringify(gapsDoc, null, 2), 'utf-8');
      await rename(gtmp, gp);
      log(`Capability coverage gaps: ${gaps.length} untagged contract-touching component(s)`);
    } finally {
      await session.close();
      await driver.close();
    }
  } catch (err) {
    logError(`federation pass failed (non-blocking): ${err.message}`);
    if (driver) {
      try {
        await driver.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Epic 6 — Story 6.5. The PROPAGATOR pass (`--global` only). Turns this wave's
 * contract drift into CONSENT-GATED, substrate-targeted port-briefs and writes
 * them to `knowledge/_graph/propagator-proposals.json`. An ingest step files
 * them into the proposals queue (DynamoDB) where a human approves/rejects —
 * NOTHING here is auto-applied (forbidden area: any auto-merge path).
 *
 * Trigger: wave-gate (default, when `--wave-gate` is set) or drift-threshold.
 * Fully non-blocking; needs ≥2 federated subgraphs + capability seed to emit.
 */
async function processPropagator(config) {
  if (!config.global) return;
  const graphDir = join(config.knowledgeDir, '_graph');

  let driver;
  try {
    driver = createDriver();
    const session = driver.session();
    try {
      // Seam C — advance `lastPropagatedTo` for sibling stories that reached Done
      // (runs every wave, independent of any new drift, so a completed port
      // always stops re-briefing). Best-effort.
      const proposalsTable = process.env.PROPAGATOR_PROPOSALS_TABLE;
      if (proposalsTable) {
        try {
          const docClient = await defaultDocClient();
          const done = await readDoneProposals({ tableName: proposalsTable, docClient });
          for (const prop of done) {
            await applyMarkerUpdate(session, markerUpdateFor(prop));
            await markProposalApplied(prop.proposalId, {
              tableName: proposalsTable,
              docClient,
              ts: new Date().toISOString(),
            });
          }
          if (done.length) {
            log(`PROPAGATOR markers: advanced lastPropagatedTo for ${done.length} completed port-stor${done.length === 1 ? 'y' : 'ies'}`);
          }
        } catch (err) {
          logError(`propagator marker pass failed (non-blocking): ${err.message}`);
        }
      }

      const changes = await readRecentChanges(session);
      const report = await perSiblingDrift(session, { sourceProject: config.project, changes });
      const driftCounts = Object.fromEntries(report.map((r) => [r.sibling, r.pendingCount]));
      const trigger = config.waveGate ? 'wave-gate' : 'drift-threshold';

      if (!shouldPropagate({ trigger, driftCounts, threshold: 1 })) {
        log('PROPAGATOR: no trigger (no sibling drift past threshold)');
        return;
      }

      // Capability seed → substrate-targeted briefs.
      let capabilities = [];
      try {
        capabilities = JSON.parse(await readFile(join(graphDir, 'capabilities.json'), 'utf-8')).capabilities ?? [];
      } catch {
        capabilities = [];
      }

      const reportWithTrigger = report.map((r) => ({ ...r, changes: r.changes }));
      const briefs = buildBriefs(reportWithTrigger, {
        sourceProject: config.project,
        trigger,
        capabilities,
      }).map((b) => ({ ...b, trigger }));

      const ts = new Date().toISOString();
      const proposals = buildProposals(briefs, {
        sourceProject: config.project,
        atCommit: config.atCommit ?? null,
        ts,
      });

      await mkdir(graphDir, { recursive: true });
      const doc = { sourceProject: config.project, generatedAt: ts, trigger, proposalCount: proposals.length, proposals };
      const p = join(graphDir, 'propagator-proposals.json');
      const tmp = p + '.tmp';
      await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8');
      await rename(tmp, p);
      log(`PROPAGATOR [${trigger}]: ${proposals.length} consent-gated proposal(s) drafted (none auto-applied)`);

      // Seam A — file the proposals into the consent queue (DynamoDB) so the API
      // + UI surface them. Idempotent; best-effort (a missing table env or AWS
      // error is logged and skipped — the artifact above is still authoritative).
      const tableName = process.env.PROPAGATOR_PROPOSALS_TABLE;
      if (proposals.length > 0 && tableName) {
        try {
          const docClient = await defaultDocClient();
          const res = await ingestToDynamo(doc, { tableName, docClient });
          log(`PROPAGATOR ingest: ${res.filed} filed, ${res.skipped} already-decided (skipped)`);
        } catch (err) {
          logError(`propagator ingest failed (non-blocking): ${err.message}`);
        }
      }
    } finally {
      await session.close();
      await driver.close();
    }
  } catch (err) {
    logError(`propagator pass failed (non-blocking): ${err.message}`);
    if (driver) {
      try {
        await driver.close();
      } catch {
        /* already closed */
      }
    }
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
                n.fnKind AS fnKind, n.extends AS extendsName,
                n.embedding AS embedding`,
        { projectId: config.project }
      );

      // Semantic neighbours from the Voyage embeddings (raw vectors stay out of
      // the snapshot). Bounded cost; empty for large graphs / no-embedding nodes.
      const similarTo = computeSimilarTo(
        nodeResult.records.map((rec) => ({ id: rec.get('id'), embedding: rec.get('embedding') })),
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
          similarTo: similarTo.get(rec.get('id')) ?? [],
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
 * Concept v2 (2026-06-17) — write the bare-repo git-graph snapshot into the
 * LOCAL `knowledge/_graph/git-graph.json` so the existing S3 backup carries it
 * to `knowledge-live/<appId>/_graph/git-graph.json` on EVERY graph-sync. The
 * Labs GitGraph tab falls back to this when the GitHub API is unavailable (e.g.
 * a PAT that lost repo permissions — brick1 2026-06-16). Previously the snapshot
 * was written DIRECTLY to S3 only after a wave-merge, so a missed/failed
 * wave-merge hook left no fallback at all. Folding it into graph-sync (which
 * reliably runs + backs up) guarantees the fallback is always fresh. Non-blocking.
 */
async function writeGitGraphSnapshotLocal(config) {
  try {
    const { execFile } = await import('node:child_process');
    const [{ buildGitGraphSnapshot }, { bareRepoPath }] = await Promise.all([
      import('../lib/git-graph-snapshot.mjs'),
      import('../lib/story-worktree.mjs'),
    ]);
    const git = (args, cwd) =>
      new Promise((res) => {
        execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (e, o, s) =>
          res({ code: e ? e.code || 1 : 0, stdout: o || '', stderr: s || '' }),
        );
      });
    const bare = bareRepoPath(config.project);
    const snapshot = await buildGitGraphSnapshot({
      appId: config.project,
      bare,
      git,
      bareOpCwd: config.knowledgeDir,
    });
    if (!snapshot) {
      log('git-graph snapshot skipped (no bare repo or empty git log)');
      return;
    }
    snapshot.generatedAt = new Date().toISOString();
    const snapshotDir = join(config.knowledgeDir, '_graph');
    await mkdir(snapshotDir, { recursive: true });
    const p = join(snapshotDir, 'git-graph.json');
    const tmp = p + '.tmp';
    await writeFile(tmp, JSON.stringify(snapshot), 'utf-8');
    await rename(tmp, p);
    log(
      `Wrote git-graph snapshot: ${snapshot.commits.length} commits, ${snapshot.branches.length} branches → _graph/git-graph.json`,
    );
  } catch (err) {
    logError(`git-graph snapshot write failed (non-blocking): ${err.message}`);
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
