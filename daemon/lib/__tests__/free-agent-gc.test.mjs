import { describe, it, expect, vi } from 'vitest';

import { runFreeAgentGc } from '../free-agent-gc.mjs';

const NOW = new Date('2026-05-17T12:00:00Z').getTime();
const NINE_DAYS_AGO = new Date(NOW - 9 * 24 * 60 * 60 * 1000).toISOString();
const SIX_DAYS_AGO = new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString();

function silentLogger() {
  return vi.fn();
}

describe('runFreeAgentGc — empty filesystem (AC #6)', () => {
  it('no-ops when no worktrees exist', async () => {
    const result = await runFreeAgentGc({
      listProjectWorktrees: () => [],
      querySessionsScan: async () => [],
      reapFn: vi.fn(),
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result).toEqual({
      reapedCount: 0,
      orphansRemoved: 0,
      kept: 0,
      errors: 0,
    });
  });
});

describe('runFreeAgentGc — reap policy (AC #6)', () => {
  it('reaps a 7+ day IDLE session', async () => {
    const reapFn = vi.fn().mockResolvedValue(undefined);
    const worktrees = [
      { projectId: 'dino', sessionId: 'sess-old', worktreePath: '/wt/dino/sess-old' },
    ];
    const sessions = [{ sessionId: 'sess-old', status: 'IDLE', lastActivityAt: NINE_DAYS_AGO }];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.reapedCount).toBe(1);
    expect(result.kept).toBe(0);
    expect(reapFn).toHaveBeenCalledWith({ projectId: 'dino', sessionId: 'sess-old' });
  });

  it('does NOT reap a 6-day-old IDLE session (under threshold)', async () => {
    const reapFn = vi.fn();
    const worktrees = [
      { projectId: 'dino', sessionId: 'sess-young', worktreePath: '/wt/dino/sess-young' },
    ];
    const sessions = [{ sessionId: 'sess-young', status: 'IDLE', lastActivityAt: SIX_DAYS_AGO }];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.reapedCount).toBe(0);
    expect(result.kept).toBe(1);
    expect(reapFn).not.toHaveBeenCalled();
  });

  it('NEVER reaps an ACTIVE session regardless of age (AC #6)', async () => {
    const reapFn = vi.fn();
    const worktrees = [
      { projectId: 'dino', sessionId: 'sess-active', worktreePath: '/wt/dino/sess-active' },
    ];
    const sessions = [
      { sessionId: 'sess-active', status: 'ACTIVE', lastActivityAt: NINE_DAYS_AGO },
    ];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.reapedCount).toBe(0);
    expect(result.kept).toBe(1);
    expect(reapFn).not.toHaveBeenCalled();
  });

  it('NEVER reaps a PROCESSING session regardless of age', async () => {
    const reapFn = vi.fn();
    const sessions = [
      { sessionId: 'sess-proc', status: 'PROCESSING', lastActivityAt: NINE_DAYS_AGO },
    ];
    const worktrees = [
      { projectId: 'dino', sessionId: 'sess-proc', worktreePath: '/wt/dino/sess-proc' },
    ];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.kept).toBe(1);
    expect(reapFn).not.toHaveBeenCalled();
  });

  it('reaps a 7+ day EXPIRED session', async () => {
    const reapFn = vi.fn().mockResolvedValue(undefined);
    const sessions = [{ sessionId: 's1', status: 'EXPIRED', lastActivityAt: NINE_DAYS_AGO }];
    const worktrees = [{ projectId: 'p', sessionId: 's1', worktreePath: '/wt/p/s1' }];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.reapedCount).toBe(1);
  });

  it('reaps a 7+ day BUDGET_EXHAUSTED session', async () => {
    const reapFn = vi.fn().mockResolvedValue(undefined);
    const sessions = [
      { sessionId: 's1', status: 'BUDGET_EXHAUSTED', lastActivityAt: NINE_DAYS_AGO },
    ];
    const worktrees = [{ projectId: 'p', sessionId: 's1', worktreePath: '/wt/p/s1' }];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.reapedCount).toBe(1);
  });

  it('keeps a session with unknown/other status (defensive)', async () => {
    const reapFn = vi.fn();
    const sessions = [{ sessionId: 's1', status: 'WHATEVER', lastActivityAt: NINE_DAYS_AGO }];
    const worktrees = [{ projectId: 'p', sessionId: 's1', worktreePath: '/wt/p/s1' }];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.kept).toBe(1);
    expect(reapFn).not.toHaveBeenCalled();
  });
});

