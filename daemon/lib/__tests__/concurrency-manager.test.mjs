import { describe, it, expect, vi } from 'vitest';

import {
  ConcurrencyManager,
  classifyJob,
  isConcurrencyManagerEnabled,
} from '../concurrency-manager.mjs';

/**
 * Story 20.14 — ConcurrencyManager tests.
 *
 * Covers AC 10's scenarios:
 *   - Capacity (acquire 2, third blocks, release frees)
 *   - Priority: interactive jumps batch
 *   - Priority: interactive-among-interactives FIFO
 *   - Priority: batch-among-batches FIFO
 *   - Never preempts
 *   - Snapshot accuracy
 *   - Classifier coverage
 */

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeJob({ jobId, jobType = 'pipeline-v2-step', createdAt }) {
  return { jobId, jobType, createdAt };
}

describe('classifyJob — coverage of known jobTypes', () => {
  it('classifies free-agent-session as interactive', () => {
    expect(classifyJob({ jobType: 'free-agent-session' })).toBe('interactive');
  });
  it('classifies every party-* jobType as interactive', () => {
    expect(classifyJob({ jobType: 'party-turn' })).toBe('interactive');
    expect(classifyJob({ jobType: 'party-bootstrap' })).toBe('interactive');
    expect(classifyJob({ jobType: 'party-inspect' })).toBe('interactive');
    expect(classifyJob({ jobType: 'party-docs-sync' })).toBe('interactive');
    expect(classifyJob({ jobType: 'party-docs-unlink' })).toBe('interactive');
    expect(classifyJob({ jobType: 'party-refresh' })).toBe('interactive');
  });
  it('classifies pipeline-v2 + backend jobs as batch', () => {
    expect(classifyJob({ jobType: 'pipeline-v2-step' })).toBe('batch');
    expect(classifyJob({ jobType: 'wave-merge' })).toBe('batch');
    expect(classifyJob({ jobType: 'app-bootstrap' })).toBe('batch');
    expect(classifyJob({ jobType: 'skill-scout' })).toBe('batch');
    expect(classifyJob({ jobType: 'skill-install' })).toBe('batch');
    expect(classifyJob({ jobType: 'reflector' })).toBe('batch');
  });
  it('defaults unknown / undefined jobType to batch (fail-safe)', () => {
    expect(classifyJob({ jobType: 'mystery-new-type' })).toBe('batch');
    expect(classifyJob({})).toBe('batch');
    expect(classifyJob(null)).toBe('batch');
  });
});

describe('ConcurrencyManager — constructor validation', () => {
  it('throws on missing classifier', () => {
    expect(() => new ConcurrencyManager({})).toThrow(/classifier/);
  });
  it('throws on non-positive maxConcurrent', () => {
    expect(
      () => new ConcurrencyManager({ classifier: () => 'batch', maxConcurrent: 0 }),
    ).toThrow(/maxConcurrent/);
    expect(
      () => new ConcurrencyManager({ classifier: () => 'batch', maxConcurrent: -1 }),
    ).toThrow(/maxConcurrent/);
  });
});

describe('ConcurrencyManager — capacity (AC 10.1)', () => {
  it('acquires 2 jobs, blocks the 3rd, frees the 3rd after release', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    const a = makeJob({ jobId: 'a', createdAt: '2026-05-21T10:00:00Z' });
    const b = makeJob({ jobId: 'b', createdAt: '2026-05-21T10:01:00Z' });
    const c = makeJob({ jobId: 'c', createdAt: '2026-05-21T10:02:00Z' });

    expect(mgr.tryAcquire(a).acquired).toBe(true);
    expect(mgr.tryAcquire(b).acquired).toBe(true);
    expect(mgr.canAcquire()).toBe(false);
    const blocked = mgr.tryAcquire(c);
    expect(blocked.acquired).toBe(false);
    expect(blocked.reason).toBe('at-capacity');

    mgr.release('a');
    expect(mgr.canAcquire()).toBe(true);
    expect(mgr.tryAcquire(c).acquired).toBe(true);
  });

  it('respects custom maxConcurrent', () => {
    const mgr = new ConcurrencyManager({
      classifier: classifyJob,
      maxConcurrent: 1,
      logger: silentLogger(),
    });
    expect(mgr.tryAcquire(makeJob({ jobId: 'a', createdAt: 'now' })).acquired).toBe(true);
    expect(mgr.tryAcquire(makeJob({ jobId: 'b', createdAt: 'now' })).acquired).toBe(false);
  });

  it('is idempotent on re-acquiring the same jobId (returns acquired:true, no double-count)', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    const a = makeJob({ jobId: 'a', createdAt: 'x' });
    expect(mgr.tryAcquire(a).acquired).toBe(true);
    expect(mgr.tryAcquire(a).acquired).toBe(true);
    expect(mgr.activeCount).toBe(1);
  });
});

