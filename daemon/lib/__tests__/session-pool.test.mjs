import { describe, it, expect } from 'vitest';
import {
  SessionPool,
  CapacitySaturated,
  CapacityTimeout,
} from '../session-pool.mjs';

function pool(opts = {}) {
  return new SessionPool({
    maxTotal: 2,
    maxInteractiveReserved: 1,
    interactiveTimeoutMs: 50,
    criticalTimeoutMs: 50,
    ...opts,
  });
}

describe('SessionPool — basic acquire/release', () => {
  it('admits up to maxTotal background tokens immediately', async () => {
    const sp = pool({ maxTotal: 3, maxInteractiveReserved: 1 });
    const t1 = await sp.acquire('background', { jobId: 'a' });
    const t2 = await sp.acquire('background', { jobId: 'b' });
    expect(t1.id).not.toBe(t2.id);
    expect(sp.predict().slotsByClass.background.used).toBe(2);
  });

  it('releases free a slot for the next waiter', async () => {
    const sp = pool({ maxTotal: 2, maxInteractiveReserved: 0 });
    const t1 = await sp.acquire('background', { jobId: 'a' });
    const t2 = await sp.acquire('background', { jobId: 'b' });
    const pending = sp.acquire('background', { jobId: 'c' });
    setTimeout(() => sp.release(t1), 10);
    const t3 = await pending;
    expect(t3.id).toBeDefined();
    expect(sp.predict().slotsByClass.background.used).toBe(2);
    sp.release(t2);
    sp.release(t3);
  });
});

describe('SessionPool — interactive reserve', () => {
  it('honors the interactive reserved slot even when background fills the rest', async () => {
    const sp = pool({ maxTotal: 2, maxInteractiveReserved: 1 });
    const bg = await sp.acquire('background', { jobId: 'bg' });
    // background can take only maxTotal - reserved = 1 slot.
    expect(sp.predict().slotsByClass.background.used).toBe(1);
    const it1 = await sp.acquire('interactive', { jobId: 'it1' });
    expect(it1).toBeTruthy();
    sp.release(bg);
    sp.release(it1);
  });

  it('rejects a second interactive request with CapacitySaturated after timeout when reserve full and pool full', async () => {
    const sp = pool({ maxTotal: 2, maxInteractiveReserved: 1, interactiveTimeoutMs: 30 });
    const it1 = await sp.acquire('interactive', { jobId: 'it1' });
    const cr1 = await sp.acquire('critical', { jobId: 'cr1' });
    // pool full now. A second interactive will queue and timeout.
    await expect(sp.acquire('interactive', { jobId: 'it2' })).rejects.toBeInstanceOf(
      CapacitySaturated,
    );
    sp.release(it1);
    sp.release(cr1);
  });
});

describe('SessionPool — critical priority over background', () => {
  it('does not admit background while a critical is waiting', async () => {
    const sp = pool({ maxTotal: 2, maxInteractiveReserved: 1 });
    const it1 = await sp.acquire('interactive', { jobId: 'it1' });
    const cr1 = await sp.acquire('critical', { jobId: 'cr1' });
    // pool full. Queue a critical, then a background.
    const cr2Promise = sp.acquire('critical', { jobId: 'cr2' });
    const bgPromise = sp.acquire('background', { jobId: 'bg1' });
    // Free one slot.
    sp.release(cr1);
    // The critical should be the next admitted, not the background.
    const cr2 = await cr2Promise;
    expect(cr2.class).toBe('critical');
    sp.release(it1);
    sp.release(cr2);
    // Now background should admit.
    const bg = await bgPromise;
    expect(bg.class).toBe('background');
    sp.release(bg);
  });

  it('background waits indefinitely (no timeout)', async () => {
    const sp = pool({
      maxTotal: 1,
      maxInteractiveReserved: 0,
      criticalTimeoutMs: 30,
    });
    const a = await sp.acquire('background', { jobId: 'a' });
    let resolved = false;
    sp.acquire('background', { jobId: 'b' }).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(resolved).toBe(false);
    sp.release(a);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(true);
  });
});

describe('SessionPool — critical timeout', () => {
  it('rejects critical with CapacityTimeout after the configured wait', async () => {
    const sp = pool({ maxTotal: 1, maxInteractiveReserved: 0, criticalTimeoutMs: 30 });
    const a = await sp.acquire('background', { jobId: 'a' });
    await expect(sp.acquire('critical', { jobId: 'cr-late' })).rejects.toBeInstanceOf(
      CapacityTimeout,
    );
    sp.release(a);
  });
});

describe('SessionPool — predict snapshot', () => {
  it('returns counts and queue snapshot', async () => {
    const sp = pool({ maxTotal: 2, maxInteractiveReserved: 1 });
    const it = await sp.acquire('interactive', { jobId: 'i' });
    const bg = await sp.acquire('background', { jobId: 'b' });
    sp.acquire('background', { jobId: 'b2' }); // queues
    const snapshot = sp.predict();
    expect(snapshot.ceiling).toBe(2);
    expect(snapshot.slotsByClass.interactive.used).toBe(1);
    expect(snapshot.slotsByClass.background.used).toBe(1);
    expect(snapshot.queueDepth).toBe(1);
    expect(snapshot.queued[0].jobId).toBe('b2');
    sp.release(it);
    sp.release(bg);
  });
});

describe('SessionPool — restart recovery', () => {
  it('registerExisting reconstitutes a token without re-acquiring', () => {
    const sp = pool({ maxTotal: 4, maxInteractiveReserved: 1 });
    const t = sp.registerExisting('background', { jobId: 'restored' });
    expect(t.class).toBe('background');
    expect(sp.predict().slotsByClass.background.used).toBe(1);
  });
});

describe('SessionPool — promoteQueued (Story 6.3)', () => {
  it('moves a waiting job from background to critical and reorders the queue', async () => {
    const sp = pool({ maxTotal: 1, maxInteractiveReserved: 0 });
    const active = await sp.acquire('background', { jobId: 'active' });
    sp.acquire('background', { jobId: 'b1' }); // pending
    sp.acquire('background', { jobId: 'b2' }); // pending
    expect(sp.promoteQueued('b2', 'background', 'critical')).toBe(true);
    sp.release(active);
    // After release, b2 (now critical) should drain before b1.
    await new Promise((r) => setTimeout(r, 10));
    const snap = sp.predict();
    expect(snap.activeTokens[0]?.jobId).toBe('b2');
  });
});

describe('SessionPool — events', () => {
  it('emits slot_freed on release', async () => {
    const sp = pool({ maxTotal: 1, maxInteractiveReserved: 0 });
    const t = await sp.acquire('background', { jobId: 'a' });
    let got;
    sp.on('slot_freed', (payload) => {
      got = payload;
    });
    sp.release(t);
    expect(got).toBeTruthy();
    expect(got.slotClass).toBe('background');
  });
});
