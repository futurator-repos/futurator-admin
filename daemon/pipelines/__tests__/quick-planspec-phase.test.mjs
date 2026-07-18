import { describe, it, expect, vi } from 'vitest';

// A2 (design Q2-schema + U4-data) — asserts quick-planspec-runner writes phase
// markers (`updateJobFields(jobId, {phase})`) at the start of each pass, so
// the Plan tab's phase stepper (planner → parallelism-repair → critique →
// critique-repair → ingest) has something real to read. Best-effort: a
// throwing updateJobFields must never fail the run.

import { runQuickPlanspecJob } from '../quick-planspec-runner.mjs';

function fakeSpawn(stdout, code = 0) {
  return () => {
    const child = {
      stdout: { on: (ev, cb) => { if (ev === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0); } },
      stderr: { on: () => {} },
      on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(code), 5); },
    };
    return child;
  };
}

// A serial (linear-chain) spec that trips the parallelism audit, so the
// repair pass fires; then a critique that reports one critical finding, so
// the critique-repair pass fires too — exercising every phase marker.
const SERIAL_SPEC =
  '<PLAN_SPEC>' +
  JSON.stringify({ stories: [
    { id: 'contract', title: 'Define the contract types', touches: ['src/types.ts'],
      acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
    { id: 'movement', title: 'Implement movement', dependsOn: ['contract'], touches: ['src/reducer.ts'],
      acceptanceCriteria: [{ text: 'movement works well', verify: 'state' }] },
    { id: 'scoring', title: 'Implement scoring', dependsOn: ['contract'], touches: ['src/reducer.ts'],
      acceptanceCriteria: [{ text: 'scoring works well', verify: 'state' }] },
    { id: 'assemble', title: 'Assemble the complete app', dependsOn: ['contract', 'movement', 'scoring'], touches: ['src/app.tsx'],
      acceptanceCriteria: [{ text: 'runs end to end', verify: 'behavior', needsBrowser: true }] },
  ] }) +
  '</PLAN_SPEC>';

const SIMPLE_SPEC =
  '<PLAN_SPEC>' +
  JSON.stringify({ stories: [
    { title: 'Define types', touches: ['src/t.ts'], acceptanceCriteria: [{ text: 'tsc is clean here', verify: 'build' }] },
    { title: 'Assemble the complete app', touches: ['src/app.tsx'], acceptanceCriteria: [{ text: 'renders end to end', verify: 'behavior', needsBrowser: true }] },
  ] }) +
  '</PLAN_SPEC>';

const baseJob = {
  jobId: 'j1', workingDir: '/w',
  quickPlanspecPayload: { planId: 'p1', appId: 'a1', intent: 'a game', appBootstrapJobId: 'boot1' },
};

function baseDeps(over = {}) {
  return {
    spawn: fakeSpawn(SIMPLE_SPEC),
    claudeBin: 'claude',
    getJob: vi.fn(async () => ({ status: 'COMPLETED' })),
    batchPutStoryNodes: vi.fn(async () => {}),
    updateJobFields: vi.fn(async () => {}),
    writeAttentionItem: vi.fn(async () => {}),
    log: () => {},
    now: () => 'T',
    sleep: async () => {},
    ...over,
  };
}

describe('runQuickPlanspecJob — phase markers', () => {
  it('marks planner then critique then ingest on the happy path (no repair needed, no critical findings)', async () => {
    const d = baseDeps();
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(true);
    const phases = d.updateJobFields.mock.calls
      .filter((c) => c[1] && Object.prototype.hasOwnProperty.call(c[1], 'phase'))
      .map((c) => c[1].phase);
    expect(phases).toEqual(['planner', 'critique', 'ingest']);
  });

  it('marks parallelism-repair when the audit trips on a serial plan', async () => {
    const d = baseDeps({ spawn: fakeSpawn(SERIAL_SPEC) });
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(true);
    const phases = d.updateJobFields.mock.calls
      .filter((c) => c[1] && Object.prototype.hasOwnProperty.call(c[1], 'phase'))
      .map((c) => c[1].phase);
    expect(phases).toEqual(['planner', 'parallelism-repair', 'critique', 'ingest']);
  });

  it('phase-write failures are best-effort and never fail the run', async () => {
    const d = baseDeps({
      updateJobFields: vi.fn(async (jobId, fields) => {
        if (fields && Object.prototype.hasOwnProperty.call(fields, 'phase')) throw new Error('ddb down');
      }),
    });
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(true);
    expect(d.batchPutStoryNodes).toHaveBeenCalledOnce();
  });
});
