// test-executors — real bound-AC test runners for the story-dev Verify stage
// (development-plan §5.5). The test-binding-runner dispatches by `kind`; these are
// the executors that actually run the bound test in the app's worktree and return
// { passed, detail }.
//
//   unit / integration → `npx vitest run <testRef>` (testRef is a vitest filter)
//   typecheck          → `npx tsc --noEmit`
//   lint               → `npx eslint <touched>`
//   browser / manual   → NOT auto-run (browser → existing probe harness later;
//                        manual → routed to human by the completion gate)
//
// Spawn is injected so the dispatch logic unit-tests without running anything.

import { spawnSync as nodeSpawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Run a shell command, return { passed, detail } from the exit code. */
function runCommand(spawnSync, cmd, args, { cwd, timeoutMs }) {
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
 * Build the default executor set bound to a worktree.
 *
 * @param {{ cwd: string, spawnSync?: Function, timeoutMs?: number }} opts
 * @returns {Record<string, (ac:object)=>Promise<{passed:boolean,detail?:string}>>}
 */
export function defaultExecutors({ cwd, spawnSync = nodeSpawnSync, timeoutMs } = {}) {
  const vitest = async (ac) => {
    const testRef = ac.testBinding?.testRef;
    if (!testRef) return { passed: false, detail: 'no testRef bound' };
    // testRef is a vitest filter — pass it through `vitest run`.
    return runCommand(spawnSync, 'npx', ['vitest', 'run', testRef], { cwd, timeoutMs });
  };
  return {
    unit: vitest,
    integration: vitest,
    typecheck: async () => runCommand(spawnSync, 'npx', ['tsc', '--noEmit'], { cwd, timeoutMs }),
    lint: async (ac) => {
      const target = ac.testBinding?.testRef || '.';
      return runCommand(spawnSync, 'npx', ['eslint', target], { cwd, timeoutMs });
    },
    // browser/manual intentionally absent → test-binding-runner falls back to unit
    // for browser (which will fail-closed without a real probe harness — safe), and
    // manual ACs are skipped by the runner and routed to human by the gate.
  };
}
