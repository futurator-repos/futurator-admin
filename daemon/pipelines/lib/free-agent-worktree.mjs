/**
 * free-agent-worktree.mjs — Story 18.1 (Epic 18: Free Claude Code Agent)
 *
 * Manages the path-confined git worktrees that the daemon uses to host
 * free-agent sessions. Each session gets its own worktree at
 *   /home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/
 * checked out to a fresh branch
 *   assist/<projectId>/<sessionId>
 * forked from the per-project bare repo at
 *   /home/ubuntu/repos/<projectId>.git
 * (same convention as `daemon/lib/app-bootstrap-steps/materialize-worktree.mjs`).
 *
 * The worktree is the AGENT'S CONFINEMENT BOUNDARY. The Claude Code
 * PreToolUse hook written into `.claude/settings.json` is what enforces it
 * (see daemon/pipelines/lib/free-agent-path-hook.sh).
 *
 * Used by:
 *   - daemon job handler for `free-agent-session` (Story 18.2) — calls
 *     `ensureWorktree` before spawning `claude -p`.
 *   - Daily GC cron (Story 18.1 AC #6) — calls `reapWorktree` on stale
 *     sessions and orphaned paths.
 */

import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
  readFileSync as fsReadFileSync,
  appendFileSync as fsAppendFileSync,
  chmodSync as fsChmodSync,
  renameSync as fsRenameSync,
  rmSync as fsRmSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Resolve hook script paths RELATIVE TO THIS FILE's location so the daemon
// works regardless of where it's deployed. EC2 prod uses /opt/futurator-daemon/,
// local dev uses /Users/<…>/Futurator-Admin/daemon/. Hardcoded
// /home/ubuntu/futurator-admin paths previously caused the .claude/settings.json
// PreToolUse hook to point at a non-existent script on prod (Bash invocations
// would silently fail-closed because the hook returned non-zero).
const _THIS_DIR = dirname(fileURLToPath(import.meta.url));

export const FREE_AGENT_WORKTREES_ROOT = '/home/ubuntu/free-agent-worktrees';
export const FREE_AGENT_REPOS_ROOT = '/home/ubuntu/repos';
export const FREE_AGENT_PATH_HOOK_SCRIPT = join(_THIS_DIR, 'free-agent-path-hook.sh');

// Story 18.3 — `prepare-commit-msg` hook installed per-session into the
// worktree to append the `Agent: FREE-AGENT-<sessionId>` trailer.
export const FREE_AGENT_COMMIT_MSG_HOOK_SCRIPT = join(_THIS_DIR, 'free-agent-commit-msg-hook.sh');

// Sentinel markers that bracket our injected hook block when a pre-existing
// user hook is already present. Used by installCommitMsgHook to detect-and-skip
// on re-install, so we never duplicate the injection.
const COMMIT_MSG_HOOK_BLOCK_START = '# >>> futurator free-agent commit-msg trailer >>>';
const COMMIT_MSG_HOOK_BLOCK_END = '# <<< futurator free-agent commit-msg trailer <<<';

/** Branch name format used for free-agent commits. */
export function branchNameFor(projectId, sessionId) {
  return `assist/${projectId}/${sessionId}`;
}

/** Filesystem path the worktree lives at. */
export function worktreePathFor(projectId, sessionId, root = FREE_AGENT_WORKTREES_ROOT) {
  return join(root, projectId, sessionId);
}

/**
 * Idempotent worktree creation. Returns the existing worktree if it's already
 * registered (matched by `.git` file presence). Otherwise spawns
 * `git -C <bareDir> worktree add -b <branch> <worktreePath> origin/<defaultBranch>`.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.sessionId
 * @param {string} [args.defaultBranch='main']
 * @param {string} [args.reposRoot=FREE_AGENT_REPOS_ROOT]
 * @param {string} [args.worktreesRoot=FREE_AGENT_WORKTREES_ROOT]
 * @param {object} [args.fs] — { existsSync, mkdirSync } shim for tests
 * @param {function} [args.execGit] — promise-returning git runner for tests
 * @returns {Promise<{worktreePath: string, branchName: string, skipped: boolean}>}
 */
