/**
 * story-reflector-hook.mjs — Pipeline-3 parity (G4).
 *
 * Fills the P3 gap where REFLECTOR never fires. In the legacy pipeline,
 * `functions/shared/services/plan-reducer.ts::maybeEnqueuePlanCloseReflector`
 * enqueues a `jobType:'reflector'` job at plan/wave/story close. Pipeline-3's
 * per-story dev path (agent-daemon.executeStoryDevJob → runStoryDevJob) bypasses
 * the plan-reducer entirely, so the inbox → approve → CLAUDE.md/skill learning
 * loop is starved: green stories teach nothing.
 *
 * This module is the missing enqueue seam. It reuses the canonical
 * `buildReflectorJobPayload` (reflector-scheduler.mjs) for the job shape and the
 * `shouldFireReflection` rigor matrix (reflector-runner.mjs) for the gate, so the
 * REFLECTOR contract stays defined in exactly one place. It is:
 *
 *   - Idempotent per scope: a conditional stamp on the owning row (the
 *     plan-spec-graph story row for `story`, the plan row for `wave`/`plan`)
 *     claims the fire; a second call for the same scope returns `already-fired`.
 *   - Rigor-gated: story-scope reflection fires ONLY under production rigor
 *     (v2.5 §38.1); wave/plan fire under any rigor.
 *   - Best-effort: every failure path is non-throwing and returns a reason —
 *     the daemon calls this fire-and-forget on the green-story path and a
 *     reflector miss must never fail the story.
 *
 * Pure/deps-injected: `createJob`, `uuid`, and the DynamoDB command classes are
 * injectable so the enqueue/idempotency logic unit-tests without a live table.
 */

