/**
 * bare-clone.mjs — Pipeline v2 / Story 1.4.3 step 1.
 *
 * Idempotent bare clone of `futurator-repos/<slug>` into
 * `<reposRoot>/<slug>.git`. Re-running on an existing bare repo is a no-op
 * (we just verify the directory exists and looks like a git bare repo).
 *
 * The daemon's git identity is configured globally by Story 1.1.3
 * (`url.https://x-access-token:<PAT>@github.com/.insteadOf https://github.com/`),
 * so this clone authenticates transparently — no PAT touches this file.
 *
 * Contract:
 *   - On first run: runs `git clone --bare <httpsUrl> <baredir>`.
 *   - On re-run with an existing bare dir: returns `{ skipped: true }`.
 *   - Failure of any kind: throws Error so the caller can catch and emit a
 *     `pv2-app-bootstrap-failed` attention item.
 *
 * @param {object}   args
 * @param {string}   args.appId            — slug
 * @param {string}   args.reposRoot        — defaults to `/home/ubuntu/repos`
 * @param {string}   [args.cloneUrlOverride] — for tests; defaults to the
 *                                            HTTPS URL of `futurator-repos/<slug>`
 * @param {object}   [args.fs]             — { existsSync } shim for tests
 * @param {function} [args.execGit]        — `(args[]) => Promise<{stdout,stderr}>`
 *                                            for tests; defaults to spawn-based
 *                                            `git` runner
 * @param {function} [args.onOutput]       — optional `(stream,data)` for live logs
 */

import { existsSync as fsExistsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const APP_BOOTSTRAP_BARE_CLONE_STEP = 'bare-clone';

export async function runBareClone({
  appId,
  reposRoot = '/home/ubuntu/repos',
  cloneUrlOverride,
  fs = { existsSync: fsExistsSync },
  execGit = defaultExecGit,
  onOutput,
} = {}) {
  if (!appId) throw new Error('runBareClone: appId required');

  const baredir = join(reposRoot, `${appId}.git`);

  // Idempotency: a bare git repo has a `HEAD` file at its root. Use that as
  // the cheap probe — `existsSync` of the dir alone is not enough because a
  // half-failed clone could leave an empty directory behind.
  if (fs.existsSync(baredir) && fs.existsSync(join(baredir, 'HEAD'))) {
    return { skipped: true, baredir };
  }

  const cloneUrl =
    cloneUrlOverride ?? `https://github.com/futurator-repos/${appId}.git`;

  await execGit(['clone', '--bare', cloneUrl, baredir], { onOutput });

  return { skipped: false, baredir };
}

function defaultExecGit(args, { onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      else reject(new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`));
    });
  });
}
