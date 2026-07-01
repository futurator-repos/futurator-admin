import { describe, it, expect, vi } from 'vitest';

import { enqueueStoryReflector } from '../story-reflector-hook.mjs';

/**
 * G4 — story-reflector-hook: the P3 REFLECTOR enqueue seam that plan-reducer's
 * bypass drops. Fires on story/wave/plan close, gated by rigor + idempotency.
 */

/** A ddb whose .send resolves for every command (records the calls). */
function passThroughDdb() {
  const calls = [];
  return {
    calls,
    send: vi.fn(async (cmd) => {
      calls.push(cmd);
      return {};
    }),
  };
}

/** A ddb whose stamp (first .send) fails the idempotency condition. */
function conditionalFailDdb() {
  return {
    send: vi.fn(async () => {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }),
  };
}

const prodPlan = {
  planId: 'plan-1',
  name: 'brick-breaker',
  appId: 'brick-breaker',
  rigor: 'production',
  workingDir: '/home/ubuntu/projects/brick-breaker',
};

describe('enqueueStoryReflector — input validation (non-throwing)', () => {
  it('returns plan-missing when plan has no planId', async () => {
    const r = await enqueueStoryReflector({ plan: {}, storyId: 's1', scope: 'story' });
    expect(r).toEqual({ enqueued: false, reason: 'plan-missing' });
  });

  it('returns invalid-scope for an unknown scope', async () => {
    const r = await enqueueStoryReflector({ plan: prodPlan, scope: 'epic', storyId: 's1' });
    expect(r.enqueued).toBe(false);
    expect(r.reason).toBe('invalid-scope:epic');
  });

  it('returns storyId-missing for story scope without a storyId', async () => {
    const r = await enqueueStoryReflector({ plan: prodPlan, scope: 'story' });
    expect(r).toEqual({ enqueued: false, reason: 'storyId-missing' });
  });

  it('returns waveNumber-invalid for wave scope without a valid wave', async () => {
    const r = await enqueueStoryReflector({ plan: prodPlan, scope: 'wave' });
    expect(r).toEqual({ enqueued: false, reason: 'waveNumber-invalid' });
  });
});

