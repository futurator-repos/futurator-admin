/**
 * GraphRAG Search Tool
 * Story MY-5.1 · rewired by S1.5 (EU-migration keystone)
 *
 * Combined vector search + graph traversal, boltless. Memgraph is EXCISED
 * (KD-1): query-time KNN now runs client-side JS over the per-project embeddings
 * sidecar (`knowledge/_graph/embeddings.json`, written by graph-sync Step 5), and
 * the hop-expansion runs over the DynamoDB-backed GraphStore. Uses Voyage AI
 * embeddings (input_type: 'query') for asymmetric search against wiki articles
 * embedded with input_type: 'document'.
 *
 * CLI Usage:
 *   node graph-search.mjs --project spyhunter --query "authentication flow" \
 *     --top-k 10 --hops 2 --min-similarity 0.6 --verbose
 *   # --knowledge-dir / --working-dir override the default sidecar location.
 *
 * Module Usage:
 *   import { graphSearch } from './graph-search.mjs';
 *   const results = await graphSearch('spyhunter', 'auth flow', { topK: 10 });
 */

import { join } from 'path';
import { embedText } from './lib/voyage-embed.mjs';
import { readEmbeddingsSidecar, knnSearch } from './lib/embedding-knn.mjs';
import { createGraphStore } from './lib/graph-store.mjs';

// ── Arg parser ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' && argv[i + 1]) args.project = argv[++i];
    else if (arg === '--query' && argv[i + 1]) args.query = argv[++i];
    else if (arg === '--top-k' && argv[i + 1]) args.topK = parseInt(argv[++i], 10);
    else if (arg === '--hops' && argv[i + 1]) args.hops = parseInt(argv[++i], 10);
    else if (arg === '--min-similarity' && argv[i + 1]) args.minSimilarity = parseFloat(argv[++i]);
    else if (arg === '--knowledge-dir' && argv[i + 1]) args.knowledgeDir = argv[++i];
    else if (arg === '--working-dir' && argv[i + 1]) args.workingDir = argv[++i];
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function printUsage() {
  console.error(`Usage: node graph-search.mjs --project <id> --query "<text>" [options]

Options:
  --project <id>          Project ID (required)
  --query "<text>"        Search query text (required)
  --top-k <n>             Max vector search results (default: 10)
  --hops <n>              Graph traversal depth (default: 2)
  --min-similarity <f>    Minimum cosine similarity threshold (default: 0.6)
  --knowledge-dir <path>  Path to the project's knowledge/ dir (sidecar location)
  --working-dir <path>    Project root; knowledge/ is resolved under it
  --verbose               Print debug info to stderr
  --json                  Force JSON output (default for stdout)`);
}

// ── Sidecar location ────────────────────────────────────────────────

/** Default projects root on a fleet host (mirrors path-remap / story-worktree). */
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/home/ubuntu/projects';

/**
 * Resolve the knowledge/ directory holding the embeddings sidecar. Explicit
 * `opts.knowledgeDir` wins; else derive `<workingDir>/knowledge`; else fall back
 * to the on-host project convention `<PROJECTS_ROOT>/<projectId>/knowledge`.
 */
function resolveKnowledgeDir(projectId, opts) {
  if (opts.knowledgeDir) return opts.knowledgeDir;
  if (opts.workingDir) return join(opts.workingDir, 'knowledge');
  return join(PROJECTS_ROOT, projectId, 'knowledge');
}

// ── Hop expansion over the GraphStore ───────────────────────────────

/**
 * Undirected BFS from `startNodeId` up to `hops` edges, collecting DISTINCT
 * reachable nodes whose status is 'active' or 'flagged' — the store equivalent
 * of the old `OPTIONAL MATCH (node)-[r*1..hops]-(related) WHERE related.status IN
 * ['active','flagged']`. Traversal passes THROUGH any node (matching Cypher),
 * but only active/flagged endpoints are emitted. Capped to keep it read-cheap.
 */
async function hopExpand(store, projectId, startNodeId, hops, nodeCache, cap = 200) {
  const seen = new Set([startNodeId]);
  let frontier = [startNodeId];
  const related = [];

  const getCached = async (id) => {
    if (nodeCache.has(id)) return nodeCache.get(id);
    const node = await store.getNode(projectId, id);
    nodeCache.set(id, node);
    return node;
  };

  for (let depth = 0; depth < hops && related.length < cap; depth++) {
    const next = [];
    for (const nid of frontier) {
      const [outs, ins] = await Promise.all([
        store.outEdges(projectId, nid),
        store.inEdges(projectId, nid),
      ]);
      const neighborIds = [...outs.map((e) => e.to), ...ins.map((e) => e.from)];
      for (const mid of neighborIds) {
        if (seen.has(mid)) continue;
        seen.add(mid);
        next.push(mid); // traverse through regardless of status
        const node = await getCached(mid);
        if (node && (node.status === 'active' || node.status === 'flagged')) {
          related.push({ nodeId: mid, type: node.kind ?? null, title: node.title ?? null });
          if (related.length >= cap) break;
        }
      }
      if (related.length >= cap) break;
    }
    frontier = next;
  }
  return related;
}

