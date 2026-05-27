/**
 * wave-merge-runner.mjs — Phase 1 worktree rollout (2026-05-19).
 *
 * Runs the wave-merge sequence when all stories in a wave reach terminal
 * (success) status. Materializes a coordinator worktree at
 * `<root>/<app>/<plan>/_merge/`, checks out `plan/<slug>`, merges each
 * `wip/<storyId>` in deterministic storyId order with `--no-ff`, and
 * (per the design doc) HALTS on the first conflict — operator resolves
 * manually.
 *
 * On a clean merge, runs the boilerplate's `postMergeValidationCmd` (e.g.
 * `npm test`) inside the coordinator worktree. Non-zero → wave-build-failed.
 *
 * On full success: pushes the plan branch, deletes the per-story
 * worktrees + their `wip/<storyId>` branches (local only — GitHub
 * branches survive for the duration of the plan).
 *
 * Pure logic + injectable shell exec for testability. Caller (the
 * wave-reducer wiring in Phase 1.6) provides the dependencies.
 *
 * See `docs/concepts/pipeline-v2/worktree-rollout-design.md` §2 + §4.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import {
  buildWaveMergeCommand,
  classifyWaveMergeOutcome,
  buildMergeConflictAttention,
  buildWaveBuildFailedAttention,
  postMergeCleanupBranches,
} from './wave-merge.mjs';
import { teardownStoryWorktree, bareRepoPath, LEGACY_PROJECTS_ROOT } from './story-worktree.mjs';

export const WORKTREE_ROOT_DEFAULT =
  process.env.FUTURATOR_WORKTREE_ROOT || '/home/ubuntu/worktrees';

/**
 * Compute the coordinator worktree path. Distinct from per-story worktrees
 * via the literal `_merge` segment (which `worktree-paths.mjs::storyWorktreeDir`
 * rejects via the slug regex — `_` is not a valid kebab-case char — so the
 * two namespaces can never collide).
 */
export function coordinatorWorktreeDir({ appId, planSlug, root }) {
  if (!appId || !planSlug) throw new Error('coordinatorWorktreeDir: appId + planSlug required');
  return `${root || WORKTREE_ROOT_DEFAULT}/${appId}/${planSlug}/_merge`;
}

/**
 * Sort wip storyIds for deterministic merge order. Sort ascending by
 * storyId (UUIDs sort lexicographically; deterministic across daemon
 * restarts). Caller can override if a wave-internal index is preferred.
 */
export function sortStoriesForMerge(storyIds) {
  return [...storyIds].sort((a, b) => a.localeCompare(b));
}

/**
 * Run git as ubuntu and capture output. Returns { code, stdout, stderr }.
 * Does NOT throw — caller branches on code.
 */
