/**
 * materialize-worktree.mjs — Pipeline v2 / Story 1.4.3 step 2.
 *
 * Adds the primary worktree for an App at `<projectsRoot>/<slug>` checked out
 * to `main`. Idempotent: if the worktree directory already exists AND is a
 * registered worktree of the bare repo, this is a no-op.
 *
 * @param {object}   args
 * @param {string}   args.appId
 * @param {string}   [args.reposRoot]    — defaults to `/home/ubuntu/repos`
 * @param {string}   [args.projectsRoot] — defaults to `/home/ubuntu/projects`
 * @param {string}   [args.branch]       — defaults to `main`
 * @param {object}   [args.fs]           — { existsSync } shim for tests
 * @param {function} [args.execGit]      — git runner for tests
 * @param {function} [args.onOutput]     — `(stream,data)` log sink
 */

import { existsSync as fsExistsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const APP_BOOTSTRAP_MATERIALIZE_WORKTREE_STEP = 'materialize-worktree';

export async function runMaterializeWorktree({
  appId,
  reposRoot = '/home/ubuntu/repos',
  projectsRoot = '/home/ubuntu/projects',
  branch = 'main',
  fs = { existsSync: fsExistsSync },
  execGit = defaultExecGit,
  onOutput,
} = {}) {
  if (!appId) throw new Error('runMaterializeWorktree: appId required');

  const baredir = join(reposRoot, `${appId}.git`);
  const worktreeDir = join(projectsRoot, appId);

  if (!fs.existsSync(baredir)) {
    throw new Error(
      `bare repo not found at ${baredir} — bare-clone step must run first`,
    );
  }

  // Idempotency probe: an active worktree has a `.git` file (not a dir)
  // pointing back at the bare repo. If that file is present, we're done.
  if (fs.existsSync(worktreeDir) && fs.existsSync(join(worktreeDir, '.git'))) {
    return { skipped: true, worktreeDir };
  }

  await execGit(
    ['-C', baredir, 'worktree', 'add', worktreeDir, branch],
    { onOutput },
  );

  return { skipped: false, worktreeDir };
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
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}
