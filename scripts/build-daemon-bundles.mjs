#!/usr/bin/env node
/**
 * Pipeline v2.0 PR-8f #1 — bundle TypeScript modules consumed by daemon
 * shell steps into self-contained CommonJS files at known paths.
 *
 * Why this exists:
 *
 *   The qa-aggregate shell step (built by `buildQaAggregatePipeline`)
 *   shells out to `node -e` and requires a classifier module:
 *
 *     require(process.env.QA_CLASSIFIER_PATH ||
 *             '/opt/futurator-daemon/lib/visual-test-classifier-bundle.cjs')
 *
 *   The classifier itself lives in functions/shared/services/visual-test-
 *   classifier.ts — TypeScript with ESM imports. The daemon runs CJS
 *   (despite `"type": "module"` in package.json, the `node -e` invocation
 *   that runs from inside a bash heredoc defaults to CJS unless the file
 *   ends in .mjs). esbuild lets us produce one self-contained .cjs that
 *   `require()` resolves cleanly.
 *
 * What this builds:
 *
 *   • daemon/lib/visual-test-classifier-bundle.cjs
 *
 * When to run:
 *
 *   • Automatically by scripts/rsync-daemon.sh before rsyncing the
 *     daemon tree to EC2.
 *   • Manually via `node scripts/build-daemon-bundles.mjs` when iterating
 *     locally (the bundled file is .gitignored — see .gitignore for
 *     daemon/lib/*-bundle.cjs).
 *
 * Failure mode if not run:
 *
 *   qa-aggregate exits with `Error: Cannot find module '/opt/futurator-
 *   daemon/lib/visual-test-classifier-bundle.cjs'`. The shell step's
 *   captureAs/extractors fail; daemon marks the agent job FAILED;
 *   plan.qaAggregateJobId is set but the contract draft never appears.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Each entry produces one self-contained CommonJS bundle the daemon's
 * `node -e` shell steps can `require()` directly. Keep the entries
 * minimal — bundling pulls every transitive import, so each entry-point
 * should be a tight, side-effect-free utility module.
 */
const BUNDLES = [
  {
    name: 'visual-test-classifier',
    entryPoint: resolve(
      REPO_ROOT,
      'functions/shared/services/visual-test-classifier.ts',
    ),
    outfile: resolve(
      REPO_ROOT,
      'daemon/lib/visual-test-classifier-bundle.cjs',
    ),
  },
];

async function main() {
  // Ensure daemon/lib exists (the rest of the dir is committed).
  mkdirSync(resolve(REPO_ROOT, 'daemon/lib'), { recursive: true });

  for (const bundle of BUNDLES) {
    process.stdout.write(`Building ${bundle.name}... `);
    const result = await build({
      entryPoints: [bundle.entryPoint],
      outfile: bundle.outfile,
      bundle: true,
      // CJS so the qa-aggregate node-eval call's `require()` resolves
      // synchronously; ESM would force --input-type=module + dynamic
      // import which is awkward inside a single-line node -e call.
      format: 'cjs',
      platform: 'node',
      // Node 20+ on EC2 — match the daemon's runtime.
      target: 'node20',
      // No external deps — the daemon's node_modules is intentionally
      // minimal; we want the classifier to be fully self-contained.
      external: [],
      // Side-effect-free utilities only — esbuild can drop unused exports.
      treeShaking: true,
      sourcemap: false,
      logLevel: 'error',
    });
    if (result.errors.length > 0) {
      console.error('FAILED');
      console.error(result.errors);
      process.exit(1);
    }
    console.log('ok →', bundle.outfile.replace(REPO_ROOT + '/', ''));
  }
}

main().catch((err) => {
  console.error('Bundle build failed:', err);
  process.exit(1);
});
