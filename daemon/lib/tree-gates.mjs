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
 * Whole-tree test suite: `npm run test` over the ENTIRE app tree. ASYNC
 * (non-blocking). This mirrors the integrator's whole-tree battery — the same
 * `npm run test` that runs once per plan — but per story, so every story blocks
 * on the WHOLE suite (see foundation-gate P3_SUITE_GREEN). A full brownfield
 * suite is the slowest of the three checks, so the ceiling is the generous
 * 300s DEFAULT_TIMEOUT_MS by default; callers may pass a tighter `timeoutMs`.
 * @param {{ cwd:string, runner?:Function, timeoutMs?:number }} opts
 * @returns {Promise<{ passed:boolean, detail:string }>}
 */
export function runTreeTests({ cwd, runner = defaultTreeRunner, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return runCommand(runner, 'npm', ['run', 'test'], { cwd, timeoutMs });
}

/**
 * PURE green-trunk verdict from a typecheck + build (+ optional whole-suite)
 * result. Every failing dimension pushes its name into `failing` and a
 * human-readable line into `reasons`. tsc/build fail-closed: a missing/undefined
 * result counts as a failure.
 *
 * PRESENCE SEMANTICS for `tests` (P3_SUITE_GREEN wiring): the whole-suite
 * dimension participates ONLY when the `tests` key is PRESENT. `tests ===
 * undefined` → not gated, so every pre-redesign 2-arg caller ({tsc,build}) stays
 * byte-identical (no 'tests' entry, no extra reason). A present-but-failed
 * `tests` result fails CLOSED with failing entry 'tests' and reason
 * 'green-trunk suite failed: <detail>'. (Passing an explicit `undefined` is the
 * flag-off posture; passing a result — even a null-ish one — opts into the gate.)
 *
 * @param {{ tsc?:{passed:boolean,detail?:string}, build?:{passed:boolean,detail?:string},
 *           tests?:{passed:boolean,detail?:string} }} opts
 * @returns {{ passed:boolean, failing:string[], reasons:string[] }}
 */
export function evaluateGreenTrunk({ tsc, build, tests } = {}) {
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
  // Whole-suite gate: PRESENT-only. undefined → skip (legacy 2-dim verdict);
  // present-but-failed → fail closed (the cross-plan regression guardrail).
  if (tests !== undefined && !tests?.passed) {
    failing.push('tests');
    reasons.push(`green-trunk suite failed: ${tests?.detail ?? 'no result'}`);
  }
  return { passed: failing.length === 0, failing, reasons };
}
