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
//
// SHA-PIN (reality-spine review fix): all concurrent stories share ONE working
// tree and only the git-commit step is serialized (commit-lock.mjs) — NOT the
// multi-second/minute tsc+build+boot whole-tree check. So a sibling story's
// commit can land WHILE this check runs, making a transient verdict that belongs
// to a different tree state. Mirroring the SHA-pin discipline used by the other
// reality checks in this pipeline, foundationGate/greenTrunk read HEAD before and
// after the check and FAIL CLOSED (retry) if it moved — a whole-tree verdict must
// describe a single, stable tree. (When no git reader is injected — unit tests —
// the pin is skipped and the raw verdict stands.)

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

/** Read the tree's current HEAD sha via the injected git runner (null if no
 *  reader or the read fails — the caller then skips the staleness pin). */
async function readHead(git, cwd) {
  if (typeof git !== 'function') return null;
  try {
    const r = await git(['rev-parse', 'HEAD'], cwd);
    if (r && r.code === 0 && r.stdout) return String(r.stdout).trim();
  } catch {
    /* tolerate — treated as "unpinnable" */
  }
  return null;
}

/**
 * If HEAD moved between `head0` and now, the whole-tree verdict describes a
 * different tree than it started on (a concurrent sibling commit) — fail closed
 * so the story retries against a stable tree. No reader / no head0 → trust the
 * raw verdict (nothing to pin against).
 */
async function pinIfStable(verdict, { git, cwd, head0 }) {
  if (!head0) return verdict;
  const head1 = await readHead(git, cwd);
  if (head1 && head1 !== head0) {
    return {
      passed: false,
      failing: [...(verdict.failing || []), 'tree-moved'],
      reasons: [
        ...(verdict.reasons || []),
        `whole-tree gate ran against a MOVING tree: HEAD ${head0.slice(0, 7)}→${head1.slice(0, 7)} `
          + `(a concurrent sibling story committed mid-check) — verdict is unreliable, fail-closed (retry)`,
      ],
    };
  }
  return verdict;
}

/**
 * Build the two story-dev gate checks bound to a worktree (contract §D/§E). S7
 * spreads the result into agent-daemon's story-dev deps; S3 calls them.
 *
 *   foundationGate({cwd,headSha,qaContext}) → runs tsc + build + boot-liveness
 *     (boots the dev server with the __harness seam env, probes, stops it) →
 *     evaluateFoundationGate, SHA-pinned against a concurrent commit.
 *   greenTrunk({cwd}) → runs tsc + build → evaluateGreenTrunk, SHA-pinned.
 *
 * Tree checks run via an async (non-blocking) runner so they never freeze the
 * daemon event loop. `deps` (bootDevServer, playwright, shell, log, runner, git)
 * are injectable for tests; the production defaults boot the real dev server,
 * lazy-import real playwright, spawn tsc/build async, and read HEAD via `git`.
 *
 * @param {{ cwd?:string, runner?:Function, git?:Function, qaContext?:object, deps?:object }} opts
 */
export function makeStoryDevGateDeps({ cwd, runner, git, qaContext, deps = {} } = {}) {
  const shell = deps.shell || realShell;
  const bootDev = deps.bootDevServer || realBootDevServer;
  const getPlaywright = deps.playwright ? async () => deps.playwright : async () => import('playwright');
  const log = deps.log || (() => {});
  const treeRunner = runner || deps.runner; // undefined → tree-gates uses its default async spawn
  const gitRunner = git || deps.git;

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
    // job); the pin itself reads the LIVE head before/after so a mid-check
    // sibling commit is caught regardless of the stamped value.
    foundationGate: async ({ cwd: c = cwd, headSha, qaContext: qa = qaContext } = {}) => {
      void headSha;
      const head0 = await readHead(gitRunner, c);
      const tsc = await runTreeTypecheck({ cwd: c, runner: treeRunner });
      const build = await runTreeBuild({ cwd: c, runner: treeRunner });
      const boot = await bootAndProbe({ cwd: c, qaContext: qa });
      const verdict = evaluateFoundationGate({ tsc, build, boot });
      return pinIfStable(verdict, { git: gitRunner, cwd: c, head0 });
    },
    greenTrunk: async ({ cwd: c = cwd } = {}) => {
      const head0 = await readHead(gitRunner, c);
      const verdict = evaluateGreenTrunk({
        tsc: await runTreeTypecheck({ cwd: c, runner: treeRunner }),
        build: await runTreeBuild({ cwd: c, runner: treeRunner }),
      });
      return pinIfStable(verdict, { git: gitRunner, cwd: c, head0 });
    },
  };
}
