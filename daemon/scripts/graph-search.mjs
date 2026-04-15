/**
 * GraphRAG Search Tool
 * Story MY-5.1
 *
 * Combined vector search + graph traversal in Memgraph.
 * Uses Voyage AI embeddings (input_type: 'query') for asymmetric search
 * against wiki articles embedded with input_type: 'document'.
 *
 * CLI Usage:
 *   node graph-search.mjs --project spyhunter --query "authentication flow" \
 *     --top-k 10 --hops 2 --min-similarity 0.6 --verbose
 *
 * Module Usage:
 *   import { graphSearch } from './graph-search.mjs';
 *   const results = await graphSearch('spyhunter', 'auth flow', { topK: 10 });
 */

import neo4j from 'neo4j-driver';
import { embedText } from './lib/voyage-embed.mjs';

const BOLT_URI = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';

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
  --verbose               Print debug info to stderr
  --json                  Force JSON output (default for stdout)`);
}

// ── Core search function ────────────────────────────────────────────

/**
 * Perform a GraphRAG search: vector similarity + graph traversal.
 *
 * @param {string} projectId - The project to search within.
 * @param {string} queryText - Natural language query text.
 * @param {object} opts - Search options.
 * @param {number} [opts.topK=10] - Max vector search results.
 * @param {number} [opts.hops=2] - Graph traversal depth from each match.
 * @param {number} [opts.minSimilarity=0.6] - Minimum cosine similarity.
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

  // Step 2: Run combined Cypher — vector search + graph traversal
  const driver = neo4j.driver(BOLT_URI);
  const session = driver.session();

  try {
    const queryStart = Date.now();

    // Build the Cypher query with parameterized hops depth.
    // Memgraph requires literal integers in variable-length patterns,
    // so we interpolate `hops` directly (validated as integer above).
    const hopsSafe = Math.max(1, Math.min(10, Math.floor(hops)));

    const cypher = `
      CALL vector_search.search('knowledge_index', $topK, $queryVector)
      YIELD node, similarity
      WHERE similarity > $minSimilarity AND node.projectId = $projectId
      OPTIONAL MATCH (node)-[r*1..${hopsSafe}]-(related)
      WHERE related.status IN ['active', 'flagged']
      RETURN node.nodeId AS nodeId,
             node.type AS type,
             node.phase AS phase,
             node.title AS title,
             node.maturity AS maturity,
             similarity,
             collect(DISTINCT {
               nodeId: related.nodeId,
               type: related.type,
               title: related.title
             }) AS related
      ORDER BY similarity DESC
    `;

    dbg(`Cypher query (topK=${topK}, hops=${hopsSafe}, minSim=${minSimilarity}):`);
    dbg(cypher.trim());

    const result = await session.run(cypher, {
      topK: neo4j.int(topK),
      queryVector,
      minSimilarity,
      projectId,
    });

    const queryMs = Date.now() - queryStart;
    dbg(`Memgraph query latency: ${queryMs}ms (${result.records.length} records)`);

    // Step 3: Map results to output schema
    const results = result.records.map((record) => {
      const sim = record.get('similarity');
      const mat = record.get('maturity');
      const related = record.get('related') || [];

      return {
        nodeId: record.get('nodeId'),
        type: record.get('type'),
        phase: record.get('phase'),
        title: record.get('title'),
        maturity: typeof mat === 'object' && mat !== null && mat.toNumber
          ? mat.toNumber() : (mat ?? 0),
        similarity: typeof sim === 'object' && sim !== null && sim.toNumber
          ? sim.toNumber() : (sim ?? 0),
        relationships: related
          .filter((r) => r && r.nodeId) // remove null entries from OPTIONAL MATCH
          .map((r) => ({
            nodeId: r.nodeId,
            type: r.type,
            title: r.title,
          })),
      };
    });

    if (verbose) {
      dbg(`Total time: ${embedMs + queryMs}ms (embed: ${embedMs}ms, query: ${queryMs}ms)`);
      dbg(`Results: ${results.length} nodes with ${results.reduce((s, r) => s + r.relationships.length, 0)} relationships`);
    }

    // Print timing to stderr even without verbose (for performance tracking)
    console.error(`[graph-search] embed=${embedMs}ms query=${queryMs}ms results=${results.length}`);

    return results;
  } finally {
    await session.close();
    await driver.close();
  }
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
      verbose: args.verbose,
    });

    // Print JSON results to stdout for daemon shell step capture
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(`[graph-search] ERROR: ${err.message}`);
    process.exit(1);
  }
}
