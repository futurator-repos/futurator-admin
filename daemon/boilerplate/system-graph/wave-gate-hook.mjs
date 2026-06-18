#!/usr/bin/env node
/**
 * wave-gate-hook.mjs — BOILERPLATE TEMPLATE (Epic 7, Story 7.2).
 *
 * Copy this one file into a new app's boilerplate and call it from the repo's
 * wave-gate slot. It makes the app graph-ready with NO per-repo code:
 *
 *   - first build  → full-repo bootstrap (bootstrap-ast --scan): seeds the
 *                    whole system graph (ast + infra/route/service + api-calls).
 *   - later waves  → incremental system-graph step (the four extractors + sync).
 *
 * It locates the daemon's `system-graph-bootstrap.mjs` via the
 * `SYSTEM_GRAPH_LIB` env var (point it at `<daemon>/scripts/lib`), or falls back
 * to a sibling `daemon/` checkout. Everything else is convention-driven from the
 * repo root.
 *
 * Usage (from the repo root, in the wave-gate slot):
 *   SYSTEM_GRAPH_LIB=/path/to/daemon/scripts/lib \
 *     node boilerplate/system-graph/wave-gate-hook.mjs --root . [--global] [--wave-gate <id>]
 *
 * Env (inherited by the spawned scripts): MEMGRAPH_URI, MEMGRAPH_USER,
 * MEMGRAPH_PASSWORD, VOYAGE_API_KEY.
 */

import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = { root: '.' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--root') out.root = a[++i];
    else if (a[i] === '--project') out.project = a[++i];
    else if (a[i] === '--global') out.global = true;
    else if (a[i] === '--wave-gate') out.waveGate = a[++i];
  }
  out.root = resolve(out.root);
  return out;
}

function resolveLibDir() {
  if (process.env.SYSTEM_GRAPH_LIB && existsSync(process.env.SYSTEM_GRAPH_LIB)) {
    return process.env.SYSTEM_GRAPH_LIB;
  }
  // Fallback: a sibling `daemon/` checkout next to this repo.
  const guess = resolve(process.cwd(), '..', 'daemon', 'scripts', 'lib');
  if (existsSync(guess)) return guess;
  throw new Error(
    'Cannot locate system-graph lib. Set SYSTEM_GRAPH_LIB=/path/to/daemon/scripts/lib',
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const libDir = resolveLibDir();
  const mod = await import(pathToFileURL(join(libDir, 'system-graph-bootstrap.mjs')).href);
  const result = await mod.runWaveGateGraph(args, { log: (m) => console.error(m) });
  console.error(`[system-graph] ${result.mode} → ${result.ran} (project=${result.project})`);
}

main().catch((err) => {
  console.error('[system-graph] wave-gate hook failed (non-blocking):', err.message);
  // Non-blocking: a graph failure must never fail the wave gate itself.
  process.exit(0);
});
