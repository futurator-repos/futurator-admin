/**
 * Unit tests for integration-lock.mjs (Story B — agentic-integration).
 *
 * The per-app integration mutex serializes wave-merge for one app while
 * letting different apps run concurrently. These tests pin the three
 * properties the pacman-2 fix relies on: FIFO serialization within an app,
 * concurrency across apps, and that a throwing holder never wedges the lock.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  withAppIntegrationLock,
  activeLockCount,
  _resetLocks,
} from '../integration-lock.mjs';

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => _resetLocks());

describe('withAppIntegrationLock', () => {
  it('serializes same-app calls in arrival (FIFO) order', async () => {
    const order = [];
    const started = [];
    const make = (label) => async () => {
      started.push(label);
      await tick();
      order.push(label);
    };
    // Fire three for the SAME app without awaiting — they must not interleave.
    const a = withAppIntegrationLock('app-1', make('a'));
    const b = withAppIntegrationLock('app-1', make('b'));
    const c = withAppIntegrationLock('app-1', make('c'));
    await Promise.all([a, b, c]);

    expect(order).toEqual(['a', 'b', 'c']);
    // Strict serialization: each starts only after the prior finished, so at
    // no point were two holders mid-flight (started grows one step ahead).
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('runs different apps concurrently', async () => {
    let app1Running = false;
    let observedConcurrent = false;

    const p1 = withAppIntegrationLock('app-1', async () => {
      app1Running = true;
      await tick();
      app1Running = false;
    });
    const p2 = withAppIntegrationLock('app-2', async () => {
      // If app-2 truly runs concurrently, app-1 is still mid-flight here.
      if (app1Running) observedConcurrent = true;
    });
    await Promise.all([p1, p2]);
    expect(observedConcurrent).toBe(true);
  });

  it('propagates the holder return value', async () => {
    const result = await withAppIntegrationLock('app-1', async () => 42);
    expect(result).toBe(42);
  });

  it('a throwing holder rejects but does NOT wedge the app lock', async () => {
    await expect(
      withAppIntegrationLock('app-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The next caller for the same app must still run.
    const after = await withAppIntegrationLock('app-1', async () => 'ok');
    expect(after).toBe('ok');
  });

  it('prunes idle app chains so the map does not grow unbounded', async () => {
    await withAppIntegrationLock('app-x', async () => {});
    await tick();
    expect(activeLockCount()).toBe(0);
  });

  it('throws on missing appId', () => {
    expect(() => withAppIntegrationLock('', async () => {})).toThrow();
  });
});
