/**
 * Brownfield AST Bootstrap — Slice C
 *
 * Seeds Memgraph with the entire AST of an existing repo so a new plan
 * starts with a populated call graph instead of an empty one. Designed to
 * run once per app, ideally during app/plan creation.
 *
 * Pipeline:
 *   1. Walk the project working dir, find every supported source file
 *      (handled inside ast-extract.mjs's --scan mode).
 *   2. Write the combined AST facts to <root>/.mycelium/ast-facts.json.
 *   3. Ensure <root>/knowledge/ exists (graph-sync assumes the dir).
 *   4. Invoke graph-sync.mjs to upsert :Function / :Class / :Import
 *      nodes + DEFINES / IMPORTS / CALLS edges. The wiki-article upsert
 *      will no-op (no markdown to compile) and the AST grounding path
 *      will fire from the ast-facts.json we just wrote.
 *
 * Usage:
 *   node bootstrap-ast.mjs --project <projectId> --root <workingDir>
 *   node bootstrap-ast.mjs --project <id> --root <dir> --skip-graph-sync
 *   node bootstrap-ast.mjs --project <id> --root <dir> --skip-backup
 *
 * Env (inherited by spawned graph-sync.mjs):
 *   MEMGRAPH_URI, MEMGRAPH_USER, MEMGRAPH_PASSWORD, VOYAGE_API_KEY
 *
 * Non-blocking by design: AST extraction failures emit fallback JSON,
 * graph-sync failures are logged but the script exits 0.
 */

import { mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function log(msg) {
  console.log(`[bootstrap-ast] ${msg}`);
}
function logError(msg) {
  console.error(`[bootstrap-ast] ERROR: ${msg}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    project: null,
    root: null,
    skipGraphSync: false,
    skipBackup: false,
    skipEmbed: true, // bootstrap is structural — no Voyage spend
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--project':
        out.project = args[++i];
        break;
      case '--root':
        out.root = args[++i];
        break;
      case '--skip-graph-sync':
        out.skipGraphSync = true;
        break;
      case '--skip-backup':
        out.skipBackup = true;
        break;
      case '--with-embed':
        out.skipEmbed = false;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        console.error(`[bootstrap-ast] unknown arg: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

function printUsage() {
  console.log(`Usage:
  node bootstrap-ast.mjs --project <projectId> --root <workingDir>

Options:
  --skip-graph-sync   Stop after writing ast-facts.json (debug)
  --skip-backup       Don't push to S3 mirror (only Memgraph + local snapshot)
  --with-embed        Also embed wiki articles via Voyage (default: skipped — bootstrap is structural-only)
`);
}

/**
 * Spawn a child process and stream its stdout/stderr to ours. Resolves with
 * the exit code; never rejects so callers can decide whether non-zero is fatal.
 */
function spawnPiped(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    child.stdout.on('data', (b) => process.stdout.write(b));
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/**
 * Same as spawnPiped, but captures stdout into a buffer (used to write the
 * ast-extract JSON to disk explicitly).
 */
function spawnCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    const stdoutChunks = [];
    child.stdout.on('data', (b) => stdoutChunks.push(b));
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('close', (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      });
    });
  });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.project || !args.root) {
    logError('--project and --root are required');
    printUsage();
    process.exit(2);
  }

  // Sanity-check the root.
  try {
    const st = await stat(args.root);
    if (!st.isDirectory()) {
      logError(`--root is not a directory: ${args.root}`);
      process.exit(2);
    }
  } catch (err) {
    logError(`--root not accessible: ${err.message}`);
    process.exit(2);
  }

  log(`Bootstrapping AST graph for project=${args.project} root=${args.root}`);

  // Ensure the target dirs exist — graph-sync expects them.
  const myceliumDir = join(args.root, '.mycelium');
  const knowledgeDir = join(args.root, 'knowledge');
  const graphDir = join(knowledgeDir, '_graph');
  await mkdir(myceliumDir, { recursive: true });
  await mkdir(graphDir, { recursive: true });

  const astFactsPath = join(myceliumDir, 'ast-facts.json');
  const stateFile = join(myceliumDir, 'compile-state.json');

  // ── Step 1: Full-repo AST scan via ast-extract.mjs --scan ───────────
  log('Running ast-extract --scan over the working dir…');
  const astScriptPath = join(__dirname, 'ast-extract.mjs');
  const { code: scanCode, stdout: scanStdout } = await spawnCapture(
    process.execPath,
    [astScriptPath, '--root', args.root, '--scan'],
    { env: process.env },
  );
  if (scanCode !== 0) {
    log(`ast-extract --scan exited ${scanCode} (non-blocking — using whatever output it wrote)`);
  }
  if (!scanStdout.trim()) {
    logError('ast-extract produced no stdout — aborting');
    process.exit(1);
  }

  // Parse to surface counts in the log, then persist verbatim.
  let factsDoc;
  try {
    factsDoc = JSON.parse(scanStdout);
  } catch (err) {
    logError(`ast-extract stdout was not valid JSON: ${err.message}`);
    process.exit(1);
  }
  log(
    `Scanned ${factsDoc.fileCount} files (skipped ${factsDoc.skipped?.length ?? 0})`,
  );

  await (await import('node:fs/promises')).writeFile(
    astFactsPath,
    scanStdout,
    'utf-8',
  );
  log(`Wrote ${astFactsPath}`);

  if (args.skipGraphSync) {
    log('Skipping graph-sync (--skip-graph-sync). Bootstrap stopping here.');
    return;
  }

  // ── Step 2: Ensure compile-state.json exists (empty is fine) ────────
  if (!existsSync(stateFile)) {
    await (await import('node:fs/promises')).writeFile(stateFile, '{}', 'utf-8');
  }

  // ── Step 3: Run graph-sync.mjs ──────────────────────────────────────
  // Wiki upsert will no-op (no markdown changes); processAstFacts will
  // fire and create all the function/class/IMPORTS/CALLS rows in Memgraph
  // and emit the graph-snapshot.json the admin UI consumes.
  log('Running graph-sync.mjs to push AST → Memgraph + snapshot…');
  const graphSyncPath = join(__dirname, 'graph-sync.mjs');
  const graphSyncArgs = [
    graphSyncPath,
    '--project',
    args.project,
    '--knowledge-dir',
    knowledgeDir,
    '--state-file',
    stateFile,
  ];
  if (args.skipBackup) graphSyncArgs.push('--skip-backup');
  if (args.skipEmbed) graphSyncArgs.push('--skip-embed');

  const code = await spawnPiped(process.execPath, graphSyncArgs, {
    env: process.env,
  });
  if (code !== 0) {
    log(`graph-sync exited ${code} (non-blocking)`);
  }

  log('Bootstrap complete.');
}

main().catch((err) => {
  logError(err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
