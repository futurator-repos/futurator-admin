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

/**
 * Same as spawnCapture, but pipes `input` to the child's stdin (used to hand a
 * newline-delimited file list to service-extract via --stdin without hitting
 * argv length limits).
 */
function spawnCaptureStdin(cmd, args, input, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    const stdoutChunks = [];
    child.stdout.on('data', (b) => stdoutChunks.push(b));
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout: Buffer.concat(stdoutChunks).toString('utf-8') });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Wave-gate slot (Pipeline v3 / Epic 1): run the system-graph extractors
 * alongside the AST scan, writing one `.mycelium/<name>-facts.json` per
 * extractor for graph-sync's `processSystemGraphFacts` to ingest. Each extractor
 * is best-effort and guarded by existence of its script + input, so partial
 * Epic-1 rollouts (an extractor not yet present) degrade gracefully rather than
 * aborting the bootstrap. `scanFiles` is the file list from the AST scan, reused
 * so service-extract scans the same set.
 */
async function runSystemGraphExtractors(args, myceliumDir, scanFiles) {
  const writeFile = (await import('node:fs/promises')).writeFile;

  // infra-extract → sst.config.ts
  const infraScript = join(__dirname, 'infra-extract.mjs');
  if (existsSync(infraScript) && existsSync(join(args.root, 'sst.config.ts'))) {
    log('Running infra-extract over sst.config.ts…');
    const { stdout } = await spawnCapture(
      process.execPath,
      [infraScript, '--root', args.root, '--config', 'sst.config.ts'],
      { env: process.env },
    );
    if (stdout.trim()) {
      await writeFile(join(myceliumDir, 'infra-facts.json'), stdout, 'utf-8');
      log('Wrote .mycelium/infra-facts.json');
    }
  }

  // route-extract → functions/api/index.ts (the Hono app)
  const routeScript = join(__dirname, 'route-extract.mjs');
  const appFile = 'functions/api/index.ts';
  if (existsSync(routeScript) && existsSync(join(args.root, appFile))) {
    log('Running route-extract over the Hono app…');
    const { stdout } = await spawnCapture(
      process.execPath,
      [routeScript, '--root', args.root, '--app', appFile, '--lambda', 'infra/lambda/Api'],
      { env: process.env },
    );
    if (stdout.trim()) {
      await writeFile(join(myceliumDir, 'route-facts.json'), stdout, 'utf-8');
      log('Wrote .mycelium/route-facts.json');
    }
  }

  // service-extract → same file set as the AST scan (piped via stdin)
  const serviceScript = join(__dirname, 'service-extract.mjs');
  if (existsSync(serviceScript) && scanFiles.length > 0) {
    log('Running service-extract over scanned files…');
    const { stdout } = await spawnCaptureStdin(
      process.execPath,
      [serviceScript, '--root', args.root, '--stdin'],
      scanFiles.join('\n'),
      { env: process.env },
    );
    if (stdout.trim()) {
      await writeFile(join(myceliumDir, 'service-facts.json'), stdout, 'utf-8');
      log('Wrote .mycelium/service-facts.json');
    }
  }

  // api-calls scan → frontend api-client request paths (CALLS_ENDPOINT, W1).
  // In-process (pure lib) rather than a subprocess — it's a regex scan.
  if (scanFiles.length > 0) {
    const { readFile } = await import('node:fs/promises');
    const { extractApiCalls } = await import('./lib/system-graph-ingest.mjs');
    const calls = [];
    for (const rel of scanFiles) {
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(rel)) continue;
      try {
        const src = await readFile(join(args.root, rel), 'utf-8');
        calls.push(...extractApiCalls(rel, src));
      } catch {
        /* unreadable — skip */
      }
    }
    if (calls.length > 0) {
      await writeFile(join(myceliumDir, 'api-calls.json'), JSON.stringify({ calls }, null, 2), 'utf-8');
      log(`Wrote .mycelium/api-calls.json (${calls.length} calls)`);
    }
  }

  // semantic-extract → cross-file CALLS via the TS compiler (ts-morph). Heavier
  // than the syntactic passes, so it runs last; non-blocking.
  const semanticScript = join(__dirname, 'semantic-extract.mjs');
  if (existsSync(semanticScript)) {
    log('Running semantic-extract (ts-morph cross-file CALLS)…');
    try {
      const { stdout } = await spawnCapture(
        process.execPath,
        [semanticScript, '--root', args.root],
        { env: process.env },
      );
      if (stdout.trim()) {
        await writeFile(join(myceliumDir, 'semantic-facts.json'), stdout, 'utf-8');
        let n = '?';
        try {
          n = JSON.parse(stdout).edgeCount ?? '?';
        } catch {
          /* still wrote whatever it produced */
        }
        log(`Wrote .mycelium/semantic-facts.json (${n} cross-file CALLS edges)`);
      }
    } catch (err) {
      log(`semantic-extract skipped (non-blocking): ${err.message}`);
    }
  }
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

  // ── Step 1b: System-graph extractors (Pipeline v3 / Epic 1 slot) ────
  const scanFiles = (factsDoc.files || []).map((f) => f.path).filter(Boolean);
  await runSystemGraphExtractors(args, myceliumDir, scanFiles);

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
  if (code === 3) {
    // F16: exit 3 = genuine-orphan / orphan-invariant failure (an extractor
    // dropped an edge). Bootstrap stays non-fatal, but surface it as an operator
    // attention signal rather than swallowing it as generic noise — the count +
    // delta live in _graph/orphan-signal.json.
    logError(
      '[operator-attention] graph-sync reported genuine orphan(s) (exit 3) — see _graph/orphan-signal.json',
    );
  } else if (code !== 0) {
    log(`graph-sync exited ${code} (non-blocking)`);
  }

  log('Bootstrap complete.');
}

main().catch((err) => {
  logError(err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