describe('ConcurrencyManager — release (AC 10.6)', () => {
  it('release of unknown jobId logs a warn and does not throw', () => {
    const logger = silentLogger();
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger });
    mgr.release('never-acquired');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('double-release'));
  });
});

describe('ConcurrencyManager.selectNext — priority (AC 10.2-10.4)', () => {
  it('interactive jumps batch even when older batch is pending', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    const olderBatch = makeJob({
      jobId: 'b1',
      jobType: 'pipeline-v2-step',
      createdAt: '2026-05-21T10:00:00Z',
    });
    const newerInteractive = makeJob({
      jobId: 'i1',
      jobType: 'party-turn',
      createdAt: '2026-05-21T10:05:00Z',
    });
    const r = mgr.selectNext([olderBatch, newerInteractive]);
    expect(r?.jobId).toBe('i1');
  });

  it('interactive-among-interactives picks the oldest', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    const older = makeJob({
      jobId: 'older',
      jobType: 'free-agent-session',
      createdAt: '2026-05-21T09:00:00Z',
    });
    const newer = makeJob({
      jobId: 'newer',
      jobType: 'party-turn',
      createdAt: '2026-05-21T10:00:00Z',
    });
    const r = mgr.selectNext([newer, older]);
    expect(r?.jobId).toBe('older');
  });

  it('batch-among-batches picks the oldest (FIFO unchanged)', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    const older = makeJob({ jobId: 'older', createdAt: '2026-05-21T09:00:00Z' });
    const newer = makeJob({ jobId: 'newer', createdAt: '2026-05-21T10:00:00Z' });
    const r = mgr.selectNext([newer, older]);
    expect(r?.jobId).toBe('older');
  });

  it('returns null for empty / non-array input', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    expect(mgr.selectNext([])).toBeNull();
    expect(mgr.selectNext(null)).toBeNull();
    expect(mgr.selectNext(undefined)).toBeNull();
  });

  it('selectNext is pure — does not mutate manager state', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    const before = mgr.activeCount;
    mgr.selectNext([
      makeJob({ jobId: 'x', jobType: 'party-turn', createdAt: 'now' }),
    ]);
    expect(mgr.activeCount).toBe(before);
  });
});

describe('ConcurrencyManager — never-preempts (AC 10.5)', () => {
  it('a RUNNING batch is NOT killed when an interactive arrives — interactive waits', () => {
    const mgr = new ConcurrencyManager({
      classifier: classifyJob,
      maxConcurrent: 1,
      logger: silentLogger(),
    });
    const batch = makeJob({ jobId: 'B', jobType: 'pipeline-v2-step', createdAt: '10:00' });
    const interactive = makeJob({ jobId: 'I', jobType: 'party-turn', createdAt: '10:05' });

    expect(mgr.tryAcquire(batch).acquired).toBe(true);
    // Now interactive arrives. selectNext would prefer it BUT capacity is full.
    const next = mgr.selectNext([interactive]);
    expect(next?.jobId).toBe('I');
    // tryAcquire blocks because batch is still RUNNING.
    expect(mgr.tryAcquire(interactive).acquired).toBe(false);
    // Snapshot still shows the batch occupying the slot.
    expect(mgr.getSnapshot().active.map((a) => a.jobId)).toEqual(['B']);
  });
});

describe('ConcurrencyManager — snapshot accuracy (AC 10.6)', () => {
  it('snapshot reflects acquire + release', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    const a = makeJob({ jobId: 'a', jobType: 'party-turn', createdAt: 'now' });
    const b = makeJob({ jobId: 'b', jobType: 'pipeline-v2-step', createdAt: 'now' });
    mgr.tryAcquire(a);
    mgr.tryAcquire(b);
    let snap = mgr.getSnapshot();
    expect(snap.maxConcurrent).toBe(2);
    expect(snap.active).toHaveLength(2);
    expect(snap.active.find((s) => s.jobId === 'a')?.jobClass).toBe('interactive');
    expect(snap.active.find((s) => s.jobId === 'b')?.jobClass).toBe('batch');

    mgr.release('a');
    snap = mgr.getSnapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0].jobId).toBe('b');
  });

  it('snapshot is a copy — mutating it does not affect internal state', () => {
    const mgr = new ConcurrencyManager({ classifier: classifyJob, logger: silentLogger() });
    mgr.tryAcquire(makeJob({ jobId: 'a', createdAt: 'now' }));
    const snap = mgr.getSnapshot();
    snap.active.push({ jobId: 'fake', jobClass: 'batch', startedAt: 'fake' });
    expect(mgr.getSnapshot().active).toHaveLength(1);
  });
});

