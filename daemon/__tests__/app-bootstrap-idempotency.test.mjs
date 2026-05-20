/**
 * app-bootstrap-idempotency.test.mjs — Pipeline v2 / Story 1.4.3 / Gate G-6.
 *
 * Hermetic Vitest run of the App-bootstrap saga against a fixture App, twice:
 *   1. First run — every step actually does work.
 *   2. Second run — every step short-circuits as a no-op.
 *
 * The pipeline's step runners are injected through `ctx.steps`, so we mock
 * each runner and assert on call counts + side-effect counts. No real fs,
 * git, npm, or BMAD subprocesses run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runAppBootstrap, APP_BOOTSTRAP_STEPS } from '../pipelines/app-bootstrap.mjs';

function makeJob() {
  return {
    jobId: 'job-test-1',
    jobType: 'app-bootstrap',
    appBootstrapPayload: {
      appId: 'idem-app',
      boilerplateType: 'nextjs',
      bmadEnabled: true,
    },
  };
}

function makeAppRow() {
  return {
    appId: 'idem-app',
    displayName: 'Idem App',
    workingDir: '/home/ubuntu/projects/idem-app',
    executionMode: 'pipeline',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    workingTreeStatus: 'clean',
    boilerplateType: 'nextjs',
    bmadEnabled: true,
    createdAt: 'x',
    updatedAt: 'y',
  };
}

let stepCounters;
let stepFns;
let pushEventCalls;
let attentionCalls;
let updateAppCalls;
let getAppMock;

beforeEach(() => {
  stepCounters = {
    bareCloneInvocations: 0,
    bareCloneReal: 0,
    bareCloneSkipped: 0,
    materializeInvocations: 0,
    materializeReal: 0,
    materializeSkipped: 0,
    injectInvocations: 0,
    injectFilesRewritten: 0,
    npmInvocations: 0,
    npmReal: 0,
    npmSkipped: 0,
    bmadInvocations: 0,
    bmadReal: 0,
    bmadSkipped: 0,
    commitInvocations: 0,
    commitReal: 0,
    commitSkipped: 0,
  };

  // Persistent across calls — flips internal state on first run, returns
  // skipped on second. Mirrors the real idempotency contracts.
  let bareCloneAlreadyRan = false;
  let materializeAlreadyRan = false;
  let injectAlreadyRan = false;
  let npmAlreadyInstalled = false;
  let bmadAlreadyRan = false;
  let commitAlreadyHappened = false;

  stepFns = {
    bareClone: vi.fn(async () => {
      stepCounters.bareCloneInvocations += 1;
      if (bareCloneAlreadyRan) {
        stepCounters.bareCloneSkipped += 1;
        return { skipped: true, baredir: '/home/ubuntu/repos/idem-app.git' };
      }
      bareCloneAlreadyRan = true;
      stepCounters.bareCloneReal += 1;
      return { skipped: false, baredir: '/home/ubuntu/repos/idem-app.git' };
    }),
    materializeWorktree: vi.fn(async () => {
      stepCounters.materializeInvocations += 1;
      if (materializeAlreadyRan) {
        stepCounters.materializeSkipped += 1;
        return { skipped: true, worktreeDir: '/home/ubuntu/projects/idem-app' };
      }
      materializeAlreadyRan = true;
      stepCounters.materializeReal += 1;
      return { skipped: false, worktreeDir: '/home/ubuntu/projects/idem-app' };
    }),
    injectValues: vi.fn(async () => {
      stepCounters.injectInvocations += 1;
      if (injectAlreadyRan) {
        // Already-injected files have no placeholders left → modified=0.
        return { modified: 0, visited: ['package.json', 'README.md', 'CLAUDE.md'] };
      }
      injectAlreadyRan = true;
      stepCounters.injectFilesRewritten += 3;
      return { modified: 3, visited: ['package.json', 'README.md', 'CLAUDE.md'] };
    }),
    npmInstall: vi.fn(async () => {
      stepCounters.npmInvocations += 1;
      if (npmAlreadyInstalled) {
        stepCounters.npmSkipped += 1;
        return { skipped: true, reason: 'already-installed' };
      }
      npmAlreadyInstalled = true;
      stepCounters.npmReal += 1;
      return { skipped: false };
    }),
    bmadBootstrap: vi.fn(async () => {
      stepCounters.bmadInvocations += 1;
      if (bmadAlreadyRan) {
        stepCounters.bmadSkipped += 1;
        return { skipped: true, reason: 'already-installed' };
      }
      bmadAlreadyRan = true;
      stepCounters.bmadReal += 1;
      return { skipped: false };
    }),
    commitAndPush: vi.fn(async () => {
      stepCounters.commitInvocations += 1;
      if (commitAlreadyHappened) {
        stepCounters.commitSkipped += 1;
        return { skipped: true, reason: 'no-changes' };
      }
      commitAlreadyHappened = true;
      stepCounters.commitReal += 1;
      return { skipped: false };
    }),
  };

  pushEventCalls = [];
  attentionCalls = [];
  updateAppCalls = [];
  getAppMock = vi.fn(async () => makeAppRow());
});

function makeCtx() {
  return {
    pushEvent: async (...args) => {
      pushEventCalls.push(args);
    },
    getApp: getAppMock,
    updateApp: async (appId, patch) => {
      updateAppCalls.push({ appId, patch });
    },
    writeAttentionItem: async (item) => {
      attentionCalls.push(item);
    },
    runPartyBootstrap: vi.fn(async () => {}),
    steps: stepFns,
  };
}

describe('runAppBootstrap — Gate G-6 idempotency', () => {
  it('first run executes every step exactly once', async () => {
    const result = await runAppBootstrap(makeJob(), makeCtx());

    expect(result.ok).toBe(true);
    expect(result.appId).toBe('idem-app');

    // Every runner called once
    expect(stepCounters.bareCloneInvocations).toBe(1);
    expect(stepCounters.materializeInvocations).toBe(1);
    expect(stepCounters.injectInvocations).toBe(1);
    expect(stepCounters.npmInvocations).toBe(1);
    expect(stepCounters.bmadInvocations).toBe(1);
    expect(stepCounters.commitInvocations).toBe(1);

    // None skipped on first run
    expect(stepCounters.bareCloneSkipped).toBe(0);
    expect(stepCounters.materializeSkipped).toBe(0);
    expect(stepCounters.npmSkipped).toBe(0);
    expect(stepCounters.bmadSkipped).toBe(0);
    expect(stepCounters.commitSkipped).toBe(0);

    // Real work happened
    expect(stepCounters.bareCloneReal).toBe(1);
    expect(stepCounters.materializeReal).toBe(1);
    expect(stepCounters.injectFilesRewritten).toBe(3);
    expect(stepCounters.npmReal).toBe(1);
    expect(stepCounters.bmadReal).toBe(1);
    expect(stepCounters.commitReal).toBe(1);

    // App row patched on success
    expect(updateAppCalls).toHaveLength(1);
    expect(updateAppCalls[0].patch.workingTreeStatus).toBe('clean');
    expect(typeof updateAppCalls[0].patch.bootstrappedAt).toBe('string');

    // No attention items on success
    expect(attentionCalls).toHaveLength(0);

    // Every saga step emitted at least a started + completed event
    const startedEvents = pushEventCalls.filter(
      (c) => c[3] === 'pv2.app-bootstrap.step.started',
    );
    expect(startedEvents.map((c) => c[1])).toEqual(APP_BOOTSTRAP_STEPS);
  });

  it('second run is a clean no-op — no duplicate work', async () => {
    const ctx = makeCtx();

    // First run primes the in-test "already-done" flags
    await runAppBootstrap(makeJob(), ctx);

    // Reset only the per-call counters that matter for the second run's
    // assertions. The shared stepFns closures preserve the "already ran"
    // state across both calls — that's what makes the second run a no-op.
    const first = { ...stepCounters };

    const result2 = await runAppBootstrap(makeJob(), ctx);
    expect(result2.ok).toBe(true);

    // Each runner was invoked exactly once more (so 2 total)
    expect(stepCounters.bareCloneInvocations).toBe(first.bareCloneInvocations + 1);
    expect(stepCounters.materializeInvocations).toBe(first.materializeInvocations + 1);
    expect(stepCounters.injectInvocations).toBe(first.injectInvocations + 1);
    expect(stepCounters.npmInvocations).toBe(first.npmInvocations + 1);
    expect(stepCounters.bmadInvocations).toBe(first.bmadInvocations + 1);
    expect(stepCounters.commitInvocations).toBe(first.commitInvocations + 1);

    // The second call to each runner returned `skipped: true`
    expect(stepCounters.bareCloneSkipped).toBe(1);
    expect(stepCounters.materializeSkipped).toBe(1);
    expect(stepCounters.npmSkipped).toBe(1);
    expect(stepCounters.bmadSkipped).toBe(1);
    expect(stepCounters.commitSkipped).toBe(1);

    // No additional file rewrites on inject (placeholders gone)
    expect(stepCounters.injectFilesRewritten).toBe(first.injectFilesRewritten);

    // No additional REAL bare-clone / npm / BMAD / commit work
    expect(stepCounters.bareCloneReal).toBe(first.bareCloneReal);
    expect(stepCounters.npmReal).toBe(first.npmReal);
    expect(stepCounters.bmadReal).toBe(first.bmadReal);
    expect(stepCounters.commitReal).toBe(first.commitReal);

    // The App row was patched again on the second success — that's fine,
    // it's idempotent (same workingTreeStatus, fresh bootstrappedAt).
    expect(updateAppCalls).toHaveLength(2);

    // Still no attention items
    expect(attentionCalls).toHaveLength(0);
  });
});

describe('runAppBootstrap — failure surfaces an attention item', () => {
  it('writes pv2-app-bootstrap-failed when a step throws', async () => {
    const ctx = makeCtx();
    // Force inject-values to fail
    stepFns.injectValues = vi.fn(async () => {
      throw new Error('disk full');
    });
    ctx.steps = stepFns;

    await expect(runAppBootstrap(makeJob(), ctx)).rejects.toThrow('disk full');

    expect(attentionCalls).toHaveLength(1);
    const item = attentionCalls[0];
    expect(item.category).toBe('pv2-app-bootstrap-failed');
    expect(item.severity).toBe('high');
    expect(item.planId).toBe('app:idem-app');
    expect(item.title).toMatch(/inject-values/);
    expect(item.body).toMatch(/disk full/);
    expect(item.suggestedActions.map((a) => a.kind)).toContain('retry-step');

    // App row NOT patched to bootstrapped on failure
    expect(updateAppCalls).toHaveLength(0);
  });
});

describe('runAppBootstrap — stub-type fast paths', () => {
  it('skips npm-install + bmad-bootstrap for stub types', async () => {
    const ctx = makeCtx();
    const stubJob = {
      jobId: 'job-stub',
      jobType: 'app-bootstrap',
      appBootstrapPayload: {
        appId: 'idem-app',
        boilerplateType: 'sst',
        bmadEnabled: false,
      },
    };

    // Override step mocks so we can observe what arguments they got
    const stubSteps = {
      bareClone: vi.fn(async () => ({ skipped: false })),
      materializeWorktree: vi.fn(async () => ({ skipped: false })),
      injectValues: vi.fn(async () => ({ modified: 0, visited: [] })),
      npmInstall: vi.fn(async (args) => {
        // `skip: true` is the contract for stub types
        if (args.skip === true) return { skipped: true, reason: 'stub-type' };
        return { skipped: false };
      }),
      bmadBootstrap: vi.fn(async (args) => {
        // bmadEnabled=false → unconditional skip
        if (!args.bmadEnabled) return { skipped: true, reason: 'bmad-disabled' };
        return { skipped: false };
      }),
      commitAndPush: vi.fn(async () => ({ skipped: false })),
    };
    ctx.steps = stubSteps;

    const result = await runAppBootstrap(stubJob, ctx);
    expect(result.ok).toBe(true);

    expect(stubSteps.npmInstall).toHaveBeenCalledTimes(1);
    expect(stubSteps.npmInstall.mock.calls[0][0].skip).toBe(true);
    expect(stubSteps.bmadBootstrap).toHaveBeenCalledTimes(1);
    expect(stubSteps.bmadBootstrap.mock.calls[0][0].bmadEnabled).toBe(false);
  });
});

// ── Epic 3 Story 3.3 (2026-05-20) — T1 SKILL-SCOUT enqueue ──

describe('runAppBootstrap — T1 SKILL-SCOUT enqueue (Epic 3 Story 3.3)', () => {
  it('inserts a PENDING skill-scout job when ctx.insertAgentJob is provided', async () => {
    const insertCalls = [];
    const ctx = {
      ...makeCtx(),
      insertAgentJob: async (j) => {
        insertCalls.push(j);
      },
    };

    await runAppBootstrap(makeJob(), ctx);

    expect(insertCalls).toHaveLength(1);
    const scoutJob = insertCalls[0];
    expect(scoutJob.jobType).toBe('skill-scout');
    expect(scoutJob.status).toBe('PENDING');
    expect(scoutJob.skillScoutPayload.trigger).toBe('T1');
    expect(scoutJob.skillScoutPayload.appId).toBe('idem-app');
    expect(scoutJob.skillScoutPayload.rigor).toBe('prototype');
    expect(scoutJob.skillScoutPayload.planId).toBeNull();
    // Pipeline baked at insert time.
    expect(scoutJob.pipeline.steps).toHaveLength(1);
    expect(scoutJob.pipeline.steps[0].id).toBe('skill-scout-resolve');
    expect(scoutJob.pipeline.agents.SKILL_SCOUT).toBeDefined();

    // Marker events still emit (forensic backwards-compat) PLUS the new
    // `.enqueued` event that carries the actual jobId.
    const queuedMarker = pushEventCalls.find((c) => c[3] === 'pv2.skill-scout.queued');
    const enqueuedReal = pushEventCalls.find((c) => c[3] === 'pv2.skill-scout.enqueued');
    expect(queuedMarker).toBeDefined();
    expect(enqueuedReal).toBeDefined();
    expect(enqueuedReal[4].scoutJobId).toBe(scoutJob.jobId);
  });

  it('falls back gracefully when ctx.insertAgentJob is absent', async () => {
    // The legacy idempotency-test ctx (above) doesn't pass insertAgentJob.
    // Bootstrap must complete cleanly, marker event still emits, but no
    // job-row insert is attempted.
    const ctx = makeCtx();
    await runAppBootstrap(makeJob(), ctx);

    const queuedMarker = pushEventCalls.find((c) => c[3] === 'pv2.skill-scout.queued');
    const enqueuedReal = pushEventCalls.find((c) => c[3] === 'pv2.skill-scout.enqueued');
    const enqueueFailed = pushEventCalls.find((c) => c[3] === 'pv2.skill-scout.enqueue-failed');
    expect(queuedMarker).toBeDefined();
    expect(enqueuedReal).toBeUndefined();
    expect(enqueueFailed).toBeUndefined();
  });

  it('surfaces enqueue-failed event when insertAgentJob throws (non-fatal)', async () => {
    const ctx = {
      ...makeCtx(),
      insertAgentJob: async () => {
        throw new Error('DDB conditional check failed');
      },
    };
    const result = await runAppBootstrap(makeJob(), ctx);
    // Bootstrap STILL completes successfully — T1 enqueue failure is non-fatal.
    expect(result.ok).toBe(true);
    const failedEvent = pushEventCalls.find(
      (c) => c[3] === 'pv2.skill-scout.enqueue-failed',
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent[4].error).toContain('DDB conditional check failed');
  });
});
