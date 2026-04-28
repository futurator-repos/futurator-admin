/**
 * app-bootstrap.mjs — Pipeline v2 / Story 1.4.3.
 *
 * Daemon-side saga steps 3–5 of App-create (steps 1+2 ran in the API Lambda):
 *
 *   1. bare-clone           — `/home/ubuntu/repos/<slug>.git` (idempotent)
 *   2. materialize-worktree — `/home/ubuntu/projects/<slug>` (idempotent)
 *   3. inject-values        — substitute `__APP_SLUG__` / `__APP_DISPLAY_NAME__`
 *   4. npm-install          — only when stack runtime is `'node'` AND not stub
 *   5. bmad-bootstrap       — only when `bmadEnabled && bmadSupported`
 *   6. commit-and-push      — empty-staged check first, no-op on re-runs
 *
 * Mirrors the shape of `daemon/pipelines/party-bootstrap.mjs` (events on
 * start/complete/output/failure, single try/catch with `currentStep` tracker).
 *
 * On failure: writes a `pv2-app-bootstrap-failed` attention item and rethrows
 * so the daemon's retry ladder kicks in. On success: updates the App row's
 * `bootstrappedAt` + `workingTreeStatus` and emits a completion event.
 *
 * Idempotency is the central design constraint (Gate G-6): every step is
 * safe to re-run against an already-bootstrapped App and produces no side
 * effects beyond what the first run already produced.
 *
 * Source of truth for per-type config is `functions/shared/boilerplates/
 * registry.ts`. The daemon has no TS compile step, so the relevant fields
 * are mirrored in the `BOILERPLATE_VIEW` constant below — keep both in sync
 * when a new type lands.
 */

import { runBareClone } from '../lib/app-bootstrap-steps/bare-clone.mjs';
import { runMaterializeWorktree } from '../lib/app-bootstrap-steps/materialize-worktree.mjs';
import { runInjectValues } from '../lib/app-bootstrap-steps/inject-values.mjs';
import { runNpmInstall } from '../lib/app-bootstrap-steps/npm-install.mjs';
import { runBmadBootstrap } from '../lib/app-bootstrap-steps/bmad-bootstrap.mjs';
import { runCommitAndPush } from '../lib/app-bootstrap-steps/commit-and-push.mjs';

export const APP_BOOTSTRAP_STEPS = [
  'bare-clone',
  'materialize-worktree',
  'inject-values',
  'npm-install',
  'bmad-bootstrap',
  'commit-and-push',
];

/**
 * Slim view of `functions/shared/boilerplates/registry.ts`. The daemon
 * cannot import the TS module directly. Update this table whenever the
 * registry changes a value the daemon depends on.
 */
const BOILERPLATE_VIEW = {
  nextjs: {
    runtime: 'node',
    bmadSupported: true,
    isStub: false,
    targetFiles: ['package.json', 'README.md', 'CLAUDE.md'],
  },
  sst: {
    runtime: 'node',
    bmadSupported: false,
    isStub: true,
    targetFiles: ['README.md', 'CLAUDE.md'],
  },
  vite: {
    runtime: 'node',
    bmadSupported: false,
    isStub: true,
    targetFiles: ['README.md', 'CLAUDE.md'],
  },
  mobile: {
    runtime: 'react-native',
    bmadSupported: false,
    isStub: true,
    targetFiles: ['README.md', 'CLAUDE.md'],
  },
};

/**
 * Run the App-bootstrap saga for a single job.
 *
 * @param {object} job  — agent-jobs row with `appBootstrapPayload`
 * @param {object} ctx
 * @param {function} ctx.pushEvent              — `(jobId, step, agent, type, data)`
 * @param {function} ctx.getApp                 — `(appId) => Promise<App|null>`
 * @param {function} ctx.updateApp              — `(appId, patch) => Promise<App>`
 * @param {function} ctx.writeAttentionItem     — wrapper around the shared writer
 * @param {object}   [ctx.partyCtx]             — same shape as `buildPartyCtx()`,
 *                                                 forwarded to BMAD step
 * @param {function} [ctx.runPartyBootstrap]    — injected for tests
 * @param {object}   [ctx.steps]                — overridable step runners for tests
 * @param {string}   [ctx.reposRoot]
 * @param {string}   [ctx.projectsRoot]
 */