export async function ensureWorktree({
  projectId,
  sessionId,
  defaultBranch = 'main',
  reposRoot = FREE_AGENT_REPOS_ROOT,
  worktreesRoot = FREE_AGENT_WORKTREES_ROOT,
  fs = { existsSync: fsExistsSync, mkdirSync: fsMkdirSync },
  execGit = defaultExecGit,
} = {}) {
  if (!projectId) throw new Error('ensureWorktree: projectId required');
  if (!sessionId) throw new Error('ensureWorktree: sessionId required');

  const bareDir = join(reposRoot, `${projectId}.git`);
  const worktreePath = worktreePathFor(projectId, sessionId, worktreesRoot);
  const branchName = branchNameFor(projectId, sessionId);

  if (!fs.existsSync(bareDir)) {
    throw new Error(
      `ensureWorktree: bare repo not found at ${bareDir} — project must be bootstrapped first`,
    );
  }

  // Idempotency probe: a registered worktree has a `.git` file (not a dir)
  // pointing back at the bare repo. If present, we're done.
  if (fs.existsSync(worktreePath) && fs.existsSync(join(worktreePath, '.git'))) {
    return { worktreePath, branchName, skipped: true };
  }

  // Ensure the parent <root>/<projectId>/ exists before `git worktree add`.
  const parent = dirname(worktreePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  await execGit([
    '-C',
    bareDir,
    'worktree',
    'add',
    '-b',
    branchName,
    worktreePath,
    `origin/${defaultBranch}`,
  ]);

  return { worktreePath, branchName, skipped: false };
}

/**
 * Atomically write `.claude/settings.json` into a session worktree, configuring
 * the Bash PreToolUse hook that enforces path confinement.
 *
 * Atomicity: write to a temp file in the same directory, then rename. POSIX
 * rename within a directory is atomic, so a partial-write race cannot leave
 * the hook half-configured.
 *
 * @param {object} args
 * @param {string} args.worktreePath
 * @param {string} args.projectId
 * @param {string} args.sessionId
 * @param {string} [args.hookScriptPath=FREE_AGENT_PATH_HOOK_SCRIPT]
 * @param {object} [args.fs] — { existsSync, mkdirSync, writeFileSync, renameSync } shim for tests
 */
export function writeFreeAgentSettings({
  worktreePath,
  projectId,
  sessionId,
  hookScriptPath = FREE_AGENT_PATH_HOOK_SCRIPT,
  fs = {
    existsSync: fsExistsSync,
    mkdirSync: fsMkdirSync,
    writeFileSync: fsWriteFileSync,
    renameSync: fsRenameSync,
  },
} = {}) {
  if (!worktreePath) throw new Error('writeFreeAgentSettings: worktreePath required');
  if (!projectId) throw new Error('writeFreeAgentSettings: projectId required');
  if (!sessionId) throw new Error('writeFreeAgentSettings: sessionId required');

  const settingsDir = join(worktreePath, '.claude');
  const finalPath = join(settingsDir, 'settings.json');
  // Suffix the temp file with a random token so concurrent writers (which
  // shouldn't happen, but defensively) don't clobber each other's temp.
  const tempPath = join(settingsDir, `.settings.json.tmp-${randomBytes(6).toString('hex')}`);

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: hookScriptPath,
            },
          ],
        },
      ],
    },
  };

  fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tempPath, finalPath);
}

/**
 * Remove the worktree directory and its associated branch. Idempotent —
 * "not found" is treated as success.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.sessionId
 * @param {string} [args.reposRoot=FREE_AGENT_REPOS_ROOT]
 * @param {string} [args.worktreesRoot=FREE_AGENT_WORKTREES_ROOT]
 * @param {function} [args.execGit]
 * @param {object} [args.fs] — { existsSync, rmSync } shim for tests
 */
