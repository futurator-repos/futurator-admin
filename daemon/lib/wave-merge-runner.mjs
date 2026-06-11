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

import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
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
import { materializeNodeModulesFromStore } from './node-modules-store.mjs';

/**
 * 2026-05-28 — default npm install used to seed the store when the
 * coordinator's lockfile has no store entry yet (rare — usually the
 * per-story setup already built it). Mirrors story-worktree's
 * defaultInstallFn. Tests inject a no-op.
 */
function defaultCoordinatorInstallFn(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'sudo',
      ['-n', '-u', 'ubuntu', 'npm', 'install', '--prefer-offline', '--no-audit', '--no-fund'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
    );
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b.toString('utf8').slice(-2000)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`npm install exit ${code}: ${stderr.slice(-500)}`)),
    );
    child.on('error', reject);
  });
}

/**
 * 2026-05-28 — recognise "the test command was a no-op, not a failure"
 * signals in the post-merge validation output. A wave that legitimately
 * ships no runtime tests (e.g. a types/scaffold wave) must not be treated
 * as a build failure. Keyed off ground-truth output, never a prediction.
 */
export function isNoOpTestExit(output) {
  if (!output) return false;
  return (
    /Missing script: ["']?test["']?/i.test(output) ||
    /No test files found/i.test(output) ||
    /No tests found/i.test(output) ||
    /no test specified/i.test(output)
  );
}

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
 * Story B (2026-05-29) — ephemeral per-candidate worktree path.
 *
 * `<root>/<app>/<plan>/_cand/<jobId>/`. Merges happen HERE on a detached
 * HEAD off the current green tip — never on `plan/<slug>` directly — so a
 * crash can never leave the published branch half-merged. `_cand` is a
 * reserved namespace (like `_merge`/`_party`/`_assist`): the kebab-case slug
 * regex rejects the leading underscore, and the reaper + listStoryWorktrees
 * skip it, so it can never be mistaken for a per-story worktree.
 */
export function candidateWorktreeDir({ appId, planSlug, jobId, root }) {
  if (!appId || !planSlug || !jobId)
    throw new Error('candidateWorktreeDir: appId + planSlug + jobId required');
  return `${root || WORKTREE_ROOT_DEFAULT}/${appId}/${planSlug}/_cand/${jobId}`;
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
// v2.6 M2 — exported so the wave-VQA runner (and the daemon handler wiring
// it) reuse the SAME sudo-as-ubuntu exec surface instead of growing a third
// privilege path.
export { runGit as defaultGitRunner, runShell as defaultShellRunner };

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
 * Best-effort removal of a git worktree (the worktree's git metadata + the
 * directory). Idempotent; never throws. Used to reap the throwaway
 * candidate worktree, and to retire any legacy `_merge` coordinator dir.
 */
async function reapWorktree({ dir, bare, git, bareOpCwd, log }) {
  if (!dir) return;
  if (existsSync(bare)) {
    await git(['--git-dir', bare, 'worktree', 'remove', '--force', dir], bareOpCwd);
  }
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log('warn', `[wave-merge] candidate worktree rm failed (non-blocking): ${err.message}`);
    }
  }
  if (existsSync(bare)) {
    await git(['--git-dir', bare, 'worktree', 'prune'], bareOpCwd);
  }
}

/**
 * Story B (2026-05-29) — set up an EPHEMERAL candidate worktree, detached at
 * the current green tip. Merges run here, never on `plan/<slug>`; the green
 * branch is advanced atomically only after the build gate passes (see
 * runWaveMerge). Returns the resolved green ref/SHA so the caller can do the
 * compare-and-swap advance.
 *
 * Green tip resolution mirrors the prior coordinator logic:
 *   - `plan/<slug>` if it already exists (wave-N, or a resumed wave), else
 *   - `main` (wave-0 first merge — the same base wip/<storyId> forked from).
 *
 * Also retires any legacy `_merge` coordinator worktree it finds, so the
 * advance-on-green `update-ref` is never blocked by `plan/<slug>` being
 * checked out somewhere.
 */
