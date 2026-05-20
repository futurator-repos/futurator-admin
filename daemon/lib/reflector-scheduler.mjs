/**
 * reflector-scheduler.mjs — Pipeline v2 Phase 3-C Epic 6 (2026-05-20).
 *
 * Quiet-window scheduler that decides WHEN REFLECTOR fires for a given
 * plan. Pairs with `daemon/pipelines/reflector-runner.mjs::shouldFireReflection`
 * (rigor matrix) — this module adds the temporal-eligibility layer:
 *
 *   - plan close: REFLECTOR fires once when status flips to `review` or
 *     `delivered`. The cron's plan-reducer is the natural trigger point.
 *   - wave close: REFLECTOR fires once per wave under production rigor
 *     (v2.5 §38.1). Wave-reducer is the trigger.
 *
 * Idempotency keys (stored on the plan/wave row via the existing repo
 * updaters): `plan.reflectorPlanCloseFiredAt` + `epic.reflectorWaveCloseFiredAt`.
 * Once stamped, this scheduler returns `{shouldFire: false, reason:
 * 'already-fired'}` so a cron tick replay never re-runs the agent.
 *
 * The actual job-row insert is the caller's responsibility — this
 * module is the GATE, not the inserter. Mirror of the SKILL-SCOUT
 * pattern (Epic 3) which separates `disposeProposals` (gate) from
 * the daemon's `executeSkillScoutJob` (inserter).
 */

/**
 * Decide whether REFLECTOR should fire for a plan-close event.
 *
 * @param {{
 *   plan: { rigor?: string, reflectorPlanCloseFiredAt?: string | null, planId: string, status?: string },
 *   shouldFireReflectionFn?: (args: { rigor: string, scope: string }) => { shouldFire: boolean, reason: string },
 * }} args
 * @returns {{ shouldFire: boolean, reason: string }}
 */
export function decidePlanCloseReflection({
  plan,
  shouldFireReflectionFn,
}) {
  if (!plan || typeof plan !== 'object') {
    return { shouldFire: false, reason: 'plan-missing' };
  }
  // Idempotency: once stamped, never re-fire.
  if (plan.reflectorPlanCloseFiredAt) {
    return { shouldFire: false, reason: 'already-fired' };
  }
  // Only fire on terminal statuses (review or delivered).
  const TERMINAL_FOR_REFLECTOR = new Set(['review', 'delivered']);
  if (!TERMINAL_FOR_REFLECTOR.has(plan.status)) {
    return {
      shouldFire: false,
      reason: `plan status (${plan.status ?? 'unknown'}) not eligible for plan-close reflection`,
    };
  }
  const rigor = plan.rigor ?? 'mvp';
  if (typeof shouldFireReflectionFn === 'function') {
    const matrixVerdict = shouldFireReflectionFn({ rigor, scope: 'plan' });
    if (!matrixVerdict.shouldFire) return matrixVerdict;
  }
  return { shouldFire: true, reason: `plan-close + ${rigor} rigor` };
}

/**
 * Decide whether REFLECTOR should fire for a wave-close event.
 *
 * @param {{
 *   plan: { rigor?: string, planId: string },
 *   epic: { epicId: string, reflectorWaveCloseFiredAt?: Record<number, string> | null, status?: string },
 *   waveNumber: number,
 *   shouldFireReflectionFn?: (args: { rigor: string, scope: string }) => { shouldFire: boolean, reason: string },
 * }} args
 */
export function decideWaveCloseReflection({
  plan,
  epic,
  waveNumber,
  shouldFireReflectionFn,
}) {
  if (!plan || !epic) return { shouldFire: false, reason: 'plan-or-epic-missing' };
  if (typeof waveNumber !== 'number' || waveNumber < 0) {
    return { shouldFire: false, reason: 'waveNumber-invalid' };
  }
  const firedMap = epic.reflectorWaveCloseFiredAt;
  if (firedMap && firedMap[String(waveNumber)]) {
    return { shouldFire: false, reason: 'already-fired' };
  }
  const rigor = plan.rigor ?? 'mvp';
  if (typeof shouldFireReflectionFn === 'function') {
    const matrixVerdict = shouldFireReflectionFn({ rigor, scope: 'wave' });
    if (!matrixVerdict.shouldFire) return matrixVerdict;
  }
  // Story 3-E-3-1 default — wave-close reflection requires mvp+ rigor.
  if (rigor === 'prototype') {
    return { shouldFire: false, reason: 'wave-close reflection requires mvp+ rigor' };
  }
  return { shouldFire: true, reason: `wave-${waveNumber} close + ${rigor} rigor` };
}

/**
 * Build a REFLECTOR job-row payload. The daemon's `executeReflectorJob`
 * (follow-on wire-in) reads this shape. Mirrors the SKILL-SCOUT job-
 * payload pattern from Epic 3.
 *
 * @param {{
 *   scope: 'plan' | 'wave' | 'story',
 *   plan: { planId: string, name?: string, rigor?: string, workingDir?: string, appId?: string },
 *   epic?: { epicId: string },
 *   waveNumber?: number,
 *   jobIdFactory: () => string,
 * }} args
 * @returns {object} agent-jobs row to insert as PENDING
 */
export function buildReflectorJobPayload({
  scope,
  plan,
  epic,
  waveNumber,
  jobIdFactory,
}) {
  if (!plan?.planId) throw new Error('buildReflectorJobPayload: plan.planId required');
  if (!['plan', 'wave', 'story'].includes(scope)) {
    throw new Error(`buildReflectorJobPayload: invalid scope "${scope}"`);
  }
  const now = new Date().toISOString();
  return {
    jobId: jobIdFactory(),
    jobType: 'reflector',
    status: 'PENDING',
    workingDir: plan.workingDir ?? null,
    createdAt: now,
    updatedAt: now,
    createdBy: 'reflector-scheduler',
    reflectorPayload: {
      scope,
      planId: plan.planId,
      planSlug: plan.name,
      projectSlug: plan.appId ?? plan.name,
      rigor: plan.rigor ?? 'mvp',
      epicId: epic?.epicId ?? null,
      waveNumber: typeof waveNumber === 'number' ? waveNumber : null,
    },
    // The actual pipeline definition (single agent step) is built by
    // executeReflectorJob at run-time when the canonical TS builder is
    // available, OR via a daemon-side mirror similar to skill-scout-
    // pipeline-builder.mjs. Held back as part of the wire-in follow-on.
    pipeline: null,
  };
}
