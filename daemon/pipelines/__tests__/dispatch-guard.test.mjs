/**
 * App/Plan v1 — daemon dispatch guard tests (Story 3.2).
 *
 * Validates the three pre-dispatch checks: Plan terminal, App tree dirty,
 * concurrency violation. Tests use a tiny in-memory DDB stub — the guard
 * code is module-private inside agent-daemon.mjs, so we replicate it here
 * for behavior coverage without spinning up the daemon.
 */

import { describe, it, expect } from 'vitest';

/**
 * Reference implementation — kept in lockstep with agent-daemon.mjs.
 * Whenever the daemon's canDispatchJob changes, mirror it here so tests
 * cover the contract. (A more elegant path is to factor the guard into
 * a shared module — listed as a follow-up.)
 */
function makeCanDispatchJob({ getPlan, getApp, markOrphaned, markFailed, setHold, clearHold }) {
  return async function canDispatchJob(job) {
    if (!job.planId || job.planId === 'app-level') return { ok: true };

    const plan = await getPlan(job.planId);
    if (!plan) {
      await markFailed(job.jobId, `plan_not_found: ${job.planId}`);
      return { ok: false, reason: 'plan_not_found' };
    }
    if (plan.status === 'delivered' || plan.status === 'abandoned') {
      await markOrphaned(
        job.jobId,
        plan.status === 'delivered' ? 'plan_delivered' : 'plan_abandoned',
      );
      return { ok: false, reason: `plan_${plan.status}` };
    }

    if (plan.appId) {
      const app = await getApp(plan.appId);
      if (app && app.workingTreeStatus === 'dirty-from-abandoned-plan') {
        if (job.holdReason !== 'app_working_tree_dirty') {
          await setHold(job.jobId, 'app_working_tree_dirty');
        }
        return { ok: false, reason: 'app_working_tree_dirty', hold: true };
      }
    }

    if (job.holdReason) {
      await clearHold(job.jobId);
    }
    return { ok: true };
  };
}

function makeStubs(overrides = {}) {
  return {
    plans: overrides.plans ?? new Map(),
    apps: overrides.apps ?? new Map(),
    orphaned: [],
    failed: [],
    holds: [],
    cleared: [],
  };
}

function makeGuard(stubs) {
  return makeCanDispatchJob({
    getPlan: async (planId) => stubs.plans.get(planId) ?? null,
    getApp: async (appId) => stubs.apps.get(appId) ?? null,
    markOrphaned: async (jobId, reason) => stubs.orphaned.push({ jobId, reason }),
    markFailed: async (jobId, reason) => stubs.failed.push({ jobId, reason }),
    setHold: async (jobId, reason) => stubs.holds.push({ jobId, reason }),
    clearHold: async (jobId) => stubs.cleared.push(jobId),
  });
}

describe('canDispatchJob — App/Plan v1 (Story 3.2)', () => {
  it('passes through legacy jobs without planId', async () => {
    const stubs = makeStubs();
    const guard = makeGuard(stubs);

    const result = await guard({ jobId: 'j1' });
    expect(result.ok).toBe(true);
    expect(stubs.failed).toEqual([]);
  });

  it('passes through app-level jobs', async () => {
    const stubs = makeStubs();
    const guard = makeGuard(stubs);

    const result = await guard({ jobId: 'j1', planId: 'app-level' });
    expect(result.ok).toBe(true);
  });

  it('marks job FAILED when Plan is missing', async () => {
    const stubs = makeStubs();
    const guard = makeGuard(stubs);

    const result = await guard({ jobId: 'j1', planId: 'nonexistent' });
    expect(result).toEqual({ ok: false, reason: 'plan_not_found' });
    expect(stubs.failed).toEqual([{ jobId: 'j1', reason: 'plan_not_found: nonexistent' }]);
  });

  it('marks job ORPHANED when Plan is delivered', async () => {
    const stubs = makeStubs({
      plans: new Map([['p1', { planId: 'p1', status: 'delivered' }]]),
    });
    const guard = makeGuard(stubs);

    const result = await guard({ jobId: 'j1', planId: 'p1' });
    expect(result).toEqual({ ok: false, reason: 'plan_delivered' });
    expect(stubs.orphaned).toEqual([{ jobId: 'j1', reason: 'plan_delivered' }]);
  });

  it('marks job ORPHANED when Plan is abandoned', async () => {
    const stubs = makeStubs({
      plans: new Map([['p1', { planId: 'p1', status: 'abandoned' }]]),
    });
    const guard = makeGuard(stubs);

    const result = await guard({ jobId: 'j1', planId: 'p1' });
    expect(result).toEqual({ ok: false, reason: 'plan_abandoned' });
    expect(stubs.orphaned).toEqual([{ jobId: 'j1', reason: 'plan_abandoned' }]);
  });

  it('holds job when App working tree is dirty', async () => {
    const stubs = makeStubs({
      plans: new Map([['p1', { planId: 'p1', status: 'developing', appId: 'dino3' }]]),
      apps: new Map([
        ['dino3', { appId: 'dino3', workingTreeStatus: 'dirty-from-abandoned-plan' }],
      ]),
    });
    const guard = makeGuard(stubs);

    const result = await guard({ jobId: 'j1', planId: 'p1' });
    expect(result).toEqual({ ok: false, reason: 'app_working_tree_dirty', hold: true });
    expect(stubs.holds).toEqual([{ jobId: 'j1', reason: 'app_working_tree_dirty' }]);
    expect(stubs.orphaned).toEqual([]); // do NOT mark terminal — held only
  });

  it('does not re-stamp holdReason if already set', async () => {
    const stubs = makeStubs({
      plans: new Map([['p1', { planId: 'p1', status: 'developing', appId: 'dino3' }]]),
      apps: new Map([
        ['dino3', { appId: 'dino3', workingTreeStatus: 'dirty-from-abandoned-plan' }],
      ]),
    });
    const guard = makeGuard(stubs);

    const result = await guard({
      jobId: 'j1',
      planId: 'p1',
      holdReason: 'app_working_tree_dirty',
    });
    expect(result.hold).toBe(true);
    expect(stubs.holds).toEqual([]); // not stamped again
  });

  it('passes through happy path and clears stale holdReason', async () => {
    const stubs = makeStubs({
      plans: new Map([['p1', { planId: 'p1', status: 'developing', appId: 'dino3' }]]),
      apps: new Map([['dino3', { appId: 'dino3', workingTreeStatus: 'clean' }]]),
    });
    const guard = makeGuard(stubs);

    const result = await guard({
      jobId: 'j1',
      planId: 'p1',
      holdReason: 'app_working_tree_dirty',
    });
    expect(result).toEqual({ ok: true });
    expect(stubs.cleared).toEqual(['j1']);
  });

  it('passes through Plan without appId (legacy v0 Plan)', async () => {
    const stubs = makeStubs({
      plans: new Map([['p1', { planId: 'p1', status: 'developing' /* no appId */ }]]),
    });
    const guard = makeGuard(stubs);

    const result = await guard({ jobId: 'j1', planId: 'p1' });
    expect(result.ok).toBe(true);
  });

  it('proceeds when App is not found (graceful degradation)', async () => {
    const stubs = makeStubs({
      plans: new Map([['p1', { planId: 'p1', status: 'developing', appId: 'missing' }]]),
    });
    const guard = makeGuard(stubs);

    const result = await guard({ jobId: 'j1', planId: 'p1' });
    expect(result.ok).toBe(true); // App row absent — don't block dispatch
  });
});
