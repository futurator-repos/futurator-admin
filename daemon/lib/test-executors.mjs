// test-executors — real bound-AC test runners for the story-dev Verify stage
// (development-plan §5.5). The test-binding-runner dispatches by `kind`; these are
// the executors that actually run the bound test in the app's worktree and return
// { passed, detail }.
//
//   unit / integration → `npx vitest run <testRef>` (testRef is a vitest filter)
//   typecheck          → `npx tsc --noEmit`
//   lint               → `npx eslint <touched>`
//   browser            → serve the app + Playwright + assert __harness.snapshot()
//                        (browser-probe-executor), WHEN a qaContext is resolvable
//                        for the boilerplate; without one it stays fail-closed.
//   manual             → NOT auto-run (routed to human by the completion gate)
//
// Spawn is injected so the dispatch logic unit-tests without running anything.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { makeBrowserExecutor } from './browser-probe-executor.mjs';

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
 * @param {{ cwd: string, qaContext?: object, spawnSync?: Function, timeoutMs?: number }} opts
 *   qaContext (from the boilerplate gate-registry) enables the `browser`
 *   executor — without it, the runner's fail-closed `browser` default applies.
 * @returns {Record<string, (ac:object)=>Promise<{passed:boolean,detail?:string}>>}
 */
export function defaultExecutors({ cwd, qaContext, spawnSync = nodeSpawnSync, timeoutMs, log } = {}) {
  const vitest = async (ac) => {
    const testRef = ac.testBinding?.testRef;
    if (!testRef) return { passed: false, detail: 'no testRef bound' };
    // Agents emit testRefs in vitest's REPORT notation, e.g.
    //   "src/x/__tests__/dino.test.ts > describe — … > it — … (AC-S2-2)"
    // `vitest run <ref>` would treat the whole string as a FILE filter → no
    // match → exit 1. Take the file segment (before the first " > ") and run
    // THAT file: a story-level gate passes iff all its tests pass, which is
    // exactly the bound-AC contract — and it's robust against agent-generated
    // test-name strings (no fragile `-t` regex). Per-test precision can come
    // later if partial-credit reporting is ever needed.
    const filePath = String(testRef).split(' > ')[0].trim();
    return runCommand(spawnSync, 'npx', ['vitest', 'run', filePath], { cwd, timeoutMs });
  };
  const executors = {
    unit: vitest,
    integration: vitest,
    typecheck: async () => runCommand(spawnSync, 'npx', ['tsc', '--noEmit'], { cwd, timeoutMs }),
    lint: async (ac) => {
      const target = ac.testBinding?.testRef || '.';
      return runCommand(spawnSync, 'npx', ['eslint', target], { cwd, timeoutMs });
    },
  };
  // Only add `browser` when we can actually serve the app (qaContext present).
  // When absent we leave the key OFF so the test-binding-runner's fail-closed
  // `browser` default applies — never fake-pass an unverified behavioral AC.
  // `manual` stays absent → routed to human by the completion gate.
  if (qaContext) executors.browser = makeBrowserExecutor({ cwd, qaContext, deps: { log } });
  return executors;
}