export async function runAppBootstrap(job, ctx) {
  const payload = job.appBootstrapPayload || {};
  const { appId, boilerplateType, bmadEnabled } = payload;
  const {
    pushEvent,
    getApp,
    updateApp,
    writeAttentionItem,
    partyCtx,
    runPartyBootstrap,
    reposRoot = '/home/ubuntu/repos',
    projectsRoot = '/home/ubuntu/projects',
    steps = {},
  } = ctx;

  if (!appId) throw new Error('runAppBootstrap: payload.appId required');
  if (!boilerplateType) {
    throw new Error('runAppBootstrap: payload.boilerplateType required');
  }
  if (typeof bmadEnabled !== 'boolean') {
    throw new Error('runAppBootstrap: payload.bmadEnabled required');
  }

  const view = BOILERPLATE_VIEW[boilerplateType];
  if (!view) {
    throw new Error(`runAppBootstrap: unknown boilerplateType "${boilerplateType}"`);
  }

  // Resolve the App's displayName for placeholder substitution. We fail loudly
  // if the App row is missing — the saga shouldn't be running at all in that
  // case (the API Lambda writes both atomically).
  const appRow = await getApp(appId);
  if (!appRow) {
    throw new Error(`runAppBootstrap: App "${appId}" not found in DDB`);
  }

  const displayName = appRow.displayName || appId;

  // Step runners are injectable for tests. Production = the imports above.
  const stepFns = {
    bareClone: steps.bareClone ?? runBareClone,
    materializeWorktree: steps.materializeWorktree ?? runMaterializeWorktree,
    injectValues: steps.injectValues ?? runInjectValues,
    npmInstall: steps.npmInstall ?? runNpmInstall,
    bmadBootstrap: steps.bmadBootstrap ?? runBmadBootstrap,
    commitAndPush: steps.commitAndPush ?? runCommitAndPush,
  };

  let currentStep = 'bare-clone';

  async function emitStarted(step) {
    currentStep = step;
    await pushEvent?.(job.jobId, step, '__app_bootstrap__', 'pv2.app-bootstrap.step.started', {
      appId,
      step,
    });
  }
  async function emitCompleted(step, details = {}) {
    await pushEvent?.(job.jobId, step, '__app_bootstrap__', 'pv2.app-bootstrap.step.completed', {
      appId,
      step,
      ...details,
    });
  }
  function makeOutputSink(step) {
    return (stream, data) =>
      pushEvent?.(job.jobId, step, '__app_bootstrap__', 'pv2.app-bootstrap.step.output', {
        appId,
        step,
        stream,
        data,
      });
  }

  const worktreeDir = `${projectsRoot}/${appId}`;

  try {
    // 1. BARE-CLONE
    await emitStarted('bare-clone');
    const cloneResult = await stepFns.bareClone({
      appId,
      reposRoot,
      onOutput: makeOutputSink('bare-clone'),
    });
    await emitCompleted('bare-clone', { skipped: !!cloneResult.skipped });

    // 2. MATERIALIZE-WORKTREE
    await emitStarted('materialize-worktree');
    const wtResult = await stepFns.materializeWorktree({
      appId,
      reposRoot,
      projectsRoot,
      onOutput: makeOutputSink('materialize-worktree'),
    });
    await emitCompleted('materialize-worktree', { skipped: !!wtResult.skipped });

    // 3. INJECT-VALUES
    await emitStarted('inject-values');
    const injectResult = await stepFns.injectValues({
      appId,
      displayName,
      targetFiles: view.targetFiles,
      worktreeDir,
      onOutput: makeOutputSink('inject-values'),
    });
    await emitCompleted('inject-values', {
      modified: injectResult.modified,
      visited: injectResult.visited?.length ?? 0,
    });

    // 4. NPM-INSTALL (skipped on stubs / non-node runtimes)
    await emitStarted('npm-install');
    const npmResult = await stepFns.npmInstall({
      worktreeDir,
      runtime: view.runtime,
      skip: view.isStub === true,
      onOutput: makeOutputSink('npm-install'),
    });
    await emitCompleted('npm-install', {
      skipped: !!npmResult.skipped,
      reason: npmResult.reason,
    });

    // 5. BMAD-BOOTSTRAP (skipped when not enabled or unsupported)
    await emitStarted('bmad-bootstrap');
    const bmadResult = await stepFns.bmadBootstrap({
      appId,
      worktreeDir,
      bmadEnabled,
      bmadSupported: view.bmadSupported,
      partyCtx,
      runPartyBootstrap,
      jobId: job.jobId,
      onOutput: makeOutputSink('bmad-bootstrap'),
    });
    await emitCompleted('bmad-bootstrap', {
      skipped: !!bmadResult.skipped,
      reason: bmadResult.reason,
    });

    // 6. COMMIT-AND-PUSH
    await emitStarted('commit-and-push');
    const pushResult = await stepFns.commitAndPush({
      appId,
      worktreeDir,
      onOutput: makeOutputSink('commit-and-push'),
    });
    await emitCompleted('commit-and-push', {
      skipped: !!pushResult.skipped,
      reason: pushResult.reason,
    });

    // SUCCESS — update App row and emit completion.
    if (typeof updateApp === 'function') {
      await updateApp(appId, {
        workingTreeStatus: 'clean',
        bootstrappedAt: new Date().toISOString(),
      });
    }

    await pushEvent?.(job.jobId, 'completed', '__app_bootstrap__', 'pv2.app-bootstrap.completed', {
      appId,
      boilerplateType,
      bmadEnabled,
    });

    return {
      ok: true,
      appId,
      boilerplateType,
      bmadEnabled,
      stepResults: {
        'bare-clone': cloneResult,
        'materialize-worktree': wtResult,
        'inject-values': injectResult,
        'npm-install': npmResult,
        'bmad-bootstrap': bmadResult,
        'commit-and-push': pushResult,
      },
    };
  } catch (err) {
    const reason = err?.message || String(err);

    await pushEvent?.(job.jobId, currentStep, '__app_bootstrap__', 'pv2.app-bootstrap.step.failed', {
      appId,
      step: currentStep,
      reason,
    });

    // Single attention item per failure — category, slug, step, message.
    if (typeof writeAttentionItem === 'function') {
      try {
        await writeAttentionItem({
          // App-level items use the synthetic `app:<slug>` planId namespace
          // (no Plan exists pre-bootstrap). Matches the API Lambda's
          // `pv2-app-bootstrap-rollback-orphan` writer.
          planId: `app:${appId}`,
          severity: 'high',
          category: 'pv2-app-bootstrap-failed',
          title: `App-bootstrap failed at "${currentStep}" for ${appId}`,
          body:
            `Step "${currentStep}" failed: ${reason}\n\n` +
            `Boilerplate: ${boilerplateType} — BMAD: ${bmadEnabled ? 'on' : 'off'}.`,
          context: { jobId: job.jobId, stepId: currentStep },
          suggestedActions: [
            { label: 'Re-run bootstrap', kind: 'retry-step' },
            { label: 'Mark App failed and delete', kind: 'archive' },
            { label: 'Open logs', kind: 'open-logs' },
          ],
        });
      } catch {
        // attention writer swallows errors internally; nothing else to do.
      }
    }

    throw err;
  }
}
