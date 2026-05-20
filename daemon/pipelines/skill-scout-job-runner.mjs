/**
 * skill-scout-job-runner.mjs — Pipeline v2 Phase 3-C Epic 3 (Story 3.1,
 * 2026-05-20).
 *
 * Orchestrates a single SKILL-SCOUT job-row lifecycle:
 *
 *   1. Read federation manifest + project skill manifest from disk
 *      (via the helpers in `skill-scout-runner.mjs`).
 *   2. Spawn the SKILL-SCOUT agent step (single step in the baked
 *      pipeline) by calling the injected `executeAgentStep` runner
 *      (mirrors the executeStep contract in agent-daemon.mjs:1619).
 *   3. Extract the proposals JSON block via the daemon's existing
 *      extractor (the pipeline's `between` extractor captures the
 *      block into `variables.SKILL_PROPOSALS_JSON`).
 *   4. Validate against `validateSkillProposalsBlock()` from the
 *      shared TS pipeline module (compiled into the daemon's tree
 *      under `functions/shared/pipelines/skill-scout-pipeline.js`).
 *   5. Dispose via `disposeProposals({output, rigor})`:
 *      - `noop`         → no card, no install
 *      - `auto-confirm` → call `applyConfirmedProposals` directly
 *      - `surface-card` → write attention item via injected writer
 *   6. Emit a forensic event with timing + cost so the dashboard's
 *      timing panel reflects SKILL-SCOUT runs alongside DEV/TEST/QA.
 *
 * Test mode: the runner accepts `executeAgentStep`, `writeAttentionItem`,
 * `applyConfirmedProposals`, `pushEvent`, and `federationCache` as
 * injectable deps so unit tests don't need to spawn Claude or touch
 * the real DDB / federation file. Production wiring lives in
 * `agent-daemon.mjs::executeSkillScoutJob` (Story 3.1 also wires).
 */

import {
  buildPromptContext,
  disposeProposals,
  buildDecisionCard,
  buildForensicEvent,
} from './skill-scout-runner.mjs';

/**
 * Validate that a SKILL-SCOUT job row carries the fields the runner needs.
 * Mirrors the validateAppBootstrapJob / validateWaveMergeJob pattern
 * in job-router.mjs so the daemon can reject malformed jobs at dispatch
 * time with a clear reason.
 *
 * @param {object} job
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateSkillScoutJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'skill-scout') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.skillScoutPayload;
  if (!p || typeof p !== 'object') {
    return { ok: false, reason: 'skillScoutPayload-missing' };
  }
  const T_OK = new Set(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
  if (!T_OK.has(p.trigger)) return { ok: false, reason: 'trigger-invalid' };
  if (typeof p.projectSlug !== 'string' || p.projectSlug.length === 0) {
    return { ok: false, reason: 'projectSlug-missing' };
  }
  if (typeof p.appId !== 'string' || p.appId.length === 0) {
    return { ok: false, reason: 'appId-missing' };
  }
  const RIGOR_OK = new Set(['prototype', 'mvp', 'production']);
  if (!RIGOR_OK.has(p.rigor)) return { ok: false, reason: 'rigor-invalid' };
  if (
    !job.pipeline ||
    !Array.isArray(job.pipeline.steps) ||
    job.pipeline.steps.length === 0
  ) {
    return { ok: false, reason: 'pipeline-missing' };
  }
  return { ok: true };
}

/**
 * Run a SKILL-SCOUT job end-to-end. Returns a structured outcome the
 * daemon's caller maps to job status (COMPLETED / FAILED) and to follow-
 * on attention items.
 *
 * @param {object} job   — agent-jobs row with `skillScoutPayload`
 * @param {object} ctx
 * @param {object} ctx.federationCache  — { get(): { manifest } }
 * @param {function} ctx.executeAgentStep
 *   `(job, step, variables) => Promise<{ variables, durationMs, tokens }>`.
 *   Daemon wires this to its module-scoped executeStep. Tests inject
 *   a mock returning canned outputs.
 * @param {function} ctx.applyConfirmedProposals
 *   Story 3.2's installer. Called for the auto-confirm disposition.
 * @param {function} ctx.writeAttentionItem
 *   Same shape as the daemon's attention writer.
 * @param {function} ctx.pushEvent
 *   `(jobId, stepId, agentId, eventType, payload) => Promise<void>`
 * @param {function} ctx.getProjectPath
 *   `(projectSlug) => string` — resolves to `/home/ubuntu/projects/<slug>`.
 * @param {function} ctx.validateSkillProposalsBlock
 *   The Zod validator from the TS pipeline. Injected so this module
 *   stays cleanly `.mjs` without a static cross-package import at the
 *   top — daemon wires the resolved import once at startup.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   disposition?: 'noop' | 'auto-confirm' | 'surface-card',
 *   reason?: string,
 *   proposalCount?: number,
 *   acceptedCount?: number,
 *   error?: string,
 * }>}
 */
