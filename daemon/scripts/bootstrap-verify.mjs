/**
 * Bootstrap Verify — Full Graph Population & Verification for Brownfield Projects
 * Story MY-6.4
 *
 * Runs graph-sync.mjs --full-resync on generated wiki, executes 5 verification
 * Cypher queries against Memgraph, backs up to S3, and updates the DynamoDB
 * project registry with knowledgeGraph metadata.
 *
 * Usage:
 *   node bootstrap-verify.mjs --project spyhunter --dir /home/ubuntu/projects/spyhunter
 *   node bootstrap-verify.mjs --project spyhunter --dir /path --skip-sync --skip-s3
 *   node bootstrap-verify.mjs --project spyhunter --dir /path --json
 *
 * Exports:
 *   verifyBootstrap(projectId, knowledgeDir) — main entry point
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

import { createGraphStore } from './lib/graph-store.mjs';

// ── Configuration ──

// Bolt/Memgraph EXCISED (EU-migration S2.2): the graph verification queries run
// over the DynamoDB GraphStore. They are SKIPPED (posture preserved) unless the
// store is configured (GRAPH_NODES_TABLE + GRAPH_EDGES_TABLE) — mirrors the old
// "graph client not installed → skip" degrade.
const GRAPH_CONFIGURED = !!(process.env.GRAPH_NODES_TABLE && process.env.GRAPH_EDGES_TABLE);
const REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET = process.env.S3_BUCKET || 'futurator-ai-website';
const REGISTRY_TABLE = process.env.REGISTRY_TABLE || 'futurator-project-registry';
const GRAPH_SYNC_PATH = process.env.GRAPH_SYNC_PATH || join(import.meta.url.replace('file://', '').replace('/bootstrap-verify.mjs', ''), 'graph-sync.mjs');

// ── Helpers ──

function log(level, msg, data = {}) {
  const prefix = {
    info: '\x1b[36mINFO\x1b[0m',
    warn: '\x1b[33mWARN\x1b[0m',
    error: '\x1b[31mERROR\x1b[0m',
    debug: '\x1b[90mDEBG\x1b[0m',
  };
  const ts = new Date().toISOString();
  const extra = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${ts}] ${prefix[level] || level} [bootstrap-verify] ${msg}${extra}`);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// ── Article Counting ──

/**
 * Count all markdown articles in the knowledge directory.
 */
function countArticlesOnDisk(knowledgeDir) {
  let count = 0;
  const articles = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip archive directory
        if (entry.name !== 'archive') {
          walk(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const relPath = relative(knowledgeDir, fullPath);
        articles.push(relPath);
        count++;
      }
    }
  }

  walk(knowledgeDir);
  return { count, articles };
}

// ── Graph Sync ──

/**
 * Execute graph-sync.mjs --full-resync.
 * Returns success status and any output.
 */
async function runGraphSync(projectId, knowledgeDir, workingDir) {
  log('info', 'Running graph-sync.mjs --full-resync...');

  const stateFile = join(workingDir, '.mycelium', 'compile-state.json');
  const cmd = `node ${GRAPH_SYNC_PATH} --project ${projectId} --knowledge-dir ${knowledgeDir} --full-resync --state-file ${stateFile}`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 300000, // 5 minute timeout
      cwd: workingDir,
      env: { ...process.env },
    });

    log('info', 'graph-sync.mjs completed successfully');
    return { success: true, output };
  } catch (err) {
    log('warn', 'graph-sync.mjs execution failed or not available', {
      error: err.message,
      note: 'This is expected if graph-sync.mjs is not yet implemented (Story 1.5)',
    });
    return { success: false, error: err.message };
  }
}

// ── Verification Queries ──

/**
 * Run all 5 verification checks against the graph store.
 */
