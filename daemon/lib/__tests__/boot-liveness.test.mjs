import { describe, it, expect } from 'vitest';
import { defaultLivenessInputs, snapshotDelta, runBootLiveness } from '../boot-liveness.mjs';

describe('defaultLivenessInputs (pure)', () => {
  it('returns the fixed ordered battery: 4 keys then a first-button click', () => {
    expect(defaultLivenessInputs()).toEqual([
      { type: 'key', key: 'ArrowRight' },
      { type: 'key', key: 'Space' },
      { type: 'key', key: 'Enter' },
      { type: 'key', key: 'ArrowDown' },
      { type: 'click', target: '__first_button__' },
    ]);
  });
});

describe('snapshotDelta (pure)', () => {
  it('is false for structurally equal snapshots', () => {
    expect(snapshotDelta({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(false);
  });
  it('is true when any field differs', () => {
    expect(snapshotDelta({ a: 1 }, { a: 2 })).toBe(true);
  });
  it('is true when shape differs', () => {
    expect(snapshotDelta({}, { a: 1 })).toBe(true);
  });
});

// ── Fake Playwright (mirrors browser-probe-executor.test.mjs fake-page) ───────
function fakePlaywright({ snapshots = [{}], harnessMounted = true } = {}) {
  let snapCalls = 0;
  const clickable = { click: async () => { page.calls.clicks += 1; } };
  const locator = { first: () => clickable, count: async () => 1 };
  const page = {
    calls: { keys: [], clicks: 0 },
    goto: async () => {},
    waitForFunction: async () => {
      if (!harnessMounted) throw new Error('timeout');
    },
    keyboard: { press: async (k) => page.calls.keys.push(k) },
    getByRole: () => locator,
    getByText: () => locator,
    locator: () => locator,
    // snapshot() is the only evaluate() caller here; clamp to the last snapshot.
    evaluate: async () => snapshots[Math.min(snapCalls++, snapshots.length - 1)],
  };
  const browser = { newPage: async () => page, close: async () => {} };
  return { pw: { chromium: { launch: async () => browser } }, page };
}

describe('runBootLiveness', () => {
  it('fails closed when chromium is unavailable', async () => {
    const r = await runBootLiveness({ url: 'http://x', playwright: {} });
    expect(r.passed).toBe(false);
    expect(r.seamMounted).toBe(false);
    expect(r.detail).toMatch(/chromium unavailable/);
  });

  it('fails closed when the __harness seam is not mounted', async () => {
    const { pw } = fakePlaywright({ harnessMounted: false });
    const r = await runBootLiveness({ url: 'http://x', playwright: pw });
    expect(r.passed).toBe(false);
    expect(r.seamMounted).toBe(false);
    expect(r.detail).toMatch(/seam not mounted/);
  });

  it('fails closed when no input produces a state delta (inert app)', async () => {
    // Every snapshot identical → no delta across all inputs.
    const { pw, page } = fakePlaywright({ snapshots: [{ status: 'idle' }] });
    const r = await runBootLiveness({ url: 'http://x', playwright: pw });
    expect(r.passed).toBe(false);
    expect(r.seamMounted).toBe(true);
    expect(r.detail).toMatch(/no synthetic input produced an observable state delta/);
    // All five inputs were replayed (4 keys + 1 click) before failing closed.
    expect(page.calls.keys).toEqual(['ArrowRight', 'Space', 'Enter', 'ArrowDown']);
    expect(page.calls.clicks).toBe(1);
  });

  it('passes on the first input that moves state, and stops there', async () => {
    // before = {}, after first key = { x: 1 } → delta on input #1.
    const { pw, page } = fakePlaywright({ snapshots: [{}, { x: 1 }] });
    const r = await runBootLiveness({ url: 'http://x', playwright: pw });
    expect(r.passed).toBe(true);
    expect(r.seamMounted).toBe(true);
    expect(r.before).toEqual({});
    expect(r.after).toEqual({ x: 1 });
    // Stopped after the first key — no further inputs replayed.
    expect(page.calls.keys).toEqual(['ArrowRight']);
    expect(page.calls.clicks).toBe(0);
  });

  it('handles the CommonJS dynamic-import shape (chromium on .default)', async () => {
    const { pw } = fakePlaywright({ snapshots: [{}, { x: 1 }] });
    const r = await runBootLiveness({ url: 'http://x', playwright: { default: pw } });
    expect(r.passed).toBe(true);
  });

  it('fails closed on a launch/navigation error', async () => {
    const pw = { chromium: { launch: async () => { throw new Error('boom'); } } };
    const r = await runBootLiveness({ url: 'http://x', playwright: pw });
    expect(r.passed).toBe(false);
    expect(r.seamMounted).toBe(false);
    expect(r.detail).toMatch(/boot-liveness error: boom/);
  });
});
