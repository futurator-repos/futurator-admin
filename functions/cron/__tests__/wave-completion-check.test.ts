/**
 * wave-completion-check.test.ts — Slice B (P3_QA_REVIEW honest-gate).
 *
 * Focused coverage of the VISIBLE SKIP diagnosis added to handleP3Plan's p3-qa
 * enqueue block: a plan sitting in `review` whose deployed-app QA gate did NOT
 * enqueue must emit a `warn` log ("P3 QA Review SKIPPED …") instead of a silent
 * no-op, so a dark-shipped flag or a stuck upstream dev-deploy is diagnosable.
 *
 * Only the minimum surface is mocked; the SUT's other passes are starved of work
 * (no epics, no concept plans) so exactly the P3 branch runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({ logMock: vi.fn() }));
vi.mock('../../shared/logger', () => ({ log: logMock }));

const { getAllPlansMock, updatePlanFieldsMock } = vi.hoisted(() => ({
  getAllPlansMock: vi.fn(),
  updatePlanFieldsMock: vi.fn(),
}));
vi.mock('../../shared/repositories/plan-repository', () => ({
  getAllPlans: getAllPlansMock,
  updatePlanFields: updatePlanFieldsMock,
  acquirePlanReduceLock: vi.fn(),
  releasePlanReduceLock: vi.fn(),
  clearP3QaForRerun: vi.fn(),
  getPlanById: vi.fn(),
}));
vi.mock('../../shared/repositories/epic-workflow-repository', () => ({
  getAllEpics: vi.fn(async () => []),
  getEpicById: vi.fn(),
  updateEpicFields: vi.fn(),
}));
vi.mock('../../shared/repositories/agent-jobs-repository', () => ({
  getJobById: vi.fn(),
  createJob: vi.fn(),
}));
vi.mock('../../shared/repositories/app-repository', () => ({ getApp: vi.fn() }));
vi.mock('../../shared/services/reduce-deps', () => ({
  buildPlanReducerDeps: () => ({
    uuid: () => 'uuid-1',
    now: () => '2026-07-08T00:00:00.000Z',
    createJob: vi.fn(),
    writeAttentionItem: vi.fn(),
  }),
}));

import { handler } from '../wave-completion-check';

function p3ReviewPlan(over: Record<string, unknown> = {}) {
  return {
    planId: 'plan-b',
    name: 'pacman-b',
    appId: 'pacman-b',
    status: 'review',
    epicIds: [], // ⇒ isP3Plan
    workingDir: '/home/ubuntu/projects/pacman-b',
    createdBy: 'u1',
    // dev-deploy already fired so step-1 doesn't try to enqueue one:
    devDeployJobId: 'dev-1',
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
    ...over,
  };
}

/** Did any log call carry the SKIPPED marker at warn level? */
function skipLogged(): boolean {
  return logMock.mock.calls.some(
    ([level, , msg]) => level === 'warn' && String(msg).includes('P3 QA Review SKIPPED'),
  );
}
function skipReason(): string | undefined {
  const call = logMock.mock.calls.find(([, , msg]) => String(msg).includes('P3 QA Review SKIPPED'));
  return (call?.[3] as { reason?: string } | undefined)?.reason;
}

const ORIGINAL_FLAG = process.env.P3_QA_REVIEW;
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.P3_QA_REVIEW;
  else process.env.P3_QA_REVIEW = ORIGINAL_FLAG;
});
beforeEach(() => {
  logMock.mockReset();
  getAllPlansMock.mockReset();
  updatePlanFieldsMock.mockReset();
});

describe('handleP3Plan — visible SKIP diagnosis (Slice B)', () => {
  it('flag OFF → warns that the deployed-app gate is dark (flag-off)', async () => {
    process.env.P3_QA_REVIEW = 'off';
    getAllPlansMock.mockResolvedValue([
      p3ReviewPlan({ devUrl: 'https://d/', qaCommitSha: 'a'.repeat(40) }),
    ]);
    await handler();
    expect(skipLogged()).toBe(true);
    expect(skipReason()).toContain('flag-off');
  });

  it('flag UNSET → still warns (never a silent no-op)', async () => {
    delete process.env.P3_QA_REVIEW;
    getAllPlansMock.mockResolvedValue([
      p3ReviewPlan({ devUrl: 'https://d/', qaCommitSha: 'a'.repeat(40) }),
    ]);
    await handler();
    expect(skipLogged()).toBe(true);
  });

  it('flag ON but devUrl missing → warns with devUrl-missing reason (stuck upstream)', async () => {
    process.env.P3_QA_REVIEW = 'on';
    getAllPlansMock.mockResolvedValue([p3ReviewPlan({ qaCommitSha: 'a'.repeat(40) })]);
    await handler();
    expect(skipLogged()).toBe(true);
    expect(skipReason()).toContain('devUrl-missing');
  });

  it('flag ON, devUrl + qaCommitSha present, no p3QaJobId → enqueues (no SKIP warn)', async () => {
    process.env.P3_QA_REVIEW = 'on';
    getAllPlansMock.mockResolvedValue([
      p3ReviewPlan({ devUrl: 'https://d/', qaCommitSha: 'a'.repeat(40) }),
    ]);
    await handler();
    expect(skipLogged()).toBe(false);
  });

  it('already enqueued (p3QaJobId set) → no SKIP warn (not a skip)', async () => {
    process.env.P3_QA_REVIEW = 'off';
    getAllPlansMock.mockResolvedValue([
      p3ReviewPlan({ devUrl: 'https://d/', qaCommitSha: 'a'.repeat(40), p3QaJobId: 'qa-1' }),
    ]);
    await handler();
    expect(skipLogged()).toBe(false);
  });
});