async function runVerificationQueries(projectId, expectedArticleCount) {
  if (!GRAPH_CONFIGURED) {
    log('warn', 'graph store not configured (GRAPH_NODES_TABLE/GRAPH_EDGES_TABLE) — skipping graph verification');
    return {
      nodeCount: { passed: null, value: null, expected: expectedArticleCount, skipped: true },
      edgeCount: { passed: null, value: null, byType: {}, skipped: true },
      embeddingCoverage: { passed: null, value: null, expected: expectedArticleCount, skipped: true },
      orphanNodes: { passed: null, count: null, nodes: [], skipped: true },
      sampleQuery: { passed: null, results: [], skipped: true },
      allPassed: null,
      skipped: true,
    };
  }

  const store = await createGraphStore();
  const results = {
    nodeCount: { passed: false, value: 0, expected: expectedArticleCount },
    edgeCount: { passed: false, value: 0, byType: {} },
    // Embeddings moved to a per-project S3 sidecar (S1.5); node rows carry no
    // embedding, so coverage is not verifiable here — reported as skipped and
    // excluded from allPassed.
    embeddingCoverage: { passed: null, value: null, expected: expectedArticleCount, skipped: true },
    orphanNodes: { passed: false, count: 0, nodes: [] },
    sampleQuery: { passed: false, results: [] },
    allPassed: false,
    skipped: false,
  };

  try {
    const nodes = await store.listNodes(projectId);
    const edges = await store.listEdges(projectId);

    // Check 1: Node count
    log('info', 'Verification check 1/5: Node count...');
    results.nodeCount.value = nodes.length;
    results.nodeCount.passed = results.nodeCount.value === expectedArticleCount;
    log('info', `Node count: ${results.nodeCount.value} (expected: ${expectedArticleCount})`, {
      passed: results.nodeCount.passed,
    });

    // Check 2: Edge count by type
    log('info', 'Verification check 2/5: Edge count...');
    let totalEdges = 0;
    for (const e of edges) {
      results.edgeCount.byType[e.type] = (results.edgeCount.byType[e.type] ?? 0) + 1;
      totalEdges += 1;
    }
    results.edgeCount.value = totalEdges;
    results.edgeCount.passed = totalEdges > 0;
    log('info', `Edge count: ${totalEdges}`, { byType: results.edgeCount.byType, passed: results.edgeCount.passed });

    // Check 3: Embedding coverage — skipped (sidecar, see above)
    log('info', 'Verification check 3/5: Embedding coverage... (skipped — sidecar)');

    // Check 4: Orphan detection (nodes touched by no edge)
    log('info', 'Verification check 4/5: Orphan detection...');
    const connected = new Set();
    for (const e of edges) { connected.add(e.from); connected.add(e.to); }
    results.orphanNodes.nodes = nodes.filter((n) => !connected.has(n.nodeId)).map((n) => n.nodeId).slice(0, 50);
    results.orphanNodes.count = results.orphanNodes.nodes.length;
    results.orphanNodes.passed = true; // Warning only
    if (results.orphanNodes.count > 0) {
      log('warn', `Found ${results.orphanNodes.count} orphan node(s)`, { nodes: results.orphanNodes.nodes.slice(0, 10) });
    } else {
      log('info', 'No orphan nodes detected');
    }

    // Check 5: Sample traversal (first 10 edges)
    log('info', 'Verification check 5/5: Sample traversal...');
    results.sampleQuery.results = edges.slice(0, 10).map((e) => ({ source: e.from, rel: e.type, target: e.to }));
    results.sampleQuery.passed = results.sampleQuery.results.length > 0;
    log('info', `Sample traversal returned ${results.sampleQuery.results.length} result(s)`, {
      passed: results.sampleQuery.passed,
    });

    // Overall pass/fail (embeddingCoverage skipped; orphanNodes warning-only)
    results.allPassed =
      results.nodeCount.passed &&
      results.edgeCount.passed &&
      results.sampleQuery.passed;

  } catch (err) {
    log('error', 'Verification checks failed', { error: err.message });
    results.allPassed = false;
  } finally {
    await store.close?.();
  }

  return results;
}

// ── S3 Backup ──

/**
 * Sync knowledge directory to S3.
 */
async function backupToS3(projectId, knowledgeDir) {
  const s3Path = `s3://${S3_BUCKET}/knowledge-live/${projectId}/`;
  log('info', `Backing up to ${s3Path}...`);

  try {
    const cmd = `aws s3 sync "${knowledgeDir}" "${s3Path}" --delete --region ${REGION}`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 120000 });

    // Count synced objects
    let objectCount = 0;
    try {
      const listOutput = execSync(
        `aws s3 ls "${s3Path}" --recursive --region ${REGION} | wc -l`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      objectCount = parseInt(listOutput.trim(), 10) || 0;
    } catch { /* count is optional */ }

    log('info', `S3 backup complete`, { objectCount });
    return { success: true, objectCount, s3Path };
  } catch (err) {
    log('warn', 'S3 backup failed or AWS CLI not available', {
      error: err.message,
      note: 'S3 backup requires AWS CLI to be configured',
    });
    return { success: false, error: err.message };
  }
}

// ── DynamoDB Registry Update ──

/**
 * Update the project registry with knowledgeGraph metadata.
 */
