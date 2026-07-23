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
import { existsSync as nodeExistsSync } from 'node:fs';
import { join } from 'node:path';
import { makeBrowserExecutor } from './browser-probe-executor.mjs';
import { resolveTestRefs } from './completion-gate.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

// A resolved ref token must name a real *.test.* / *.spec.* file; anything else
// is a binding fault (errored), never a silent pass. Matches .ts/.tsx/.js/.jsx/
// .mts/.cts and their spec variants.
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

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
export function defaultExecutors({ cwd, qaContext, spawnSync = nodeSpawnSync, timeoutMs, log, exists = nodeExistsSync, emitProbeEvent } = {}) {
  // F1 (Incident C, 2026-07-13): an AC's testRef may be a single path, a
  // 'file > describe > it' selector, a JSON array of paths, OR a legacy
  // " + "-joined composite with parenthetical prose. resolveTestRefs normalizes
  // ALL of these to a run-list; we resolve EACH token to a REAL committed test
  // file and run it. The AC passes IFF every token resolved to an existing test
  // file AND every run exits 0.
  //
  // SAFETY: this must NEVER turn a genuinely-failing AC green. A token that does
  // not resolve to a real *.test.* file → `errored` (a BINDING FAULT, distinct
  // from a test that ran and failed) and passed:false. Any failing run →
  // passed:false. passed:true ONLY when every token is a real file AND every run
  // is green. The OLD code fed the whole composite to vitest as one filename
  // filter → unmatchable → exit 1 → an un-completable story.
  const vitest = async (ac) => {
    const tokens = resolveTestRefs(ac.testBinding?.testRef);
    if (!tokens.length) return { passed: false, errored: true, detail: 'no testRef bound' };
    const details = [];
    let allPassed = true;
    let errored = false;
    for (const token of tokens) {
      // resolveTestRefs already reduced each ref to its file segment; re-split
      // defensively so a raw selector that slips through still runs by file.
      const filePath = String(token).split(' > ')[0].trim();
      // A ref that names no real *.test.*/*.spec.* file in the worktree is a
      // BINDING FAULT — errored, never a silent pass. (The vitest filter would
      // exit 1 and masquerade as a real test failure; --passWithNoTests could
      // vacuously pass.)
      if (!TEST_FILE_RE.test(filePath) || !exists(cwd ? join(cwd, filePath) : filePath)) {
        errored = true;
        allPassed = false;
        details.push(`${filePath}: no such test file (unrunnable ref)`);
        continue;
      }
      // --passWithNoTests=false (pacman1, 2026-07-13): the scaffold's vitest
      // config ships passWithNoTests:true; without this a file that resolves to
      // NO test exits 0 — a vacuous PASS on an AC nobody verified.
      const r = runCommand(spawnSync, 'npx', ['vitest', 'run', '--passWithNoTests=false', filePath], { cwd, timeoutMs });
      // A spawn error / throw from the runner itself is ALSO a binding fault
      // (the test could not be executed), distinct from a clean exit!=0.
      if (typeof r.detail === 'string' && /^npx (error|threw):/.test(r.detail)) errored = true;
      if (!r.passed) allPassed = false;
      details.push(`${filePath}: ${r.detail}`);
    }
    return { passed: allPassed && !errored, errored, detail: details.join(' | ') };
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
  if (qaContext) executors.browser = makeBrowserExecutor({ cwd, qaContext, deps: { log, emitProbeEvent } });
  return executors;
}
