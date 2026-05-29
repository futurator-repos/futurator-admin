/**
 * story-worktree.mjs — Phase 1 worktree rollout (2026-05-19).
 *
 * Per-story worktree lifecycle: `setupStoryWorktree` creates the
 * `wip/<storyId>` branch + git worktree + node_modules symlink, returning
 * the absolute working directory the daemon should hand to the pipeline.
 * `teardownStoryWorktree` reverses everything — runs on successful wave-
 * merge cleanup OR when the reaper finds a terminal-job orphan.
 *
 * Slots into the existing topology: the bare repo at
 * `/home/ubuntu/repos/<app>.git` already serves the legacy shared worktree
 * at `/home/ubuntu/projects/<app>/`. Phase 1 adds per-story worktrees at
 * `/home/ubuntu/worktrees/<app>/<plan>/<storyId>/` off the same bare repo
 * — Git's object store is reused (no clone cost).
 *
 * See `docs/concepts/pipeline-v2/worktree-rollout-design.md` §1 + §5.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { storyBranchName, storyWorktreeDir, WORKTREE_ROOT_DEFAULT } from './worktree-paths.mjs';
import {
  setupNodeModulesSymlink,
  teardownNodeModulesSymlink,
} from './node-modules-store.mjs';

export const LEGACY_PROJECTS_ROOT =
  process.env.FUTURATOR_LEGACY_PROJECTS_ROOT || '/home/ubuntu/projects';
export const BARE_REPOS_ROOT =
  process.env.FUTURATOR_BARE_REPOS_ROOT || '/home/ubuntu/repos';

/**
 * Run a git command as `ubuntu` (the daemon's user) and capture output.
 * Returns { code, stdout, stderr }. Does NOT throw on non-zero — callers
 * branch on `code`.
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    // `sudo -u ubuntu` is required when SSM-relayed callers (e.g. the
    // reaper invoked from a CloudWatch event) run as root. The daemon's
    // own process IS ubuntu, in which case sudo is a no-op cost.
    const child = spawn('sudo', ['-n', '-u', 'ubuntu', 'git', ...args], {
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
 * Path to the bare repo for an App. The migrate-module bootstrap clones
 * brownfield repos here; the app-bootstrap saga sets up greenfield repos
 * the same way.
 */
export function bareRepoPath(appId) {
  return `${BARE_REPOS_ROOT}/${appId}.git`;
}

/**
 * Setup a per-story worktree.
 *
 * @param {{
 *   appId: string,
 *   planSlug: string,
 *   storyId: string,
 *   planBranchRef?: string,   // defaults to `plan/<planSlug>` then `main`
 *   sourceWorktree?: string,  // for node_modules install; defaults to legacy projects dir
 *   installFn?: (cwd: string) => Promise<void>,  // injectable for tests; defaults to `npm install --prefer-offline`
 *   log?: (level: string, msg: string) => void,
 * }} args
 *
 * @returns {Promise<{
 *   worktreeDir: string,
 *   branch: string,
 *   nodeModules: { lockfileSha: string | null, storeTarget: string | null, freshlyInstalled: boolean, skipped?: boolean },
 *   created: boolean,
 *   reused: boolean,
 * }>}
 */
export async function setupStoryWorktree({
  appId,
  planSlug,
  storyId,
  planBranchRef,
  sourceWorktree,
  installFn,
  log = () => {},
}) {
  if (!appId || !planSlug || !storyId) {
    throw new Error('setupStoryWorktree: appId, planSlug, storyId required');
  }
  const worktreeDir = storyWorktreeDir({ project: appId, plan: planSlug, storyId });
  const branch = storyBranchName(storyId);
  const bare = bareRepoPath(appId);

  if (!existsSync(bare)) {
    throw new Error(
      `setupStoryWorktree: bare repo missing at ${bare} — app-bootstrap or brownfield clone must run first`,
    );
  }

  // Ensure parent dir exists (git worktree add creates the leaf only).
  mkdirSync(dirname(worktreeDir), { recursive: true });

  // If a worktree already exists at the target path, treat as "reused"
  // (daemon restart picked up the same story). Validate the branch matches;
  // if it doesn't, that's an orphan — caller should reap-then-retry.
  if (existsSync(worktreeDir)) {
    const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir);
    if (head.code === 0 && head.stdout.trim() === branch) {
      log('info', `[story-worktree] reusing existing worktree at ${worktreeDir} on ${branch}`);
      // Refresh node_modules symlink in case it was unlinked.
      const nm = await setupNodeModulesSymlink({
        appId,
        sourceWorktree: sourceWorktree || `${LEGACY_PROJECTS_ROOT}/${appId}`,
        destWorktree: worktreeDir,
        installFn: installFn || defaultInstallFn,
      });
      return { worktreeDir, branch, nodeModules: nm, created: false, reused: true };
    }
    throw new Error(
      `setupStoryWorktree: worktree at ${worktreeDir} exists but is on a different branch (${head.stdout.trim()}); reaper should clean it before retry`,
    );
  }

  // Resolve the parent ref. Prefer `plan/<slug>` (created earlier in the
  // plan's lifecycle by compile-commit-on-pass) so wip branches inherit
  // the plan's existing history. Fall back to `main` for the first story.
  const parentRef = planBranchRef || (await resolveParentRef({ bare, planSlug }));

  // `git worktree add -B <branch> <path> <parentRef>` creates or
  // resets the branch to parentRef and checks it out at <path>. `-B`
  // (force) keeps the operation idempotent across daemon restarts where a
  // stale ref might linger.
  const add = await runGit(
    ['--git-dir', bare, 'worktree', 'add', '-B', branch, worktreeDir, parentRef],
    LEGACY_PROJECTS_ROOT,
  );
  if (add.code !== 0) {
    throw new Error(
      `git worktree add failed (exit ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`,
    );
  }

  const nm = await setupNodeModulesSymlink({
    appId,
    sourceWorktree: sourceWorktree || `${LEGACY_PROJECTS_ROOT}/${appId}`,
    destWorktree: worktreeDir,
    installFn: installFn || defaultInstallFn,
  });

  log(
    'info',
    `[story-worktree] created ${worktreeDir} on ${branch} (parent=${parentRef}); node_modules ${nm.skipped ? 'SKIPPED' : nm.freshlyInstalled ? 'INSTALLED' : 'SYMLINKED'}`,
  );

  return { worktreeDir, branch, nodeModules: nm, created: true, reused: false };
}