async function updateProjectRegistry(projectId, metadata) {
  log('info', 'Updating project registry in DynamoDB...', metadata);

  try {
    // Dynamic import of AWS SDK
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = await import('@aws-sdk/lib-dynamodb');

    const ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION }),
      { marshallOptions: { removeUndefinedValues: true } }
    );

    // Update the project registry
    await ddb.send(new UpdateCommand({
      TableName: REGISTRY_TABLE,
      Key: { projectId },
      UpdateExpression: 'SET knowledgeGraph = :kg, updatedAt = :now',
      ExpressionAttributeValues: {
        ':kg': {
          nodeCount: metadata.nodeCount,
          edgeCount: metadata.edgeCount,
          lastCompileAt: new Date().toISOString(),
          memgraphSynced: metadata.memgraphSynced,
        },
        ':now': new Date().toISOString(),
      },
    }));

    // Verify by reading back
    const result = await ddb.send(new GetCommand({
      TableName: REGISTRY_TABLE,
      Key: { projectId },
    }));

    const updatedKG = result.Item?.knowledgeGraph;
    if (updatedKG) {
      log('info', 'Project registry updated successfully', updatedKG);
      return { success: true, knowledgeGraph: updatedKG };
    } else {
      log('warn', 'Project registry update could not be verified');
      return { success: true, verified: false };
    }
  } catch (err) {
    log('warn', 'DynamoDB update failed or AWS SDK not available', {
      error: err.message,
      note: 'DynamoDB update requires AWS SDK and proper credentials',
    });
    return { success: false, error: err.message };
  }
}

// ── Compile State Generation ──

/**
 * Generate .mycelium/compile-state.json with content hashes for all articles.
 */
function generateCompileState(knowledgeDir, workingDir) {
  const statePath = join(workingDir, '.mycelium', 'compile-state.json');
  const articles = {};

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'archive') {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const hash = createHash('md5').update(content).digest('hex');
          const relPath = relative(knowledgeDir, fullPath);
          articles[relPath] = {
            hash,
            lastSyncAt: new Date().toISOString(),
          };
        } catch { /* skip unreadable */ }
      }
    }
  }

  walk(knowledgeDir);

  const state = {
    projectId: null, // Set by caller
    generatedAt: new Date().toISOString(),
    articleCount: Object.keys(articles).length,
    articles,
  };

  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  log('info', `Generated compile-state.json with ${state.articleCount} article hashes`);

  return state;
}

// ── Pipeline Event Emission ──

function emitEvent(event) {
  log('info', `Pipeline event: ${event.type}`, event);
}

// ── Main Verification ──

/**
 * Main verification function.
 *
 * @param {string} projectId - Project identifier
 * @param {string} knowledgeDir - Path to knowledge/ directory
 * @param {object} opts - Options
 * @param {boolean} opts.skipSync - Skip graph-sync step
 * @param {boolean} opts.skipS3 - Skip S3 backup step
 * @param {boolean} opts.skipDynamo - Skip DynamoDB update step
 * @returns {object} Verification results
 */
