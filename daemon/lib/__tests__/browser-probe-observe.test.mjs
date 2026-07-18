import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runObserveStep, runBrowserJourney } from '../browser-probe-executor.mjs';

// SLICE A1 (design Q1) — observe-step executor. An observe step navigates,
// settles, and captures ONE frame; no actions, no assertions.

const fastWait = async () => {};

// A fake Playwright/page that spies on navigation, settle, and screenshot, and
// records call order so we can prove "no action, exactly one frame".
function fakeObservePlaywright({ currentUrl } = {}) {
  const order = [];
  const page = {
    _url: currentUrl,
    calls: { gotos: [], settles: [], screenshots: 0, order },
    url: () => page._url,
    goto: async (u) => { page._url = u; page.calls.gotos.push(u); order.push(`goto:${u}`); },
    waitForTimeout: async (ms) => { page.calls.settles.push(ms); order.push(`settle:${ms}`); },
    keyboard: { press: async () => order.push('act:key'), down: async () => order.push('act:down') },
    evaluate: async () => { order.push('act:evaluate'); return {}; },
    screenshot: async () => { page.calls.screenshots += 1; order.push(`shot:${page.calls.screenshots}`); return Buffer.from(`obs-frame-${page.calls.screenshots}`); },
  };
  const browser = { newPage: async () => page, close: async () => { order.push('close'); } };
  return { pw: { chromium: { launch: async () => { order.push('launch'); return browser; } } }, page, browser };
}

describe('runObserveStep — standalone (launches its own browser)', () => {
  const URL = 'https://dev.futurator.ai/plans/p-1';

  it('navigates, settles the declared window, captures exactly one "after" frame, no actions/assertions', async () => {
    const { pw, page } = fakeObservePlaywright();
    const r = await runObserveStep({
      url: URL,
      step: { acId: 'obs-ac1', spec: 'maze walls render', settleMs: 1200 },
      playwright: pw,
    });
    assert.equal(r.ok, true);
    assert.equal(r.observe, true);
    assert.equal(Buffer.isBuffer(r.frames.after), true);
    assert.equal(r.frames.after.toString(), 'obs-frame-1');
    assert.equal(r.acId, 'obs-ac1');
    // Exactly ONE frame, and NO action was replayed (no key/evaluate/down).
    assert.equal(page.calls.screenshots, 1);
    assert.deepEqual(page.calls.settles, [1200]);
    assert.deepEqual(page.calls.gotos, [URL]);
    assert.deepEqual(page.calls.order, ['launch', `goto:${URL}`, 'settle:1200', 'shot:1', 'close']);
    // No assertion machinery / no drive action ran.
    assert.equal(page.calls.order.some((o) => o.startsWith('act:')), false);
  });

  it('defaults the settle to 1200ms when the step omits settleMs', async () => {
    const { pw, page } = fakeObservePlaywright();
    await runObserveStep({ url: URL, step: { acId: 'a' }, playwright: pw });
    assert.deepEqual(page.calls.settles, [1200]);
  });

  it('honours an explicit settleMs override arg when the step carries none', async () => {
    const { pw, page } = fakeObservePlaywright();
    await runObserveStep({ url: URL, step: { acId: 'a' }, settleMs: 500, playwright: pw });
    assert.deepEqual(page.calls.settles, [500]);
  });

  it('reports an infra failure (never a fabricated frame) when playwright is unavailable', async () => {
    const r = await runObserveStep({ url: URL, step: { acId: 'a' }, playwright: {} });
    assert.equal(r.ok, false);
    assert.equal(r.observe, true);
    assert.equal(r.infra, true);
    assert.equal(r.frames, undefined);
  });

  it('handles the CommonJS dynamic-import shape (chromium on .default)', async () => {
    const { pw } = fakeObservePlaywright();
    const r = await runObserveStep({ url: URL, step: { acId: 'a' }, playwright: { default: pw } });
    assert.equal(r.ok, true);
    assert.equal(Buffer.isBuffer(r.frames.after), true);
  });

  it('returns an infra failure (not a crash) when screenshot throws', async () => {
    const { pw, page } = fakeObservePlaywright();
    page.screenshot = async () => { throw new Error('render context lost'); };
    const r = await runObserveStep({ url: URL, step: { acId: 'a' }, playwright: pw });
    assert.equal(r.ok, false);
    assert.equal(r.infra, true);
    assert.match(r.detail, /render context lost/);
  });
});

describe('runObserveStep — reuse an already-open page', () => {
  const URL = 'https://dev.futurator.ai/plans/p-1';

  it('does NOT re-navigate when the page is already at the journey URL', async () => {
    const { page } = fakeObservePlaywright({ currentUrl: URL });
    const r = await runObserveStep({ url: URL, step: { acId: 'a', settleMs: 800 }, page });
    assert.equal(r.ok, true);
    assert.deepEqual(page.calls.gotos, []); // already there — no goto
    assert.deepEqual(page.calls.settles, [800]);
    assert.equal(page.calls.screenshots, 1);
  });

  it('navigates when the reused page is at a different URL', async () => {
    const { page } = fakeObservePlaywright({ currentUrl: 'https://dev.futurator.ai/other' });
    await runObserveStep({ url: URL, step: { acId: 'a' }, page });
    assert.deepEqual(page.calls.gotos, [URL]);
  });
});

// Backward-compat guard: existing runBrowserJourney callers pass steps WITHOUT
// `kind` and must behave exactly as before (this slice adds no observe handling
// to runBrowserJourney; it stays a pure action/assertion driver).
describe('runBrowserJourney — unchanged for kind-less steps (backward compat)', () => {
  function fakeJourneyPlaywright({ snapshots = [{}] } = {}) {
    let snapCalls = 0;
    const page = {
      calls: { keys: [] },
      goto: async () => {},
      waitForFunction: async () => {},
      keyboard: { press: async (k) => page.calls.keys.push(k), down: async () => {}, up: async () => {} },
      waitForTimeout: async () => {},
      locator: () => ({ count: async () => 0, first: () => ({ click: async () => {} }) }),
      screenshot: async () => Buffer.from('x'),
      evaluate: async (_fn, arg) => {
        if (arg && arg.__settle) return undefined;
        if (arg && arg.k) return undefined;
        if (arg && arg.m) return undefined;
        return snapshots[Math.min(snapCalls++, snapshots.length - 1)];
      },
    };
    const browser = { newPage: async () => page, close: async () => {} };
    return { pw: { chromium: { launch: async () => browser } }, page };
  }

  it('still drives a plain action step and passes on a matching snapshot', async () => {
    const { pw, page } = fakeJourneyPlaywright({ snapshots: [{ status: 'running' }, { status: 'running' }] });
    const r = await runBrowserJourney({
      url: 'https://dev.futurator.ai/plans/p-1',
      steps: [{ label: 'start', action: { type: 'key', key: 'Space' }, assertions: [{ field: 'status', op: 'eq', value: 'running' }] }],
      playwright: pw,
      wait: fastWait,
    });
    assert.equal(r.passed, true);
    assert.deepEqual(page.calls.keys, ['Space']);
  });
});
