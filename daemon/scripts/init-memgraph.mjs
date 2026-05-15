/**
 * Memgraph Schema & Vector Index Initialization
 * Story MY-1.2
 *
 * Idempotent script that:
 *   1. Creates uniqueness constraint on Node.nodeId
 *   2. Creates vector index node_embedding_index (1024-dim, cosine, f16, 50k capacity)
 *   3. Validates all 8 edge types with test nodes
 *   4. Validates vector search with a test embedding
 *   5. Cleans up all test data
 *
 * Usage:
 *   node init-memgraph.mjs              # Initialize schema
 *   node init-memgraph.mjs --validate   # Initialize + run validation tests
 *   node init-memgraph.mjs --json       # Output JSON results
 */

import { createDriver, BOLT_URI } from './lib/memgraph-driver.mjs';
const args = process.argv.slice(2);
const validateMode = args.includes('--validate');
const jsonMode = args.includes('--json');

/** Edge types with their default weights per architecture doc */
const EDGE_TYPES = [
  { type: 'DEPENDS_ON', weight: 1.0 },
  { type: 'DERIVED_FROM', weight: 0.7 },
  { type: 'INFORMS', weight: 0.3 },
  { type: 'REFINES', weight: 0.5 },
  { type: 'VALIDATES', weight: 0.6 },
  { type: 'SUPERSEDES', weight: 0.8 },
  { type: 'CONFLICTS_WITH', weight: 0.9 },
  { type: 'ENABLES', weight: 0.5 },
];

const results = {
  constraint: false,
  vectorIndex: false,
  edgeTypes: false,
  vectorSearch: false,
  errors: [],
};

function log(msg) {
  if (!jsonMode) console.log(`[init-memgraph] ${msg}`);
}

/**
 * Wait for Memgraph to be ready by retrying a simple query.
 */
