import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { startCancelPoller } from '../cancel-poller.mjs';

/**
 * Story 19.2 AC 7 — 4 unit tests for the shared cancel-poller module.
 *
 * Scenarios:
 *   1. Happy path: child exits cleanly, stop() clears flag, isCancelled() = false.
 *   2. Cancel path: cancelRequested flips true, SIGTERM fires, isCancelled() = true after stop().
 *   3. DDB read failure: poller continues, doesn't throw, doesn't SIGTERM erroneously.
 *   4. clearCancelFlag failure on stop: stop returns cleanly (warn-only), state intact.
 */

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeChild() {
  return { kill: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startCancelPoller — happy path (AC 1)', () => {
  it('does not SIGTERM child and clears flag on stop when cancelRequested stays false', async () => {
    const sessionsRepo = {
      getSession: vi.fn().mockResolvedValue({ cancelRequested: false }),
      clearCancelFlag: vi.fn().mockResolvedValue(undefined),
    };
    const child = makeChild();
    const logger = silentLogger();

    const poller = startCancelPoller({
      sessionsRepo,
      sessionId: 'sess-happy-12345678',
      child,
      logger,
      pollMs: 100,
      killGraceMs: 50,
    });

    // Advance through several poll ticks. The session row never flips.
    await vi.advanceTimersByTimeAsync(350);

    expect(child.kill).not.toHaveBeenCalled();
    expect(poller.isCancelled()).toBe(false);
    expect(sessionsRepo.getSession).toHaveBeenCalled();

    await poller.stop();

    expect(sessionsRepo.clearCancelFlag).toHaveBeenCalledWith('sess-happy-12345678');
    expect(poller.isCancelled()).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('startCancelPoller — cancel path (AC 2)', () => {
  it('SIGTERMs the child when cancelRequested flips true, then SIGKILLs after grace', async () => {
    let cancelRequested = false;
    const sessionsRepo = {
      getSession: vi.fn(async () => ({ cancelRequested })),
      clearCancelFlag: vi.fn().mockResolvedValue(undefined),
    };
    const child = makeChild();
    const logger = silentLogger();

    const poller = startCancelPoller({
      sessionsRepo,
      sessionId: 'sess-cancel-87654321',
      child,
      logger,
      pollMs: 100,
      killGraceMs: 200,
    });

    // First tick: cancelRequested still false. No kill.
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).not.toHaveBeenCalled();
    expect(poller.isCancelled()).toBe(false);

    // Operator hits Stop — flag flips.
    cancelRequested = true;

    // Next tick observes the flag.
    await vi.advanceTimersByTimeAsync(100);
    expect(poller.isCancelled()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // After grace, SIGKILL fires.
    await vi.advanceTimersByTimeAsync(200);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    // stop() always clears the flag — the bug-fix from §12.1.5.
    await poller.stop();
    expect(sessionsRepo.clearCancelFlag).toHaveBeenCalledWith('sess-cancel-87654321');
    // isCancelled() stays true after stop so the close-handler can branch on it.
    expect(poller.isCancelled()).toBe(true);
  });

  it('does not fire SIGTERM twice if multiple ticks see cancelRequested=true', async () => {
    const sessionsRepo = {
      getSession: vi.fn().mockResolvedValue({ cancelRequested: true }),
      clearCancelFlag: vi.fn().mockResolvedValue(undefined),
    };
    const child = makeChild();
    const logger = silentLogger();

    const poller = startCancelPoller({
      sessionsRepo,
      sessionId: 'sess-dup-aaaaaaaa',
      child,
      logger,
      pollMs: 50,
      killGraceMs: 500,
    });

    await vi.advanceTimersByTimeAsync(200); // 4 ticks
    // SIGTERM exactly once (the SIGKILL timer hasn't fired yet at 200ms < 500ms grace).
    const sigtermCalls = child.kill.mock.calls.filter((c) => c[0] === 'SIGTERM');
    expect(sigtermCalls.length).toBe(1);

    await poller.stop();
  });
});

describe('startCancelPoller — DDB read failure (AC 3)', () => {
  it('continues polling when getSession throws and never SIGTERMs erroneously', async () => {
    let callCount = 0;
    const sessionsRepo = {
      getSession: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) throw new Error('DDB ProvisionedThroughputExceededException');
        return { cancelRequested: false };
      }),
      clearCancelFlag: vi.fn().mockResolvedValue(undefined),
    };
    const child = makeChild();
    const logger = silentLogger();

    const poller = startCancelPoller({
      sessionsRepo,
      sessionId: 'sess-ddb-fail-deadbeef',
      child,
      logger,
      pollMs: 100,
      killGraceMs: 50,
    });

    // First tick throws — caught and logged.
    await vi.advanceTimersByTimeAsync(100);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('read failed'),
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(poller.isCancelled()).toBe(false);

    // Subsequent ticks return normally — poller didn't die.
    await vi.advanceTimersByTimeAsync(200);
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(child.kill).not.toHaveBeenCalled();
    expect(poller.isCancelled()).toBe(false);

    await poller.stop();
  });
});

describe('startCancelPoller — clearCancelFlag failure on stop (AC 4)', () => {
  it('stop() returns cleanly with a warn log when clearCancelFlag rejects', async () => {
    const sessionsRepo = {
      getSession: vi.fn().mockResolvedValue({ cancelRequested: false }),
      clearCancelFlag: vi.fn().mockRejectedValue(new Error('DDB throttle on clear')),
    };
    const child = makeChild();
    const logger = silentLogger();

    const poller = startCancelPoller({
      sessionsRepo,
      sessionId: 'sess-clear-fail-12121212',
      child,
      logger,
      pollMs: 100,
      killGraceMs: 50,
    });

    await vi.advanceTimersByTimeAsync(150);

    // stop() must NOT throw, even if clearCancelFlag rejects.
    await expect(poller.stop()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('clearCancelFlag failed'),
    );
    // isCancelled() state intact (was false, stays false).
    expect(poller.isCancelled()).toBe(false);
  });

  it('skips clearCancelFlag silently when repo does not implement it', async () => {
    const sessionsRepo = {
      getSession: vi.fn().mockResolvedValue({ cancelRequested: false }),
      // clearCancelFlag omitted — optional in the contract.
    };
    const child = makeChild();
    const logger = silentLogger();

    const poller = startCancelPoller({
      sessionsRepo,
      sessionId: 'sess-no-clear-fn-99999999',
      child,
      logger,
      pollMs: 100,
      killGraceMs: 50,
    });

    await vi.advanceTimersByTimeAsync(150);
    await expect(poller.stop()).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('startCancelPoller — input validation', () => {
  it('throws if sessionsRepo.getSession is missing', () => {
    expect(() =>
      startCancelPoller({
        sessionsRepo: {},
        sessionId: 'x',
        child: makeChild(),
        logger: silentLogger(),
      }),
    ).toThrow(/sessionsRepo\.getSession/);
  });

  it('throws if sessionId is missing', () => {
    expect(() =>
      startCancelPoller({
        sessionsRepo: { getSession: vi.fn() },
        sessionId: '',
        child: makeChild(),
        logger: silentLogger(),
      }),
    ).toThrow(/sessionId/);
  });

  it('throws if child is missing', () => {
    expect(() =>
      startCancelPoller({
        sessionsRepo: { getSession: vi.fn() },
        sessionId: 'x',
        child: undefined,
        logger: silentLogger(),
      }),
    ).toThrow(/child/);
  });
});
