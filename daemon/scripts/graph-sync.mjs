/**
 * Graph Sync Script — Embed + GraphStore Upsert
 * Story MY-1.5 + MY-1.6 (S3 backup integration) · S1.1 (EU migration: GraphStore)
 *
 * Reads wiki articles from knowledge/ dir, parses frontmatter,
 * diffs against compile-state.json hashes, embeds changed articles
 * via Voyage AI, upserts nodes/edges into the DynamoDB-backed GraphStore
 * (bolt/Memgraph EXCISED — see lib/graph-store.mjs), creates edges from
 * [[wikilinks]], and backs up to S3.
 *
 * Usage:
 *   node graph-sync.mjs --project spyhunter --knowledge-dir /path/to/knowledge
 *   node graph-sync.mjs --project spyhunter --knowledge-dir /path/to/knowledge --full-resync
 *   node graph-sync.mjs --project spyhunter --knowledge-dir /path/to/knowledge --skip-backup
 *
 * Environment:
 *   GRAPH_NODES_TABLE  — DynamoDB nodes table; when unset the store falls back
 *                        to an in-memory impl (tests / hosts without graph env)
 *   GRAPH_EDGES_TABLE  — DynamoDB edges table (paired with GRAPH_NODES_TABLE)
 *   AWS_REGION         — DynamoDB region (default: eu-central-1)
 *   VOYAGE_API_KEY     — Required for embedding
 */

import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Legacy Memgraph driver — S1.4 converted the integrity / prune / analytics /
// contract-revision / federation(5.1) passes onto the GraphStore below (their
// lib functions now take a `store`, not a `session`). RETAINED as a narrow
// seam for the two passes that still route through lib files OUTSIDE S1.4's
// file scope: capability ingest/gaps (5.2/5.3, `lib/capability.mjs`) inside
// processFederation, and the whole PROPAGATOR pass (`propagator.mjs`, a
// DIFFERENT file from this story's `lib/impact-propagation.mjs`). A follow-on
// story converts those two and this import goes away.
import { createDriver } from './lib/memgraph-driver.mjs';
import { createGraphStore } from './lib/graph-store.mjs';
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
import { extractSubsystems } from './extractors/subsystem-extract.mjs';
import { extractConceptDocs } from './extractors/doc-extract.mjs';
import { upsertExtractedFacts as upsertDocFacts } from './lib/system-graph-ingest.mjs';
import { touchPointToNodeId } from './ground-truth-injection.mjs';
import { globsIntersect } from '../pipelines/lib/glob-intersect.mjs';
import { runAnalytics, buildInsightsDoc } from './graph-analytics.mjs';
import { readContracts, federateContracts, writeFederation } from './lib/federation.mjs';
import {
  buildCapabilityIngest,
  writeCapabilities,
  findCapabilityGaps,
} from './lib/capability.mjs';
import {
  computeSimilarTo,
  readEmbeddingsSidecar,
  writeEmbeddingsSidecar,
  mergeEmbeddings,
} from './lib/embedding-knn.mjs';
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
    docScan: false,
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
      case '--doc-scan':
        parsed.docScan = true;
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
  --doc-scan              Run ONLY the Agentic Document Center pass (subsystem
                          shards + god docs + GOVERNS/PROPOSES), skipping the
                          full article embed/upsert. Fired on artifact apply/gate.
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

const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * F19 — normalize an extension-less `code/` article nodeId to the canonical
 * code-file nodeId (WITH the real source extension), so an article the compiler
 * named `<path>.md` (instead of `<path>.tsx.md`) unifies with its AST file node
 * instead of forking a separate null-kind duplicate. Deterministic: only
 * rewrites when a sibling source file actually exists on disk.
 *   code/src--game--types   →  code/src--game--types.ts   (if src/game/types.ts exists)
 */
