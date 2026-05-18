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

  // Use the bare repo's LOCAL branch ref, not `origin/${defaultBranch}`.
  // Pipeline v2 app bare repos (e.g. /home/ubuntu/repos/snake-4.git) are
  // bootstrapped on EC2 directly — they have refs/heads/main but no `origin`
  // remote. Brownfield bare repos that ARE clones still have refs/heads/main
  // (copied from origin at clone time), so the local ref resolves in both
  // cases. This avoided a `fatal: invalid reference: origin/main` regression
  // on the snake-4 first-turn worktree spawn (2026-05-18).
  await execGit([
    '-C',
    bareDir,
    'worktree',
    'add',
    '-b',
    branchName,
    worktreePath,
    defaultBranch,
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
 * Write a per-session `AGENT.md` at the worktree root describing the operator
 * context, available AWS resources, and tool surface to the spawned Claude
 * CLI. The daemon's spawn args pass `--append-system-prompt` telling the
 * agent to read this file first, so it learns its capabilities instead of
 * defaulting to `gh`/`git` instincts that don't apply on EC2.
 *
 * Idempotent — overwritten on every turn so the timestamp + sessionId + any
 * scope changes stay fresh. Uses a temp+rename to avoid half-written content
 * during a concurrent read.
 *
 * @param {object} args
 * @param {string} args.worktreePath
 * @param {string} args.projectId
 * @param {string} args.sessionId
 * @param {{kind: string, id?: string}} args.scope
 * @param {string} [args.planId]    — when scope.kind === 'plan' this is its id
 * @param {string} [args.operatorId]
 * @param {object} [args.fs]
 * @param {() => Date} [args.now]   — injectable for deterministic tests
 */
export function writeAgentMd({
  worktreePath,
  projectId,
  sessionId,
  scope,
  planId,
  operatorId,
  fs = {
    existsSync: fsExistsSync,
    writeFileSync: fsWriteFileSync,
    renameSync: fsRenameSync,
  },
  now = () => new Date(),
} = {}) {
  if (!worktreePath) throw new Error('writeAgentMd: worktreePath required');
  if (!projectId) throw new Error('writeAgentMd: projectId required');
  if (!sessionId) throw new Error('writeAgentMd: sessionId required');
  if (!scope || typeof scope !== 'object') throw new Error('writeAgentMd: scope required');

  const planLine = planId ? `- **Plan:** \`${planId}\`` : '- **Plan:** _(none — scope is not plan)_';
  const scopeLine = `- **Scope:** \`${scope.kind}\`${scope.id ? ` / \`${scope.id}\`` : ''}`;
  const operatorLine = operatorId ? `- **Operator:** \`${operatorId}\`` : '';
  const generatedAt = now().toISOString();

  const content = `# Free Agent — Operator Context

_Generated by the daemon for session \`${sessionId}\` at ${generatedAt}. Refreshed every turn._

You are the **Futurator Free Agent**, launched by the operator from the chat widget at \`admin.futurator.ai\`. This document is the source of truth for what you can and cannot do in this session — **read it before responding**.

## Current scope

- **Project / App:** \`${projectId}\`
${planLine}
${scopeLine}
- **Session id:** \`${sessionId}\` (this also tags your STS credentials)
- **Working tree:** \`${worktreePath}\` (this is your cwd; a fresh worktree of the \`${projectId}\` bare repo)
- **Branch:** \`assist/${projectId}/${sessionId}\` (yours alone — the operator never edits here; pushes are not synced back to GitHub)
${operatorLine ? operatorLine + '\n' : ''}
## Tools you have

### AWS CLI (credentials pre-loaded in \`$AWS_ACCESS_KEY_ID\` / \`$AWS_SECRET_ACCESS_KEY\` / \`$AWS_SESSION_TOKEN\`)

You can run \`aws\` commands with \`--region us-east-1\`. Your STS role has **read** access to these DynamoDB tables:

| Table | What it holds | Schema hint |
|---|---|---|
| \`futurator-plans\` | Plan metadata, current stage, story breakdown, total cost | PK: \`planId\` (e.g. \`plan_${projectId}_<random>\`) |
| \`futurator-agent-jobs\` | Per-turn execution rows: status, phase, cost, errorMessage, retryAttempt | PK: \`jobId\`. GSI \`status-createdAt-index\` for "recent FAILED" queries |
| \`futurator-attention-items\` | Operator attention queue (alerts surfaced for human review) | PK: \`itemId\` |
| \`futurator-free-agent-sessions\` | Free-agent session metadata incl. your own row | PK: \`sessionId\` |
| \`futurator-free-agent-conversations\` | Conversation history per free-agent session | PK: \`sessionId\`, SK: \`messageIndex\` (zero-padded 6-digit) |

You also have **read** on \`s3://futurator-ai-website/knowledge-live/${projectId}/\` — the mycelium knowledge-graph backup for this project. Useful for code recall.

### Local filesystem

Anything under \`${worktreePath}\` is readable & writable. Paths outside it are blocked by a Bash PreToolUse hook — don't try to \`cd /etc\`, you'll be denied.

### Git

You're inside a git worktree on branch \`assist/${projectId}/${sessionId}\`. \`git log\`, \`git diff\`, \`git show\` all work normally. Commits land on your branch only and carry an \`Agent: FREE-AGENT-${sessionId}\` trailer automatically. **Do not push.**

## Tools you do NOT have (don't try them)

- \`gh\` — no GitHub PAT in env. If the operator wants PR data, they'll fetch it themselves.
- \`secretsmanager:*\` / \`iam:*\` / \`lambda:UpdateFunctionCode\` — explicit \`Deny\` in your IAM role.
- DynamoDB writes on any table except your own conversation rows (and the daemon handles those — you don't need to).
- Cross-project worktrees, S3 prefixes for other projects, etc.
- Network egress to arbitrary hosts (no proxy configured beyond AWS endpoints).

## How to answer common operator questions

- **"What status is plan X in?"**
  \`aws dynamodb get-item --region us-east-1 --table-name futurator-plans --key '{"planId":{"S":"plan_X..."}}'\`
- **"Did the last run succeed?"**
  \`aws dynamodb query --region us-east-1 --table-name futurator-agent-jobs --index-name status-createdAt-index --key-condition-expression "#s = :s" --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":s":{"S":"COMPLETED"}}' --no-scan-index-forward --limit 5\`
- **"What attention items are open?"**
  \`aws dynamodb scan --region us-east-1 --table-name futurator-attention-items --filter-expression "#s = :s" --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":s":{"S":"OPEN"}}'\`
- **"Show me the code for X."** Prefer the \`Read\` tool over \`cat\`. Cite \`file:line\` so the operator can click.
- **"What changed recently in this repo?"** \`git log --oneline -20\` from the worktree root.

## Cost discipline

The operator sees your running cost in the panel header against a budget cap (default $10). Be terse, factual, cite specifics. Avoid speculative tool fan-out. When the answer is "I don't know", say so — don't burn tokens guessing.
`;

  const finalPath = join(worktreePath, 'AGENT.md');
  const tempPath = join(worktreePath, `.AGENT.md.tmp-${randomBytes(6).toString('hex')}`);

  if (!fs.existsSync(worktreePath)) {
    throw new Error(`writeAgentMd: worktreePath does not exist: ${worktreePath}`);
  }

  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, finalPath);

  return { finalPath, bytes: content.length };
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
