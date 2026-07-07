import { describe, it, expect, vi } from 'vitest';
import { runQuickPlanspecJob } from '../quick-planspec-runner.mjs';

// Minimal fake child: emits `stdout` then closes with `code`.
function fakeSpawn(stdout, code = 0) {
  return fakeSpawnSeq([stdout], code);
}

// Like fakeSpawn but returns outputs[i] on the i-th spawn (last one repeats).
function fakeSpawnSeq(outputs, code = 0) {
  let calls = 0;
  const fn = () => {
    const stdout = outputs[Math.min(calls, outputs.length - 1)];
    calls += 1;
    fn.calls = calls;
    const handlers = {};
    const child = {
      stdout: { on: (ev, cb) => { if (ev === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0); } },
      stderr: { on: () => {} },
      on: (ev, cb) => { handlers[ev] = cb; if (ev === 'close') setTimeout(() => cb(code), 5); },
    };
    return child;
  };
  fn.calls = 0;
  return fn;
}

// A serial plan (god-file reducer.ts across 3 features) — fails the audit.
const SERIAL_SPEC =
  '<PLAN_SPEC>' +
  JSON.stringify({ stories: [
    { id: 'contract', title: 'Define the contract types', touches: ['src/types.ts'],
      acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
    { id: 'movement', title: 'Implement movement', dependsOn: ['contract'], touches: ['src/reducer.ts'],
      acceptanceCriteria: [{ text: 'movement works well', verify: 'state' }] },
    { id: 'scoring', title: 'Implement scoring', dependsOn: ['contract'], touches: ['src/reducer.ts'],
      acceptanceCriteria: [{ text: 'scoring works well', verify: 'state' }] },
    { id: 'ghosts', title: 'Implement ghosts', dependsOn: ['contract'], touches: ['src/reducer.ts'],
      acceptanceCriteria: [{ text: 'ghosts work well', verify: 'state' }] },
    { id: 'assemble', title: 'Assemble the complete app', dependsOn: ['contract', 'movement', 'scoring', 'ghosts'], touches: ['src/app.tsx'],
      acceptanceCriteria: [{ text: 'runs end to end', verify: 'behavior', needsBrowser: true }] },
  ] }) +
  '</PLAN_SPEC>';

// The repaired wide plan: disjoint slices → passes the audit.
const WIDE_SPEC =
  '<PLAN_SPEC>' +
  JSON.stringify({ stories: [
    { id: 'contract', title: 'Define the contract types', touches: ['src/types.ts'],
      acceptanceCriteria: [{ text: 'types compile clean', verify: 'build' }] },
    { id: 'movement', title: 'Implement movement', dependsOn: ['contract'], touches: ['src/slices/movement.ts'],
      acceptanceCriteria: [{ text: 'movement works well', verify: 'state' }] },
    { id: 'scoring', title: 'Implement scoring', dependsOn: ['contract'], touches: ['src/slices/scoring.ts'],
      acceptanceCriteria: [{ text: 'scoring works well', verify: 'state' }] },
    { id: 'ghosts', title: 'Implement ghosts', dependsOn: ['contract'], touches: ['src/slices/ghosts.ts'],
      acceptanceCriteria: [{ text: 'ghosts work well', verify: 'state' }] },
    { id: 'assemble', title: 'Assemble the complete app', dependsOn: ['contract', 'movement', 'scoring', 'ghosts'], touches: ['src/app.tsx'],
      acceptanceCriteria: [{ text: 'runs end to end', verify: 'behavior', needsBrowser: true }] },
  ] }) +
  '</PLAN_SPEC>';

const SPEC =
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

function deps(over = {}) {
  return {
    spawn: fakeSpawn(SPEC),
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

describe('runQuickPlanspecJob', () => {
  it('waits for scaffold → generates → ingests StoryNode rows → COMPLETED', async () => {
    const d = deps();
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(true);
    expect(r.summary.stories).toBe(2);
    expect(d.batchPutStoryNodes).toHaveBeenCalledOnce();
    const rows = d.batchPutStoryNodes.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.cohortBatch).sort()).toEqual([0, 1]); // foundation → integration
    expect(d.updateJobFields).toHaveBeenCalledWith('j1', { status: 'COMPLETED' });
  });

  it('fails (attention + FAILED) when the app scaffold does not complete', async () => {
    const d = deps({ getJob: vi.fn(async () => ({ status: 'FAILED' })) });
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(false);
    expect(d.batchPutStoryNodes).not.toHaveBeenCalled();
    expect(d.writeAttentionItem).toHaveBeenCalled();
    expect(d.updateJobFields).toHaveBeenLastCalledWith('j1', expect.objectContaining({ status: 'FAILED' }));
  });

  it('fails when the model output has no parseable plan_spec', async () => {
    const d = deps({ spawn: fakeSpawn('sorry, prose only') });
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parse a plan_spec/);
    expect(d.batchPutStoryNodes).not.toHaveBeenCalled();
  });

  it('validates the payload', async () => {
    const r = await runQuickPlanspecJob({ jobId: 'j', quickPlanspecPayload: {} }, deps());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing/);
  });

  it('does not spawn a repair pass when the plan audits clean', async () => {
    const spawn = fakeSpawnSeq([WIDE_SPEC]);
    const d = deps({ spawn });
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(true);
    expect(spawn.calls).toBe(1);
    expect(r.summary.maxWidth).toBe(3);
    expect(r.summary.violations).toEqual([]);
  });

  it('repairs a serial plan: audit fails → second spawn → wide plan ingested', async () => {
    const spawn = fakeSpawnSeq([SERIAL_SPEC, WIDE_SPEC]);
    const d = deps({ spawn });
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(true);
    expect(spawn.calls).toBe(2); // plan + repair
    expect(r.summary.stories).toBe(5);
    expect(r.summary.maxWidth).toBe(3); // the repaired wide DAG won
    expect(r.summary.violations).toEqual([]);
    // no serial-plan attention item on a successful repair
    const cats = d.writeAttentionItem.mock.calls.map((c) => c[0]?.category);
    expect(cats).not.toContain('quick-planspec-serial-plan');
  });

  it('keeps the original + raises attention when the repair does not improve', async () => {
    const spawn = fakeSpawnSeq([SERIAL_SPEC, SERIAL_SPEC]);
    const d = deps({ spawn });
    const r = await runQuickPlanspecJob(baseJob, d);
    expect(r.ok).toBe(true); // never fail the job over width — safety edges keep it correct
    expect(spawn.calls).toBe(2);
    expect(r.summary.violations.length).toBeGreaterThan(0);
    expect(d.batchPutStoryNodes).toHaveBeenCalledOnce();
    expect(d.writeAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'quick-planspec-serial-plan', severity: 'medium' }),
    );
  });
});