/**
 * Teardown a per-story worktree. Runs on successful wave-merge cleanup OR
 * when the reaper reaps a terminal-job orphan. Idempotent.
 */
export async function teardownStoryWorktree({
  appId,
  planSlug,
  storyId,
  deleteBranch = true,
  log = () => {},
}) {
  const worktreeDir = storyWorktreeDir({ project: appId, plan: planSlug, storyId });
  const branch = storyBranchName(storyId);
  const bare = bareRepoPath(appId);
  const results = { worktreeRemoved: false, branchDeleted: false, nodeModules: null };

  // 1. Decrement node_modules refcount BEFORE removing the worktree — we
  // need the lockfile in the working tree to compute the sha.
  if (existsSync(worktreeDir)) {
    try {
      results.nodeModules = teardownNodeModulesSymlink({ appId, worktreeDir });
    } catch (err) {
      log('warn', `[story-worktree] node_modules teardown failed (non-blocking): ${err.message}`);
    }
  }

  // 2. Remove the worktree via git. `--force` because there may be untracked
  // files (e.g. .next build output) that git worktree remove refuses to drop
  // without it.
  if (existsSync(bare)) {
    const rm = await runGit(
      ['--git-dir', bare, 'worktree', 'remove', '--force', worktreeDir],
      LEGACY_PROJECTS_ROOT,
    );
    if (rm.code === 0) {
      results.worktreeRemoved = true;
    } else if (/not a working tree|not a git repository|No such file/i.test(rm.stderr)) {
      // Already gone — idempotent.
      results.worktreeRemoved = true;
    } else {
      log(
        'warn',
        `[story-worktree] git worktree remove non-clean (continuing with rm -rf): ${rm.stderr.trim()}`,
      );
    }
  }

  // 3. Belt-and-suspenders rm -rf in case git refused or the dir is orphaned
  // (no git metadata).
  if (existsSync(worktreeDir)) {
    rmSync(worktreeDir, { recursive: true, force: true });
    results.worktreeRemoved = true;
  }

  // 4. Optional branch delete. Wave-merge cleanup wants this (keeps local
  // refs tidy); the reaper-on-orphan path may want to keep the branch
  // for forensic value, so this is a flag.
  if (deleteBranch && existsSync(bare)) {
    const del = await runGit(
      ['--git-dir', bare, 'branch', '-D', branch],
      LEGACY_PROJECTS_ROOT,
    );
    if (del.code === 0) {
      results.branchDeleted = true;
    } else if (/not found|does not exist/i.test(del.stderr)) {
      results.branchDeleted = true; // already gone
    } else {
      log(
        'warn',
        `[story-worktree] branch delete non-clean (continuing): ${del.stderr.trim()}`,
      );
    }
  }

  return results;
}

/**
 * Resolve the parent ref for a new wip branch. Prefers `plan/<slug>` if it
 * exists in the bare repo, otherwise falls back to `main`. Used when the
 * caller doesn't supply an explicit parentRef.
 */
async function resolveParentRef({ bare, planSlug }) {
  const planRef = `plan/${planSlug}`;
  const check = await runGit(
    ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${planRef}`],
    LEGACY_PROJECTS_ROOT,
  );
  if (check.code === 0 && check.stdout.trim().length === 40) {
    return planRef;
  }
  return 'main';
}

/**
 * Default install function — `npm install --prefer-offline --no-audit
 * --no-fund` in the source worktree. Tests inject a no-op.
 */
function defaultInstallFn(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'sudo',
      ['-n', '-u', 'ubuntu', 'npm', 'install', '--prefer-offline', '--no-audit', '--no-fund'],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1' },
      },
    );
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b.toString('utf8').slice(-2000)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install exit ${code}: ${stderr.slice(-500)}`));
    });
    child.on('error', reject);
  });
}

/**
 * List all per-story worktrees under WORKTREE_ROOT_DEFAULT for a given
 * App. Returns absolute paths. Used by the reaper.
 */
export function listStoryWorktrees(appId) {
  const appRoot = `${WORKTREE_ROOT_DEFAULT}/${appId}`;
  if (!existsSync(appRoot)) return [];
  const out = [];
  const { readdirSync } = require('node:fs');
  for (const plan of readdirSync(appRoot, { withFileTypes: true })) {
    if (!plan.isDirectory()) continue;
    const planDir = `${appRoot}/${plan.name}`;
    for (const story of readdirSync(planDir, { withFileTypes: true })) {
      if (!story.isDirectory()) continue;
      // Skip the _merge coordinator worktree — caller handles it separately.
      if (story.name === '_merge') continue;
      // Story B (2026-05-29) — `_cand` holds ephemeral wave-merge candidate
      // worktrees; never a per-story worktree.
      if (story.name === '_cand') continue;
      out.push(`${planDir}/${story.name}`);
    }
  }
  return out;
}
