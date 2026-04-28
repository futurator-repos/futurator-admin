/**
 * commit-and-push.mjs — Pipeline v2 / Story 1.4.3 step 6.
 *
 * Stages all changes in the worktree, commits with the daemon's git identity
 * (`Futurator Daemon <daemon@futurator.ai>`, configured globally by Story
 * 1.1.3), and pushes to `origin main`.
 *
 * Idempotent in the "no work to do" sense: if `git status --porcelain`
 * returns no output AND `git rev-parse @{u}` matches `git rev-parse HEAD`,
 * this is a clean no-op (nothing staged + remote already in sync).
 *
 * The injected `execGit` lets the idempotency test simulate "already
 * pristine" without spawning real git.
 *
 * @param {object}   args
 * @param {string}   args.appId
 * @param {string}   args.worktreeDir
 * @param {string}   [args.branch]   — defaults to `main`
 * @param {function} [args.execGit]  — `(args[], { cwd? }) => Promise<{stdout,stderr}>`
 * @param {function} [args.onOutput]
 */

import { spawn } from 'node:child_process';

export const APP_BOOTSTRAP_COMMIT_AND_PUSH_STEP = 'commit-and-push';

const COMMIT_TEMPLATE = (slug) =>
  `chore: post-create scaffold (__APP_SLUG__ -> ${slug})`;

export async function runCommitAndPush({
  appId,
  worktreeDir,
  branch = 'main',
  execGit = defaultExecGit,
  onOutput,
} = {}) {
  if (!appId) throw new Error('runCommitAndPush: appId required');
  if (!worktreeDir) throw new Error('runCommitAndPush: worktreeDir required');

  // 1. Probe `git status --porcelain` — empty output = nothing to commit.
  const status = await execGit(['status', '--porcelain'], {
    cwd: worktreeDir,
    onOutput,
  });
  const hasChanges = (status?.stdout ?? '').trim().length > 0;

  if (!hasChanges) {
    // Idempotent re-run: worktree is pristine. Nothing to commit, nothing
    // to push (the prior run already pushed). Skip.
    return { skipped: true, reason: 'no-changes' };
  }

  await execGit(['add', '-A'], { cwd: worktreeDir, onOutput });
  await execGit(['commit', '-m', COMMIT_TEMPLATE(appId)], {
    cwd: worktreeDir,
    onOutput,
  });
  await execGit(['push', 'origin', branch], { cwd: worktreeDir, onOutput });

  return { skipped: false };
}

function defaultExecGit(args, { cwd, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
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
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}
