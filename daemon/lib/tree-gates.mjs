// tree-gates — whole-tree reality gates for the Reality-Spine pipeline
// (redesign Part 2, P1 ①②; Part 5 #3 green-trunk). These run on the USER app
// tree (job.workingDir, e.g. /home/ubuntu/projects/<appId>) — NOT this repo —
// which exposes `npx tsc --noEmit` and `npm run build`.
//
// HONESTY CONTRACT (shared with browser-probe-executor): these NEVER fake-pass.
// A gate passes only when the command actually exits 0; any error, timeout, or
// non-zero exit returns { passed:false } with the captured tail as `detail`.
//
// ASYNC / NON-BLOCKING (reality-spine review fix): these are default-ON and are
// awaited from INSIDE the single-process daemon's per-story job loop. They MUST
// NOT block the event loop — a synchronous spawnSync (tsc+build can take minutes
// on a cold worktree) would freeze the heartbeat writer, the PENDING-job poll,
// and every concurrently-dispatched sibling story for its full duration. So the
// command runs via an event-based async child process (`child_process.spawn`),
// letting other jobs, the heartbeat, and the frontier keep making progress while
// tsc/build run. The runner is injected so the pure dispatch logic unit-tests
// without spawning a real process.

import { spawn as nodeSpawn } from 'node:child_process';

// A whole-tree build can be slow on a cold worktree (Turbopack cold start), so
// the default ceiling is generous — callers may pass a tighter `timeoutMs`.
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Default async command runner: spawn `cmd args` in `cwd`, collect stdout/stderr,
 * resolve `{ status, stdout, stderr, error }` (spawnSync-compatible shape) on
 * close — WITHOUT blocking the event loop. A launch error resolves `{ error }`;
 * a timeout kills the child and resolves `{ error }` (fail-closed upstream).
 *
 * @returns {Promise<{status:number|null, stdout:string, stderr:string, error?:Error}>}
 */
export function defaultTreeRunner(cmd, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = nodeSpawn(cmd, args, { cwd });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: '', error: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* best-effort */ }
        }, timeoutMs)
      : null;
    child.stdout?.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => done({ status: null, stdout, stderr, error: err }));
    child.on('close', (code) =>
      done(
        timedOut
          ? { status: null, stdout, stderr, error: new Error(`timed out after ${timeoutMs}ms`) }
          : { status: code, stdout, stderr },
      ),
    );
  });
}

/** Run a command via the injected async runner → { passed, detail } from the
 *  exit code (mirrors test-executors.runCommand: error → passed:false, non-zero
 *  → tail detail). Fail-closed on any thrown/rejected runner. */
async function runCommand(runner, cmd, args, { cwd, timeoutMs } = {}) {
  try {
    const res = (await runner(cmd, args, { cwd, timeoutMs })) || {};
    if (res.error) return { passed: false, detail: `${cmd} error: ${res.error.message}` };
    const passed = res.status === 0;
    const tail = ((res.stdout || '') + (res.stderr || '')).trim().slice(-400);
    return { passed, detail: passed ? 'pass' : `exit ${res.status}: ${tail}` };
  } catch (err) {
    return { passed: false, detail: `${cmd} threw: ${err?.message || err}` };
  }
}

/**
 * Whole-tree typecheck: `npx tsc --noEmit` in the app tree. ASYNC (non-blocking).
 * @param {{ cwd:string, runner?:Function, timeoutMs?:number }} opts
 * @returns {Promise<{ passed:boolean, detail:string }>}
 */
export function runTreeTypecheck({ cwd, runner = defaultTreeRunner, timeoutMs } = {}) {
  return runCommand(runner, 'npx', ['tsc', '--noEmit'], { cwd, timeoutMs });
}

/**
 * Whole-tree build: `npm run build` in the app tree. ASYNC (non-blocking).
 * @param {{ cwd:string, runner?:Function, timeoutMs?:number }} opts
 * @returns {Promise<{ passed:boolean, detail:string }>}
 */
export function runTreeBuild({ cwd, runner = defaultTreeRunner, timeoutMs } = {}) {
  return runCommand(runner, 'npm', ['run', 'build'], { cwd, timeoutMs });
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