describe('enqueueStoryReflector — rigor gate (v2.5 §38.1)', () => {
  it('does NOT fire story-scope under mvp rigor (production-only)', async () => {
    const createJob = vi.fn();
    const r = await enqueueStoryReflector({
      plan: { ...prodPlan, rigor: 'mvp' },
      storyId: 's1',
      scope: 'story',
      createJob,
    });
    expect(r.enqueued).toBe(false);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('does NOT fire story-scope under prototype rigor', async () => {
    const createJob = vi.fn();
    const r = await enqueueStoryReflector({
      plan: { ...prodPlan, rigor: 'prototype' },
      storyId: 's1',
      scope: 'story',
      createJob,
    });
    expect(r.enqueued).toBe(false);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('DOES fire wave-scope under mvp rigor (wave fires under any rigor)', async () => {
    const createJob = vi.fn(async () => {});
    const r = await enqueueStoryReflector({
      plan: { ...prodPlan, rigor: 'mvp' },
      scope: 'wave',
      waveNumber: 0,
      createJob,
      uuid: () => 'job-wave',
    });
    expect(r.enqueued).toBe(true);
    expect(createJob).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueStoryReflector — story-scope enqueue', () => {
  it('enqueues a canonical reflector job and returns its jobId', async () => {
    const ddb = passThroughDdb();
    const createJob = vi.fn(async () => {});
    const r = await enqueueStoryReflector({
      ddb,
      plan: prodPlan,
      storyId: 'story-42',
      scope: 'story',
      createJob,
      uuid: () => 'job-abc',
    });
    expect(r).toEqual({ enqueued: true, jobId: 'job-abc' });

    const row = createJob.mock.calls[0][0];
    expect(row.jobType).toBe('reflector');
    expect(row.status).toBe('PENDING');
    expect(row.createdBy).toBe('story-reflector-hook');
    expect(row.reflectorPayload.scope).toBe('story');
    expect(row.reflectorPayload.planId).toBe('plan-1');
    // Provenance: the trigger storyId is stamped for the forensic tab.
    expect(row.reflectorPayload.storyId).toBe('story-42');
  });

  it('stamps the idempotency claim on the plan-spec-graph story row before enqueue', async () => {
    const ddb = passThroughDdb();
    await enqueueStoryReflector({
      ddb,
      plan: prodPlan,
      storyId: 'story-42',
      scope: 'story',
      uuid: () => 'job-abc',
      deps: { planSpecGraphTable: 'test-graph', jobsTable: 'test-jobs' },
    });
    // First send = conditional stamp on the story row.
    const stamp = ddb.calls[0].input;
    expect(stamp.TableName).toBe('test-graph');
    expect(stamp.Key).toEqual({ storyId: 'story-42' });
    expect(stamp.ConditionExpression).toContain('attribute_not_exists');
    // Second send = the PutCommand fallback insert (no createJob supplied).
    expect(ddb.calls[1].input.TableName).toBe('test-jobs');
    expect(ddb.calls[1].input.Item.jobType).toBe('reflector');
  });

  it('returns already-fired when the idempotency condition fails', async () => {
    const createJob = vi.fn();
    const r = await enqueueStoryReflector({
      ddb: conditionalFailDdb(),
      plan: prodPlan,
      storyId: 'story-42',
      scope: 'story',
      createJob,
      uuid: () => 'job-abc',
    });
    expect(r).toEqual({ enqueued: false, reason: 'already-fired' });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('still enqueues when the idempotency stamp fails for a NON-conditional reason', async () => {
    let sendCount = 0;
    const ddb = {
      send: vi.fn(async () => {
        sendCount += 1;
        if (sendCount === 1) throw new Error('ProvisionedThroughputExceeded');
        return {};
      }),
    };
    const createJob = vi.fn(async () => {});
    const r = await enqueueStoryReflector({
      ddb,
      plan: prodPlan,
      storyId: 'story-42',
      scope: 'story',
      createJob,
      uuid: () => 'job-abc',
    });
    expect(r.enqueued).toBe(true);
    expect(createJob).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueStoryReflector — insertion + failure handling', () => {
  it('falls back to a ddb PutCommand when no createJob is injected', async () => {
    const ddb = passThroughDdb();
    const r = await enqueueStoryReflector({
      ddb,
      plan: prodPlan,
      storyId: 'story-9',
      scope: 'story',
      uuid: () => 'job-xyz',
    });
    expect(r).toEqual({ enqueued: true, jobId: 'job-xyz' });
    // stamp + put == 2 sends.
    expect(ddb.send).toHaveBeenCalledTimes(2);
  });

  it('returns no-inserter when neither createJob nor ddb is available', async () => {
    const r = await enqueueStoryReflector({
      plan: prodPlan,
      storyId: 'story-9',
      scope: 'story',
      uuid: () => 'job-xyz',
    });
    expect(r).toEqual({ enqueued: false, reason: 'no-inserter' });
  });

  it('is non-throwing and returns an enqueue-failed reason when createJob throws', async () => {
    const createJob = vi.fn(async () => {
      throw new Error('ddb down');
    });
    const r = await enqueueStoryReflector({
      ddb: passThroughDdb(),
      plan: prodPlan,
      storyId: 'story-9',
      scope: 'story',
      createJob,
      uuid: () => 'job-xyz',
    });
    expect(r.enqueued).toBe(false);
    expect(r.reason).toContain('enqueue-failed');
  });

  it('wave-scope stamps the plan row with a wave-specific key', async () => {
    const ddb = passThroughDdb();
    await enqueueStoryReflector({
      ddb,
      plan: prodPlan,
      scope: 'wave',
      waveNumber: 3,
      uuid: () => 'job-w3',
      deps: { plansTable: 'test-plans' },
    });
    const stamp = ddb.calls[0].input;
    expect(stamp.TableName).toBe('test-plans');
    expect(stamp.Key).toEqual({ planId: 'plan-1' });
    expect(stamp.ExpressionAttributeNames['#k']).toBe('reflectorWave3FiredAt');
  });
});