async function setupCandidateWorktree({ appId, planSlug, jobId, git, bareOpCwd, log }) {
  const bare = bareRepoPath(appId);
  if (!existsSync(bare)) {
    throw new Error(`setupCandidateWorktree: bare repo missing at ${bare}`);
  }
  const planBranch = `plan/${planSlug}`;

  // Retire the legacy shared coordinator worktree if present — under the new
  // model `plan/<slug>` is never checked out, so the atomic ref advance is
  // unobstructed.
  const legacyMerge = coordinatorWorktreeDir({ appId, planSlug });
  if (existsSync(legacyMerge)) {
    log('info', `[wave-merge] retiring legacy _merge coordinator worktree at ${legacyMerge}`);
    await reapWorktree({ dir: legacyMerge, bare, git, bareOpCwd, log });
  }

  // Resolve the green tip.
  const check = await git(
    ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${planBranch}`],
    bareOpCwd,
  );
  const planExists = check.code === 0 && check.stdout.trim().length === 40;
  const greenRef = planExists ? `refs/heads/${planBranch}` : 'main';

  const greenR = await git(['--git-dir', bare, 'rev-parse', '--verify', greenRef], bareOpCwd);
  if (greenR.code !== 0 || greenR.stdout.trim().length !== 40) {
    throw new Error(`setupCandidateWorktree: cannot resolve green ref ${greenRef}: ${greenR.stderr.trim()}`);
  }
  const greenSha = greenR.stdout.trim();

  const dir = candidateWorktreeDir({ appId, planSlug, jobId });
  // A stale candidate dir at this exact path (same jobId re-run) is reaped.
  if (existsSync(dir)) {
    await reapWorktree({ dir, bare, git, bareOpCwd, log });
  }
  mkdirSync(dirname(dir), { recursive: true });

  // Detached worktree at the green SHA — a throwaway scratchpad. Merges move
  // its detached HEAD; `plan/<slug>` is untouched until the green advance.
  const add = await git(['--git-dir', bare, 'worktree', 'add', '--detach', dir, greenSha], bareOpCwd);
  if (add.code !== 0) {
    throw new Error(`candidate worktree add failed (exit ${add.code}): ${add.stderr.trim()}`);
  }
  log(
    'info',
    `[wave-merge] candidate worktree at ${dir} detached at green ${greenSha.slice(0, 7)} ` +
      `(${planExists ? `plan/${planSlug}` : 'main'})`,
  );
  return { dir, bare, planBranch, planExists, greenRef, greenSha };
}

/**
 * Identify which files conflict in a half-merged state. Used to populate
 * the merge-conflict attention item's body.
 */
async function listConflictedFiles(cwd, git = runGit) {
  const r = await git(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter((l) => l.trim().length > 0);
}

/**
 * Story C (2026-05-29) — capture the contents of conflicted files WHILE the
 * conflict markers are still present, before `git merge --abort` destroys
 * them. Returns `{ file, content }[]`, content truncated to a sane bound so
 * a giant generated file can't blow up the attention item / DDB row. The
 * conflict is otherwise unrecoverable after the abort — this is what makes a
 * halted (or future auto-resolved) merge judgeable after the fact.
 */
/**
 * Story E Tier 2 (2026-05-30) — after the agentic merger edits the conflicted
 * files in place, verify it actually removed every conflict marker. Returns
 * the subset of `files` that STILL contain a `<<<<<<<`, `=======`, or
 * `>>>>>>>` marker line. Empty array = clean. Reads files directly (no shell);
 * unreadable files are treated as still-conflicted (conservative — never
 * commit a tree we can't verify). This is the deterministic backstop on the
 * resolver's output BEFORE the build gate is the second backstop.
 */
const CONFLICT_MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)(\s|$)/m;
export function filesWithConflictMarkers(files, cwd) {
  const remaining = [];
  for (const f of files) {
    const abs = f.startsWith('/') ? f : `${cwd.replace(/\/$/, '')}/${f}`;
    try {
      if (CONFLICT_MARKER_RE.test(readFileSync(abs, 'utf8'))) remaining.push(f);
    } catch {
      remaining.push(f);
    }
  }
  return remaining;
}

/**
 * pacman1 disease (2026-06-11) — detect generator-owned files by the
 * industry-standard '@generated' marker in the file head (the wiring
 * generator stamps "// @generated by scripts/generate-wiring.mjs"). The
 * conflicted working copy contains markers from BOTH sides, so the stamp
 * survives wherever the conflict hunks start. Conservative: unreadable or
 * unmarked files are NOT generated (they go to the agent resolver).
 */
export function isGeneratedConflictFile(file, cwd) {
  const abs = file.startsWith('/') ? file : `${cwd.replace(/\/$/, '')}/${file}`;
  try {
    return readFileSync(abs, 'utf8').slice(0, 2048).includes('@generated');
  } catch {
    return false;
  }
}

const MAX_BLOB_BYTES = 64 * 1024;
async function captureConflictBlobs(files, cwd, _git) {
  const blobs = [];
  for (const f of files) {
    const abs = f.startsWith('/') ? f : `${cwd.replace(/\/$/, '')}/${f}`;
    try {
      const raw = readFileSync(abs, 'utf8');
      const truncated = raw.length > MAX_BLOB_BYTES;
      blobs.push({
        file: f,
        content: truncated ? raw.slice(0, MAX_BLOB_BYTES) : raw,
        truncated,
        bytes: Buffer.byteLength(raw, 'utf8'),
      });
    } catch {
      blobs.push({ file: f, content: null, truncated: false, bytes: 0, unreadable: true });
    }
  }
  return blobs;
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
  // snake3 (2026-06-10) — optional dedupKey resolver; on merge success the
  // runner closes the failure cards a prior attempt on this wave opened.
  resolveAttention,
  log = () => {},
  // Story B (2026-05-29) — names the ephemeral candidate worktree
  // (`_cand/<jobId>`). Required so concurrent/retried jobs never collide.
  jobId = 'job',
  // 2026-05-28 — injectable for tests; defaults to npm install. Used only
  // when the candidate's lockfile has no store entry yet.
  coordinatorInstallFn,
  // Story C (2026-05-29) — durable conflict-event sink. No-op by default;
  // the daemon wires a DDB-backed recorder. Receives the full event shape.
  recordConflictEvent = async () => {},
  // Story E Tier 2 (2026-05-30) — OPT-IN agentic conflict merger. UNDEFINED by
  // default → preserves the Story A operator-resolve-only halt. The daemon
  // passes this ONLY when the autoMerge toggle is on (global agent.autoMerge
  // flag + per-plan autoMergeMode). Signature:
  //   resolveConflict({ worktreeDir, conflictedFiles, conflictStoryId,
  //     mergedStoryIds, blobs, planId, epicId, waveNumber })
  //     => { resolved: boolean, reasoning?: string }
  // It edits the conflicted files IN the candidate worktree (markers present);
  // the runner verifies marker-free, commits with an audit trailer, and the
  // post-merge build gate is the final backstop. Any failure → halt (Story A).
  resolveConflict,
  // pacman1 (2026-06-11) — OPT-IN agentic build-fix for post-merge
  // validation failures. UNDEFINED by default → preserves the halt-for-
  // operator behavior. Gated daemon-side by the same autoMerge toggle as
  // resolveConflict. Signature:
  //   fixBuild({ worktreeDir, validationCmd, validationOutput,
  //     mergedStoryIds, planId, epicId, waveNumber })
  //     => { attempted: boolean, reasoning?: string }
  // It edits files IN the candidate worktree; the runner re-runs the full
  // validation gate, commits with an audit trailer, and only then advances.
  fixBuild,
  // v2.6 M2 (2026-06-11) — OPT-IN wave-gate VQA hook. UNDEFINED by default.
  // The daemon passes it when rigor !== 'prototype' && the boilerplate has a
  // qaContext && the wave's stories carry browser ACs. Signature:
  //   runVqa({ candidateDir, mergedStoryIds })
  //     => { outcome: 'pass'|'fixed'|'fix-forward'|'skipped'|'env-blocked', ... }
  // See lib/wave-vqa-runner.mjs for the stage machinery + fix-forward rules.
  runVqa,
  // Story B (2026-05-29) — injectable exec surface for hermetic real-git
  // tests. Production defaults shell out as `sudo -u ubuntu`.
  gitRunner = runGit,
  shellRunner = runShell,
  bareOpCwd = LEGACY_PROJECTS_ROOT,
}) {
  if (!storyIds || storyIds.length === 0) {
    return { outcome: 'no-stories' };
  }
  const git = gitRunner;
  const shell = shellRunner;

  // 1. Ephemeral candidate worktree, detached at the current green tip.
  //    `plan/<slug>` is NOT touched here — it advances atomically only on
  //    green (step 4). A crash mid-merge can never leave it half-merged.
  let cand;
  try {
    cand = await setupCandidateWorktree({ appId, planSlug, jobId, git, bareOpCwd, log });
  } catch (err) {
    log('error', `[wave-merge] candidate setup failed: ${err.message}`);
    return { outcome: 'setup-failed', transient: true, error: err.message };
  }
  const { dir: candidateDir, bare, planBranch, planExists, greenSha } = cand;

  // 2. Sequential `--no-ff` merges into the candidate, halt on first
  //    conflict (operator-resolve-only per worktree-rollout-design.md §2).
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
    // snake3 19:03 (2026-06-10) — the "CONFLICT … 0 file(s)" halt was a
    // MISSING REF: `wip/<storyId>` didn't exist (reaped by an earlier
    // successful merge attempt / teardown race), so `git merge` failed with
    // a not-a-thing-we-can-merge error that the exit-code-only classifier
    // labeled a content conflict. Verify the ref first; a missing branch is
    // a transient bookkeeping state (the story IS merged or re-mintable),
    // never an operator-facing conflict.
    const refCheck = await git(
      ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/wip/${storyId}`],
      bareOpCwd,
    );
    if (refCheck.code !== 0) {
      // If the story's commit is already reachable from the candidate HEAD
      // (a prior attempt merged it before failing later), just skip it.
      const already = await shell(
        `git log --oneline --grep="${storyId}" HEAD | head -1`,
        candidateDir,
      );
      if (already.code === 0 && already.stdout.trim().length > 0) {
        log('info', `[wave-merge] wip/${storyId} branch gone but commit already on candidate — skipping`);
        merged.push(storyId);
        continue;
      }
      log('warn', `[wave-merge] wip/${storyId} ref MISSING and commit not on candidate — transient (will retry)`);
      await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
      return {
        outcome: 'merge-error',
        transient: true,
        mergedStoryIds: merged,
        conflictedAtStoryId: storyId,
        error: `wip/${storyId} ref missing (not a content conflict)`,
      };
    }

    log('info', `[wave-merge] merging wip/${storyId} into candidate (green ${greenSha.slice(0, 7)})`);
    const r = await shell(command, candidateDir);
    const verdict = classifyWaveMergeOutcome({ mergeExit: r.code });
    if (verdict.outcome === 'merge-conflict') {
      // Story C — capture the conflicted blobs (WITH markers) BEFORE we
      // resolve/abort, so the conflict is judgeable after the fact. `git
      // merge --abort` would otherwise incinerate the evidence.
      const conflictedFiles = await listConflictedFiles(candidateDir, git);

      // snake3 (2026-06-10) — merge failed but ZERO files are in conflicted
      // state: this is NOT a content conflict (untracked-file overwrite,
      // index lock, bad ref, …). The old path mislabeled it "CONFLICT … 0
      // file(s)" and halted the wave permanently with an operator card that
      // named no cause. Surface the REAL git error, mark TRANSIENT (the
      // reducer re-mints the job — these states are usually self-clearing
      // or fixed by a fresh candidate), and skip the conflict machinery
      // (there is nothing for a resolver to resolve).
      if (conflictedFiles.length === 0) {
        const gitError = `${r.stderr || ''}\n${r.stdout || ''}`.trim().slice(-800);
        log(
          'warn',
          `[wave-merge] merge of wip/${storyId} failed with NO conflicted files — git error (transient, will retry): ${gitError.slice(0, 300)}`,
        );
        await git(['merge', '--abort'], candidateDir); // may no-op when no MERGE_HEAD
        await recordConflictEvent({
          planId,
          epicId,
          waveNumber,
          appId,
          mode: 'merge-error',
          conflictedAtStoryId: storyId,
          files: [],
          mergedStoryIds: [...merged],
          blobs: {},
          reasoning: gitError,
          candidateWorktree: candidateDir,
        }).catch((e) => log('warn', `[wave-merge] recordConflictEvent(merge-error) failed: ${e.message}`));
        await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
        return {
          outcome: 'merge-error',
          transient: true,
          mergedStoryIds: merged,
          conflictedAtStoryId: storyId,
          error: gitError,
        };
      }

      const conflictBlobs = await captureConflictBlobs(conflictedFiles, candidateDir, git);

      // pacman1 disease (2026-06-11) — MECHANICAL pre-resolution for conflict
      // classes whose correct resolution is known by construction, so the
      // agent resolver (a multi-second Claude spawn per conflict) only ever
      // sees genuine source collisions:
      //   - scratch paths (.context/, .pipeline/, .mycelium/, knowledge/):
      //     per-story pipeline bookkeeping; take the incoming story's side.
      //   - '@generated' files (e.g. src/app/page.tsx from generate-wiring):
      //     outputs of a checked-in generator; either side is throwaway —
      //     take ours, the post-merge validation re-runs the generator on
      //     the merged union and commits its output (dino1 contract).
      // Any checkout failure (delete/rename conflicts) falls through to the
      // agent path — mechanical resolution is an optimization, never a gate.
      const agentFiles = [];
      const mechanicalFiles = [];
      for (const f of conflictedFiles) {
        let side = null;
        if (/^(\.context|\.pipeline|\.mycelium|knowledge)\//.test(f)) {
          side = '--theirs';
        } else if (isGeneratedConflictFile(f, candidateDir)) {
          side = '--ours';
        }
        if (side) {
          const co = await git(['checkout', side, '--', f], candidateDir);
          const staged = co.code === 0 ? await git(['add', '--', f], candidateDir) : co;
          if (co.code === 0 && staged.code === 0) {
            mechanicalFiles.push(`${f} (${side.slice(2)})`);
            continue;
          }
        }
        agentFiles.push(f);
      }
      if (mechanicalFiles.length > 0) {
        log(
          'info',
          `[wave-merge] mechanically resolved ${mechanicalFiles.length}/${conflictedFiles.length} conflict(s): ${mechanicalFiles.join(', ')}`,
        );
      }
      if (agentFiles.length === 0) {
        // Every conflict was mechanical — commit the merge without spawning
        // the agent resolver at all.
        const subject = `merge story ${storyId} into wave [mechanical: ${conflictedFiles.join(', ')}]`;
        const commit = await git(['commit', '-m', subject], candidateDir);
        if (commit.code === 0) {
          log('info', `[wave-merge] mechanical-only resolution committed for wip/${storyId}`);
          await recordConflictEvent({
            planId,
            epicId,
            waveNumber,
            appId,
            mode: 'auto-resolved',
            conflictedAtStoryId: storyId,
            files: conflictedFiles,
            mergedStoryIds: [...merged],
            blobs: conflictBlobs,
            reasoning: `mechanical resolution (scratch/@generated paths): ${mechanicalFiles.join(', ')}`,
            candidateWorktree: candidateDir,
          }).catch((e) =>
            log('warn', `[wave-merge] recordConflictEvent(mechanical) failed: ${e.message}`),
          );
          merged.push(storyId);
          continue;
        }
        log('warn', `[wave-merge] mechanical-resolution commit failed (${commit.code}); falling through to halt`);
      }

      // Story E Tier 2 (2026-05-30) — OPT-IN agentic merge. Only when the
      // daemon passed a resolver (toggle on). The resolver edits the
      // conflicted files in place; we verify marker-free, then commit with an
      // audit trailer and CONTINUE — the post-merge build gate (step 3) is the
      // final backstop, and advance-on-green (step 4) means a bad resolution
      // that compiles-but-is-wrong still never corrupts green silently (it's
      // recorded + revertible). Any failure falls through to the halt below.
      if (typeof resolveConflict === 'function' && agentFiles.length > 0) {
        log(
          'info',
          `[wave-merge] auto-merge ENABLED — resolving ${agentFiles.length} conflicted file(s) on wip/${storyId}`,
        );
        let res = null;
        try {
          res = await resolveConflict({
            worktreeDir: candidateDir,
            conflictedFiles: agentFiles,
            conflictStoryId: storyId,
            mergedStoryIds: [...merged],
            blobs: conflictBlobs,
            planId,
            epicId,
            waveNumber,
          });
        } catch (err) {
          log('warn', `[wave-merge] conflict resolver threw: ${err.message}; halting`);
        }
        if (res && res.resolved) {
          const remaining = filesWithConflictMarkers(agentFiles, candidateDir);
          if (remaining.length === 0) {
            const add = await git(['add', '-A'], candidateDir);
            // Audit trail (fixes F3): self-describing commit, NOT --no-edit.
            const subject =
              `merge story ${storyId} into wave [auto-resolved: ${agentFiles.join(', ')}` +
              (mechanicalFiles.length > 0 ? `; mechanical: ${mechanicalFiles.join(', ')}` : '') +
              `]`;
            const commit = await git(['commit', '-m', subject], candidateDir);
            if (add.code === 0 && commit.code === 0) {
              log('info', `[wave-merge] auto-resolved + committed merge of wip/${storyId}`);
              await recordConflictEvent({
                planId,
                epicId,
                waveNumber,
                appId,
                mode: 'auto-resolved',
                conflictedAtStoryId: storyId,
                files: conflictedFiles,
                mergedStoryIds: [...merged],
                blobs: conflictBlobs,
                reasoning: res.reasoning,
                candidateWorktree: candidateDir,
              }).catch((e) =>
                log('warn', `[wave-merge] recordConflictEvent(auto) failed: ${e.message}`),
              );
              merged.push(storyId);
              continue; // proceed to the next wip branch
            }
            log('warn', `[wave-merge] post-resolution commit failed (add=${add.code} commit=${commit.code}); halting`);
          } else {
            log(
              'warn',
              `[wave-merge] resolver left markers in ${remaining.length} file(s) (${remaining.join(', ')}); halting`,
            );
          }
        } else if (res && res.infra) {
          // snake3 (2026-06-10) — the resolver never got to WORK on the
          // conflict (expired OAuth / spawn failure / timeout, twice). Do
          // not burn this as "unresolvable": abort the half-merge, mark the
          // job TRANSIENT, and let the reducer re-mint it — the conflict
          // will be re-attempted by a healthy resolver. No operator card
          // for an attempt that never happened.
          log('warn', `[wave-merge] resolver INFRA failure (${res.reasoning?.slice(0, 200)}); marking transient for retry`);
          await git(['merge', '--abort'], candidateDir);
          await recordConflictEvent({
            planId,
            epicId,
            waveNumber,
            appId,
            mode: 'resolver-infra',
            conflictedAtStoryId: storyId,
            files: conflictedFiles,
            mergedStoryIds: [...merged],
            blobs: conflictBlobs,
            reasoning: res.reasoning,
            candidateWorktree: candidateDir,
          }).catch((e) => log('warn', `[wave-merge] recordConflictEvent(resolver-infra) failed: ${e.message}`));
          await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
          return {
            outcome: 'resolver-infra',
            transient: true,
            mergedStoryIds: merged,
            conflictedAtStoryId: storyId,
            conflictedFiles,
            error: res.reasoning,
          };
        } else if (res) {
          log('warn', `[wave-merge] resolver reported unresolved; halting`);
        }
        // Fall through to the halt path — must re-capture blobs (the resolver
        // may have partially edited the tree) before aborting.
      }

      // Abort the half-merge so the candidate is in a clean, re-tryable
      // state (back to green + the prior clean merges) for the operator.
      await git(['merge', '--abort'], candidateDir);
      log(
        'warn',
        `[wave-merge] CONFLICT on wip/${storyId}: ${conflictedFiles.length} file(s); halting wave`,
      );
      // Story C — durable telemetry. This is the conflict-rate data the
      // 2026-05-19 decision named as the precondition for revisiting
      // auto-resolution. Best-effort; never blocks the halt.
      await recordConflictEvent({
        planId,
        epicId,
        waveNumber,
        appId,
        mode: 'halted',
        conflictedAtStoryId: storyId,
        files: conflictedFiles,
        mergedStoryIds: [...merged],
        blobs: conflictBlobs,
        candidateWorktree: candidateDir,
      }).catch((e) => log('warn', `[wave-merge] recordConflictEvent failed (non-blocking): ${e.message}`));

      const attn = buildMergeConflictAttention({ planId, storyIds: ordered, conflictedFiles });
      await writeAttention({
        ...attn,
        dedupKey: `wave-merge-conflict:${planId}:${epicId}:${waveNumber}`,
        context: {
          ...(attn.context || {}),
          conflictedAtStoryId: storyId,
          coordinatorWorktree: candidateDir,
          mergeFlagBodies: flagBodies,
          conflictBlobs,
        },
      });
      // KEEP the candidate worktree — under operator-resolve-only the
      // operator needs a clean tree to resolve in. The reaper reaps it if
      // the wave is abandoned.
      return {
        outcome: 'merge-conflict',
        mergedStoryIds: merged,
        conflictedAtStoryId: storyId,
        conflictedFiles,
        coordinatorWorktree: candidateDir,
      };
    }
    merged.push(storyId);
  }

  // 3. Post-merge validation (if the boilerplate declared a command).
  if (postMergeValidationCmd) {
    // 2026-05-28 — the candidate worktree is created via `git worktree add`
    // with NO node_modules, so ANY validation command needing deps
    // (`npm run build`, `npm test`, `tsc`) would fail with exit 1/127.
    // Provide a REAL node_modules (Turbopack rejects the store symlink)
    // before running the gate. Lockfile-aware + idempotent.
    try {
      const mat = await materializeNodeModulesFromStore({
        appId,
        worktreeDir: candidateDir,
        installFn: coordinatorInstallFn || defaultCoordinatorInstallFn,
        log,
      });
      log(
        'info',
        `[wave-merge] candidate node_modules ${mat.materialized ? 'materialized' : `reused (${mat.skipped})`}`,
      );
    } catch (err) {
      // Can't provision deps → validation can't run. Surface as setup-failed
      // (infra problem, not a fake test failure) and reap the candidate.
      log('error', `[wave-merge] node_modules materialization failed: ${err.message}`);
      await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
      return { outcome: 'setup-failed', transient: true, error: `node_modules: ${err.message}` };
    }

    log('info', `[wave-merge] running post-merge validation: ${postMergeValidationCmd}`);
    let testRun = await shell(postMergeValidationCmd, candidateDir, 900_000);
    let combinedOut = testRun.stdout + '\n' + testRun.stderr;

    // pacman1 (2026-06-11) — agentic build-fix, one bounded attempt.
    // A non-transient validation failure used to halt the epic in 'fixing'
    // until an operator intervened — even for the classic cross-story
    // integration break no single story could see (parallel stories agree
    // on an interface but the merged union doesn't compile). When the
    // daemon passes `fixBuild` (same autoMerge gate as the conflict
    // resolver), let an agent repair the MERGED tree in the candidate,
    // then re-run the SAME validation. Green stays green-gated: the fix
    // only ships if the full gate passes, and the commit is audited.
    if (testRun.code !== 0 && !isNoOpTestExit(combinedOut) && fixBuild) {
      log('warn', `[wave-merge] post-merge validation failed (exit ${testRun.code}); attempting agentic build-fix`);
      try {
        const fix = await fixBuild({
          worktreeDir: candidateDir,
          validationCmd: postMergeValidationCmd,
          validationOutput: combinedOut.slice(-6000),
          mergedStoryIds: merged,
          planId,
          epicId,
          waveNumber,
        });
        if (fix?.attempted) {
          const rerun = await shell(postMergeValidationCmd, candidateDir, 900_000);
          if (rerun.code === 0 || isNoOpTestExit(rerun.stdout + '\n' + rerun.stderr)) {
            // Commit EVERYTHING the fix produced (add -A: it may create
            // files, e.g. a missing contract module) with an audit trailer.
            await git(['add', '-A'], candidateDir);
            const fixCommit = await git(
              [
                '-c', 'user.email=daemon@futurator.local',
                '-c', 'user.name=Daemon',
                'commit', '-m',
                `wave ${waveNumber}: agentic build-fix after merge\n\nValidation: ${postMergeValidationCmd}\nReasoning: ${(fix.reasoning || '').slice(0, 800)}`,
              ],
              candidateDir,
            );
            if (fixCommit.code !== 0 && !/nothing to commit/.test(fixCommit.stdout + fixCommit.stderr)) {
              log('warn', `[wave-merge] build-fix commit failed: ${(fixCommit.stderr || '').trim().slice(0, 300)}`);
            } else {
              log('info', `[wave-merge] agentic build-fix PASSED revalidation — proceeding to green advance`);
              testRun = rerun;
              combinedOut = rerun.stdout + '\n' + rerun.stderr;
            }
          } else {
            log('warn', `[wave-merge] build-fix attempted but revalidation still failing (exit ${rerun.code}) — halting`);
            testRun = rerun;
            combinedOut = rerun.stdout + '\n' + rerun.stderr;
          }
        }
      } catch (err) {
        log('warn', `[wave-merge] build-fix hook threw (non-blocking, falling through to halt): ${err.message}`);
      }
    }

    // 2026-05-28 — a no-op test command (no test script / no test files) is
    // NOT a wave failure. Treat as pass; the build half of the gate already
    // validated compile + type-check.
    if (testRun.code !== 0 && isNoOpTestExit(combinedOut)) {
      log(
        'info',
        `[wave-merge] post-merge validation exited ${testRun.code} but output indicates no runnable tests — treating as pass`,
      );
    } else if (testRun.code !== 0) {
      const failing = parseFailingTests(combinedOut);
      log(
        'warn',
        `[wave-merge] post-merge validation FAILED (exit ${testRun.code}); ${failing.length} failing test(s)`,
      );
      const attn = buildWaveBuildFailedAttention({
        planId,
        storyIds: merged,
        testExit: testRun.code,
        failingTests: failing,
        outputTail: combinedOut.slice(-1800),
      });
      await writeAttention({
        ...attn,
        dedupKey: `wave-build-failed:${planId}:${epicId}:${waveNumber}`,
        context: {
          ...(attn.context || {}),
          validationCmd: postMergeValidationCmd,
          // pacman1 (2026-06-11) — epicId + waveNumber wire the card's
          // Retry button to POST /plans/:id/waves/retry-gate.
          epicId,
          waveNumber,
        },
      });
      // Build failed against the candidate — `plan/<slug>` was never
      // advanced (still at green). Reap the throwaway candidate.
      await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
      return {
        outcome: 'wave-build-failed',
        mergedStoryIds: merged,
        testOutput: combinedOut.slice(-4000),
        failingTests: failing,
      };
    }
    log('info', `[wave-merge] post-merge validation passed`);

    // dino1 root-cause (2026-06-10) — COMMIT WHAT WE VALIDATED. The
    // validation command may regenerate generated source (e.g., a
    // boilerplate's wiring generator rebuilding src/app/page.tsx from
    // src/features/*). Pre-fix, those regenerated files existed only in
    // this throwaway candidate worktree: the build validated the WIRED
    // app, then the green advance pointed plan/<slug> at the merge commit
    // WITHOUT them. The committed branch never contained the integrated
    // page — every dev-server consumer (in-story VQA, QA preview, deploy)
    // served the boilerplate starter while all build gates stayed green.
    // Generic contract: any TRACKED file the validation command modified
    // is part of the validated state and must land in the branch.
    const dirty = await git(['status', '--porcelain', '--untracked-files=no'], candidateDir);
    if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
      const changed = dirty.stdout.trim().split('\n');
      await git(['add', '-u'], candidateDir);
      const gen = await git(
        [
          '-c',
          'user.email=daemon@futurator.local',
          '-c',
          'user.name=Daemon',
          'commit',
          '-m',
          `wave ${waveNumber}: regenerated files from post-merge validation\n\n${changed.slice(0, 20).join('\n')}`,
        ],
        candidateDir,
      );
      if (gen.code === 0) {
        log(
          'info',
          `[wave-merge] committed ${changed.length} regenerated file(s) from validation: ${changed.join(', ').slice(0, 300)}`,
        );
      } else {
        log('warn', `[wave-merge] could not commit regenerated files (non-blocking): ${gen.stderr.trim()}`);
      }
    }
  } else {
    log('info', `[wave-merge] no postMergeValidationCmd — skipping validation`);
  }

  // 3.5. v2.6 wave-gate VQA (M2, 2026-06-11) — judged visual QA runs against
  // the MERGED candidate (the first place the real integrated product
  // exists), between validation and the green advance. The hook is OPT-IN:
  // undefined ⇒ skip (the daemon passes it only when rigor !== 'prototype',
  // the boilerplate has a qaContext, and the wave has browser ACs).
  //
  // Outcome contract (fix-forward semantics — judged failures NEVER block):
  //   pass / fixed / fix-forward / skipped → proceed to advance; the vqa
  //     result is surfaced on the runner result for the handler/UI. A 'fixed'
  //     outcome means the VQA fixer committed audited changes to the
  //     candidate — the advance below ships them.
  //   env-blocked (dev server would not boot — DETERMINISTIC) → behaves
  //     exactly like a build failure: attention card, candidate reaped,
  //     'wave-build-failed' outcome (reuses ALL existing retry machinery).
  let vqa = null;
  if (typeof runVqa === 'function') {
    try {
      vqa = await runVqa({ candidateDir, mergedStoryIds: merged });
    } catch (err) {
      // The VQA stage is judged-path machinery — a crash in it must never
      // hold the wave hostage. Loud, non-blocking.
      log('warn', `[wave-merge] wave VQA threw (non-blocking, advancing): ${err.message}`);
      vqa = { outcome: 'skipped', reason: `vqa-crashed: ${err.message}` };
    }
    if (vqa?.outcome === 'env-blocked') {
      log('error', `[wave-merge] wave VQA env-blocked — dev server no-boot on the merged candidate`);
      const attn = buildWaveBuildFailedAttention({
        planId,
        storyIds: merged,
        testExit: 1,
        failingTests: [],
        outputTail: `wave VQA: dev server failed to boot on the merged candidate.\n\n--- dev server log (tail) ---\n${(vqa.bootLogTail || '').slice(-1500)}`,
      });
      await writeAttention({
        ...attn,
        dedupKey: `wave-build-failed:${planId}:${epicId}:${waveNumber}`,
        context: { ...(attn.context || {}), validationCmd: 'wave-vqa dev-server boot', epicId, waveNumber },
      });
      await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
      return {
        outcome: 'wave-build-failed',
        mergedStoryIds: merged,
        testOutput: (vqa.bootLogTail || '').slice(-4000),
        failingTests: [],
        vqa,
      };
    }
  }

  // 4. Advance green ATOMICALLY to the validated candidate SHA. This is the
  //    only mutation of `plan/<slug>`, and it only ever points the branch at
  //    a fully-built commit — readers/deploys never see a half-merge.
  const headSha = await git(['rev-parse', 'HEAD'], candidateDir);
  const candidateSha = headSha.code === 0 ? headSha.stdout.trim() : '';
  if (candidateSha.length !== 40) {
    log('error', `[wave-merge] could not read candidate HEAD; aborting advance`);
    await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
    return { outcome: 'setup-failed', transient: true, error: 'candidate HEAD unreadable' };
  }
  // Compare-and-swap: advance only if green is still where we forked from.
  // Under the per-app integration lock this always holds; the expected-old
  // arg is the distributed-ready ref-CAS backstop (see integration-lock.mjs).
  const updateArgs = planExists
    ? ['--git-dir', bare, 'update-ref', `refs/heads/${planBranch}`, candidateSha, greenSha]
    : ['--git-dir', bare, 'update-ref', `refs/heads/${planBranch}`, candidateSha];
  const upd = await git(updateArgs, bareOpCwd);
  if (upd.code !== 0) {
    // Green moved underneath us (should be impossible under the lock). Do
    // NOT force — leave green untouched; the wave re-runs on the new green.
    log('error', `[wave-merge] green advance CAS failed (green moved?): ${upd.stderr.trim()}`);
    await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
    return { outcome: 'setup-failed', transient: true, error: `green-advance-failed: ${upd.stderr.trim()}` };
  }
  log('info', `[wave-merge] advanced plan/${planSlug} → ${candidateSha.slice(0, 7)} (was ${greenSha.slice(0, 7)})`);

  // Push the advanced ref (non-blocking — the local ref is the source of
  // truth today; origin is a mirror).
  const push = await git(
    ['--git-dir', bare, 'push', 'origin', `refs/heads/${planBranch}:refs/heads/${planBranch}`],
    bareOpCwd,
  );
  if (push.code !== 0) {
    log(
      'warn',
      `[wave-merge] push to origin/${planBranch} failed (non-blocking): ${push.stderr.trim()}`,
    );
  }

  // 5. Reap the throwaway candidate, then tear down per-story worktrees +
  //    local wip branches. GitHub branches survive (forensic value during
  //    the plan's lifetime; plan-delete cascade reaps them later).
  await reapWorktree({ dir: candidateDir, bare, git, bareOpCwd, log });
  for (const storyId of merged) {
    try {
      await teardownStoryWorktree({ appId, planSlug, storyId, deleteBranch: true, log });
    } catch (err) {
      log('warn', `[wave-merge] teardown failed for ${storyId} (non-blocking): ${err.message}`);
    }
  }

  log(
    'info',
    `[wave-merge] wave ${waveNumber} merged ${merged.length} stories cleanly; green ${candidateSha.slice(0, 7)}`,
  );

  // snake3 (2026-06-10) — a SUCCESSFUL merge closes any open failure cards a
  // prior attempt on this same (epic, wave) opened. Without this the
  // operator keeps seeing "Wave merge conflict" / "wave build failed" hours
  // after a retry went green (dedup keeps it ONE card, but nothing resolved
  // it). Best-effort; never blocks the success.
  if (typeof resolveAttention === 'function') {
    for (const key of [
      `wave-merge-conflict:${planId}:${epicId}:${waveNumber}`,
      `wave-build-failed:${planId}:${epicId}:${waveNumber}`,
    ]) {
      await resolveAttention(key).catch((e) =>
        log('warn', `[wave-merge] attention auto-resolve failed for ${key} (non-blocking): ${e.message}`),
      );
    }
  }

  return {
    outcome: 'success',
    mergedStoryIds: merged,
    pushSha: candidateSha,
    cleanupBranches: postMergeCleanupBranches(merged),
    // v2.6 M2 — judged VQA result (null when the hook wasn't passed). The
    // handler persists it on waveMergeResult; M5 surfaces it in the UI and
    // mints fix stories from `vqa.fixForward`.
    vqa,
  };
}
