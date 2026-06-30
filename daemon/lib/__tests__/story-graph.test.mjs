import { describe, it, expect } from 'vitest';
import {
  detectCycles,
  isDag,
  topoOrder,
  topoLevels,
  readyFrontier,
  isStoryDispatchable,
  applyTransition,
  canTransition,
  STORY_STATES,
} from '../story-graph.mjs';
import {
  buildClaimParams,
  buildReleaseParams,
  buildDecrementDepParams,
  buildUnblockParams,
  claimStory,
  recordDependencyDone,
} from '../atomic-claim.mjs';
import { dispatchReadyFrontier } from '../ready-frontier.mjs';

const n = (storyId, depends_on = [], state = 'blocked') => ({ storyId, depends_on, state });

describe('detectCycles / isDag', () => {
  it('clean DAG has no cycles or dangling', () => {
    const g = [n('a'), n('b', ['a']), n('c', ['a', 'b'])];
    expect(detectCycles(g)).toEqual({ cycles: [], dangling: [] });
    expect(isDag(g)).toBe(true);
  });
  it('finds a cycle', () => {
    const g = [n('a', ['c']), n('b', ['a']), n('c', ['b'])];
    const { cycles } = detectCycles(g);
    expect(cycles.length).toBeGreaterThan(0);
    expect(isDag(g)).toBe(false);
  });
  it('flags a dangling dependency', () => {
    const g = [n('a', ['ghost'])];
    expect(detectCycles(g).dangling).toEqual([{ storyId: 'a', missing: 'ghost' }]);
    expect(isDag(g)).toBe(false);
  });
});

describe('topoOrder / topoLevels (diamond)', () => {
  // a → b,c → d
  const diamond = [n('d', ['b', 'c']), n('b', ['a']), n('c', ['a']), n('a')];
  it('orders deps before dependents, deterministically', () => {
    const order = topoOrder(diamond);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });
  it('returns null on a cycle', () => {
    expect(topoOrder([n('a', ['b']), n('b', ['a'])])).toBe(null);
  });
  it('assigns cohortBatch levels', () => {
    const lv = topoLevels(diamond);
    expect(lv.get('a')).toBe(0);
    expect(lv.get('b')).toBe(1);
    expect(lv.get('c')).toBe(1);
    expect(lv.get('d')).toBe(2);
  });
});

describe('readyFrontier', () => {
  it('only stories whose deps are all done are dispatchable', () => {
    const g = [
      n('a', [], 'done'),
      n('b', ['a'], 'blocked'),     // dep done → ready
      n('c', ['b'], 'blocked'),     // dep not done → not yet
      n('d', [], 'ready'),          // no deps, already ready
      n('e', [], 'developing'),     // in-flight → excluded
    ];
    expect(readyFrontier(g)).toEqual(['b', 'd']);
  });
  it('isStoryDispatchable matches against a doneSet', () => {
    const done = new Set(['a']);
    expect(isStoryDispatchable(n('b', ['a'], 'blocked'), done)).toBe(true);
    expect(isStoryDispatchable(n('c', ['b'], 'blocked'), done)).toBe(false);
    expect(isStoryDispatchable(n('d', [], 'developing'), done)).toBe(false);
  });
});

describe('applyTransition state machine', () => {
  it('allows legal transitions, returns a new node', () => {
    const s = n('a', [], 'ready');
    const next = applyTransition(s, 'claimed');
    expect(next.state).toBe('claimed');
    expect(s.state).toBe('ready'); // immutable
  });
  it('rejects illegal transitions but allows failed→ready reopen', () => {
    expect(() => applyTransition(n('a', [], 'done'), 'ready')).toThrow(/illegal/); // done is terminal
    expect(() => applyTransition(n('a', [], 'ready'), 'done')).toThrow(/illegal/);
    expect(applyTransition(n('a', [], 'failed'), 'ready').state).toBe('ready'); // retry reopen
  });
  it('canTransition reflects the table; same-state is a no-op', () => {
    expect(canTransition('ready', 'claimed')).toBe(true);
    expect(canTransition('ready', 'done')).toBe(false);
    expect(canTransition('done', 'done')).toBe(true);
    expect(STORY_STATES).toContain('verifying');
  });
});