export async function verifyBootstrap(projectId, knowledgeDir, opts = {}) {
  const startTime = Date.now();
  const workingDir = join(knowledgeDir, '..');

  log('info', `Starting bootstrap verification for project "${projectId}"`, { knowledgeDir });

  // Step 1: Count articles on disk
  const diskInfo = countArticlesOnDisk(knowledgeDir);
  log('info', `Found ${diskInfo.count} articles on disk`);

  emitEvent({
    type: 'progress',
    stage: 'populate',
    message: `Found ${diskInfo.count} articles to process`,
    articleCount: diskInfo.count,
  });

  // Step 2: Run graph-sync.mjs --full-resync
  let syncResult = { success: false, skipped: true };
  if (!opts.skipSync) {
    syncResult = await runGraphSync(projectId, knowledgeDir, workingDir);
  } else {
    log('info', 'Skipping graph-sync (--skip-sync)');
  }

  // Step 3: Run verification queries
  const verification = await runVerificationQueries(projectId, diskInfo.count);

  // Step 4: S3 backup
  let s3Result = { success: false, skipped: true };
  if (!opts.skipS3) {
    s3Result = await backupToS3(projectId, knowledgeDir);
  } else {
    log('info', 'Skipping S3 backup (--skip-s3)');
  }

  // Step 5: Update DynamoDB project registry
  let registryResult = { success: false, skipped: true };
  if (!opts.skipDynamo) {
    registryResult = await updateProjectRegistry(projectId, {
      nodeCount: verification.nodeCount?.value || diskInfo.count,
      edgeCount: verification.edgeCount?.value || 0,
      memgraphSynced: verification.allPassed === true,
    });
  } else {
    log('info', 'Skipping DynamoDB update (--skip-dynamo)');
  }

  // Step 6: Generate compile-state.json
  const compileState = generateCompileState(knowledgeDir, workingDir);
  compileState.projectId = projectId;
  const statePath = join(workingDir, '.mycelium', 'compile-state.json');
  writeFileSync(statePath, JSON.stringify(compileState, null, 2), 'utf-8');

  // Step 7: Append final log entry
  const durationMs = Date.now() - startTime;
  appendVerifyLog(knowledgeDir, {
    projectId,
    articleCount: diskInfo.count,
    nodeCount: verification.nodeCount?.value,
    edgeCount: verification.edgeCount?.value,
    edgesByType: verification.edgeCount?.byType || {},
    embeddedCount: verification.embeddingCoverage?.value,
    orphanCount: verification.orphanNodes?.count,
    allPassed: verification.allPassed,
    syncSuccess: syncResult.success,
    s3Success: s3Result.success,
    registrySuccess: registryResult.success,
    durationMs,
  });

  // Build final report
  const report = {
    projectId,
    articleCount: diskInfo.count,
    graphSync: {
      success: syncResult.success,
      skipped: syncResult.skipped || false,
    },
    verification: {
      nodeCount: verification.nodeCount,
      edgeCount: verification.edgeCount,
      embeddingCoverage: verification.embeddingCoverage,
      orphanNodes: verification.orphanNodes,
      sampleQuery: verification.sampleQuery,
      allPassed: verification.allPassed,
      skipped: verification.skipped || false,
    },
    s3Backup: {
      success: s3Result.success,
      skipped: s3Result.skipped || false,
      s3Path: s3Result.s3Path,
    },
    registryUpdate: {
      success: registryResult.success,
      skipped: registryResult.skipped || false,
    },
    compileState: {
      articleCount: compileState.articleCount,
      path: statePath,
    },
    durationMs,
  };

  // Emit completion event
  emitEvent({
    type: 'complete',
    stage: 'populate',
    verification: {
      nodeCount: verification.nodeCount?.value,
      edgeCount: verification.edgeCount?.value,
      allPassed: verification.allPassed,
    },
    durationMs,
  });

  // Log warnings for failed checks
  if (verification.allPassed === false && !verification.skipped) {
    log('warn', 'Some verification checks failed', {
      nodeCount: verification.nodeCount?.passed,
      edgeCount: verification.edgeCount?.passed,
      embeddingCoverage: verification.embeddingCoverage?.passed,
      sampleQuery: verification.sampleQuery?.passed,
    });
    emitEvent({
      type: 'warning',
      stage: 'populate',
      message: 'Verification checks failed — see report for details',
    });
  }

  log('info', 'Bootstrap verification complete', {
    articleCount: diskInfo.count,
    allPassed: verification.allPassed,
    durationMs,
  });

  return report;
}

/**
 * Append verification record to knowledge/log.md.
 */
function appendVerifyLog(knowledgeDir, stats) {
  const logPath = join(knowledgeDir, 'log.md');
  if (!existsSync(logPath)) return;

  const existing = readFileSync(logPath, 'utf-8');

  const edgesByTypeStr = Object.entries(stats.edgesByType)
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ') || 'none';

  const entry = `
### bootstrap-verify - ${new Date().toISOString()}

- **Project:** ${stats.projectId}
- **Articles on Disk:** ${stats.articleCount}
- **Memgraph Nodes:** ${stats.nodeCount ?? 'N/A'}
- **Memgraph Edges:** ${stats.edgeCount ?? 'N/A'} (${edgesByTypeStr})
- **Embeddings:** ${stats.embeddedCount ?? 'N/A'}
- **Orphan Nodes:** ${stats.orphanCount ?? 'N/A'}
- **All Checks Passed:** ${stats.allPassed ?? 'N/A'}
- **Graph Sync:** ${stats.syncSuccess ? 'success' : 'skipped/failed'}
- **S3 Backup:** ${stats.s3Success ? 'success' : 'skipped/failed'}
- **Registry Update:** ${stats.registrySuccess ? 'success' : 'skipped/failed'}
- **Duration:** ${(stats.durationMs / 1000).toFixed(1)}s

---
_End of brownfield bootstrap pipeline log._
`;

  writeFileSync(logPath, existing + entry, 'utf-8');
}

// ── CLI Entry Point ──