export async function reapWorktree({
  projectId,
  sessionId,
  reposRoot = FREE_AGENT_REPOS_ROOT,
  worktreesRoot = FREE_AGENT_WORKTREES_ROOT,
  execGit = defaultExecGit,
  fs = { existsSync: fsExistsSync, rmSync: fsRmSync },
} = {}) {
  if (!projectId) throw new Error('reapWorktree: projectId required');
  if (!sessionId) throw new Error('reapWorktree: sessionId required');

  const bareDir = join(reposRoot, `${projectId}.git`);
  const worktreePath = worktreePathFor(projectId, sessionId, worktreesRoot);
  const branchName = branchNameFor(projectId, sessionId);

  // Best-effort worktree removal. `--force` ignores dirty state.
  // If git reports "not a working tree" or similar, we still want to clean up
  // any stray directory below.
  if (fs.existsSync(bareDir)) {
    try {
      await execGit(['-C', bareDir, 'worktree', 'remove', '--force', worktreePath]);
    } catch {
      // ignore — worktree may already be gone or never registered
    }
    try {
      await execGit(['-C', bareDir, 'branch', '-D', branchName]);
    } catch {
      // ignore — branch may already be gone
    }
  }

  // Defensive: if the directory still exists (orphan, or git refused), nuke it.
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
}

/**
 * Story 18.3 — install the prepare-commit-msg hook into a free-agent worktree.
 *
 * Behavior:
 *   - If <worktreePath>/.git/hooks/prepare-commit-msg does NOT exist: write our
 *     hook script verbatim with mode 0o755.
 *   - If it exists AND already contains our sentinel marker: no-op (idempotent
 *     re-install).
 *   - If it exists WITHOUT our marker: append a marker-bracketed block that
 *     delegates to our hook script. Preserves any existing hook logic.
 *
 * Hook script must have FREE_AGENT_SESSION_ID set in the env when git invokes
 * it — the daemon does that at `claude -p` spawn time (Story 18.3 AC #1).
 *
 * @param {object} args
 * @param {string} args.worktreePath
 * @param {string} args.sessionId
 * @param {string} [args.hookScriptPath=FREE_AGENT_COMMIT_MSG_HOOK_SCRIPT]
 * @param {object} [args.fs] — { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, chmodSync } shim for tests
 */
export function installCommitMsgHook({
  worktreePath,
  sessionId,
  hookScriptPath = FREE_AGENT_COMMIT_MSG_HOOK_SCRIPT,
  fs = {
    existsSync: fsExistsSync,
    mkdirSync: fsMkdirSync,
    writeFileSync: fsWriteFileSync,
    readFileSync: fsReadFileSync,
    appendFileSync: fsAppendFileSync,
    chmodSync: fsChmodSync,
  },
} = {}) {
  if (!worktreePath) throw new Error('installCommitMsgHook: worktreePath required');
  if (!sessionId) throw new Error('installCommitMsgHook: sessionId required');

  const hooksDir = join(worktreePath, '.git', 'hooks');
  const hookFile = join(hooksDir, 'prepare-commit-msg');

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // Fresh install: write our own hook script as the file itself.
  if (!fs.existsSync(hookFile)) {
    const ourHook = [
      '#!/usr/bin/env bash',
      '# Installed by futurator free-agent (Story 18.3) — appends `Agent: FREE-AGENT-<sessionId>`',
      '# trailer to commit messages. Delegates to the canonical hook script.',
      COMMIT_MSG_HOOK_BLOCK_START,
      `exec "${hookScriptPath}" "$@"`,
      COMMIT_MSG_HOOK_BLOCK_END,
      '',
    ].join('\n');
    fs.writeFileSync(hookFile, ourHook, 'utf8');
    fs.chmodSync(hookFile, 0o755);
    return { installed: true, mode: 'fresh' };
  }

  // Existing hook: detect-and-skip if our marker block is already present.
  let existing = '';
  try {
    existing = fs.readFileSync(hookFile, 'utf8');
  } catch {
    // If we can't read it, fail safe by not modifying.
    return { installed: false, mode: 'unreadable' };
  }

  if (existing.includes(COMMIT_MSG_HOOK_BLOCK_START)) {
    return { installed: false, mode: 'already-present' };
  }

  // Append our marker-bracketed block to the existing hook.
  const appendBlock = [
    '',
    COMMIT_MSG_HOOK_BLOCK_START,
    `"${hookScriptPath}" "$@"`,
    COMMIT_MSG_HOOK_BLOCK_END,
    '',
  ].join('\n');
  fs.appendFileSync(hookFile, appendBlock, 'utf8');
  // Re-assert mode in case the existing hook lost the +x bit somehow.
  try {
    fs.chmodSync(hookFile, 0o755);
  } catch {
    // best-effort
  }
  return { installed: true, mode: 'appended' };
}

/** Default git runner — mirrors the materialize-worktree.mjs pattern. */
function defaultExecGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}
