import { describe, it, expect } from 'vitest';
import { runFrontierTick, propagateCompletion, dependentsOf } from '../story-dispatch-driver.mjs';
import { buildGateSpawn } from '../gate-settings.mjs';
import { readFileSync } from 'node:fs';

const row = (storyId, depends_on = [], state = 'blocked') => ({ storyId, depends_on, state, planId: 'p1' });

describe('runFrontierTick', () => {
  const nodes = [row('a', [], 'done'), row('b', ['a'], 'ready'), row('c', ['b'], 'blocked')];
  const loadNodes = async () => nodes;

  it('off → no-op', async () => {
    const r = await runFrontierTick({ planId: 'p1', p3Flags: { P3_READY_FRONTIER: 'off' }, loadNodes });
    expect(r.mode).toBe('off');
    expect(r.dispatched).toEqual([]);
  });
  it('shadow → computes frontier, dispatches nothing', async () => {
    const r = await runFrontierTick({ planId: 'p1', p3Flags: { P3_READY_FRONTIER: 'shadow' }, loadNodes });
    expect(r.frontier).toEqual(['b']);
    expect(r.dispatched).toEqual([]);
  });
  it('on → claims + enqueues the frontier', async () => {
    const enqueued = [];
    const ddb = { send: async (cmd) => ({ Attributes: { storyState: 'claimed', ...cmd.input.Key } }) };
    const r = await runFrontierTick({
      planId: 'p1', p3Flags: { P3_READY_FRONTIER: 'on' }, ddb, table: 't',
      loadNodes: async () => [row('x', [], 'ready')],
      enqueue: async (s) => enqueued.push(s.storyId), now: 0,
    });
    expect(r.dispatched).toEqual(['x']);
    expect(enqueued).toEqual(['x']);
  });
  it('maps storyState→state when state field absent', async () => {
    const r = await runFrontierTick({
      planId: 'p1', p3Flags: { P3_READY_FRONTIER: 'shadow' },
      loadNodes: async () => [{ storyId: 'z', depends_on: [], storyState: 'ready' }],
    });
    expect(r.frontier).toEqual(['z']);
  });
});

describe('propagateCompletion + dependentsOf', () => {
  it('dependentsOf finds stories depending on the completed one', () => {
    const nodes = [row('a'), row('b', ['a']), row('c', ['a', 'b'])];
    expect(dependentsOf(nodes, 'a').sort()).toEqual(['b', 'c']);
  });
  it('decrements each dependent, collects newly unblocked', async () => {
    // dep 'b' reaches 0 (unblocks), dep 'c' still has 1 remaining
    const ddb = {
      send: async (cmd) => {
        const id = cmd.input.Key.storyId;
        if (cmd.input.UpdateExpression.startsWith('ADD')) {
          return { Attributes: { unblockedDepsCount: id === 'b' ? 0 : 1 } };
        }
        return { Attributes: { storyState: 'ready' } };
      },
    };
    const r = await propagateCompletion({ ddb, table: 't', completedStoryId: 'a', dependents: ['b', 'c'], now: 0 });
    expect(r.unblocked).toEqual(['b']);
  });
});

describe('gate-settings observe wiring', () => {
  it('adds the observe hook + env when gate on and observeLog given', () => {
    const dir = '/tmp';
    const g = buildGateSpawn({
      jobId: 'job-obs', p3Flags: { P3_GATE_MODE: 'audit' },
      observeLog: '/tmp/obs.jsonl', agentRole: 'orchestrator', settingsDir: dir,
    });
    const settings = JSON.parse(readFileSync(g.settingsPath, 'utf8'));
    const cmds = settings.hooks.PostToolUse[0].hooks.map((h) => h.command).join(' ');
    expect(cmds).toMatch(/posttool-observe\.mjs/);
    expect(g.env.FUTURATOR_OBSERVE_LOG).toBe('/tmp/obs.jsonl');
    expect(g.env.FUTURATOR_AGENT_ROLE).toBe('orchestrator');
  });
  it('no observe hook when gate off', () => {
    const g = buildGateSpawn({ jobId: 'j', p3Flags: { P3_GATE_MODE: 'off' }, observeLog: '/tmp/obs.jsonl' });
    expect(g.env.FUTURATOR_OBSERVE_LOG).toBeUndefined();
  });
});
