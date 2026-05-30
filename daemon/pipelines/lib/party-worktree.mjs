/**
 * party-worktree.mjs — Story 20.6 (party-push Epic 20).
 *
 * Per-session worktree lifecycle for party-mode debates. Each session
 * gets its own worktree off the bare repo so debates don't contend with
 * the legacy `/home/ubuntu/projects/<projectId>/` shared working tree.
 *
 *   Bare repo:  /home/ubuntu/repos/<projectId>.git           (shared)
 *   Worktree:   /home/ubuntu/worktrees/<projectId>/_party/<sessionIdShort>/
 *   Branch:     party/<projectId>/<sessionIdShort>           (off main)
 *
 * Object-store sharing means the worktree disk cost is ~5–10 MB (no full
 * clone). No node_modules symlink (party debates don't run `npm test`).
 *
 * Mirrors `daemon/lib/story-worktree.mjs` shape (Phase 1) for consistency
 * — same `sudo -u ubuntu` posture, same idempotent reuse semantics, same
 * defensive wrong-branch cleanup.
 *
 * See `plan.md` §10.1 + §11.3.1 for the full topology.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { bareRepoPath, LEGACY_PROJECTS_ROOT } from '../../lib/story-worktree.mjs';

const WORKTREE_ROOT =
  process.env.FUTURATOR_WORKTREE_ROOT || '/home/ubuntu/worktrees';

/**
 * `sessionIdShort` is the first 8 chars of the session UUID. Same form
 * the filesystem path encodes — kept in sync with
 * `functions/shared/repositories/party-sessions-repository.findBySessionIdShort`
 * (Story 19.8) so the reaper (Story 20.15) can round-trip path → DDB.
 *
 * @param {string} sessionId — full UUID
 * @returns {string} 8-char lowercase hex prefix
 */
export function sessionIdShortOf(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 8) {
    throw new Error(`sessionIdShortOf: invalid sessionId "${sessionId}"`);
  }
  return sessionId.slice(0, 8);
}

/**
 * @param {string} projectId
 * @param {string} sessionIdShort
 * @returns {string} `/home/ubuntu/worktrees/<projectId>/_party/<sessionIdShort>`
 */
export function partyWorktreeDir(projectId, sessionIdShort) {
  return join(WORKTREE_ROOT, projectId, '_party', sessionIdShort);
}

/**
 * @param {string} projectId
 * @param {string} sessionIdShort
 * @returns {string} `party/<projectId>/<sessionIdShort>`
 */
export function partyBranchName(projectId, sessionIdShort) {
  return `party/${projectId}/${sessionIdShort}`;
}

/**
 * Run a git command as the `ubuntu` user. Returns `{ code, stdout, stderr }`.
 * Does NOT throw on non-zero — callers branch on `code`.
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
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

export class WorktreeSetupError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.name = 'WorktreeSetupError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Setup a per-session party worktree.
 *
 * Idempotent: re-running for the same session reuses the existing worktree
 * when its HEAD matches `party/<projectId>/<sessionIdShort>`. Wrong-branch
 * worktrees (defensive case — operator interference, orphan from a prior
 * crash) are removed and re-created.
 *
 * @param {object} args
 * @param {string} args.projectId — kebab-case project slug
 * @param {string} args.sessionId — full UUID; truncated to 8 chars for path/branch
 * @param {(level: string, msg: string) => void} [args.log]
 * @returns {Promise<{
 *   worktreePath: string,
 *   branch: string,
 *   created: boolean,
 *   reused: boolean,
 * }>}
 */