function runGit(args, cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-n', '-u', 'ubuntu', 'git', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runShell(command, cwd, timeoutMs = 600_000) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-n', '-u', 'ubuntu', 'bash', '-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\n[wave-merge-runner] timeout after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Set up the coordinator worktree on `plan/<slug>`. Idempotent — if the
 * worktree already exists on the right branch, just refreshes from
 * origin to pick up any pushed updates.
 */
async function setupCoordinatorWorktree({ appId, planSlug, log }) {
  const bare = bareRepoPath(appId);
  if (!existsSync(bare)) {
    throw new Error(`setupCoordinatorWorktree: bare repo missing at ${bare}`);
  }
  const dir = coordinatorWorktreeDir({ appId, planSlug });
  mkdirSync(dirname(dir), { recursive: true });
  const planBranch = `plan/${planSlug}`;

  if (existsSync(dir)) {
    const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    if (head.code === 0 && head.stdout.trim() === planBranch) {
      log('info', `[wave-merge] reusing coordinator worktree at ${dir}`);
      // Make sure we have the latest refs from origin.
      await runGit(['fetch', 'origin', '--quiet'], dir);
      return dir;
    }
    log('warn', `[wave-merge] coordinator dir exists on wrong branch (${head.stdout.trim()}); reaping`);
    rmSync(dir, { recursive: true, force: true });
    // Best-effort: also tell git the worktree is gone.
    await runGit(['--git-dir', bare, 'worktree', 'prune'], LEGACY_PROJECTS_ROOT);
  }

  // 2026-05-27 (brick-breaker-11 fix) — create plan/<slug> if absent.
  //
  // BEFORE the per-story-worktree fix, the first story's
  // compile-commit-on-pass created plan/<slug> (it did `git checkout -b
  // plan/<slug>` in the shared worktree). That collided across parallel
  // per-story worktrees (a branch can only be checked out in one
  // worktree), so compile-commit-on-pass no longer touches plan/<slug>
  // — stories stay on their own wip/<storyId>. That makes WAVE-MERGE the
  // sole owner of plan/<slug> creation.
  //
  // So: if plan/<slug> doesn't exist yet (wave-0 first merge), create it
  // from `main` — the SAME base the wip/<storyId> branches forked from
  // (story-worktree.mjs::resolveParentRef falls back to 'main'). The
  // subsequent `--no-ff` merges of each wip branch then replay cleanly
  // against that common ancestor. If it already exists (wave-N, or a
  // resumed/retried wave), check it out as-is.
  const check = await runGit(
    ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${planBranch}`],
    LEGACY_PROJECTS_ROOT,
  );
  const planExists = check.code === 0 && check.stdout.trim().length === 40;

  const addArgs = planExists
    ? ['--git-dir', bare, 'worktree', 'add', dir, planBranch]
    : // `-b <newbranch> <dir> main` creates plan/<slug> from main's tip
      // and checks it out at the coordinator dir in one step.
      ['--git-dir', bare, 'worktree', 'add', '-b', planBranch, dir, 'main'];

  const add = await runGit(addArgs, LEGACY_PROJECTS_ROOT);
  if (add.code !== 0) {
    throw new Error(`coordinator worktree add failed (exit ${add.code}): ${add.stderr.trim()}`);
  }
  log(
    'info',
    `[wave-merge] coordinator worktree created at ${dir} on ${planBranch} ` +
      `(${planExists ? 'existing branch' : 'created from main'})`,
  );
  return dir;
}

/**
 * Identify which files conflict in a half-merged state. Used to populate
 * the merge-conflict attention item's body.
 */
async function listConflictedFiles(cwd) {
  const r = await runGit(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter((l) => l.trim().length > 0);
}

/**
 * Try to extract a short list of failing test names from the
 * postMergeValidationCmd's stdout/stderr. Best-effort regex over the
 * common vitest / jest "FAIL" line shapes.
 */
function parseFailingTests(output) {
  const lines = output.split('\n');
  const failing = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:FAIL|✗|×)\s+(.+?)(?:\s+\(|$)/);
    if (m) failing.push(m[1].trim());
    if (failing.length >= 20) break;
  }
  return failing;
}

/**
 * Run the wave-merge sequence.
 *
 * @param {{
 *   appId: string,
 *   planId: string,
 *   planSlug: string,
 *   epicId: string,
 *   waveNumber: number,
 *   storyIds: string[],            // stories in THIS wave that completed successfully
 *   postMergeValidationCmd?: string | null,
 *   writeAttention: (item) => Promise<void>,
 *   log?: (level, msg) => void,
 * }} args
 *
 * @returns {Promise<{
 *   outcome: 'success' | 'merge-conflict' | 'wave-build-failed' | 'no-stories' | 'setup-failed',
 *   mergedStoryIds?: string[],
 *   conflictedAtStoryId?: string,
 *   conflictedFiles?: string[],
 *   testOutput?: string,
 *   failingTests?: string[],
 *   coordinatorWorktree?: string,
 *   pushSha?: string,
 * }>}
 */
export async function runWaveMerge({
  appId,
  planId,
  planSlug,
  epicId,
  waveNumber,
  storyIds,
  postMergeValidationCmd,
  writeAttention,
  log = () => {},
}) {
  if (!storyIds || storyIds.length === 0) {
    return { outcome: 'no-stories' };
  }

  // 1. Coordinator worktree.
  let coordinatorDir;
  try {
    coordinatorDir = await setupCoordinatorWorktree({ appId, planSlug, log });
  } catch (err) {
    log('error', `[wave-merge] setup failed: ${err.message}`);
    return { outcome: 'setup-failed', error: err.message };
  }

  // 2. Sequential `--no-ff` merges, halt on first conflict.
  const ordered = sortStoriesForMerge(storyIds);
  const merged = [];
  for (const storyId of ordered) {
    const { command, flagBodies } = buildWaveMergeCommand({
      storyId,
      waveBaseRef: 'HEAD',
      planId,
      plan: planSlug,
      epicId,
      wave: waveNumber,
    });
    log('info', `[wave-merge] merging wip/${storyId} into plan/${planSlug}`);
    const r = await runShell(command, coordinatorDir);
    const verdict = classifyWaveMergeOutcome({ mergeExit: r.code });
    if (verdict.outcome === 'merge-conflict') {
      // Abort the half-merge so the worktree is in a re-tryable state.
      await runGit(['merge', '--abort'], coordinatorDir);
      const conflictedFiles = await listConflictedFiles(coordinatorDir);
      log(
        'warn',
        `[wave-merge] CONFLICT on wip/${storyId}: ${conflictedFiles.length} file(s); halting wave`,
      );
      const attn = buildMergeConflictAttention({
        planId,
        storyIds: ordered,
        conflictedFiles,
      });
      await writeAttention({
        ...attn,
        dedupKey: `wave-merge-conflict:${planId}:${epicId}:${waveNumber}`,
        context: {
          ...(attn.context || {}),
          conflictedAtStoryId: storyId,
          coordinatorWorktree: coordinatorDir,
          mergeFlagBodies: flagBodies,
        },
      });
      return {
        outcome: 'merge-conflict',
        mergedStoryIds: merged,
        conflictedAtStoryId: storyId,
        conflictedFiles,
        coordinatorWorktree: coordinatorDir,
      };
    }
    merged.push(storyId);
  }

  // 3. Post-merge validation (if the boilerplate declared a command).
  if (postMergeValidationCmd) {
    log('info', `[wave-merge] running post-merge validation: ${postMergeValidationCmd}`);
    const testRun = await runShell(postMergeValidationCmd, coordinatorDir, 900_000);
    if (testRun.code !== 0) {
      const failing = parseFailingTests(testRun.stdout + '\n' + testRun.stderr);
      log(
        'warn',
        `[wave-merge] post-merge validation FAILED (exit ${testRun.code}); ${failing.length} failing test(s)`,
      );
      const attn = buildWaveBuildFailedAttention({
        planId,
        storyIds: merged,
        testExit: testRun.code,
        failingTests: failing,
      });
      await writeAttention({
        ...attn,
        dedupKey: `wave-build-failed:${planId}:${epicId}:${waveNumber}`,
        context: {
          ...(attn.context || {}),
          coordinatorWorktree: coordinatorDir,
          validationCmd: postMergeValidationCmd,
        },
      });
      return {
        outcome: 'wave-build-failed',
        mergedStoryIds: merged,
        testOutput: (testRun.stdout + '\n' + testRun.stderr).slice(-4000),
        failingTests: failing,
        coordinatorWorktree: coordinatorDir,
      };
    }
    log('info', `[wave-merge] post-merge validation passed`);
  } else {
    log('info', `[wave-merge] no postMergeValidationCmd — skipping validation`);
  }

  // 4. Push the merged plan branch.
  const push = await runGit(['push', 'origin', `plan/${planSlug}`], coordinatorDir);
  if (push.code !== 0) {
    log(
      'warn',
      `[wave-merge] post-success push to origin/plan/${planSlug} failed (non-blocking): ${push.stderr.trim()}`,
    );
  }
  const headSha = await runGit(['rev-parse', 'HEAD'], coordinatorDir);
  const pushSha = headSha.code === 0 ? headSha.stdout.trim() : undefined;

  // 5. Cleanup per-story worktrees + local wip branches. GitHub branches
  // survive (forensic value during the plan's lifetime; plan-delete
  // cascade reaps them later).
  for (const storyId of merged) {
    try {
      await teardownStoryWorktree({
        appId,
        planSlug,
        storyId,
        deleteBranch: true,
        log,
      });
    } catch (err) {
      log(
        'warn',
        `[wave-merge] teardown failed for ${storyId} (non-blocking): ${err.message}`,
      );
    }
  }

  log(
    'info',
    `[wave-merge] wave ${waveNumber} merged ${merged.length} stories cleanly; head ${pushSha?.slice(0, 7) ?? '?'}`,
  );

  return {
    outcome: 'success',
    mergedStoryIds: merged,
    coordinatorWorktree: coordinatorDir,
    pushSha,
    cleanupBranches: postMergeCleanupBranches(merged),
  };
}