function normalizeCodeNodeId(nodeId, rootDir) {
  if (!nodeId.startsWith('code/')) return nodeId;
  if (CODE_EXTS.some((e) => nodeId.endsWith(e))) return nodeId; // already canonical
  const relPath = nodeId.slice('code/'.length).replace(/--/g, '/');
  for (const ext of CODE_EXTS) {
    if (existsSync(join(rootDir, relPath + ext))) return nodeId + ext;
  }
  return nodeId;
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

  // GraphStore: the DynamoDB-backed store when GRAPH_NODES_TABLE/GRAPH_EDGES_TABLE
  // resolve, else an in-memory store. ONE instance is threaded through every
  // write pass so the in-memory impl (per-instance state) observes a coherent
  // graph across passes; the Dynamo impl shares the same tables regardless.
  const store = await createGraphStore();

  // ── --doc-scan: run ONLY the Agentic Document Center pass ─────────────
  // The apply-artifact endpoint + the readiness gate enqueue a fast
  // `graph-sync --doc-scan` (Story 6.5 pattern) so approved specs reflect into
  // the graph without a full article re-embed. Idempotent upsert makes replay free.
  if (config.docScan) {
    log(`Document-center scan for project: ${config.project}`);
    await processDocumentFacts(config, store);
    return;
  }

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

  const articleRootDir = join(config.knowledgeDir, '..');
  for (const articlePath of articlePaths) {
    const nodeId = normalizeCodeNodeId(
      deriveNodeId(articlePath, config.knowledgeDir),
      articleRootDir,
    );
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
    await processAstFacts(config, store);
    await processSystemGraphFacts(config, store);
    await processTestCoverFacts(config, store); // W3.3 — dark unless P3_TEST_COVER_EDGES=on
    await processDocumentFacts(config, store);
    await processGraphIntegrity(config, store);
    await writeGraphSnapshot(config, store);
    await writeGitGraphSnapshotLocal(config);
    await processGraphAnalytics(config, store);
    await processContractRevisions(config, store);
    await processFederation(config, store);
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

  // ── S1.5: persist embedding vectors to the per-project sidecar ────
  // Step 5 still computes Voyage vectors, but they are NOT stored on graph nodes
  // (the store node shape carries no vector) nor in the browser-served
  // `graph-snapshot.json`. They land in a PRIVATE per-project sidecar
  // (`knowledge/_graph/embeddings.json`, `{nodeId: number[1024]}`) which rides the
  // existing S3 backup to `knowledge-live/<projectId>/_graph/` — never shipped to
  // the Graph tab. `graph-search.mjs` reads it for query-time KNN. Only re-embedded
  // (NEW/CHANGED) articles are updated this run, so we MERGE onto the existing
  // sidecar and drop deleted nodes — an overwrite would wipe every unchanged
  // node's vector. Non-blocking: a sidecar failure never fails the sync.
  const embeddedCount = embeddings.filter(Boolean).length;
  try {
    const updates = {};
    for (let i = 0; i < parsedArticles.length; i++) {
      const vec = embeddings[i];
      if (Array.isArray(vec) && vec.length > 0) {
        updates[parsedArticles[i].nodeId] = vec;
      }
    }
    if (Object.keys(updates).length > 0 || deletedNodeIds.length > 0) {
      const existing = await readEmbeddingsSidecar(config.knowledgeDir);
      const merged = mergeEmbeddings(existing, updates, deletedNodeIds);
      await writeEmbeddingsSidecar(config.knowledgeDir, merged);
      log(
        `Embeddings sidecar: +${Object.keys(updates).length} vector(s), ` +
          `-${deletedNodeIds.length} deleted → _graph/embeddings.json ` +
          `(${Object.keys(merged).length} total)`,
      );
    } else if (embeddedCount > 0) {
      log(`Embeddings ready for ${embeddedCount}/${embeddings.length} article(s) (sidecar unchanged)`);
    }
  } catch (err) {
    logError(`Embeddings sidecar write failed (non-blocking): ${err.message}`);
  }

  // ── Step 6: Upsert nodes into the GraphStore ─────────────────────
  // `putNodes` is a full-overwrite upsert keyed on (projectId, nodeId): re-running
  // is idempotent, and two wave writers writing DIFFERENT nodes never collide.
  const today = new Date().toISOString().split('T')[0];
  let upsertCount = 0;
  let pruneCount = 0;
  let edgeCreateCount = 0;

  // NOTE: the embedding vector is intentionally NOT stored on the node — S1.5
  // moves vectors to a per-project sidecar. The rich wiki metadata is carried on
  // `props`; the GraphStore currently persists only the SYSTEM_GRAPH_NODE_PROPS-
  // allowlisted subset (graph-store.mjs), so a few article fields (summary / type /
  // phase / maturity / tags / created*) do not yet round-trip — flagged for the
  // S1.3 snapshot byte-compat / S0.2 allowlist coordination.
  const wikiNodes = parsedArticles.map((article) => {
    const fm = article.frontmatter;
    return {
      nodeId: article.nodeId,
      // kind left unset → GraphStore defaults to 'file' (matches the old
      // `coalesce(n.kind,'file')` snapshot behaviour for article nodes).
      status: fm.status || 'active',
      title: fm.title || article.nodeId,
      updated: fm.updated || today,
      props: {
        type: fm.type || 'unknown',
        phase: fm.phase || 'unknown',
        maturity: typeof fm.maturity === 'number' ? fm.maturity : 0.1,
        summary: article.summary,
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        createdByEpic: fm.createdByEpic || '',
        createdByStory: fm.createdByStory || '',
        lastMutatedByStory: fm.lastMutatedByStory || '',
        created: fm.created || today,
      },
    };
  });
  if (wikiNodes.length) {
    await store.putNodes(config.project, wikiNodes);
    upsertCount = wikiNodes.length;
  }
  log(`Upserted ${upsertCount} nodes`);

  // Prune deleted articles (status flip, never a hard delete).
  for (const deletedId of deletedNodeIds) {
    const flipped = await store.setNodeAttrs(config.project, deletedId, {
      status: 'pruned',
      updated: today,
    });
    if (flipped) pruneCount++;
  }
  if (pruneCount > 0) {
    log(`Pruned ${pruneCount} nodes`);
  }

  // ── Step 7: Create/update edges from wikilinks ───────────────────
  // Edge CREATION only. The old read-then-DELETE stale-edge GC is dropped: the
  // GraphStore exposes no per-edge delete, AND read-modify-delete is exactly the
  // pattern that clobbers a concurrent writer's edge (wave width ≥2). `putEdges`
  // is an idempotent upsert keyed on (src, edgeType|target), so re-running never
  // duplicates and unchanged wikilinks keep a stable count. An edge forms only
  // when the OTHER endpoint node exists (heir of the old `MATCH (a) MATCH (b)`),
  // so a wikilink to a not-yet-materialized code node adds no phantom edge.
  // Stale-wikilink GC is deferred pending a GraphStore deleteEdge primitive (S0.2 /
  // S1.4 coordination).
  for (const article of parsedArticles) {
    const edges = [];
    for (const link of article.wikilinks) {
      const targetNode = await store.getNode(config.project, link.target);
      if (!targetNode) continue; // the other endpoint must exist
      if (link.direction === 'outgoing') {
        edges.push({ type: link.type, from: article.nodeId, to: link.target, props: { weight: link.weight } });
      } else if (link.direction === 'incoming') {
        // Target → current article (reverse edge).
        edges.push({ type: link.type, from: link.target, to: article.nodeId, props: { weight: link.weight } });
      } else if (link.direction === 'bidirectional') {
        edges.push({ type: link.type, from: article.nodeId, to: link.target, props: { weight: link.weight } });
        edges.push({ type: link.type, from: link.target, to: article.nodeId, props: { weight: link.weight } });
      }
    }
    if (edges.length) {
      await store.putEdges(config.project, edges);
      edgeCreateCount += edges.length;
    }
  }

  log(`Created/updated ${edgeCreateCount} wikilink edges`);

  // ── Step 8: Update compile-state.json ────────────────────────────
  const newState = { ...currentHashes };
  // Remove deleted articles from state
  for (const deletedId of deletedNodeIds) {
    delete newState[deletedId];
  }
  await writeCompileState(config.stateFile, newState);
  log(`Updated compile-state.json (${Object.keys(newState).length} entries)`);

  // ── Step 8.4: AST grounding (Slice B) ────────────────────────────
  await processAstFacts(config, store);

  // ── Step 8.45: System graph grounding (Pipeline v3 / Epic 1) ─────
  await processSystemGraphFacts(config, store);

  // ── Step 8.455: Test-cover edges (W3.3) — dark unless P3_TEST_COVER_EDGES=on
  await processTestCoverFacts(config, store);

  // ── Step 8.46: Agentic Document Center — subsystem shards + god docs ─
  await processDocumentFacts(config, store);

  // ── Step 8.47: Graph integrity — orphans + dead code (Epic 2) ────
  await processGraphIntegrity(config, store);

  // ── Step 8.5: Graph snapshot for in-app visualization ────────────
  await writeGraphSnapshot(config, store);

  // ── Step 8.55: git-graph snapshot (GitGraph fallback — always fresh) ─
  await writeGitGraphSnapshotLocal(config);

  // ── Step 8.6: Architectural X-Ray analytics — insights.json (Epic 3) ─
  await processGraphAnalytics(config, store);

  // ── Step 8.7: Cross-project contract spine — federation (Epic 5, --global) ─
  await processFederation(config, store);

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
async function processAstFacts(config, store) {
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

  const today = new Date().toISOString().split('T')[0];
  let funcUpserts = 0;
  let classUpserts = 0;
  let definesEdges = 0;
  let importsEdges = 0;
  let callsEdges = 0;
  const backboneFiles = [];
  // Every non-parseError scanned file gets a node in pass 1; pass 2 only forms an
  // IMPORTS edge when the target is in this set (heir of the old `MATCH (a) MATCH
  // (b)` both-endpoints-exist rule, without a per-edge store round-trip).
  const createdFileNodeIds = new Set();

  // ── Pass 1: file / function / class nodes + DEFINES edges ──────────────
  for (const file of facts.files) {
    if (file.parseError) continue;
    const fileNodeId = fileToCodeNodeId(file.path);
    backboneFiles.push(file.path);
    createdFileNodeIds.add(fileNodeId);

    // Ensure the parent file node EXISTS (kind='file') so DEFINES always links —
    // AST_FACTS covers more files than the article diff (test files, bare
    // components). Do NOT clobber an existing wiki node's fields: create only
    // when missing; otherwise just (re)assert `file` so the file-index GSI
    // (get_file_symbols, S2.1) resolves. projectId is the store partition key, so
    // the old "self-heal a stale UUID projectId" step is structurally unnecessary.
    const existingFile = await store.getNode(config.project, fileNodeId);
    if (!existingFile) {
      await store.putNodes(config.project, [
        {
          nodeId: fileNodeId,
          kind: 'file',
          file: file.path,
          title: file.path,
          status: 'active',
          props: { type: 'code', phase: 'implementation' },
        },
      ]);
    } else if (existingFile.file !== file.path) {
      await store.setNodeAttrs(config.project, fileNodeId, { file: file.path });
    }

    // Functions
    for (const fn of file.functions || []) {
      const fnNodeId = subNodeId(fileNodeId, 'function', fn.name);
      await store.putNodes(config.project, [
        {
          nodeId: fnNodeId,
          kind: 'function',
          file: file.path,
          title: fn.className ? `${fn.className}.${fn.name}()` : `${fn.name}()`,
          status: 'active',
          updated: today,
          props: {
            name: fn.name,
            fnKind: fn.kind || 'function',
            exported: !!fn.exported,
            params: Array.isArray(fn.params) ? fn.params : [],
            line: fn.line ?? 0,
            endLine: fn.endLine ?? 0,
            parentFile: fileNodeId,
            className: fn.className ?? '',
            type: 'code',
            phase: 'implementation',
          },
        },
      ]);
      funcUpserts++;

      // file -[:DEFINES]-> function (both endpoints exist by construction)
      await store.putEdges(config.project, [
        { type: 'DEFINES', from: fileNodeId, to: fnNodeId },
      ]);
      definesEdges++;
    }

    // Classes
    for (const cls of file.classes || []) {
      const clsNodeId = subNodeId(fileNodeId, 'class', cls.name);
      await store.putNodes(config.project, [
        {
          nodeId: clsNodeId,
          kind: 'class',
          file: file.path,
          title: `class ${cls.name}`,
          status: 'active',
          updated: today,
          props: {
            name: cls.name,
            extends: cls.extends ?? '',
            line: cls.line ?? 0,
            endLine: cls.endLine ?? 0,
            parentFile: fileNodeId,
            type: 'code',
            phase: 'implementation',
          },
        },
      ]);
      classUpserts++;

      await store.putEdges(config.project, [
        { type: 'DEFINES', from: fileNodeId, to: clsNodeId },
      ]);
      definesEdges++;
    }
  }

  // ── Pass 2: IMPORTS (file → file) + CALLS (same-file) ──────────────────
  // Deferred to a second pass so ALL scanned file nodes exist before edges form —
  // this removes the old single-pass ordering hazard (a file importing a
  // not-yet-processed file silently lost its IMPORTS edge).
  for (const file of facts.files) {
    if (file.parseError) continue;
    const fileNodeId = fileToCodeNodeId(file.path);

    // Imports — file → file edges for relative imports we can resolve.
    for (const imp of file.imports || []) {
      const resolved = resolveImportSource(file.path, imp.source, knownFiles, { aliasMap, rootDir });
      if (!resolved) continue; // external or unresolvable — skip silently
      const targetNodeId = fileToCodeNodeId(resolved);
      // Both endpoints must exist as nodes (target may be a parseError file with
      // no node) — the heir of the old `MATCH (a) MATCH (b) MERGE`.
      if (!createdFileNodeIds.has(targetNodeId)) continue;
      await store.putEdges(config.project, [
        { type: 'IMPORTS', from: fileNodeId, to: targetNodeId },
      ]);
      importsEdges++;
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
      await store.putEdges(config.project, [
        { type: 'CALLS', from: callerId, to: calleeId },
      ]);
      callsEdges++;
    }
  }

  log(
    `AST grounding: ${funcUpserts} functions, ${classUpserts} classes, ${definesEdges} DEFINES, ${importsEdges} IMPORTS, ${callsEdges} CALLS`
  );

  // ── Containment backbone (Story 2.1) + delete-aware prune (F15) ────────────
  // S1.4: `emitContainmentBackbone`/`pruneDeletedCodeNodes` now run on the
  // GraphStore (the legacy Memgraph session seam is gone) — still wrapped
  // non-blocking so a store hiccup can't abort the already-persisted writes
  // above it.
  try {
    const { dirNodes, containsEdges } = await emitContainmentBackbone(
      store,
      config.project,
      backboneFiles,
      today,
    );
    log(`Containment backbone: ${dirNodes} dir nodes, ${containsEdges} CONTAINS edges`);

    if (isAuthoritativeFullScan) {
      const { prunedFiles, prunedSubNodes, prunedIds } = await pruneDeletedCodeNodes(
        store,
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
  } catch (err) {
    logError(`containment-backbone/prune pass failed (non-blocking): ${err.message}`);
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
/**
 * W3.3 (P3_TEST_COVER_EDGES) — MERGE deterministic `TESTS` edges (test file →
 * exercised source file) from `.mycelium/test-cover-facts.json`. SAFETY: gated on
 * the flag (D1 — dark on the unflagged live graph-sync path) and TOTALLY wrapped
 * in try/catch (D2 — a failure here must never abort processGraphIntegrity /
 * the snapshot / the S3 backup that run after it). MERGE-only-when-both-endpoints
 * exist (never creates nodes → preserves the orphan/dead-code invariants), exactly
 * like the IMPORTS block.
 */
async function processTestCoverFacts(config, store) {
  try {
    if (process.env.P3_TEST_COVER_EDGES !== 'on') return; // dark by default
    const myceliumDir = join(config.knowledgeDir, '..', '.mycelium');
    const p = join(myceliumDir, 'test-cover-facts.json');
    if (!existsSync(p)) return;
    let doc;
    try {
      doc = JSON.parse(await readFile(p, 'utf-8'));
    } catch (err) {
      logError(`test-cover-facts malformed: ${err.message}`);
      return;
    }
    const edges = Array.isArray(doc?.edges) ? doc.edges : [];
    if (!edges.length) return;

    const today = new Date().toISOString().split('T')[0];
    let testsEdges = 0;
    for (const e of edges) {
      if (!e || e.type !== 'TESTS' || !e.from || !e.to) continue;
      const fromId = fileToCodeNodeId(e.from);
      const toId = fileToCodeNodeId(e.to);
      // MERGE-only-when-both-endpoints-exist (never creates nodes → preserves the
      // orphan/dead-code invariants), exactly like the IMPORTS block.
      const [a, b] = await Promise.all([
        store.getNode(config.project, fromId),
        store.getNode(config.project, toId),
      ]);
      if (a && b) {
        await store.putEdges(config.project, [
          { type: 'TESTS', from: fromId, to: toId, props: { updated: today } },
        ]);
        testsEdges++;
      }
    }
    log(`Test-cover grounding: ${testsEdges} TESTS edges (${edges.length} candidate)`);
  } catch (err) {
    logError(`test-cover pass failed (non-blocking): ${err.message}`);
  }
}

async function processSystemGraphFacts(config, store) {
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
  let totalNodes = 0;
  let totalEdges = 0;

  // 1) Ingest infra / route / service nodes + edges (idempotent). The ingest
  // functions (lib/system-graph-ingest.mjs) take the GraphStore directly (S1.2).
  for (const [name, doc] of factDocs) {
    const { nodeUpserts, edgeUpserts, skippedEdges } = await upsertExtractedFacts(
      store,
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
      store,
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
      store,
      config.project,
      apiCallsDoc.calls,
      endpoints,
      today,
      { basePath: '/api' },
    );
    log(`System graph CALLS_ENDPOINT: ${edgeUpserts} edges`);
  }
}

// ── Agentic Document Center: subsystem shards + god docs (E3.5 / E5 / E6.1) ──

/**
 * Resolve a story/shard touchPoint (or member) to the code nodeIds it governs,
 * reusing the SAME oracle DEV uses (`touchPointToNodeId`, ground-truth-injection.mjs)
 * for literals and `glob-intersect.mjs` for glob patterns. A literal that doesn't
 * exist as a `:Node`, or a glob matching zero known code nodes, is NEVER turned
 * into a bogus edge — it is returned on `ambiguous[]`.
 *
 * @param {string} tp                touchPoint (literal path, code/ nodeId, or glob)
 * @param {Set<string>} codeNodeIds  the project's existing `code/*` nodeIds
 * @returns {{ matched: string[], ambiguous: object[] }}
 */
export function resolveGovernsTargets(tp, codeNodeIds) {
  const isGlob = /[*?[\]{}]/.test(String(tp));
  if (!isGlob) {
    const id = tp.startsWith('code/') ? tp : touchPointToNodeId(tp);
    if (codeNodeIds.has(id)) return { matched: [id], ambiguous: [] };
    return { matched: [], ambiguous: [{ touchPoint: tp, reason: 'no-matching-code-node' }] };
  }
  // Glob: compare against each code node's path-shaped tail (strip `code/`, `--`→`/`).
  const matched = [];
  for (const id of codeNodeIds) {
    const relPath = id.replace(/^code\//, '').replace(/--/g, '/');
    if (globsIntersect(tp, relPath)) matched.push(id);
  }
  matched.sort();
  if (matched.length === 0) {
    return { matched: [], ambiguous: [{ touchPoint: tp, reason: 'glob-matched-no-code-node' }] };
  }
  return { matched, ambiguous: [] };
}

/**
 * The Agentic Document Center graph step. Deterministic, zero-LLM, MERGE-on-nodeId
 * idempotent — mirrors `processSystemGraphFacts` (read .mycelium, session
 * lifecycle, log lines). Runs AFTER processSystemGraphFacts, BEFORE
 * processGraphIntegrity. Steps:
 *
 *   1. subsystem-extract → docShard nodes + shard→shard DEPENDS_ON edges, plus a
 *      synthetic `godDoc/<docType>/<slug>` node CONTAINS-ing each shard.
 *   2. docShard GOVERNS its member code nodes — every member is normalized via
 *      `touchPointToNodeId`; a member with no `:Node` → ambiguous[], never a
 *      bogus edge. (Glob members are expanded via glob-intersect.)
 *   3. PROPOSES: each concept `document` (architecture/prd/ux on disk) PROPOSES
 *      the godDoc — the intention edge from the spec to the codebase-reactive doc.
 *   4. Prune-on-tombstone: docShard nodes whose shardKey is no longer produced by
 *      the current extract are marked `status:'pruned'` (a vanished module
 *      boundary), and stale GOVERNS/CONTAINS edges from them are removed — edges
 *      to deleted shards never accumulate.
 *
 * Prototype / empty project (no ast-facts files ⇒ no shards) → log + skip,
 * zero nodes, byte-identical to today.
 */
async function processDocumentFacts(config, store) {
  const root = join(config.knowledgeDir, '..');
  const subsysEnv = extractSubsystems(root);
  const shardNodes = (subsysEnv.nodes || []).filter((n) => n.kind === 'docShard');

  if (shardNodes.length === 0) {
    log('No subsystem shards (prototype/empty project) — skipping document-center grounding');
    return;
  }

  const docType = 'architecture'; // the god-doc family this layer projects
  const slug = config.project;
  const godDocId = `godDoc/${docType}/${slug}`;
  const today = new Date().toISOString().split('T')[0];

  // Concept documents present on disk → PROPOSES sources (intention edges).
  const { nodes: conceptNodes } = extractConceptDocs(root);
  const conceptDocs = conceptNodes.filter((n) => n.kind === 'document');

  try {
    // The set of existing code nodeIds — the GOVERNS resolution domain
    // (kind-index query, non-pruned only).
    const fileNodes = await store.queryByKind(slug, 'file');
    const codeNodeIds = new Set(
      fileNodes.filter((n) => (n.status ?? 'active') !== 'pruned').map((n) => n.nodeId),
    );

    // 1) Ingest docShard nodes + DEPENDS_ON edges + the godDoc node + CONTAINS.
    const godNode = {
      nodeId: godDocId,
      kind: 'godDoc',
      label: docType,
      docType,
      shardKeys: shardNodes.map((n) => n.nodeId).sort(),
      projectId: slug,
    };
    const containsEdges = shardNodes.map((n) => ({
      type: 'CONTAINS',
      source: godDocId,
      target: n.nodeId,
      provenance: 'EXTRACTED',
    }));
    const ingestDoc = {
      nodes: [godNode, ...shardNodes],
      edges: [...(subsysEnv.edges || []), ...containsEdges],
    };
    const { nodeUpserts, edgeUpserts, skippedEdges } = await upsertDocFacts(
      store,
      slug,
      ingestDoc,
      today,
    );
    if (skippedEdges.length > 0) {
      log(`document-center: ${skippedEdges.length} edges/nodes skipped (unresolved or not allowlisted)`);
    }

    // 2) docShard GOVERNS its member code nodes (touchPointToNodeId / glob-intersect).
    // Both endpoints exist by construction: the shard was just ingested and every
    // matched target came out of the store's code-node set.
    let governsEdges = 0;
    const ambiguous = [...(subsysEnv.ambiguous || [])];
    for (const shard of shardNodes) {
      for (const member of shard.members || []) {
        const { matched, ambiguous: amb } = resolveGovernsTargets(member, codeNodeIds);
        ambiguous.push(...amb);
        for (const target of matched) {
          await store.putEdges(slug, [
            { type: 'GOVERNS', from: shard.nodeId, to: target, props: { updated: today, provenance: 'EXTRACTED' } },
          ]);
          governsEdges++;
        }
      }
    }

    // 3) PROPOSES: each concept document → the godDoc (intention edge). The
    // concept document node may not be ingested here (doc-extract runs its own
    // ingest elsewhere); create it only when missing (ON CREATE semantics — never
    // clobber a richer existing node), then form the edge to the godDoc.
    let proposesEdges = 0;
    for (const doc of conceptDocs) {
      const existingDoc = await store.getNode(slug, doc.nodeId);
      if (!existingDoc) {
        await store.putNodes(slug, [
          {
            nodeId: doc.nodeId,
            kind: 'document',
            label: doc.label ?? doc.nodeId,
            status: 'active',
            updated: today,
            props: doc.docType ? { docType: doc.docType } : {},
          },
        ]);
      }
      await store.putEdges(slug, [
        { type: 'PROPOSES', from: doc.nodeId, to: godDocId, props: { updated: today, provenance: 'EXTRACTED' } },
      ]);
      proposesEdges++;
    }

    // 4) Prune-on-tombstone: docShards no longer produced by the current extract.
    // The status flip (via setNodeAttrs) removes the shard from the live
    // projection. NOTE: the old code ALSO deleted the shard's outgoing GOVERNS/
    // DEPENDS_ON + incoming CONTAINS edges; the GraphStore exposes no per-edge
    // delete, so that stale-edge GC is deferred pending a deleteEdge primitive
    // (S0.2 / S1.4 coordination) — the tombstoned shard is still excluded from
    // the live graph by its `status: 'pruned'`.
    const liveShardKeys = new Set(shardNodes.map((n) => n.nodeId));
    const existingShards = await store.queryByKind(slug, 'docShard');
    let prunedShards = 0;
    for (const node of existingShards) {
      if ((node.status ?? 'active') === 'pruned') continue;
      if (liveShardKeys.has(node.nodeId)) continue;
      await store.setNodeAttrs(slug, node.nodeId, { status: 'pruned', updated: today });
      prunedShards++;
    }

    // Write a per-scan summary report next to the other graph reports.
    const graphDir = join(config.knowledgeDir, '_graph');
    await mkdir(graphDir, { recursive: true });
    const reportPath = join(graphDir, 'documents.json');
    const tmp = reportPath + '.tmp';
    await writeFile(
      tmp,
      JSON.stringify(
        {
          projectId: slug,
          generatedAt: new Date().toISOString(),
          godDoc: godDocId,
          shardCount: shardNodes.length,
          nodeUpserts,
          dependsEdges: edgeUpserts - containsEdges.length,
          containsEdges: containsEdges.length,
          governsEdges,
          proposesEdges,
          prunedShards,
          cycles: subsysEnv.cycles || [],
          ambiguous,
        },
        null,
        2,
      ),
      'utf-8',
    );
    await rename(tmp, reportPath);

    log(
      `Document center: ${shardNodes.length} shard(s), ${governsEdges} GOVERNS, ` +
        `${proposesEdges} PROPOSES, ${prunedShards} pruned, ${ambiguous.length} ambiguous` +
        ((subsysEnv.cycles || []).length ? `, ${subsysEnv.cycles.length} dep-cycle(s) reported` : ''),
    );
  } catch (err) {
    // Non-blocking like the snapshot/analytics steps — a store or query error
    // must not fail the sync; real extractor bugs surface via the orphan check.
    logError(`document-center pass failed (non-blocking): ${err.message}`);
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

async function processGraphIntegrity(config, store) {
  const graphDir = join(config.knowledgeDir, '_graph');
  const writeReport = async (name, doc) => {
    await mkdir(graphDir, { recursive: true });
    const p = join(graphDir, name);
    const tmp = p + '.tmp';
    await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8');
    await rename(tmp, p);
  };

  try {
    const generatedAt = new Date().toISOString();

    // ── Story 2.2: orphan invariant ──────────────────────────────────
    const { orphans } = await reportOrphans(store, config.project);

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
    const deadCode = await reportDeadCode(store, config.project);
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
  } catch (err) {
    // Store failure (e.g. Dynamo unreachable) — non-blocking, like the
    // snapshot/backup steps. A real extractor bug surfaces via the orphan query
    // above, not here.
    logError(`graph-integrity check failed (non-blocking): ${err.message}`);
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
 * write-path. Fully non-blocking: an empty project graph (or a store error)
 * degrades to a well-formed insights.json with the dimension's `*Available`
 * flag false, and never fails the sync.
 */
async function processGraphAnalytics(config, store) {
  const graphDir = join(config.knowledgeDir, '_graph');
  const threshold = config.centralityThreshold ?? 0;

  try {
    const generatedAt = new Date().toISOString();
    const analytics = await runAnalytics(store, config.project, { threshold, logger: log });
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
      log('Graph analytics: empty graph — wrote empty insights.json (overlay disabled in UI)');
    }
  } catch (err) {
    logError(`graph-analytics pass failed (non-blocking): ${err.message}`);
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

/**
 * Read this project's contract-bearing nodes with their shape props. S1.4:
 * one `queryByKind` (kind-index GSI) per contract kind, in place of the old
 * `kind IN [...]` Cypher scan. `name`/`host` are not on the
 * `SYSTEM_GRAPH_NODE_PROPS` allowlist (`lib/graph-store.mjs`) so they never
 * round-trip through the store today — harmless here, `identityKey`/
 * `contractShape` (contract-diff.mjs) already fall back to `label` for both.
 */
async function readProjectContracts(store, projectId) {
  const out = [];
  for (const kind of CONTRACT_NODE_KINDS) {
    const nodes = await store.queryByKind(projectId, kind);
    for (const n of nodes) {
      out.push({
        nodeId: n.nodeId,
        kind: n.kind,
        name: n.props?.name ?? null,
        label: n.title ?? n.label ?? n.nodeId,
        fields: n.props?.fields ?? null,
        primaryIndex: n.props?.primaryIndex ?? null,
        method: n.props?.method ?? null,
        path: n.props?.path ?? null,
        host: n.props?.host ?? null,
      });
    }
  }
  return out;
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
async function processContractRevisions(config, store) {
  const graphDir = join(config.knowledgeDir, '_graph');
  const snapPath = join(graphDir, 'contract-snapshot.json');

  try {
    const after = await readProjectContracts(store, config.project);

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
    const appended = await appendRevisions(store, revisions);
    log(
      `Contract revisions: appended ${appended.revisions} (${diff.added} new, ` +
        `${diff.removed} removed, ${diff.modified} modified)` +
        (config.waveGate ? ` at ${config.waveGate}` : ''),
    );
  } catch (err) {
    logError(`contract-revision pass failed (non-blocking): ${err.message}`);
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
 * Fully non-blocking: any store/Memgraph error is logged and skipped.
 *
 * S1.4: step 5.1 (`lib/federation.mjs`, in this story's file scope) runs on
 * the GraphStore. Steps 5.2/5.3 (`lib/capability.mjs`) are NOT yet converted
 * (out of S1.4's file scope) — they keep the legacy Memgraph seam until a
 * follow-on story converts that lib file, mirroring the seam pattern already
 * used elsewhere in this file for not-yet-converted passes.
 */
async function processFederation(config, store) {
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

  try {
    // 5.1 — federate contract spine (lib/federation.mjs, S1.4). See that
    // module's doc comment: true cross-project federation needs a
    // projects-enumeration capability the project-partitioned GraphStore
    // doesn't expose, so this is scoped to THIS project until that lands.
    const projects = await readContracts(store, [config.project]);
    const result = federateContracts(projects, { strategy });
    const fed = await writeFederation(store, result);
    log(
      `Federation [${strategy}]: ${fed.contractNodes} shared contract node(s), ` +
        `${fed.consumes} CONSUMES_CONTRACT edge(s) across ${projects.length} project(s)` +
        (result.unjoinable.length ? `; ${result.unjoinable.length} unjoinable` : ''),
    );
  } catch (err) {
    logError(`federation pass failed (non-blocking): ${err.message}`);
  }

  // 5.2/5.3 — capability ingest + coverage gaps (lib/capability.mjs). NOT
  // converted by S1.4 (out of file scope) — legacy Memgraph seam, wrapped
  // independently so a dead/absent Memgraph never blocks 5.1 above.
  let driver;
  try {
    driver = createDriver();
    const session = driver.session();
    try {
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
    logError(`capability pass failed (non-blocking): ${err.message}`);
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
 *
 * S1.4 NOTE: every graph read/write in this pass routes through
 * `propagator.mjs` (`readRecentChanges`/`perSiblingDrift`/`applyMarkerUpdate`),
 * which is a DIFFERENT file from this story's `lib/impact-propagation.mjs` and
 * is NOT in S1.4's file scope — it stays on the legacy Memgraph session until a
 * follow-on story converts it. Left as-is here (a `store` param would be dead
 * weight until that conversion lands).
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
 * S1.3 (EU migration): the two Cypher reads (`MATCH (n:Node {projectId})`,
 * `MATCH (a)-[r]->(b)`) are replaced by `store.listNodes`/`store.listEdges`
 * (project-index GSI on the edges table). The projection below reproduces the
 * exact legacy field set — including the per-kind (`function`/`class`) shaping
 * and `similarTo` — from the GraphStore's public node/edge shape, so downstream
 * consumers (the Graph tab, `readSnapshotStats`) see byte-compatible output.
 * Wiki/AST-authored fields (`type`, `phase`, `summary`, `tags`, `createdByStory`,
 * `lastMutatedByStory`, `name`, `parentFile`, `line`, `endLine`, `exported`,
 * `params`, `className`, `fnKind`, `extends`) live under `node.props` — they
 * round-trip once the `SYSTEM_GRAPH_NODE_PROPS` allowlist (`lib/graph-store.mjs`)
 * carries them; until then `props` simply omits the not-yet-allowlisted keys and
 * this projection degrades gracefully (`?? null` / `?? []` / `?? 0`), matching
 * how the old Cypher `RETURN` also nulled out an absent property.
 *
 * Non-blocking: errors are logged but do not fail compile-sync.
 */
async function writeGraphSnapshot(config, store) {
  try {
    const [nodeRows, edgeRows] = await Promise.all([
      store.listNodes(config.project),
      store.listEdges(config.project),
    ]);

    // Semantic neighbours from the Voyage embeddings (raw vectors stay out of
    // the snapshot). Bounded cost; empty for large graphs / no-embedding nodes.
    // Node embeddings are not (yet) part of the GraphStore's public shape — the
    // sidecar that carries them is S1.5's seam — so this yields an empty map
    // until that lands, same as if every node had no embedding.
    const similarTo = computeSimilarTo(
      nodeRows.map((n) => ({ id: n.nodeId, embedding: n.embedding ?? null })),
    );

    const toNum = (v) =>
      v && typeof v.toNumber === 'function' ? v.toNumber() : v ?? null;

    const nodes = nodeRows.map((n) => {
      const kind = n.kind ?? 'file';
      const props = n.props ?? {};
      const base = {
        id: n.nodeId,
        kind,
        type: props.type ?? null,
        phase: props.phase ?? null,
        status: n.status ?? null,
        title: n.title ?? null,
        summary: props.summary ?? null,
        maturity: toNum(props.maturity) ?? 0,
        tags: props.tags ?? [],
        createdByStory: props.createdByStory ?? null,
        lastMutatedByStory: props.lastMutatedByStory ?? null,
        updated: n.updated ?? null,
        similarTo: similarTo.get(n.nodeId) ?? [],
      };
      // Surface AST-specific fields only when present, so wiki-only nodes
      // don't carry empty/null clutter that bloats the snapshot.
      if (kind === 'function') {
        return {
          ...base,
          name: props.name ?? null,
          parentFile: props.parentFile ?? null,
          line: toNum(props.line) ?? 0,
          endLine: toNum(props.endLine) ?? 0,
          exported: props.exported ?? false,
          params: props.params ?? [],
          className: props.className || null,
          fnKind: props.fnKind || 'function',
        };
      }
      if (kind === 'class') {
        return {
          ...base,
          name: props.name ?? null,
          parentFile: props.parentFile ?? null,
          line: toNum(props.line) ?? 0,
          endLine: toNum(props.endLine) ?? 0,
          extends: props.extends || null,
        };
      }
      return base;
    });

    const edges = edgeRows.map((e) => ({
      source: e.from,
      target: e.to,
      type: e.type,
      weight: toNum(e.props?.weight) ?? 1.0,
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