describe('atomic-claim builders', () => {
  it('claim condition only fires on a ready/expired-lease row (state aliased)', () => {
    const p = buildClaimParams({ table: 't', storyId: 's', owner: 'o', token: 'k', now: 0 });
    expect(p.ConditionExpression).toMatch(/#state = :ready/);
    expect(p.ConditionExpression).toMatch(/claimExpiresAt < :now/);
    expect(p.ExpressionAttributeNames['#state']).toBe('state');
    expect(p.ExpressionAttributeValues[':owner']).toBe('o');
  });
  it('release returns to ready and clears the claim', () => {
    const p = buildReleaseParams({ table: 't', storyId: 's', token: 'k', now: 0 });
    expect(p.UpdateExpression).toMatch(/REMOVE claimOwner, claimToken, claimExpiresAt/);
    expect(p.ConditionExpression).toMatch(/claimToken = :token/);
  });
  it('decrement is conditional on counter > 0; unblock flips at 0', () => {
    expect(buildDecrementDepParams({ table: 't', storyId: 's', now: 0 }).ConditionExpression).toMatch(/unblockedDepsCount > :zero/);
    expect(buildUnblockParams({ table: 't', storyId: 's', now: 0 }).ConditionExpression).toMatch(/#state = :blocked AND unblockedDepsCount = :zero/);
  });
});

describe('atomic-claim race semantics', () => {
  class fakeCmd { constructor(params) { this.input = params; } }
  it('two callers, one wins (ConditionalCheckFailed → claimed:false)', async () => {
    let first = true;
    const ddb = {
      send: async () => {
        if (first) { first = false; return { Attributes: { storyState: 'claimed' } }; }
        const e = new Error('cond'); e.name = 'ConditionalCheckFailedException'; throw e;
      },
    };
    const a = await claimStory({ ddb, table: 't', storyId: 's', owner: 'o1', token: 'k1', UpdateCommand: fakeCmd });
    const b = await claimStory({ ddb, table: 't', storyId: 's', owner: 'o2', token: 'k2', UpdateCommand: fakeCmd });
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(false);
  });
  it('a real infra error propagates (not swallowed as a lost race)', async () => {
    const ddb = { send: async () => { throw new Error('throttled'); } };
    await expect(claimStory({ ddb, table: 't', storyId: 's', owner: 'o', token: 'k', UpdateCommand: fakeCmd })).rejects.toThrow('throttled');
  });
  it('recordDependencyDone unblocks when counter reaches 0', async () => {
    const calls = [];
    const ddb = {
      send: async (cmd) => {
        calls.push(cmd.input.UpdateExpression);
        if (cmd.input.UpdateExpression.startsWith('ADD')) return { Attributes: { unblockedDepsCount: 0 } };
        return { Attributes: { storyState: 'ready' } };
      },
    };
    const res = await recordDependencyDone({ ddb, table: 't', storyId: 's', UpdateCommand: fakeCmd });
    expect(res.unblocked).toBe(true);
    expect(calls.some((u) => u.startsWith('ADD'))).toBe(true);
    expect(calls.some((u) => u.includes('#state = :ready'))).toBe(true);
  });
  it('recordDependencyDone does not unblock when deps remain', async () => {
    const ddb2 = { send: async () => ({ Attributes: { unblockedDepsCount: 2 } }) };
    expect((await recordDependencyDone({ ddb: ddb2, table: 't', storyId: 's', UpdateCommand: fakeCmd })).unblocked).toBe(false);
  });
});

describe('dispatchReadyFrontier', () => {
  const nodes = [n('a', [], 'done'), n('b', ['a'], 'ready'), n('c', ['b'], 'blocked')];
  it('shadow computes frontier, dispatches nothing', async () => {
    const r = await dispatchReadyFrontier({ nodes, mode: 'shadow' });
    expect(r.shadow).toBe(true);
    expect(r.frontier).toEqual(['b']);
    expect(r.dispatched).toEqual([]);
  });
  it('off returns frontier, no shadow flag, no dispatch', async () => {
    const r = await dispatchReadyFrontier({ nodes, mode: 'off' });
    expect(r.shadow).toBe(false);
    expect(r.dispatched).toEqual([]);
  });
  it('on claims + enqueues, respects capacity', async () => {
    const enqueued = [];
    const ddb = { send: async (cmd) => ({ Attributes: { storyState: 'claimed', ...cmd.input.Key } }) };
    const r = await dispatchReadyFrontier({
      nodes: [n('a', [], 'ready'), n('b', [], 'ready')],
      mode: 'on', ddb, table: 't', owner: 'd1', capacity: 1,
      enqueue: async (s) => enqueued.push(s.storyId),
      makeToken: () => 'tok',
    });
    expect(r.dispatched.length).toBe(1); // capacity capped
    expect(enqueued.length).toBe(1);
  });
});
