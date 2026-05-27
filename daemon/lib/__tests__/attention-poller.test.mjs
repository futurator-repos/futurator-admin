import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runAttentionPollerTick,
  composeAttentionPromptBody,
  POLLER_ELIGIBLE_POLICIES,
  ATTENTION_POLLER_INTERVAL_MS,
} from '../attention-poller.mjs';

/**
 * 2026-05-27 PR D.b — attention poller unit tests.
 *
 * Coverage:
 *   - paused: tick is a no-op
 *   - manual policy: items skipped
 *   - auto-draft policy: spawns session
 *   - auto-fix policy: spawns session with autoFix=true metadata
 *   - per-item remediationPolicy override beats category default
 *   - items with agentSessionId already set: skipped
 *   - claim returns null (race): skipped without spawn
 *   - enqueue failure is logged + counted
 *   - composeAttentionPromptBody includes id/severity/category/title/body
 *     + optional context block
 */

function fakeDeps(overrides = {}) {
  return {
    isPaused: vi.fn(async () => false),
    scanOpenItems: vi.fn(async () => []),
    getPolicy: vi.fn(async () => 'manual'),
    claimForAgent: vi.fn(async () => ({ ok: true })),
    enqueueSession: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POLLER_ELIGIBLE_POLICIES', () => {
  it('includes auto-draft and auto-fix; excludes manual', () => {
    expect(POLLER_ELIGIBLE_POLICIES.has('auto-draft')).toBe(true);
    expect(POLLER_ELIGIBLE_POLICIES.has('auto-fix')).toBe(true);
    expect(POLLER_ELIGIBLE_POLICIES.has('manual')).toBe(false);
  });
});

describe('ATTENTION_POLLER_INTERVAL_MS', () => {
  it('is 30s per §7.4', () => {
    expect(ATTENTION_POLLER_INTERVAL_MS).toBe(30_000);
  });
});

