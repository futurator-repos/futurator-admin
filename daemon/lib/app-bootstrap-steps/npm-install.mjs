/**
 * npm-install.mjs — Pipeline v2 / Story 1.4.3 step 4.
 *
 * Runs `npm install` inside the worktree when the boilerplate's stack runtime
 * is `'node'`. Skipped on stub types (sst/vite/mobile in Phase 1 don't have
 * package.json) and on `'react-native'` (mobile needs Expo's flow, not npm).
 *
 * Idempotency is delegated to npm itself: a second `npm install` against an
 * already-installed `node_modules/` is the standard "verify and link" no-op
 * pattern. We DO add a fast path that skips the spawn entirely when
 * `node_modules/` and `package-lock.json` are both already present, to keep
 * re-runs fast in the daemon idempotency test.
 *
 * @param {object}   args
 * @param {string}   args.worktreeDir
 * @param {string}   [args.runtime]    — `'node' | 'bun' | 'react-native'`. Skips
 *                                       unless `'node'`.
 * @param {boolean}  [args.skip]       — caller-supplied skip override (used
 *                                       for stub types from the registry).
 * @param {object}   [args.fs]         — { existsSync } shim
 * @param {function} [args.execNpm]    — for tests; defaults to a spawn-based
 *                                       runner of `npm install`.
 * @param {function} [args.onOutput]   — log sink
 */

import { existsSync as fsExistsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const APP_BOOTSTRAP_NPM_INSTALL_STEP = 'npm-install';

export async function runNpmInstall({
  worktreeDir,
  runtime = 'node',
  skip = false,
  fs = { existsSync: fsExistsSync },
  execNpm = defaultExecNpm,
  onOutput,
} = {}) {
  if (!worktreeDir) throw new Error('runNpmInstall: worktreeDir required');

  if (skip || runtime !== 'node') {
    return { skipped: true, reason: skip ? 'stub-type' : `runtime=${runtime}` };
  }

  if (!fs.existsSync(join(worktreeDir, 'package.json'))) {
    return { skipped: true, reason: 'no-package-json' };
  }

  // Fast-path: re-runs of an already-installed worktree are no-ops.
  const hasNodeModules = fs.existsSync(join(worktreeDir, 'node_modules'));
  const hasLockfile = fs.existsSync(join(worktreeDir, 'package-lock.json'));
  if (hasNodeModules && hasLockfile) {
    return { skipped: true, reason: 'already-installed' };
  }

  await execNpm(['install', '--no-audit', '--no-fund'], { worktreeDir, onOutput });

  return { skipped: false };
}

function defaultExecNpm(args, { worktreeDir, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: worktreeDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      stdout += s;
      onOutput?.('stdout', s);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      stderr += s;
      onOutput?.('stderr', s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`npm ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}