export async function setupPartyWorktree({
  projectId,
  sessionId,
  log = () => {},
  gitRunner = runGit,
  bareDir, // override for tests; defaults to `bareRepoPath(projectId)`
  worktreeRootOverride, // override for tests; defaults to WORKTREE_ROOT
  // 2026-05-30 — the ref the debate worktree forks from. Defaults to 'main'
  // (synced to latest origin/main for brownfield before this call). Pass an
  // existing `plan/<slug>` to debate against a plan-in-execution — that branch
  // is EC2-owned (the freshest copy lives here) and is used AS-IS (never reset
  // to origin). Foundation for "debate on a specific branch".
  baseRef = 'main',
}) {
  if (!projectId || !sessionId) {
    throw new WorktreeSetupError('WORKTREE_SETUP_FAILED', 'projectId + sessionId required');
  }
  const sessionIdShort = sessionIdShortOf(sessionId);
  const worktreePath = worktreeRootOverride
    ? join(worktreeRootOverride, projectId, '_party', sessionIdShort)
    : partyWorktreeDir(projectId, sessionIdShort);
  const branch = partyBranchName(projectId, sessionIdShort);
  const bare = bareDir || bareRepoPath(projectId);

  if (!existsSync(bare)) {
    throw new WorktreeSetupError(
      'WORKTREE_SETUP_FAILED',
      `bare repo missing at ${bare} — operator must POST /api/admin/migrate-brownfield/${projectId} first (Story 20.4)`,
    );
  }

  mkdirSync(dirname(worktreePath), { recursive: true });

  if (existsSync(worktreePath)) {
    const head = await gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    if (head.code === 0 && head.stdout.trim() === branch) {
      log('info', `[party-worktree] reusing ${worktreePath} on ${branch}`);
      return { worktreePath, branch, created: false, reused: true };
    }
    log(
      'warn',
      `[party-worktree] ${worktreePath} exists but is on '${head.stdout.trim()}', not '${branch}' — removing + recreating`,
    );
    const rm = await gitRunner(
      ['--git-dir', bare, 'worktree', 'remove', '--force', worktreePath],
      LEGACY_PROJECTS_ROOT,
    );
    if (rm.code !== 0) {
      log('warn', `[party-worktree] worktree-remove warn: ${rm.stderr.trim() || rm.stdout.trim()}`);
    }
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  const add = await gitRunner(
    ['--git-dir', bare, 'worktree', 'add', '-B', branch, worktreePath, baseRef],
    LEGACY_PROJECTS_ROOT,
  );
  if (add.code !== 0) {
    throw new WorktreeSetupError(
      'WORKTREE_SETUP_FAILED',
      `git worktree add failed (exit ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`,
    );
  }

  log('info', `[party-worktree] created ${worktreePath} on ${branch} (off ${baseRef})`);
  return { worktreePath, branch, created: true, reused: false };
}

/**
 * Teardown a per-session worktree. Mirrors `teardownStoryWorktree`'s
 * idempotent shape — used by Story 20.10's DELETE cascade and Story
 * 20.15's reaper. Already covered by the SSM-driven path in
 * `functions/shared/services/plan-folder-service.ts::reapPartyWorktree`
 * (Story 20.9) for Lambda callers; this daemon-side helper is for the
 * reaper's in-process invocation.
 *
 * Best-effort: missing path / missing bare repo are NOT errors — they
 * mean the work is already done.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.sessionIdShort
 * @param {(level: string, msg: string) => void} [args.log]
 * @returns {Promise<{ removed: boolean, warnings: string[] }>}
 */
export async function teardownPartyWorktree({ projectId, sessionIdShort, log = () => {} }) {
  if (!projectId || !sessionIdShort) {
    throw new WorktreeSetupError(
      'WORKTREE_TEARDOWN_FAILED',
      'projectId + sessionIdShort required',
    );
  }
  const worktreePath = partyWorktreeDir(projectId, sessionIdShort);
  const bare = bareRepoPath(projectId);
  const warnings = [];

  if (!existsSync(worktreePath)) {
    return { removed: false, warnings };
  }

  if (existsSync(bare)) {
    const rm = await runGit(
      ['--git-dir', bare, 'worktree', 'remove', '--force', worktreePath],
      LEGACY_PROJECTS_ROOT,
    );
    if (rm.code !== 0) {
      warnings.push(`worktree-remove: ${rm.stderr.trim() || rm.stdout.trim()}`);
    }
  } else {
    warnings.push(`bare-repo-absent: ${bare}`);
  }
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  log('info', `[party-worktree] reaped ${worktreePath}`);
  return { removed: true, warnings };
}