describe('runAttentionPollerTick', () => {
  it('no-ops when the daemon is paused', async () => {
    const deps = fakeDeps({ isPaused: vi.fn(async () => true) });
    const result = await runAttentionPollerTick(deps);
    expect(result).toEqual({ spawned: 0, skipped: 0, reason: 'paused' });
    expect(deps.scanOpenItems).not.toHaveBeenCalled();
  });

  it('skips items with manual policy', async () => {
    const deps = fakeDeps({
      scanOpenItems: vi.fn(async () => [
        { planId: 'p1', itemId: 'i1', category: 'test-gate-failed' },
      ]),
      getPolicy: vi.fn(async () => 'manual'),
    });
    const result = await runAttentionPollerTick(deps);
    expect(result.spawned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.claimForAgent).not.toHaveBeenCalled();
    expect(deps.enqueueSession).not.toHaveBeenCalled();
  });

  it('spawns a session for an auto-draft item', async () => {
    const deps = fakeDeps({
      scanOpenItems: vi.fn(async () => [
        { planId: 'p1', itemId: 'i1', category: 'test-gate-failed', title: 'X' },
      ]),
      getPolicy: vi.fn(async () => 'auto-draft'),
      claimForAgent: vi.fn(async () => ({ planId: 'p1', itemId: 'i1' })),
    });
    const result = await runAttentionPollerTick(deps);
    expect(result.spawned).toBe(1);
    const enqueueArgs = deps.enqueueSession.mock.calls[0][0];
    expect(enqueueArgs.autoFix).toBe(false);
    expect(enqueueArgs.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(enqueueArgs.item).toMatchObject({ planId: 'p1', itemId: 'i1' });
  });

  it('spawns a session with autoFix=true for an auto-fix item', async () => {
    const deps = fakeDeps({
      scanOpenItems: vi.fn(async () => [
        { planId: 'p1', itemId: 'i1', category: 'low-risk-test-flake' },
      ]),
      getPolicy: vi.fn(async () => 'auto-fix'),
      claimForAgent: vi.fn(async () => ({ planId: 'p1', itemId: 'i1' })),
    });
    const result = await runAttentionPollerTick(deps);
    expect(result.spawned).toBe(1);
    expect(deps.enqueueSession.mock.calls[0][0].autoFix).toBe(true);
  });

  it('per-item remediationPolicy beats category default', async () => {
    const deps = fakeDeps({
      scanOpenItems: vi.fn(async () => [
        {
          planId: 'p1',
          itemId: 'i1',
          category: 'test-gate-failed',
          remediationPolicy: 'auto-draft',
        },
      ]),
      // Category default = manual; per-item override wins
      getPolicy: vi.fn(async () => 'manual'),
      claimForAgent: vi.fn(async () => ({ planId: 'p1', itemId: 'i1' })),
    });
    const result = await runAttentionPollerTick(deps);
    expect(result.spawned).toBe(1);
    // getPolicy never called because per-item override short-circuited
    expect(deps.getPolicy).not.toHaveBeenCalled();
  });

  it('skips items that already have an agentSessionId', async () => {
    const deps = fakeDeps({
      scanOpenItems: vi.fn(async () => [
        {
          planId: 'p1',
          itemId: 'i1',
          category: 'test-gate-failed',
          remediationPolicy: 'auto-draft',
          agentSessionId: 'sid-already-running',
        },
      ]),
    });
    const result = await runAttentionPollerTick(deps);
    expect(result.spawned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.claimForAgent).not.toHaveBeenCalled();
  });

  it('skips when claimForAgent returns null (race lost)', async () => {
    const deps = fakeDeps({
      scanOpenItems: vi.fn(async () => [
        {
          planId: 'p1',
          itemId: 'i1',
          category: 'x',
          remediationPolicy: 'auto-draft',
        },
      ]),
      claimForAgent: vi.fn(async () => null),
    });
    const result = await runAttentionPollerTick(deps);
    expect(result.spawned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.enqueueSession).not.toHaveBeenCalled();
  });

  it('counts an enqueueSession throw as not-spawned but logs the error', async () => {
    const deps = fakeDeps({
      scanOpenItems: vi.fn(async () => [
        {
          planId: 'p1',
          itemId: 'i1',
          category: 'x',
          remediationPolicy: 'auto-draft',
        },
      ]),
      claimForAgent: vi.fn(async () => ({ planId: 'p1', itemId: 'i1' })),
      enqueueSession: vi.fn(async () => {
        throw new Error('DDB throttled');
      }),
    });
    const result = await runAttentionPollerTick(deps);
    expect(result.spawned).toBe(0);
    expect(deps.log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('DDB throttled'),
    );
  });

  it('processes multiple items in one tick', async () => {
    const deps = fakeDeps({
      scanOpenItems: vi.fn(async () => [
        { planId: 'p1', itemId: 'i1', category: 'x', remediationPolicy: 'auto-draft' },
        { planId: 'p1', itemId: 'i2', category: 'y', remediationPolicy: 'auto-fix' },
        { planId: 'p1', itemId: 'i3', category: 'z' }, // policy resolves to manual
      ]),
      getPolicy: vi.fn(async () => 'manual'),
      claimForAgent: vi.fn(async (args) => ({ planId: args.planId, itemId: args.itemId })),
    });
    const result = await runAttentionPollerTick(deps);
    expect(result.spawned).toBe(2);
    expect(result.skipped).toBe(1);
  });
});

describe('composeAttentionPromptBody', () => {
  it('includes every documented field', () => {
    const body = composeAttentionPromptBody({
      itemId: 'item-1',
      planId: 'plan-x',
      severity: 'high',
      category: 'retry-exhausted',
      title: 'A specific failure',
      body: 'The wave failed because…',
      context: { jobId: 'job-1', storyId: 'st-1' },
    });
    expect(body).toContain('item-1');
    expect(body).toContain('plan-x');
    expect(body).toContain('high');
    expect(body).toContain('retry-exhausted');
    expect(body).toContain('A specific failure');
    expect(body).toContain('The wave failed because');
    expect(body).toContain('job-1');
    expect(body).toContain('st-1');
  });

  it('handles missing optional fields cleanly', () => {
    const body = composeAttentionPromptBody({
      itemId: 'item-1',
      planId: 'plan-x',
      severity: 'low',
      category: 'other',
      title: 'X',
      body: '',
    });
    expect(body).toContain('_(no body)_');
    expect(body).not.toContain('### Context');
  });
});
