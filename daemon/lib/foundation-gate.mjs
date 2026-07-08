// foundation-gate — the hardened P1 SCAFFOLD gate + the story-dev gate factory
// (redesign Part 2 P1 ①②③, Part 5 #2). A foundation story is only `done` once
// the contract COMPILES (tsc), BUILDS (npm run build), and is ALIVE (boot-
// liveness) as a unit — before any dependent forks off it. All three dimensions
// FAIL CLOSED.
//
// This module is the seam S3 (story-dev-pipeline) and S7 (agent-daemon) consume:
// makeStoryDevGateDeps returns { foundationGate, greenTrunk } — the two async
// checks the story-dev job runs. Boot/probe deps are injectable so the factory
// unit-tests without a real dev server or playwright.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { bootDevServer as realBootDevServer } from './dev-server-boot.mjs';
import { defaultShellRunner as realShell } from './wave-merge-runner.mjs';
import { runTreeTypecheck, runTreeBuild, evaluateGreenTrunk } from './tree-gates.mjs';
import { runBootLiveness, defaultLivenessInputs } from './boot-liveness.mjs';

/**
 * PURE: is this a foundation/scaffold story? Either the planner-set flag or the
 * classified nodeKind marks it (contract §D).
 * @param {{ isFoundation?:boolean, nodeKind?:string }} [payload]
 * @returns {boolean}
 */
export function isFoundationStory(payload) {
  return payload?.isFoundation === true || payload?.nodeKind === 'foundation';
}

/**
 * PURE: the P1 SCAFFOLD verdict from tsc + build + boot-liveness. Every failing
 * dimension pushes its name into `failing` and a human-readable line into
 * `reasons`. Fail-closed: a missing/undefined result counts as a failure.
 *
 * @param {{ tsc?:{passed:boolean,detail?:string}, build?:{passed:boolean,detail?:string},
 *           boot?:{passed:boolean,detail?:string} }} opts
 * @returns {{ passed:boolean, failing:string[], reasons:string[] }}
 */
export function evaluateFoundationGate({ tsc, build, boot } = {}) {
  const failing = [];
  const reasons = [];
  if (!tsc?.passed) {
    failing.push('tsc');
    reasons.push(`foundation tsc failed: ${tsc?.detail ?? 'no result'}`);
  }
  if (!build?.passed) {
    failing.push('build');
    reasons.push(`foundation build failed: ${build?.detail ?? 'no result'}`);
  }
  if (!boot?.passed) {
    failing.push('boot');
    reasons.push(`boot-liveness failed: ${boot?.detail ?? 'no result'}`);
  }
  return { passed: failing.length === 0, failing, reasons };
}

/**
 * Build the two story-dev gate checks bound to a worktree (contract §D/§E). S7
 * spreads the result into agent-daemon's story-dev deps; S3 calls them.
 *
 *   foundationGate({cwd,headSha,qaContext}) → runs tsc + build + boot-liveness
 *     (boots the dev server with the __harness seam env, probes, stops it) →
 *     evaluateFoundationGate.
 *   greenTrunk({cwd}) → runs tsc + build → evaluateGreenTrunk.
 *
 * `deps` (bootDevServer, playwright, shell, log) are injectable for tests; the
 * production defaults boot the real dev server and lazy-import real playwright.
 *
 * @param {{ cwd?:string, spawnSync?:Function, qaContext?:object, deps?:object }} opts
 */
export function makeStoryDevGateDeps({ cwd, spawnSync = nodeSpawnSync, qaContext, deps = {} } = {}) {
  const shell = deps.shell || realShell;
  const bootDev = deps.bootDevServer || realBootDevServer;
  const getPlaywright = deps.playwright ? async () => deps.playwright : async () => import('playwright');
  const log = deps.log || (() => {});

  // Boot the served app with the seam env (bootDevServer already sets
  // NEXT_PUBLIC_TEST_HARNESS=1) and run the liveness probe; always stop the
  // server in `finally` (lifecycle mirrors makeBrowserExecutor). Fail-closed on
  // any boot/probe error — a reality gate never passes unobserved.
  async function bootAndProbe({ cwd: workDir, qaContext: qa }) {
    const bootLog = (m) => {
      try {
        log('info', `[foundation-gate:dev-server] ${m}`);
      } catch {
        /* best-effort */
      }
    };
    const port = qa?.defaultPort ?? 3000;
    let boot;
    try {
      boot = await bootDev({ cwd: workDir, qaContext: qa, port, shell, log: bootLog });
      if (!boot?.ok) {
        return { passed: false, seamMounted: false, detail: `dev server did not boot (status=${boot?.status ?? 'unknown'})` };
      }
      const url = `http://localhost:${boot.port}${qa?.healthcheckPath ?? '/'}`;
      const playwright = await getPlaywright();
      return await runBootLiveness({ url, playwright, inputs: defaultLivenessInputs(), log });
    } catch (err) {
      return { passed: false, seamMounted: false, detail: `boot-liveness error: ${err?.message || err}` };
    } finally {
      try {
        if (boot?.stop) await boot.stop();
      } catch {
        /* best-effort */
      }
    }
  }

  return {
    // headSha is accepted for SHA-pinning by the caller (S7 stamps it on the
    // job); the pure verdict itself does not depend on it.
    foundationGate: async ({ cwd: c = cwd, headSha, qaContext: qa = qaContext } = {}) => {
      void headSha;
      const tsc = runTreeTypecheck({ cwd: c, spawnSync });
      const build = runTreeBuild({ cwd: c, spawnSync });
      const boot = await bootAndProbe({ cwd: c, qaContext: qa });
      return evaluateFoundationGate({ tsc, build, boot });
    },
    greenTrunk: async ({ cwd: c = cwd } = {}) =>
      evaluateGreenTrunk({
        tsc: runTreeTypecheck({ cwd: c, spawnSync }),
        build: runTreeBuild({ cwd: c, spawnSync }),
      }),
  };
}