describe('runFreeAgentGc — orphan handling (AC #6)', () => {
  it('removes a worktree with no corresponding DDB row', async () => {
    const reapFn = vi.fn().mockResolvedValue(undefined);
    const worktrees = [
      { projectId: 'dino', sessionId: 'orphan-1', worktreePath: '/wt/dino/orphan-1' },
    ];
    // No matching session row.

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => [],
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.orphansRemoved).toBe(1);
    expect(result.reapedCount).toBe(0);
    expect(reapFn).toHaveBeenCalledWith({ projectId: 'dino', sessionId: 'orphan-1' });
  });

  it('treats all worktrees as orphans when the DDB scan throws (pre-18.2 path)', async () => {
    const reapFn = vi.fn().mockResolvedValue(undefined);
    const worktrees = [
      { projectId: 'p1', sessionId: 's1', worktreePath: '/wt/p1/s1' },
      { projectId: 'p2', sessionId: 's2', worktreePath: '/wt/p2/s2' },
    ];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => {
        throw new Error('ResourceNotFoundException: table not found');
      },
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.orphansRemoved).toBe(2);
    expect(reapFn).toHaveBeenCalledTimes(2);
  });
});

describe('runFreeAgentGc — error handling', () => {
  it('counts and surfaces reap failures without aborting the sweep', async () => {
    const reapFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('git failed'))
      .mockResolvedValueOnce(undefined);
    const worktrees = [
      { projectId: 'p1', sessionId: 's1', worktreePath: '/wt/p1/s1' },
      { projectId: 'p2', sessionId: 's2', worktreePath: '/wt/p2/s2' },
    ];
    const sessions = [
      { sessionId: 's1', status: 'IDLE', lastActivityAt: NINE_DAYS_AGO },
      { sessionId: 's2', status: 'IDLE', lastActivityAt: NINE_DAYS_AGO },
    ];

    const result = await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.reapedCount).toBe(1);
    expect(result.errors).toBe(1);
    expect(reapFn).toHaveBeenCalledTimes(2);
  });

  it('handles listProjectWorktrees throwing (early-exit with errors=1)', async () => {
    const result = await runFreeAgentGc({
      listProjectWorktrees: () => {
        throw new Error('readdir EACCES');
      },
      querySessionsScan: async () => [],
      reapFn: vi.fn(),
      now: () => NOW,
      logFn: silentLogger(),
    });

    expect(result.errors).toBe(1);
    expect(result.reapedCount).toBe(0);
  });
});

describe('runFreeAgentGc — summary event emission (AC #6)', () => {
  it('logs a free-agent-gc.run summary message after the sweep', async () => {
    const logFn = vi.fn();
    const worktrees = [
      { projectId: 'p', sessionId: 'orphan', worktreePath: '/wt/p/orphan' },
      { projectId: 'p', sessionId: 'kept', worktreePath: '/wt/p/kept' },
      { projectId: 'p', sessionId: 'reap', worktreePath: '/wt/p/reap' },
    ];
    const sessions = [
      { sessionId: 'kept', status: 'ACTIVE', lastActivityAt: NINE_DAYS_AGO },
      { sessionId: 'reap', status: 'IDLE', lastActivityAt: NINE_DAYS_AGO },
    ];
    const reapFn = vi.fn().mockResolvedValue(undefined);

    await runFreeAgentGc({
      listProjectWorktrees: () => worktrees,
      querySessionsScan: async () => sessions,
      reapFn,
      now: () => NOW,
      logFn,
    });

    const summaryCall = logFn.mock.calls.find((call) => call[1] === 'free-agent-gc.run');
    expect(summaryCall).toBeDefined();
    expect(summaryCall[2]).toMatchObject({
      reapedCount: 1,
      orphansRemoved: 1,
      kept: 1,
    });
  });
});