async function waitForMemgraph(driver, maxRetries = 10, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const session = driver.session();
    try {
      await session.run('RETURN 1 AS test');
      await session.close();
      return;
    } catch (err) {
      await session.close();
      if (attempt === maxRetries) {
        throw new Error(`Memgraph not ready after ${maxRetries} attempts: ${err.message}`);
      }
      log(`Waiting for Memgraph (attempt ${attempt}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * Create uniqueness constraint on Node.nodeId.
 * Idempotent: catches "already exists" errors.
 */
async function createConstraint(session) {
  log('Creating uniqueness constraint on Node.nodeId...');
  try {
    await session.run('CREATE CONSTRAINT ON (n:Node) ASSERT n.nodeId IS UNIQUE;');
    log('Constraint created successfully');
    results.constraint = true;
  } catch (err) {
    if (
      err.message.includes('already exists') ||
      err.message.includes('Constraint already') ||
      err.message.includes('equivalent')
    ) {
      log('Constraint already exists (idempotent)');
      results.constraint = true;
    } else {
      results.errors.push(`Constraint creation failed: ${err.message}`);
      throw err;
    }
  }
}

/**
 * Create vector index node_embedding_index on :Node(embedding).
 * Config: 1024 dimensions, cosine metric, f16 scalar, 50k capacity.
 * Idempotent: catches "already exists" errors.
 */
async function createVectorIndex(session) {
  log('Creating vector index node_embedding_index...');
  const query = `CREATE VECTOR INDEX node_embedding_index ON :Node(embedding)
    WITH CONFIG {
      "dimension": 1024,
      "capacity": 50000,
      "metric": "cos",
      "scalar_kind": "f16"
    };`;

  try {
    await session.run(query);
    log('Vector index created successfully (1024-dim, cosine, f16, 50k capacity)');
    results.vectorIndex = true;
  } catch (err) {
    if (
      err.message.includes('already exists') ||
      err.message.includes('already created') ||
      err.message.includes('Index with label')
    ) {
      log('Vector index already exists (idempotent)');
      results.vectorIndex = true;
    } else {
      results.errors.push(`Vector index creation failed: ${err.message}`);
      throw err;
    }
  }
}

/**
 * Generate a deterministic 1024-dim test embedding vector.
 * Values are normalized floats for consistent test results.
 */
function generateTestEmbedding(seed = 42) {
  const embedding = [];
  let x = seed;
  for (let i = 0; i < 1024; i++) {
    // Simple PRNG for deterministic floats
    x = ((x * 1103515245 + 12345) & 0x7fffffff) % 2147483647;
    embedding.push((x / 2147483647) * 2 - 1);
  }
  // Normalize to unit vector
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map((v) => v / norm);
}

/**
 * Validate all 8 edge types by creating test nodes and edges.
 */
async function validateEdgeTypes(session) {
  log('Validating 8 edge types...');

  const testPrefix = '__test_edge_';
  const nodeA = `${testPrefix}source`;
  const nodeB = `${testPrefix}target`;

  try {
    // Create two test nodes
    await session.run(
      `CREATE (a:Node {nodeId: $nodeA, projectId: '__test__', type: 'test', phase: 'test', status: 'active', title: 'Test Source'})
       CREATE (b:Node {nodeId: $nodeB, projectId: '__test__', type: 'test', phase: 'test', status: 'active', title: 'Test Target'})`,
      { nodeA, nodeB }
    );

    // Create one edge of each type
    for (const { type, weight } of EDGE_TYPES) {
      await session.run(
        `MATCH (a:Node {nodeId: $nodeA}), (b:Node {nodeId: $nodeB})
         CREATE (a)-[:${type} {weight: $weight}]->(b)`,
        { nodeA, nodeB, weight }
      );
    }

    // Verify all edge types are returned
    const traversalResult = await session.run(
      `MATCH (a:Node {nodeId: $nodeA})-[r]->(b:Node {nodeId: $nodeB})
       RETURN type(r) AS edgeType, r.weight AS weight`,
      { nodeA, nodeB }
    );

    const foundTypes = new Set(traversalResult.records.map((r) => r.get('edgeType')));
    const expectedTypes = new Set(EDGE_TYPES.map((e) => e.type));
    const missing = [...expectedTypes].filter((t) => !foundTypes.has(t));

    if (missing.length === 0) {
      log(`All 8 edge types verified: ${[...foundTypes].join(', ')}`);

      // Verify weights
      for (const record of traversalResult.records) {
        const edgeType = record.get('edgeType');
        const weight = record.get('weight');
        const expected = EDGE_TYPES.find((e) => e.type === edgeType);
        const w = typeof weight === 'object' && weight.toNumber ? weight.toNumber() : weight;
        if (expected && Math.abs(w - expected.weight) > 0.001) {
          log(`WARNING: ${edgeType} weight mismatch: expected ${expected.weight}, got ${w}`);
        }
      }

      results.edgeTypes = true;
    } else {
      results.errors.push(`Missing edge types: ${missing.join(', ')}`);
    }
  } finally {
    // Clean up test data
    await session.run(
      `MATCH (n:Node) WHERE n.nodeId STARTS WITH $prefix DETACH DELETE n`,
      { prefix: testPrefix }
    );
    log('Edge type test data cleaned up');
  }
}

/**
 * Validate vector search by inserting a test node with embedding
 * and querying it back via vector_search.search.
 */
async function validateVectorSearch(session) {
  log('Validating vector search capability...');

  const testNodeId = '__test_vector_search_node';
  const embedding = generateTestEmbedding(42);

  try {
    // Insert test node with embedding
    await session.run(
      `CREATE (n:Node {
        nodeId: $nodeId,
        projectId: '__test__',
        type: 'test',
        phase: 'test',
        status: 'active',
        maturity: 0.5,
        title: 'Vector Search Test Node',
        summary: 'Test node for vector search validation',
        tags: ['test'],
        embedding: $embedding
      })`,
      { nodeId: testNodeId, embedding }
    );

    // Search with the same vector (should return similarity ~1.0)
    const searchResult = await session.run(
      `CALL vector_search.search('node_embedding_index', 5, $queryVector)
       YIELD node, similarity
       WITH node, similarity
       WHERE node.nodeId = $nodeId
       RETURN node.nodeId AS nodeId, similarity`,
      { queryVector: embedding, nodeId: testNodeId }
    );

    if (searchResult.records.length > 0) {
      const similarity = searchResult.records[0].get('similarity');
      const simVal = typeof similarity === 'object' && similarity.toNumber ? similarity.toNumber() : similarity;
      log(`Vector search returned test node with similarity: ${simVal}`);
      if (simVal > 0.9) {
        results.vectorSearch = true;
        log('Vector search validation PASSED');
      } else {
        results.errors.push(`Vector search similarity too low: ${simVal}`);
      }
    } else {
      results.errors.push('Vector search returned no results for test node');
    }
  } finally {
    // Clean up
    await session.run(
      `MATCH (n:Node {nodeId: $nodeId}) DETACH DELETE n`,
      { nodeId: testNodeId }
    );
    log('Vector search test data cleaned up');
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const driver = createDriver();

try {
  // Wait for Memgraph to be ready
  await waitForMemgraph(driver);
  log(`Connected to Memgraph at ${BOLT_URI}`);

  // Task 1: Create schema (constraints + vector index)
  const schemaSession = driver.session();
  try {
    await createConstraint(schemaSession);
    await createVectorIndex(schemaSession);
  } finally {
    await schemaSession.close();
  }

  // Task 2 + 3: Validation tests (if --validate flag or always for edge types)
  const validationSession = driver.session();
  try {
    await validateEdgeTypes(validationSession);

    if (validateMode) {
      await validateVectorSearch(validationSession);
    } else {
      results.vectorSearch = 'skipped (use --validate to test)';
    }
  } finally {
    await validationSession.close();
  }
} catch (err) {
  results.errors.push(err.message);
} finally {
  await driver.close();
}

// ── Output results ───────────────────────────────────────────────────

if (jsonMode) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('');
  console.log('=== Memgraph Schema Initialization Results ===');
  console.log(`Constraint (Node.nodeId):   ${results.constraint ? 'OK' : 'FAILED'}`);
  console.log(`Vector Index:               ${results.vectorIndex ? 'OK' : 'FAILED'}`);
  console.log(`Edge Types (8 types):       ${results.edgeTypes ? 'OK' : 'FAILED'}`);
  console.log(`Vector Search:              ${typeof results.vectorSearch === 'string' ? results.vectorSearch : results.vectorSearch ? 'OK' : 'FAILED'}`);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach((e) => console.log(`  - ${e}`));
  }

  const allPassed =
    results.constraint &&
    results.edgeTypes &&
    results.vectorIndex &&
    (results.vectorSearch === true || typeof results.vectorSearch === 'string');

  console.log('');
  if (!allPassed) {
    console.log('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: PASS');
}
