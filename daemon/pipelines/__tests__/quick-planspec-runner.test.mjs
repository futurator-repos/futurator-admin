import { describe, it, expect, vi } from 'vitest';
import { runQuickPlanspecJob } from '../quick-planspec-runner.mjs';

// Minimal fake child: emits `stdout` then closes with `code`.
function fakeSpawn(stdout, code = 0) {
  return () => {
    const handlers = {};
    const child = {
      stdout: { on: (ev, cb) => { if (ev === 'data') setTimeout(() => cb(Buffer.from(stdout)), 0); } },
      stderr: { on: () => {} },
      on: (ev, cb) => { handlers[ev] = cb; if (ev === 'close') setTimeout(() => cb(code), 5); },
    };
    return child;
  };
}

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
});