import { PutCommand as RealPutCommand, UpdateCommand as RealUpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { buildReflectorJobPayload } from '../../lib/reflector-scheduler.mjs';
import { shouldFireReflection } from '../reflector-runner.mjs';

const VALID_SCOPES = new Set(['story', 'wave', 'plan']);

/**
 * Build the conditional idempotency claim for a scope. A scalar `attribute_not_exists`
 * stamp so a replay (or a duplicate green-story tick) can never double-enqueue.
 *
 * @returns {object | null} an UpdateCommand input, or null when the key is missing.
 */
function buildIdempotencyClaim({ scope, storyId, planId, waveNumber, planSpecGraphTable, plansTable }) {
  const now = new Date().toISOString();
  const base = {
    UpdateExpression: 'SET #k = :now',
    ConditionExpression: 'attribute_not_exists(#k)',
    ExpressionAttributeValues: { ':now': now },
  };
  if (scope === 'story') {
    if (!storyId) return null;
    return {
      ...base,
      TableName: planSpecGraphTable,
      Key: { storyId },
      ExpressionAttributeNames: { '#k': 'reflectorFiredAt' },
    };
  }
  if (scope === 'plan') {
    return {
      ...base,
      TableName: plansTable,
      Key: { planId },
      ExpressionAttributeNames: { '#k': 'reflectorPlanCloseFiredAt' },
    };
  }
  if (scope === 'wave') {
    return {
      ...base,
      TableName: plansTable,
      Key: { planId },
      ExpressionAttributeNames: { '#k': `reflectorWave${waveNumber}FiredAt` },
    };
  }
  return null;
}

/** DynamoDB surfaces a failed ConditionExpression under a few names/versions. */
function isConditionalCheckFailed(err) {
  if (!err) return false;
  const name = err.name || err.code || err.__type || '';
  return typeof name === 'string' && name.includes('ConditionalCheckFailed');
}

/**
 * Enqueue a REFLECTOR job for a P3 story/wave/plan close. Non-throwing.
 *
 * @param {{
 *   ddb?: { send: (cmd: unknown) => Promise<unknown> },
 *   plan: { planId: string, name?: string, rigor?: string, workingDir?: string, appId?: string },
 *   storyId?: string,
 *   scope?: 'story' | 'wave' | 'plan',
 *   waveNumber?: number,
 *   epicId?: string,
 *   createJob?: (row: object) => Promise<unknown>,
 *   uuid?: () => string,
 *   log?: (level: string, msg: string) => void,
 *   deps?: {
 *     shouldFireReflectionFn?: typeof shouldFireReflection,
 *     buildPayload?: typeof buildReflectorJobPayload,
 *     PutCommand?: unknown,
 *     UpdateCommand?: unknown,
 *     jobsTable?: string,
 *     planSpecGraphTable?: string,
 *     plansTable?: string,
 *   },
 * }} args
 * @returns {Promise<{ enqueued: boolean, jobId?: string, reason?: string }>}
 */
export async function enqueueStoryReflector({
  ddb,
  plan,
  storyId,
  scope = 'story',
  waveNumber,
  epicId,
  createJob,
  uuid,
  log,
  deps = {},
}) {
  const {
    shouldFireReflectionFn = shouldFireReflection,
    buildPayload = buildReflectorJobPayload,
    PutCommand = RealPutCommand,
    UpdateCommand = RealUpdateCommand,
    jobsTable = process.env.JOBS_TABLE || 'futurator-agent-jobs',
    planSpecGraphTable = process.env.PLAN_SPEC_GRAPH_TABLE || 'futurator-plan-spec-graph',
    plansTable = process.env.PLANS_TABLE || 'futurator-plans',
  } = deps;

  const warn = (m) => {
    try {
      (log || (() => {}))('warn', m);
    } catch {
      /* logging is best-effort */
    }
  };
  const uuidFn = typeof uuid === 'function' ? uuid : randomUUID;

  // ── Validate inputs (all non-throwing) ──────────────────────────────────
  if (!plan || typeof plan !== 'object' || !plan.planId) {
    return { enqueued: false, reason: 'plan-missing' };
  }
  if (!VALID_SCOPES.has(scope)) {
    return { enqueued: false, reason: `invalid-scope:${scope}` };
  }
  if (scope === 'story' && !storyId) {
    return { enqueued: false, reason: 'storyId-missing' };
  }
  if (scope === 'wave' && (typeof waveNumber !== 'number' || waveNumber < 0)) {
    return { enqueued: false, reason: 'waveNumber-invalid' };
  }

  // ── Rigor gate (v2.5 §38.1) ─────────────────────────────────────────────
  const rigor = plan.rigor || 'mvp';
  const gate = shouldFireReflectionFn({ rigor, scope });
  if (!gate || !gate.shouldFire) {
    return { enqueued: false, reason: gate?.reason || 'rigor-gate' };
  }

  // ── Idempotency claim: stamp the owning row BEFORE enqueue so a replay can
  //    never double-fire (mirrors plan-reducer's reflectorPlanCloseFiredAt). ─
  const claim = buildIdempotencyClaim({
    scope,
    storyId,
    planId: plan.planId,
    waveNumber,
    planSpecGraphTable,
    plansTable,
  });
  if (ddb && claim) {
    try {
      await ddb.send(new UpdateCommand(claim));
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return { enqueued: false, reason: 'already-fired' };
      }
      // A non-conditional ddb error (throttling, missing row) shouldn't block a
      // best-effort reflection — warn and still attempt the enqueue.
      warn(`[reflector-hook] idempotency stamp failed (non-blocking): ${err?.message || err}`);
    }
  }

  // ── Build the canonical reflector job row ────────────────────────────────
  let row;
  try {
    row = buildPayload({
      scope,
      plan: {
        planId: plan.planId,
        name: plan.name,
        rigor,
        workingDir: plan.workingDir,
        appId: plan.appId,
      },
      epic: epicId ? { epicId } : undefined,
      waveNumber,
      jobIdFactory: uuidFn,
    });
  } catch (err) {
    warn(`[reflector-hook] payload build failed: ${err?.message || err}`);
    return { enqueued: false, reason: `payload-failed:${err?.message || err}` };
  }

  // Story-scope provenance: stamp the originating storyId so the forensic
  // Skills & Learnings tab can trace a reflection back to its trigger story.
  row.createdBy = 'story-reflector-hook';
  if (scope === 'story' && storyId) {
    row.reflectorPayload = { ...row.reflectorPayload, storyId };
  }

  // ── Insert (injected createJob preferred; ddb PutCommand fallback) ───────
  try {
    if (typeof createJob === 'function') {
      await createJob(row);
    } else if (ddb) {
      await ddb.send(new PutCommand({ TableName: jobsTable, Item: row }));
    } else {
      return { enqueued: false, reason: 'no-inserter' };
    }
  } catch (err) {
    warn(`[reflector-hook] reflector enqueue failed (non-blocking): ${err?.message || err}`);
    return { enqueued: false, reason: `enqueue-failed:${err?.message || err}` };
  }

  return { enqueued: true, jobId: row.jobId };
}