describe('ConcurrencyManager — classifier failsafe (AC 10.7)', () => {
  it('warns + defaults to batch when classifier returns an unknown class', () => {
    const logger = silentLogger();
    const mgr = new ConcurrencyManager({
      classifier: () => 'mystery',
      logger,
    });
    mgr.tryAcquire(makeJob({ jobId: 'x', createdAt: 'now' }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown class'));
    expect(mgr.getSnapshot().active[0].jobClass).toBe('batch');
  });
});

describe('isConcurrencyManagerEnabled — AC 9 feature flag', () => {
  it('defaults to true when env var is unset', () => {
    const prev = process.env.PARTY_PUSH_CONCURRENCY_MANAGER;
    delete process.env.PARTY_PUSH_CONCURRENCY_MANAGER;
    expect(isConcurrencyManagerEnabled()).toBe(true);
    if (prev !== undefined) process.env.PARTY_PUSH_CONCURRENCY_MANAGER = prev;
  });
  it('returns false when env var = "0"', () => {
    const prev = process.env.PARTY_PUSH_CONCURRENCY_MANAGER;
    process.env.PARTY_PUSH_CONCURRENCY_MANAGER = '0';
    expect(isConcurrencyManagerEnabled()).toBe(false);
    if (prev !== undefined) process.env.PARTY_PUSH_CONCURRENCY_MANAGER = prev;
    else delete process.env.PARTY_PUSH_CONCURRENCY_MANAGER;
  });
  it('returns false when env var = "false"', () => {
    const prev = process.env.PARTY_PUSH_CONCURRENCY_MANAGER;
    process.env.PARTY_PUSH_CONCURRENCY_MANAGER = 'false';
    expect(isConcurrencyManagerEnabled()).toBe(false);
    if (prev !== undefined) process.env.PARTY_PUSH_CONCURRENCY_MANAGER = prev;
    else delete process.env.PARTY_PUSH_CONCURRENCY_MANAGER;
  });
});

// ── Queues module — classifier + runtime-settable cap (setMax) ──
describe('classifyJob — queue-request', () => {
  it('classifies queue-request as batch (shares the cap, no jump-ahead)', () => {
    expect(classifyJob({ jobType: 'queue-request' })).toBe('batch');
  });
});

describe('ConcurrencyManager.setMax — runtime-settable cap (Queues module)', () => {
  const classifier = () => 'batch';

  it('raises the ceiling and lets a previously-blocked job acquire', () => {
    const cm = new ConcurrencyManager({ maxConcurrent: 2, classifier, logger: silentLogger() });
    expect(cm.tryAcquire(makeJob({ jobId: 'a', createdAt: '1' })).acquired).toBe(true);
    expect(cm.tryAcquire(makeJob({ jobId: 'b', createdAt: '2' })).acquired).toBe(true);
    // At cap — third blocks.
    expect(cm.canAcquire()).toBe(false);
    expect(cm.setMax(3)).toBe(true);
    expect(cm.maxConcurrent).toBe(3);
    expect(cm.canAcquire()).toBe(true);
    expect(cm.tryAcquire(makeJob({ jobId: 'c', createdAt: '3' })).acquired).toBe(true);
  });

  it('lowering below the active count never preempts; drains as slots free', () => {
    const cm = new ConcurrencyManager({ maxConcurrent: 3, classifier, logger: silentLogger() });
    cm.tryAcquire(makeJob({ jobId: 'a', createdAt: '1' }));
    cm.tryAcquire(makeJob({ jobId: 'b', createdAt: '2' }));
    cm.tryAcquire(makeJob({ jobId: 'c', createdAt: '3' }));
    expect(cm.activeCount).toBe(3);
    cm.setMax(2); // below active — no preemption
    expect(cm.activeCount).toBe(3);
    expect(cm.canAcquire()).toBe(false);
    cm.release('a');
    expect(cm.activeCount).toBe(2);
    expect(cm.canAcquire()).toBe(false); // still at the new ceiling
    cm.release('b');
    expect(cm.canAcquire()).toBe(true);
  });

  it('rejects a non-positive / non-integer max and keeps the current ceiling', () => {
    const cm = new ConcurrencyManager({ maxConcurrent: 2, classifier, logger: silentLogger() });
    expect(cm.setMax(0)).toBe(false);
    expect(cm.setMax(-1)).toBe(false);
    expect(cm.setMax(2.5)).toBe(false);
    expect(cm.maxConcurrent).toBe(2);
  });

  it('is a no-op (returns false) when the value is unchanged', () => {
    const cm = new ConcurrencyManager({ maxConcurrent: 2, classifier, logger: silentLogger() });
    expect(cm.setMax(2)).toBe(false);
  });
});
