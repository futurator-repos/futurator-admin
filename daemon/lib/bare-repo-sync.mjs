/**
 * bare-repo-sync.mjs — pull-latest-before-work for brownfield apps (2026-05-30).
 *
 * Brownfield apps (migrated from a real GitHub repo, any org) treat GitHub as
 * the source of truth for `main`; EC2 is a one-way downstream mirror. Before a
 * debate or plan starts, we sync `main` to `origin/main` so work begins from
 * the latest pushed code (the operator's laptop, or other machines/agents).
 *
 * MECHANISM (verified 2026-05-30): the bare repo's `main` is checked out as a
 * worktree at `/home/ubuntu/projects/<appId>`, and ALL worktrees share one
 * `refs/heads/main` ref store. So `git fetch + reset --hard origin/main` in
 * that working copy updates the single shared `main` that party/plan worktrees
 * fork from (they do `worktree add -B <branch> main`). A bare `--git-dir fetch`
 * into refs/heads/main is refused because main is checked out — hence the
 * working-copy reset.
 *
 * SAFETY: `main` only — it's a pure downstream mirror (the daemon never commits
 * to main). `plan/<slug>` is EC2-owned (wave-merge builds it locally, pushes to
 * GitHub as a mirror) and must NEVER be hard-reset to origin — this helper
 * refuses any branch other than the app's tracked default. One-way: never
 * pushes. Best-effort: a fetch failure is logged, not thrown — a debate against
 * slightly-stale main beats a hard failure.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { LEGACY_PROJECTS_ROOT } from './story-worktree.mjs';

function defaultRunner(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-n', '-u', 'ubuntu', 'bash', '-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Sync a brownfield app's `main` to `origin/main`. Returns the result; never
 * throws (best-effort).
 *
 * @param {{ appId: string, branch?: string, projectsRoot?: string,
 *           runner?: Function, log?: Function }} args
 * @returns {Promise<{ synced: boolean, sha?: string, reason?: string }>}
 */
export async function syncMainToOrigin({
  appId,
  branch = 'main',
  projectsRoot = LEGACY_PROJECTS_ROOT,
  runner = defaultRunner,
  log = () => {},
}) {
  if (!appId) return { synced: false, reason: 'no-appId' };
  // Hard refusal: only the tracked default branch is a downstream mirror.
  // plan/<slug> and any wip/* are EC2-owned and must not be reset to origin.
  if (branch !== 'main') {
    log('warn', `[sync] refusing to hard-sync non-main branch '${branch}' for ${appId} (EC2-owned)`);
    return { synced: false, reason: 'refused-non-main' };
  }
  const repoDir = `${projectsRoot}/${appId}`;
  if (!existsSync(repoDir)) {
    log('warn', `[sync] no working copy at ${repoDir} for ${appId}`);
    return { synced: false, reason: 'no-working-copy' };
  }

  // Reset to FETCH_HEAD (not origin/<branch>): the working copy is a worktree
  // of the bare repo, which has an EMPTY fetch refspec — so `git fetch origin
  // main` sets FETCH_HEAD but never creates `refs/remotes/origin/main`, and
  // `reset --hard origin/main` would fail "ambiguous argument 'origin/main'".
  // FETCH_HEAD always points at the just-fetched tip, independent of refspec.
  const res = await runner(
    `git fetch origin ${branch} && git reset --hard FETCH_HEAD`,
    repoDir,
  );
  if (res.code !== 0) {
    log('warn', `[sync] ${appId} fetch+reset failed (non-blocking): ${res.stderr.trim().slice(-300)}`);
    return { synced: false, reason: 'fetch-reset-failed' };
  }
  const head = await runner('git rev-parse HEAD', repoDir);
  const sha = head.code === 0 ? head.stdout.trim() : undefined;
  log('info', `[sync] ${appId} ${branch} → ${sha ? sha.slice(0, 7) : '?'} (origin/${branch})`);
  return { synced: true, sha };
}