// ── Core search function ────────────────────────────────────────────

/**
 * Perform a GraphRAG search: vector similarity (sidecar KNN) + graph traversal
 * (GraphStore). Output schema is unchanged from the Memgraph era so callers
 * (search-cascade Layer 1) need no edits.
 *
 * @param {string} projectId - The project to search within.
 * @param {string} queryText - Natural language query text.
 * @param {object} opts - Search options.
 * @param {number} [opts.topK=10] - Max vector search results.
 * @param {number} [opts.hops=2] - Graph traversal depth from each match.
 * @param {number} [opts.minSimilarity=0.6] - Minimum cosine similarity.
 * @param {string} [opts.knowledgeDir] - Explicit knowledge/ dir (sidecar location).
 * @param {string} [opts.workingDir] - Project root; knowledge/ resolved under it.
 * @param {object} [opts.store] - Injected GraphStore (tests); else auto-created.
 * @param {boolean} [opts.verbose=false] - Log debug info to stderr.
 * @returns {Promise<Array<{nodeId: string, type: string, phase: string, title: string, maturity: number, similarity: number, relationships: Array}>>}
 */
export async function graphSearch(projectId, queryText, opts = {}) {
  const {
    topK = 10,
    hops = 2,
    minSimilarity = 0.6,
    verbose = false,
  } = opts;

  const dbg = verbose ? (msg) => console.error(`[graph-search] ${msg}`) : () => {};

  // Step 1: Embed the query via Voyage AI (input_type: 'query')
  const embedStart = Date.now();
  let queryVector;
  try {
    queryVector = await embedText(queryText, 'query');
  } catch (err) {
    throw new Error(`Embedding failed: ${err.message}`);
  }
  const embedMs = Date.now() - embedStart;
  dbg(`Embedding latency: ${embedMs}ms (${queryVector.length}-dim vector)`);

  // Step 2: KNN over the per-project embeddings sidecar
  const queryStart = Date.now();
  const knowledgeDir = resolveKnowledgeDir(projectId, opts);
  const sidecar = await readEmbeddingsSidecar(knowledgeDir);
  const sidecarSize = Object.keys(sidecar).length;
  dbg(`Sidecar: ${sidecarSize} vector(s) at ${knowledgeDir}/_graph/embeddings.json`);

  const hopsSafe = Math.max(1, Math.min(10, Math.floor(hops)));
  const matches = knnSearch(queryVector, sidecar, { topK, minSimilarity });
  dbg(`KNN: ${matches.length} match(es) (topK=${topK}, minSim=${minSimilarity}, hops=${hopsSafe})`);

  // Step 3: Hop-expand each match + hydrate node metadata via the GraphStore.
  const store = opts.store ?? (await createGraphStore());
  const nodeCache = new Map();
  const results = [];

  for (const { nodeId, score } of matches) {
    const node = nodeCache.has(nodeId)
      ? nodeCache.get(nodeId)
      : (nodeCache.set(nodeId, await store.getNode(projectId, nodeId)), nodeCache.get(nodeId));
    const props = node?.props ?? {};
    const relationships = await hopExpand(store, projectId, nodeId, hopsSafe, nodeCache);

    results.push({
      nodeId,
      type: props.type ?? node?.kind ?? null,
      phase: props.phase ?? null,
      title: node?.title ?? props.title ?? null,
      maturity: typeof props.maturity === 'number' ? props.maturity : Number(props.maturity ?? 0) || 0,
      similarity: score,
      relationships,
    });
  }

  const queryMs = Date.now() - queryStart;

  if (verbose) {
    dbg(`Total time: ${embedMs + queryMs}ms (embed: ${embedMs}ms, search: ${queryMs}ms)`);
    dbg(`Results: ${results.length} nodes with ${results.reduce((s, r) => s + r.relationships.length, 0)} relationships`);
  }

  // Print timing to stderr even without verbose (for performance tracking)
  console.error(`[graph-search] embed=${embedMs}ms query=${queryMs}ms results=${results.length}`);

  return results;
}

// ── CLI entry point ─────────────────────────────────────────────────

const isCLI = process.argv[1] &&
  (process.argv[1].endsWith('graph-search.mjs') ||
   process.argv[1].endsWith('graph-search'));

if (isCLI) {
  const args = parseArgs(process.argv.slice(2));

  if (!args.project || !args.query) {
    printUsage();
    process.exit(1);
  }

  try {
    const results = await graphSearch(args.project, args.query, {
      topK: args.topK,
      hops: args.hops,
      minSimilarity: args.minSimilarity,
      knowledgeDir: args.knowledgeDir,
      workingDir: args.workingDir,
      verbose: args.verbose,
    });

    // Print JSON results to stdout for daemon shell step capture
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(`[graph-search] ERROR: ${err.message}`);
    process.exit(1);
  }
}
