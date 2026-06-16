/**
 * system-graph-step.mjs — Story 7.1 (PRD §8 P10). The four system-graph
 * extractors + graph-sync wiring packaged as ONE reusable, config-driven
 * wave-gate step, so any repo adopts the system graph through a single
 * integration point — no per-repo code.
 *
 * Each extractor (`infra/route/service/ast`) is a deterministic, zero-LLM script
 * that emits its envelope to STDOUT. This step runs each against the repo's own
 * `sst.config.ts` + Hono app, captures stdout into `<root>/.mycelium/<name>-
 * facts.json` (where `graph-sync`'s `processSystemGraphFacts` reads them), then
 * runs `graph-sync` to ingest. Keep it config-driven (config path, app path,
 * lambda id) — that's what makes it reusable.
 *
 * Core is pure + dependency-injected (`run`/`writeFile`/`log`) so it unit-tests
 * without spawning processes; the CLI wires the real subprocess runner.
 */

import { execFile } from 'node:child_process';
import { writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The extractor + graph-sync scripts live one level up (daemon/scripts/). */
const SCRIPTS_DIR = join(__dirname, '..');

/** Resolve a repo's step config from sparse input, applying the conventions. */
export function resolveStepConfig(input = {}) {
  const root = input.root;
  return {
    root,
    config: input.config ?? 'sst.config.ts',
    app: input.app ?? 'functions/api/index.ts',
    lambda: input.lambda ?? 'infra/lambda/Api',
    project: input.project ?? (root ? basename(root) : null),
    knowledgeDir: input.knowledgeDir ?? (root ? join(root, 'knowledge') : null),
    myceliumDir: input.myceliumDir ?? (root ? join(root, '.mycelium') : null),
    // Full-repo bootstrap (Story 7.2) vs incremental wave.
    scan: input.scan ?? false,
    global: input.global ?? false,
    waveGate: input.waveGate ?? null,
    // Source file list for service-extract (it needs explicit files); when
    // absent the service extractor is skipped rather than guessed at.
    sourceFiles: input.sourceFiles ?? null,
  };
}

/**
 * The ordered extractor plan. infra → route → (service) → ast. service is
 * included only when a source-file list is available (the extractor requires
 * explicit files). Each step names the script, its args, and the envelope file
 * its stdout is captured into.
 */
export function buildExtractorPlan(config) {
  const out = (f) => (config.myceliumDir ? join(config.myceliumDir, f) : f);
  const plan = [
    {
      name: 'infra',
      script: 'infra-extract.mjs',
      args: ['--root', config.root, '--config', config.config],
      outFile: out('infra-facts.json'),
    },
    {
      name: 'route',
      script: 'route-extract.mjs',
      args: ['--root', config.root, '--app', config.app, '--lambda', config.lambda],
      outFile: out('route-facts.json'),
    },
  ];
  if (config.sourceFiles && config.sourceFiles.length) {
    plan.push({
      name: 'service',
      script: 'service-extract.mjs',
      args: ['--root', config.root, '--files', config.sourceFiles.join(',')],
      outFile: out('service-facts.json'),
    });
  }
  plan.push({
    name: 'ast',
    script: 'ast-extract.mjs',
    args: ['--root', config.root, ...(config.scan ? ['--scan'] : [])],
    outFile: out('ast-facts.json'),
  });
  return plan;
}

/** graph-sync args from the step config (carries --global / --wave-gate through). */
export function buildSyncArgs(config) {
  const args = ['--project', config.project, '--knowledge-dir', config.knowledgeDir];
  if (config.global) args.push('--global');
  if (config.waveGate) args.push('--wave-gate', config.waveGate);
  return args;
}

/**
 * Run the full step: every extractor (stdout → envelope file), then graph-sync.
 * Non-blocking per extractor — one failing extractor is logged and skipped, the
 * rest (and graph-sync) still run, mirroring the daemon's graceful-degradation
 * discipline.
 *
 * @param {object} input - sparse step config (see resolveStepConfig)
 * @param {{ run:Function, writeFile?:Function, log?:Function, mkdir?:Function }} deps
 *   run(script, args) → Promise<stdout string>
 */
export async function runSystemGraphStep(input, deps = {}) {
  const run = deps.run;
  if (typeof run !== 'function') throw new Error('runSystemGraphStep requires a `run` dependency');
  const writeFile = deps.writeFile ?? fsWriteFile;
  const log = deps.log ?? (() => {});
  const ensureDir = deps.mkdir ?? ((p) => mkdir(p, { recursive: true }));

  const config = resolveStepConfig(input);
  if (!config.root || !config.project || !config.knowledgeDir) {
    throw new Error('runSystemGraphStep requires root, project, and knowledgeDir');
  }
  if (config.myceliumDir) await ensureDir(config.myceliumDir);

  const plan = buildExtractorPlan(config);
  const results = [];
  for (const step of plan) {
    try {
      const stdout = await run(step.script, step.args);
      await writeFile(step.outFile, stdout);
      results.push({ name: step.name, ok: true, outFile: step.outFile });
    } catch (err) {
      log(`[system-graph-step] ${step.name} extractor failed (non-blocking): ${err.message}`);
      results.push({ name: step.name, ok: false, error: err.message });
    }
  }

  let synced = false;
  try {
    await run('graph-sync.mjs', buildSyncArgs(config));
    synced = true;
  } catch (err) {
    log(`[system-graph-step] graph-sync failed: ${err.message}`);
  }

  return { config, plan, results, synced };
}

// ── Default subprocess runner + CLI ──────────────────────────────────────────

/** Default `run`: `node <SCRIPTS_DIR/script> ...args`, resolving stdout. */
export function defaultRun(script, args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(SCRIPTS_DIR, script), ...args],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '--root': out.root = a[++i]; break;
      case '--config': out.config = a[++i]; break;
      case '--app': out.app = a[++i]; break;
      case '--lambda': out.lambda = a[++i]; break;
      case '--project': out.project = a[++i]; break;
      case '--knowledge-dir': out.knowledgeDir = a[++i]; break;
      case '--files': out.sourceFiles = a[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--scan': out.scan = true; break;
      case '--global': out.global = true; break;
      case '--wave-gate': out.waveGate = a[++i]; break;
      default:
        console.error(`[system-graph-step] unknown arg: ${a[i]}`);
        process.exit(2);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runSystemGraphStep(parseArgs(process.argv), {
    run: defaultRun,
    log: (m) => console.error(m),
  })
    .then((r) => {
      console.error(
        `[system-graph-step] ${r.results.filter((x) => x.ok).length}/${r.plan.length} extractor(s) ok; ` +
          `graph-sync ${r.synced ? 'ran' : 'skipped'}`,
      );
    })
    .catch((err) => {
      console.error('[system-graph-step] fatal:', err.message);
      process.exit(1);
    });
}
