/**
 * reflector-job-runner.mjs — Pipeline v2 Phase 3-C Epic 6 (2026-05-20).
 *
 * Daemon-side runner that processes a PENDING `jobType: 'reflector'`
 * row. Mirrors the SKILL-SCOUT pattern (skill-scout-job-runner.mjs):
 *
 *   1. Validate job shape
 *   2. Spawn REFLECTOR agent via the existing reflector-runner.mjs
 *      helpers (buildPromptContext + the daemon's executeStep adapter
 *      injected by the caller)
 *   3. Parse + validate the proposals JSON the agent emits
 *   4. Write each proposal as a row into `futurator-reflections`
 *      (the operator surfaces them on /labs/reflections)
 *
 * The actual apply-to-disk path is reflector-apply.mjs, called by the
 * operator-confirm action on the Reflection Inbox row. This runner's
 * job is ONLY to produce proposals — never to act on them.
 *
 * Design note: REFLECTOR's prompt + parser plumbing is more involved
 * than SKILL-SCOUT's. For v1 we ship the JOB-RUNNER SCAFFOLD with
 * deps injected — the agent-spawn + proposal-shape integration is
 * the next iteration's surface. This module:
 *
 *   - validates the job-row shape (validateReflectorJob)
 *   - produces a structured forensic event payload
 *   - calls an injected `runAgentStep` + `writeReflectionRow` pair
 *
 * Tests inject mocks for both so we can unit-test the routing without
 * spawning Claude.
 */

import { buildForensicEvent, shouldFireReflection } from './reflector-runner.mjs';

/**
 * Validate the job-row shape.
 *
 * @param {object} job
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateReflectorJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'reflector') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.reflectorPayload;
  if (!p || typeof p !== 'object') {
    return { ok: false, reason: 'reflectorPayload-missing' };
  }
  if (!['plan', 'wave', 'story'].includes(p.scope)) {
    return { ok: false, reason: 'scope-invalid' };
  }
  if (typeof p.planId !== 'string' || p.planId.length === 0) {
    return { ok: false, reason: 'planId-missing' };
  }
  const RIGOR_OK = new Set(['prototype', 'mvp', 'production']);
  if (!RIGOR_OK.has(p.rigor)) return { ok: false, reason: 'rigor-invalid' };
  return { ok: true };
}

/**
 * Run a REFLECTOR job end-to-end. Returns a structured result the
 * daemon's caller maps to job status (COMPLETED / FAILED) + any
 * subsequent attention items.
 *
 * @param {object} job
 * @param {object} ctx
 * @param {function} ctx.runAgentStep
 *   `(job) => Promise<{ proposals: Array<object>, durationMs: number,
 *      tokensConsumed: number }>` — the daemon wraps this around its
 *   executeStep for production. v1: this is the spawn-integration
 *   contract for follow-on; tests inject a canned response.
 * @param {function} ctx.writeReflectionRow
 *   `(proposal) => Promise<void>` — writes one row into
 *   `futurator-reflections`. Operator confirms via /labs/reflections.
 * @param {function} [ctx.writeAttentionItem]
 * @param {function} [ctx.pushEvent]
 */
export async function runReflectorJob(job, ctx) {
  const validation = validateReflectorJob(job);
  if (!validation.ok) {
    return { ok: false, reason: `validation: ${validation.reason}` };
  }
  const { scope, planId, rigor, projectSlug } = job.reflectorPayload;

  // Rigor-matrix gate (re-check at run-time in case rigor changed
  // between enqueue and execute — the reducer stamped what it knew).
  const matrixVerdict = shouldFireReflection({ rigor, scope });
  if (!matrixVerdict.shouldFire) {
    return { ok: true, status: 'gated', reason: matrixVerdict.reason };
  }

  // Spawn the agent step. The caller's executeAgentStep adapter
  // bridges to the daemon's module-scoped executeStep (mirror of
  // skill-scout-job-runner.mjs).
  let stepResult;
  const t0 = Date.now();
  try {
    stepResult = await ctx.runAgentStep(job);
  } catch (err) {
    await ctx.writeAttentionItem?.({
      planId,
      severity: 'medium',
      category: 'other',
      title: `REFLECTOR ${scope} agent step failed for plan ${planId}`,
      body: String(err?.message || err).slice(0, 1500),
      dedupKey: `reflector-agent-failed:${scope}:${planId}`,
    });
    return { ok: false, reason: 'agent-step-failed', error: String(err?.message || err) };
  }
  const durationMs = Date.now() - t0;

  const proposals = Array.isArray(stepResult?.proposals) ? stepResult.proposals : [];

  // Emit forensic event (mirrors SKILL-SCOUT pattern).
  await ctx.pushEvent?.(
    job.jobId,
    'reflector-resolve',
    'REFLECTOR',
    buildForensicEvent({
      scope,
      output: { proposals, planId },
      durationMs,
      tokensConsumed: stepResult?.tokensConsumed ?? 0,
    }).eventType,
    buildForensicEvent({
      scope,
      output: { proposals, planId },
      durationMs,
      tokensConsumed: stepResult?.tokensConsumed ?? 0,
    }).payload,
  );

  // Write each proposal as a futurator-reflections row.
  let written = 0;
  if (typeof ctx.writeReflectionRow === 'function') {
    for (const proposal of proposals) {
      try {
        await ctx.writeReflectionRow({
          ...proposal,
          planId,
          projectSlug,
          scope,
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        written += 1;
      } catch (err) {
        // Per-proposal errors are non-fatal — other proposals still
        // get written. The operator's view is best-effort.
        await ctx.pushEvent?.(
          job.jobId,
          'reflector-write',
          'REFLECTOR',
          'reflection-write-failed',
          { error: String(err?.message || err), proposalId: proposal?.id ?? null },
        );
      }
    }
  }

  return {
    ok: true,
    status: 'completed',
    proposalCount: proposals.length,
    writtenCount: written,
  };
}
