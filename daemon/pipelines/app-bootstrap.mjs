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

import { randomUUID } from 'node:crypto';
import { buildSkillScoutPipelineDaemon } from '../lib/skill-scout-pipeline-builder.mjs';

import { runBareClone } from '../lib/app-bootstrap-steps/bare-clone.mjs';
import { runMaterializeWorktree } from '../lib/app-bootstrap-steps/materialize-worktree.mjs';
import { runInjectValues } from '../lib/app-bootstrap-steps/inject-values.mjs';
import { runApplyStarterAugments } from '../lib/app-bootstrap-steps/apply-starter-augments.mjs';
import { runPrepinDefaultSkills } from '../lib/app-bootstrap-steps/prepin-default-skills.mjs';
import { runNpmInstall } from '../lib/app-bootstrap-steps/npm-install.mjs';
import { runVendorSkills } from '../lib/app-bootstrap-steps/vendor-skills.mjs';
import { runBmadBootstrap } from '../lib/app-bootstrap-steps/bmad-bootstrap.mjs';
import { runCommitAndPush } from '../lib/app-bootstrap-steps/commit-and-push.mjs';

export const APP_BOOTSTRAP_STEPS = [
  'bare-clone',
  'materialize-worktree',
  'inject-values',
  'apply-starter-augments', // PR-13 — starter pack files written on top of base
  'prepin-default-skills',  // Epic 2 Story 2.2 — pin starter's defaultSkillLoadout
  'npm-install',
  'vendor-skills',          // Epic 2 Story 2.3 — fetch SKILL.md bodies via skills-sync.mjs
  'bmad-bootstrap',
  'commit-and-push',
];

/**
 * Slim view of `functions/shared/boilerplates/registry.ts`. The daemon
 * cannot import the TS module directly. Update this table whenever the
 * registry changes a value the daemon depends on.
 *
 * PR-13 — `nextjs` renamed to `nextjs-base`; new starter pack entries
 * derive their config from nextjs-base (they share the templateRepo + the
 * same npm-install/bmad-bootstrap behavior). The `augmentFiles` per
 * starter come through `appBootstrapPayload.augmentFiles` so the daemon
 * doesn't have to mirror the registry's content.
 */
const NEXTJS_VIEW = {
  runtime: 'node',
  bmadSupported: true,
  isStub: false,
  // PR-71 (Story 3-C-2-1): `.claude/skills.manifest.yaml` ships the
  // `project: __APP_SLUG__` placeholder via the boilerplate augments and
  // depends on inject-values for substitution. Mirror of the TS registry's
  // postCreateSteps[0].targetFiles for nextjs-base.
  targetFiles: [
    'package.json',
    'README.md',
    'CLAUDE.md',
    '.claude/skills.manifest.yaml',
  ],
  // Epic 2 Story 2.2 (2026-05-19): defaultSkillLoadout is forwarded through
  // appBootstrapPayload at job-create time and overrides this value at the
  // call site (see line ~167 below). The undefined default here means
  // "no override" — the per-starter loadout from the TS registry wins.
  // Keeping the field declared on the view doc-block is a contract reminder
  // for daemon-side readers; the runtime value comes through the payload.
  defaultSkillLoadout: undefined,
};