async function main() {
  const args = process.argv.slice(2);

  let projectId = null;
  let workingDir = null;
  let jsonOutput = false;
  let skipSync = false;
  let skipS3 = false;
  let skipDynamo = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--project':
        projectId = args[++i];
        break;
      case '--dir':
      case '--working-dir':
        workingDir = args[++i];
        break;
      case '--json':
        jsonOutput = true;
        break;
      case '--skip-sync':
        skipSync = true;
        break;
      case '--skip-s3':
        skipS3 = true;
        break;
      case '--skip-dynamo':
        skipDynamo = true;
        break;
      case '--help':
        console.log(`
Usage: node bootstrap-verify.mjs --project <id> --dir <path> [options]

Options:
  --project <id>     Project identifier (e.g., "spyhunter")
  --dir <path>       Path to project root directory
  --json             Output results as JSON
  --skip-sync        Skip graph-sync.mjs execution
  --skip-s3          Skip S3 backup
  --skip-dynamo      Skip DynamoDB project registry update
  --help             Show this help message
`);
        process.exit(0);
    }
  }

  if (!projectId || !workingDir) {
    console.error('Error: --project and --dir are required');
    console.error('Usage: node bootstrap-verify.mjs --project <id> --dir /path/to/project');
    process.exit(1);
  }

  const knowledgeDir = join(workingDir, 'knowledge');
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: knowledge/ directory not found at ${knowledgeDir}`);
    console.error('Run the bootstrap pipeline (scan, deps, decisions) first.');
    process.exit(1);
  }

  try {
    const report = await verifyBootstrap(projectId, knowledgeDir, {
      skipSync,
      skipS3,
      skipDynamo,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('\n=== Bootstrap Verification Report ===');
      console.log(`  Project:            ${report.projectId}`);
      console.log(`  Articles on disk:   ${report.articleCount}`);
      console.log('');

      console.log('  Graph Sync:');
      console.log(`    Status:           ${report.graphSync.skipped ? 'skipped' : (report.graphSync.success ? 'success' : 'FAILED')}`);
      console.log('');

      if (!report.verification.skipped) {
        console.log('  Verification:');
        console.log(`    Node count:       ${report.verification.nodeCount.value}/${report.verification.nodeCount.expected} ${report.verification.nodeCount.passed ? 'PASS' : 'FAIL'}`);
        console.log(`    Edge count:       ${report.verification.edgeCount.value} ${report.verification.edgeCount.passed ? 'PASS' : 'FAIL'}`);
        if (Object.keys(report.verification.edgeCount.byType).length > 0) {
          for (const [type, count] of Object.entries(report.verification.edgeCount.byType)) {
            console.log(`      ${type}: ${count}`);
          }
        }
        console.log(`    Embeddings:       ${report.verification.embeddingCoverage.skipped ? 'skipped (S3 sidecar)' : `${report.verification.embeddingCoverage.value}/${report.verification.embeddingCoverage.expected} ${report.verification.embeddingCoverage.passed ? 'PASS' : 'FAIL'}`}`);
        console.log(`    Orphan nodes:     ${report.verification.orphanNodes.count} (warning only)`);
        console.log(`    Sample query:     ${report.verification.sampleQuery.results.length} results ${report.verification.sampleQuery.passed ? 'PASS' : 'FAIL'}`);
        console.log(`    ALL PASSED:       ${report.verification.allPassed ? 'YES' : 'NO'}`);
      } else {
        console.log('  Verification:       skipped (graph store not configured)');
      }
      console.log('');

      console.log('  S3 Backup:');
      console.log(`    Status:           ${report.s3Backup.skipped ? 'skipped' : (report.s3Backup.success ? 'success' : 'FAILED')}`);
      if (report.s3Backup.s3Path) {
        console.log(`    Path:             ${report.s3Backup.s3Path}`);
      }
      console.log('');

      console.log('  Registry Update:');
      console.log(`    Status:           ${report.registryUpdate.skipped ? 'skipped' : (report.registryUpdate.success ? 'success' : 'FAILED')}`);
      console.log('');

      console.log(`  Compile State:      ${report.compileState.articleCount} article hashes`);
      console.log(`  Duration:           ${(report.durationMs / 1000).toFixed(1)}s`);
      console.log('');
    }
  } catch (err) {
    console.error('Bootstrap verification failed:', err.message);
    if (!jsonOutput) console.error(err.stack);
    process.exit(1);
  }
}

// Run if executed directly
const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith('bootstrap-verify.mjs') ||
  process.argv[1].endsWith('bootstrap-verify')
);

if (isDirectExecution) {
  main();
}
