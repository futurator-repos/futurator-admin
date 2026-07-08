// tree-gates — whole-tree reality gates for the Reality-Spine pipeline
// (redesign Part 2, P1 ①②; Part 5 #3 green-trunk). These run on the USER app
// tree (job.workingDir, e.g. /home/ubuntu/projects/<appId>) — NOT this repo —
// which exposes `npx tsc --noEmit` and `npm run build`.
//
// HONESTY CONTRACT (shared with browser-probe-executor): these NEVER fake-pass.
// A gate passes only when the command actually exits 0; any error, timeout, or
// non-zero exit returns { passed:false } with the captured tail as `detail`.
//
// Spawn is injected so the pure dispatch logic unit-tests without running tsc.

import { spawnSync as nodeSpawnSync } from 'node:child_process';

// A whole-tree build can be slow on a cold worktree (Turbopack cold start), so
// the default ceiling is generous — callers may pass a tighter `timeoutMs`.
const DEFAULT_TIMEOUT_MS = 300_000;

/** Run a shell command, return { passed, detail } from the exit code (mirrors
 *  test-executors.runCommand: error → passed:false, non-zero → tail detail). */
function runCommand(spawnSync, cmd, args, { cwd, timeoutMs } = {}) {
  try {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs || DEFAULT_TIMEOUT_MS });
    if (res.error) return { passed: false, detail: `${cmd} error: ${res.error.message}` };
    const passed = res.status === 0;
    const tail = ((res.stdout || '') + (res.stderr || '')).trim().slice(-400);
    return { passed, detail: passed ? 'pass' : `exit ${res.status}: ${tail}` };
  } catch (err) {
    return { passed: false, detail: `${cmd} threw: ${err?.message || err}` };
  }
}

/**
 * Whole-tree typecheck: `npx tsc --noEmit` in the app tree.
 * @param {{ cwd:string, spawnSync?:Function, timeoutMs?:number }} opts
 * @returns {{ passed:boolean, detail:string }}
 */
export function runTreeTypecheck({ cwd, spawnSync = nodeSpawnSync, timeoutMs } = {}) {
  return runCommand(spawnSync, 'npx', ['tsc', '--noEmit'], { cwd, timeoutMs });
}

/**
 * Whole-tree build: `npm run build` in the app tree.
 * @param {{ cwd:string, spawnSync?:Function, timeoutMs?:number }} opts
 * @returns {{ passed:boolean, detail:string }}
 */
export function runTreeBuild({ cwd, spawnSync = nodeSpawnSync, timeoutMs } = {}) {
  return runCommand(spawnSync, 'npm', ['run', 'build'], { cwd, timeoutMs });
}

/**
 * PURE green-trunk verdict from a typecheck + build result. Every failing
 * dimension pushes its name into `failing` and a human-readable line into
 * `reasons`. Fail-closed: a missing/undefined result counts as a failure.
 *
 * @param {{ tsc?:{passed:boolean,detail?:string}, build?:{passed:boolean,detail?:string} }} opts
 * @returns {{ passed:boolean, failing:string[], reasons:string[] }}
 */
export function evaluateGreenTrunk({ tsc, build } = {}) {
  const failing = [];
  const reasons = [];
  if (!tsc?.passed) {
    failing.push('tsc');
    reasons.push(`green-trunk tsc failed: ${tsc?.detail ?? 'no result'}`);
  }
  if (!build?.passed) {
    failing.push('build');
    reasons.push(`green-trunk build failed: ${build?.detail ?? 'no result'}`);
  }
  return { passed: failing.length === 0, failing, reasons };
}