export async function runSkillScoutJob(job, ctx) {
  const validation = validateSkillScoutJob(job);
  if (!validation.ok) {
    return { ok: false, reason: `validation: ${validation.reason}` };
  }

  const { trigger, projectSlug, appId, planId, planIntent, rigor } =
    job.skillScoutPayload;

  // 1. Read federation + project manifest from disk.
  const projectPath = ctx.getProjectPath(projectSlug);
  let promptCtx;
  try {
    promptCtx = buildPromptContext({
      federationCache: ctx.federationCache,
      projectPath,
      projectSlug,
    });
  } catch (err) {
    await ctx.writeAttentionItem({
      appId,
      planId: planId ?? null,
      severity: 'medium',
      category: 'skill-scout-failed',
      title: `SKILL-SCOUT ${trigger} could not read manifest for ${projectSlug}`,
      body: String(err?.message || err).slice(0, 1500),
      dedupKey: `skill-scout-manifest-read:${trigger}:${projectSlug}`,
    });
    return { ok: false, reason: 'manifest-read-failed', error: String(err?.message || err) };
  }

  // 2. Spawn the SKILL-SCOUT agent step. The pipeline definition is
  //    single-step (generateSkillScoutPipeline). Variables seed the
  //    prompt template — the daemon's substituteTemplate inside
  //    executeStep replaces {{trigger}}, {{currentManifestYaml}}, etc.
  const step = job.pipeline.steps[0];
  let stepExec;
  const t0 = Date.now();
  try {
    stepExec = await ctx.executeAgentStep(job, step, {
      // Initial variables passed to substituteTemplate. The prompt
      // builder (buildSkillScoutPrompt) already embedded the federation
      // and manifest YAML at pipeline-generation time, but we forward
      // them here so retries / re-substitutions stay consistent.
      trigger,
      projectSlug,
      planIntent: planIntent || '(none — T1 init)',
      currentManifestYaml: promptCtx.currentManifestYaml,
      federationYaml: promptCtx.federationYaml,
    });
  } catch (err) {
    await ctx.writeAttentionItem({
      appId,
      planId: planId ?? null,
      severity: 'medium',
      category: 'skill-scout-failed',
      title: `SKILL-SCOUT ${trigger} agent step failed for ${projectSlug}`,
      body: String(err?.message || err).slice(0, 1500),
      dedupKey: `skill-scout-agent-failed:${trigger}:${projectSlug}`,
    });
    return { ok: false, reason: 'agent-step-failed', error: String(err?.message || err) };
  }
  const durationMs = Date.now() - t0;

  // 3. Extract proposals JSON from the step output.
  //    Pipeline extractor key: SKILL_PROPOSALS_JSON (see skill-scout-
  //    pipeline.ts line 134).
  const raw = stepExec?.variables?.SKILL_PROPOSALS_JSON ?? '';
  if (!raw.trim()) {
    // Agent ran but emitted no between-marker block — surface a
    // medium-severity invalid attention so operators can tune the prompt.
    await ctx.writeAttentionItem({
      appId,
      planId: planId ?? null,
      severity: 'medium',
      category: 'skill-scout-output-invalid',
      title: `SKILL-SCOUT ${trigger} emitted no proposals block for ${projectSlug}`,
      body: 'Agent step succeeded but SKILL_PROPOSALS_JSON variable is empty. The prompt may need tuning to ensure the between-marker block is always emitted.',
      dedupKey: `skill-scout-empty-output:${trigger}:${projectSlug}`,
    });
    return { ok: false, reason: 'empty-output' };
  }

  // 4. Validate via the injected Zod-backed validator.
  const valid = ctx.validateSkillProposalsBlock(raw);
  if (!valid.ok) {
    await ctx.writeAttentionItem({
      appId,
      planId: planId ?? null,
      severity: 'medium',
      category: 'skill-scout-output-invalid',
      title: `SKILL-SCOUT ${trigger} emitted invalid proposals block for ${projectSlug}`,
      body: valid.error.slice(0, 1500),
      dedupKey: `skill-scout-invalid:${trigger}:${projectSlug}`,
    });
    return { ok: false, reason: 'invalid-output', error: valid.error };
  }
  const { output } = valid;

  // 5. Forensic event — capture timing + proposal count BEFORE we
  //    branch on disposition so the dashboard sees the run regardless
  //    of outcome.
  const forensic = buildForensicEvent({
    trigger,
    output,
    durationMs,
    tokensConsumed: stepExec?.tokensConsumed ?? 0,
  });
  await ctx.pushEvent?.(
    job.jobId,
    step.id,
    step.agentId,
    forensic.eventType,
    forensic.payload,
  );

  // 6. Dispose.
  const disposition = disposeProposals({ output, rigor });

  if (disposition.disposition === 'noop') {
    return {
      ok: true,
      disposition: 'noop',
      reason: disposition.reason,
      proposalCount: 0,
    };
  }

  if (disposition.disposition === 'auto-confirm') {
    // Apply directly. The installer is responsible for any vendor-skills
    // failure surfacing its own attention item — we don't double-report.
    let applyResult;
    try {
      applyResult = await ctx.applyConfirmedProposals({
        projectPath,
        projectSlug,
        output,
        source: 'auto-confirm',
      });
    } catch (err) {
      await ctx.writeAttentionItem({
        appId,
        planId: planId ?? null,
        severity: 'medium',
        category: 'skill-install-failed',
        title: `SKILL-SCOUT ${trigger} auto-confirm install failed for ${projectSlug}`,
        body: String(err?.message || err).slice(0, 1500),
        dedupKey: `skill-install-auto:${trigger}:${projectSlug}`,
      });
      return {
        ok: false,
        reason: 'auto-confirm-install-failed',
        error: String(err?.message || err),
      };
    }
    return {
      ok: true,
      disposition: 'auto-confirm',
      reason: disposition.reason,
      proposalCount: output.proposals.length,
      acceptedCount: applyResult?.written ?? 0,
    };
  }

  // disposition === 'surface-card'
  const card = buildDecisionCard({ output, projectSlug, appId, planId });
  await ctx.writeAttentionItem({
    ...card,
    appId,
    planId: planId ?? null,
    // Stable dedup so repeat runs of the same trigger on the same
    // (app, plan) collapse into one open card.
    dedupKey: `skill-scout-card:${trigger}:${projectSlug}:${planId ?? 'app-level'}`,
  });
  return {
    ok: true,
    disposition: 'surface-card',
    reason: disposition.reason,
    proposalCount: output.proposals.length,
  };
}
