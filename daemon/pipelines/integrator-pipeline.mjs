// integrator-pipeline — the Reality-Spine INTEGRATE-RUN stage (redesign Part 2
// P3, Part 5 #4). ONE Opus agent with WHOLE-TREE write authority (danger paths
// still forbidden) loops until the assembled artifact is fully green:
//
//   tsc --noEmit  &&  npm run lint  &&  npm run test  &&  npm run build  &&
//   boot-liveness (the app boots, mounts window.__harness, and ≥1 synthetic
//   input produces an observable state delta)
//
// This is the missing organ from run D phase 4: no scope-jailed slice can fix a
// cross-cutting integration defect (a whole that is broken while every part is
// green). The Integrator is the only actor allowed to hold and fix the whole.
//
// Every green check runs on the USER app tree (job.workingDir) via injected
// runners so the loop unit-tests without spawning tsc/build/playwright. It
// commits ONLY on all-green and stamps a SHA-pinned readiness mark; on
// exhaustion it completes RED without stamping (fail-closed — an unproven tree
// never advances to review).

import { spawn as realSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { registerChild, unregisterChild } from './lib/child-tracker.mjs';
import { freezeFlagsOntoJob } from '../lib/pipeline-flags.mjs';
import { buildGateSpawn } from '../lib/gate-settings.mjs';
import { integrateStory } from '../lib/story-integrate.mjs';
import { planBranchName } from '../lib/plan-branch.mjs';
import { resolveAgentPolicy, cliModelArgs } from '../lib/model-effort-policy.mjs';

// Whole-tree write authority is real, but never for the repo's plumbing, its
// installed deps, its infra/build config, or its secrets. These globs are the
// Integrator's forbiddenAreas — the live gate blocks any write matching them.
export const DANGER_PATHS = Object.freeze([
  '.git/**',
  'node_modules/**',
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  'sst.config.ts',
  'infra/**',
  '.github/**',
]);

const GREEN_DIMS = ['tsc', 'lint', 'test', 'build', 'boot'];

/**
 * Build the whole-tree Integrator prompt. PURE.
 *
 * @param {{ appId?: string, failureSummary?: string, priorFailure?: string }} args
 *   failureSummary — why the Integrator was dispatched (a green-trunk pause or a
 *     blocking QA verdict summary). priorFailure — the concrete red-dimension
 *     detail from THIS Integrator's previous attempt (fed back on a re-spawn).
 * @returns {string}
 */
export function buildIntegratorPrompt({ appId, failureSummary, priorFailure } = {}) {
  return [
    `You are the INTEGRATOR for the application "${appId || '(app)'}".`,
    ``,
    `Your job: make the WHOLE assembled application genuinely green and runnable.`,
    `You have WHOLE-TREE write authority — you may edit ANY file (except the danger`,
    `paths: .git, node_modules, infra/build config, secrets). Unlike the per-story`,
    `developers — each scope-jailed to its own files — you are the ONE actor allowed`,
    `to fix cross-cutting integration defects: a codebase where every slice is`,
    `individually green but the assembled whole is broken or lifeless.`,
    ``,
    `# Definition of done — a DETERMINISTIC gate re-checks ALL of these after you finish:`,
    `  1. npx tsc --noEmit   — the whole tree typechecks`,
    `  2. npm run lint       — no lint errors`,
    `  3. npm run test       — the test suite passes (do NOT weaken or delete tests to pass)`,
    `  4. npm run build      — the production build succeeds`,
    `  5. boot-liveness      — the built app boots, mounts window.__harness, and at`,
    `                          least one synthetic user input produces an observable`,
    `                          state change (the app is actually interactive, not a`,
    `                          frozen/placeholder initial state)`,
    ``,
    failureSummary
      ? `# Why you were dispatched:\n${failureSummary}\n`
      : '',
    priorFailure
      ? `# Your PREVIOUS attempt left these RED — fix EXACTLY these root causes:\n${priorFailure}\n`
      : '',
    `Find and fix the real root cause. Prefer the smallest correct change. Never`,
    `paper over a failure by mocking the module under test, weakening an assertion,`,
    `or deleting a test. When you are done, every command above must exit clean.`,
  ].filter((l) => l !== '').join('\n');
}

function ensureDir(d) {
  try {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Run the full green battery on the app tree via injected runners. Each runner
 * returns { passed, detail }; boot-liveness additionally carries seamMounted.
 * FAIL CLOSED — a missing runner or a thrown runner counts as a failing
 * dimension (a reality gate never passes unobserved).
 * @returns {Promise<Record<string,{passed:boolean,detail?:string}>>}
 */
async function runGreenChecks({ deps, cwd, headSha }) {
  const call = async (fn, name) => {
    if (typeof fn !== 'function') return { passed: false, detail: `${name}: no runner injected` };
    try {
      return (await fn({ cwd, headSha })) || { passed: false, detail: `${name}: no result` };
    } catch (err) {
      return { passed: false, detail: `${name} threw: ${err?.message || err}` };
    }
  };
  // Cheapest-first ordering: tsc → lint → test → build → boot. (All run
  // regardless so the agent gets the complete red set in one feedback block.)
  const [tsc, lint, test, build, boot] = await Promise.all([
    call(deps.runTreeTypecheck, 'tsc'),
    call(deps.runLint, 'lint'),
    call(deps.runTests, 'test'),
    call(deps.runTreeBuild, 'build'),
    call(deps.bootLiveness, 'boot'),
  ]);
  return { tsc, lint, test, build, boot };
}

/**
 * Run an Integrator job end to end.
 *
 * @param {{ job: object, eventLogDir: string, deps?: object }} opts
 *   deps: { spawn, claudeBin, git, headSha, executors, runTreeTypecheck,
 *           runTreeBuild, runLint, runTests, bootLiveness, updateJobFields,
 *           pushEvent, logger, now, maxAttempts }
 *   The five green runners each take ({cwd,headSha}) and return {passed,detail}.
 * @returns {Promise<{ green:boolean, sha?:string, attemptsUsed:number, failing:string[] }>}
 */
export async function runIntegratorJob({ job, eventLogDir, deps = {} }) {
  const spawn = deps.spawn || realSpawn;
  const logger = deps.logger || console;
  const claudeBin = deps.claudeBin || 'claude';
  const now = deps.now || (() => Date.now());
  const maxAttempts = deps.maxAttempts ?? 3;

  const workingDir = resolve(job.workingDir);
  const appId = job.appId || basename(workingDir);
  const planSlug = job.planSlug || appId;

  const p3Flags = freezeFlagsOntoJob(job, { env: process.env });
  // Whole-tree write: touchPoints '**', forbiddenAreas = the danger set. Same
  // live gate the per-story devs use, only with the scope opened to the tree.
  const gate = buildGateSpawn({
    jobId: job.jobId,
    p3Flags,
    touchPoints: ['**'],
    forbiddenAreas: DANGER_PATHS,
    ledgerPath: join(workingDir, '.pipeline', 'gate-events.jsonl'),
    ceilingUsd: job.costCeilingUsd,
    harnessCostDir: join(workingDir, '.pipeline', 'harness-cost'),
    haltDir: workingDir,
    observeLog: join(workingDir, '.pipeline', 'observations.jsonl'),
    agentRole: 'integrator',
  });
  const modelArgs = cliModelArgs(
    resolveAgentPolicy({ role: 'integrator', overrides: { model: job.integratorModel } }),
  );

  ensureDir(eventLogDir);
  const stdoutPath = join(eventLogDir, `${job.jobId}.integrator.stdout.log`);

  const spawnIntegratorOnce = (prompt) =>
    new Promise((res) => {
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'bypassPermissions',
        ...modelArgs,
        ...gate.args,
      ];
      const child = spawn(claudeBin, args, {
        cwd: workingDir,
        env: { ...process.env, ...gate.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      registerChild(job.jobId, child);
      const outFile = createWriteStream(stdoutPath, { flags: 'a' });
      child.stdout.on('data', (c) => {
        try { outFile.write(c); } catch { /* ignore */ }
      });
      child.stderr.on('data', (c) =>
        logger.warn?.(`[integrator:${job.jobId}:stderr] ${c.toString('utf8').trimEnd()}`),
      );
      child.on('error', (err) => {
        unregisterChild(job.jobId, child);
        logger.error?.(`[integrator] spawn error: ${err.message}`);
        res(-1);
      });
      child.on('close', (code) => {
        unregisterChild(job.jobId, child);
        outFile.end();
        res(code ?? 0);
      });
    });

  let priorFailure = null;
  let green = false;
  let attemptsUsed = 0;
  let lastFailing = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const prompt = buildIntegratorPrompt({ appId, failureSummary: job.failureSummary, priorFailure });
    logger.info?.(`[integrator] spawning attempt=${attempt}/${maxAttempts} app=${appId}`);
    await deps.pushEvent?.(job.jobId, 'integrator', 'integrator', 'step_start', {
      text: `integrator attempt ${attempt}/${maxAttempts}${priorFailure ? ' (fixing prior red)' : ''}`,
    })?.catch?.(() => {});

    const exitCode = await spawnIntegratorOnce(prompt);
    if (exitCode !== 0) {
      // A spawn crash is not a green result — treat the whole battery as red
      // (fail-closed) and let the loop feed back and retry.
      logger.warn?.(`[integrator] agent exit ${exitCode} (attempt ${attempt})`);
    }

    const checks = await runGreenChecks({ deps, cwd: workingDir, headSha: deps.headSha });
    const failing = GREEN_DIMS.filter((d) => !checks[d]?.passed);
    lastFailing = failing;

    if (failing.length === 0) {
      green = true;
      await deps.pushEvent?.(job.jobId, 'integrator', 'integrator', 'step_complete', {
        text: `whole tree GREEN (tsc+lint+test+build+boot) after ${attempt} attempt(s)`,
      })?.catch?.(() => {});
      break;
    }

    priorFailure = failing.map((d) => `- ${d}: ${checks[d]?.detail || 'failing'}`).join('\n');
    logger.warn?.(`[integrator] attempt ${attempt} RED: [${failing.join(', ')}]`);
    await deps.pushEvent?.(job.jobId, 'integrator', 'integrator', 'step_error', {
      text: `attempt ${attempt} RED: ${failing.join(', ')}`,
    })?.catch?.(() => {});
  }

  const finishedAt = new Date(now()).toISOString();

  if (green) {
    // Commit the whole tree (touches:[] → `git add -A`) to the plan branch. This
    // commit's SHA is what the plan stamps as integrateVerifiedSha (the caller
    // reads INTEGRATE_SHA off the job vars). If the agent changed nothing (the
    // tree was already green), no commit is produced — fall back to the head the
    // caller resolved (deps.headSha), which IS the proven-green head.
    let sha = deps.headSha || '';
    if (deps.git) {
      const integ = await integrateStory({
        repoDir: workingDir,
        touches: [],
        storyId: 'integrator',
        title: 'integrate + green whole tree',
        planBranch: planBranchName(planSlug),
        git: deps.git,
      });
      if (integ.committed && integ.sha) sha = integ.sha;
      else if (!integ.committed) logger.info?.(`[integrator] no commit (${integ.reason || 'no changes'}) — pinning ${sha.slice(0, 7)}`);
    }
    await deps.updateJobFields?.(job.jobId, {
      status: 'COMPLETED',
      variables: { INTEGRATE_SHA: sha, INTEGRATE_GREEN: 'true' },
      integrateFinishedAt: finishedAt,
    });
    logger.info?.(`[integrator] GREEN → committed ${String(sha).slice(0, 7)} (${attemptsUsed} attempt(s))`);
    return { green: true, sha, attemptsUsed, failing: [] };
  }

  // Exhausted without green — fail closed. Do NOT stamp an integrate SHA; the
  // caller leaves the plan un-verified so review stays unreachable.
  await deps.updateJobFields?.(job.jobId, {
    status: 'COMPLETED',
    variables: { INTEGRATE_GREEN: 'false', INTEGRATE_FAILING: lastFailing.join(',') },
    integrateFinishedAt: finishedAt,
  });
  logger.warn?.(`[integrator] EXHAUSTED ${attemptsUsed} attempt(s) — still RED [${lastFailing.join(', ')}]`);
  return { green: false, attemptsUsed, failing: lastFailing };
}