const BOILERPLATE_VIEW = {
  // Canonical key (PR-13).
  'nextjs-base': NEXTJS_VIEW,
  // Legacy alias — App rows created before PR-13 stored 'nextjs'.
  nextjs: NEXTJS_VIEW,
  // PR-13 starters derive config from nextjs-base.
  'nextjs-canvas-game': NEXTJS_VIEW,
  'nextjs-form-app': NEXTJS_VIEW,
  'nextjs-dashboard': NEXTJS_VIEW,
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
    applyStarterAugments: steps.applyStarterAugments ?? runApplyStarterAugments,
    prepinDefaultSkills: steps.prepinDefaultSkills ?? runPrepinDefaultSkills,
    npmInstall: steps.npmInstall ?? runNpmInstall,
    vendorSkills: steps.vendorSkills ?? runVendorSkills,
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

    // PR-13 — APPLY-STARTER-AUGMENTS (no-op for base starters / stubs)
    // 2026-05-16: thread appId/displayName/initDate so the augment
    // contents (e.g. `__APP_SLUG__` in `.claude/skills.manifest.yaml`,
    // `__APP_DISPLAY_NAME__` in `CLAUDE.md`) get substituted in-memory
    // before write. inject-values runs BEFORE this step, so without
    // this threading the augment files would ship raw placeholders.
    await emitStarted('apply-starter-augments');
    const augmentResult = await stepFns.applyStarterAugments({
      workingDir: worktreeDir,
      augmentFiles: payload.augmentFiles,
      packageJsonScripts: payload.packageJsonScripts,
      packageJsonDevDependencies: payload.packageJsonDevDependencies,
      appId,
      displayName: appRow.displayName ?? appId,
      initDate: new Date().toISOString(),
      onOutput: makeOutputSink('apply-starter-augments'),
    });
    await emitCompleted('apply-starter-augments', {
      written: augmentResult.written,
      skipped: !!augmentResult.skipped,
    });

    // Epic 2 Story 2.2 — PREPIN-DEFAULT-SKILLS
    // Reads the starter's defaultSkillLoadout from the payload (threaded
    // by the API Lambda; see functions/api/index.ts:~7298) and writes
    // entries into .claude/skills.manifest.yaml under core[]. Skips when
    // the manifest is missing (stub boilerplates) or already has skills
    // pinned. The subsequent vendor-skills step reads what we pinned
    // here and materializes SKILL.md bodies onto disk.
    await emitStarted('prepin-default-skills');
    const prepinResult = await stepFns.prepinDefaultSkills({
      worktreeDir,
      defaultSkillLoadout: payload.defaultSkillLoadout,
      onOutput: makeOutputSink('prepin-default-skills'),
    });
    await emitCompleted('prepin-default-skills', {
      skipped: !!prepinResult.skipped,
      reason: prepinResult.reason,
      pinnedCount: prepinResult.pinnedCount,
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

    // Epic 2 Story 2.3 — VENDOR-SKILLS
    // Spawns the in-worktree scripts/skills-sync.mjs which fetches each
    // pinned SKILL.md from its federation source (GitHub raw API) and
    // writes to .claude/skills/<name>/. Non-blocking: a hard failure
    // (exit 1, e.g. missing ~/.futurator/skill-federation.yaml) surfaces
    // a medium-severity attention but bootstrap continues. Drift
    // (exit 2) surfaces low-severity attention. See vendor-skills.mjs
    // for the full exit-code → outcome mapping.
    await emitStarted('vendor-skills');
    const vendorResult = await stepFns.vendorSkills({
      worktreeDir,
      skip: view.isStub === true,
      onOutput: makeOutputSink('vendor-skills'),
    });
    await emitCompleted('vendor-skills', {
      skipped: !!vendorResult.skipped,
      reason: vendorResult.reason,
      vendoredCount: vendorResult.vendoredCount,
      drift: vendorResult.drift,
      exitCode: vendorResult.exitCode,
    });
    // Surface a per-app attention item on vendor-skills failure or drift.
    // dedupKey ensures repeat bootstraps don't multiply rows.
    if (vendorResult.attentionCategory && typeof writeAttentionItem === 'function') {
      try {
        await writeAttentionItem({
          planId: null,
          appId,
          category: vendorResult.attentionCategory,
          severity: vendorResult.attentionSeverity ?? 'medium',
          title:
            vendorResult.attentionCategory === 'skill-manifest-out-of-sync'
              ? `Skill manifest drift detected for ${appId} (${vendorResult.drift ?? 0} skill(s))`
              : `Skill vendor sync failed for ${appId} (${vendorResult.reason ?? 'unknown'})`,
          body: (vendorResult.stderr || '').slice(0, 1500),
          dedupKey: `skill-vendor-${vendorResult.attentionCategory}:${appId}`,
        });
      } catch (attentionErr) {
        // Non-fatal — log and continue. The bootstrap-failed attention
        // path doesn't fire here because vendor-skills is non-blocking.
        await pushEvent?.(
          job.jobId,
          'vendor-skills',
          '__app_bootstrap__',
          'pv2.app-bootstrap.attention-write-failed',
          { appId, error: String(attentionErr?.message || attentionErr) },
        );
      }
    }

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

    // Epic 3 Story 3.3 (2026-05-20) — T1 SKILL-SCOUT enqueue. Replaces
    // the prior marker-only `.queued` event with a real PENDING job
    // row. The daemon's main loop will pick it up next tick and route
    // to executeSkillScoutJob → runSkillScoutJob.
    //
    // Backwards-compat: the `.queued` event is STILL emitted so any
    // operator dashboard / forensic-parsing code that looks for that
    // marker keeps working. The new `.enqueued` event carries the
    // actual jobId so the operator can correlate back to the row.
    //
    // ctx.insertAgentJob is optional — when absent (idempotency unit
    // tests, brownfield migration tools) the saga skips the insert and
    // only emits the marker. Production always passes the inserter.
    await pushEvent?.(
      job.jobId,
      'completed',
      '__app_bootstrap__',
      'pv2.skill-scout.queued',
      {
        appId,
        trigger: 'T1',
        boilerplateType,
        reason: 'project init — full federation sweep',
      },
    );

    if (typeof ctx.insertAgentJob === 'function') {
      try {
        const scoutJobId = randomUUID();
        const scoutPipeline = buildSkillScoutPipelineDaemon({
          trigger: 'T1',
          projectSlug: appId,
          boilerplateKind: boilerplateType,
          rigor: 'prototype', // T1 has no plan-rigor yet (v2.5 §38).
        });
        await ctx.insertAgentJob({
          jobId: scoutJobId,
          jobType: 'skill-scout',
          status: 'PENDING',
          workingDir: worktreeDir,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: 'app-bootstrap-saga',
          skillScoutPayload: {
            trigger: 'T1',
            projectSlug: appId,
            appId,
            planId: null,
            rigor: 'prototype',
          },
          pipeline: scoutPipeline,
        });
        await pushEvent?.(
          job.jobId,
          'completed',
          '__app_bootstrap__',
          'pv2.skill-scout.enqueued',
          {
            appId,
            trigger: 'T1',
            scoutJobId,
            reason: 'project init — full federation sweep',
          },
        );
      } catch (insertErr) {
        // Non-fatal — app-bootstrap completed; the operator can re-fire
        // T1 manually via the API. Surface as a low-severity attention.
        await pushEvent?.(
          job.jobId,
          'completed',
          '__app_bootstrap__',
          'pv2.skill-scout.enqueue-failed',
          { appId, trigger: 'T1', error: String(insertErr?.message || insertErr) },
        );
      }
    }

    await pushEvent?.(
      job.jobId,
      'completed',
      '__app_bootstrap__',
      'pv2.architect.queued',
      {
        appId,
        trigger: 'T1',
        boilerplateType,
        reason: 'project init — greenfield AWS scaffold proposal',
      },
    );

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
