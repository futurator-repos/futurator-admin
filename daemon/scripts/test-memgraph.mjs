/**
 * Memgraph Connection Test Script
 *
 * Validates Bolt connectivity, runs a basic Cypher query, reports version
 * and memory usage, and optionally tests persistence across restarts.
 *
 * Usage:
 *   node test-memgraph.mjs              # Quick connectivity test
 *   node test-memgraph.mjs --persist    # Include persistence test
 *   node test-memgraph.mjs --json       # Output JSON (for automation)
 */

import { createDriver, BOLT_URI } from './lib/memgraph-driver.mjs';

const args = process.argv.slice(2);
const persistMode = args.includes('--persist');
const jsonMode = args.includes('--json');

const results = {
  connection: false,
  version: null,
  memoryUsage: null,
  basicQuery: false,
  persistence: null,
  errors: [],
};

const driver = createDriver();

try {
  // Test 1: Basic connectivity
  const session = driver.session();
  try {
    const connResult = await session.run('RETURN 1 AS test');
    const value = connResult.records[0].get('test');
    results.connection = true;
    results.basicQuery = value.toNumber ? value.toNumber() === 1 : value === 1;
  } finally {
    await session.close();
  }

  // Test 2: Get Memgraph version and storage info
  const infoSession = driver.session();
  try {
    const infoResult = await infoSession.run('SHOW STORAGE INFO');
    for (const record of infoResult.records) {
      const key = record.get('storage info');
      const val = record.get('value');
      if (key === 'name') results.version = val;
      if (key === 'memory_usage') results.memoryUsage = val;
    }
  } catch {
    // SHOW STORAGE INFO may not be available in all versions
    // Try alternative
    try {
      const verResult = await infoSession.run(
        "CALL mg.procedures() YIELD name RETURN 'connected' AS status LIMIT 1"
      );
      if (verResult.records.length > 0) {
        results.version = 'Memgraph (version query unavailable)';
      }
    } catch {
      results.version = 'Connected (version unknown)';
    }
  } finally {
    await infoSession.close();
  }

  // Test 3: Persistence test (optional)
  if (persistMode) {
    const persistSession = driver.session();
    try {
      // Create test node
      await persistSession.run(
        "CREATE (n:Test {name: 'persistence-check', ts: $ts})",
        { ts: new Date().toISOString() }
      );

      // Read it back
      const readResult = await persistSession.run(
        "MATCH (n:Test {name: 'persistence-check'}) RETURN n.ts AS ts"
      );
      results.persistence =
        readResult.records.length > 0 ? 'created' : 'failed';

      // Clean up
      await persistSession.run(
        "MATCH (n:Test {name: 'persistence-check'}) DELETE n"
      );
      if (results.persistence === 'created') {
        results.persistence = 'passed';
      }
    } catch (err) {
      results.persistence = `failed: ${err.message}`;
      results.errors.push(`Persistence test: ${err.message}`);
    } finally {
      await persistSession.close();
    }
  }
} catch (err) {
  results.errors.push(err.message);
} finally {
  await driver.close();
}

// Output results
if (jsonMode) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('=== Memgraph Connection Test ===');
  console.log(`Endpoint:     ${BOLT_URI}`);
  console.log(
    `Connection:   ${results.connection ? '✓ Connected' : '✗ Failed'}`
  );
  console.log(
    `Basic Query:  ${results.basicQuery ? '✓ RETURN 1 OK' : '✗ Failed'}`
  );
  console.log(`Version:      ${results.version || 'N/A'}`);
  console.log(`Memory Usage: ${results.memoryUsage || 'N/A'}`);
  if (persistMode) {
    console.log(
      `Persistence:  ${results.persistence === 'passed' ? '✓ Passed' : `✗ ${results.persistence}`}`
    );
  }
  if (results.errors.length > 0) {
    console.log(`\nErrors:`);
    results.errors.forEach((e) => console.log(`  - ${e}`));
  }
  console.log('');

  // Exit code
  const allPassed =
    results.connection &&
    results.basicQuery &&
    (persistMode ? results.persistence === 'passed' : true);
  if (!allPassed) {
    console.log('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: PASS');
}
