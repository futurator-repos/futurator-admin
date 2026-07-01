import { describe, it, expect } from 'vitest';
import { parseProbe, runBrowserProbe, makeBrowserExecutor } from '../browser-probe-executor.mjs';

// The two real dino2 "Wire game loop" behavioral ACs.
const AC_RUN = {
  when: 'The user presses Space and 2 seconds of game time elapse',
  thenObservable: 'snapshot.status equals \'running\' and snapshot.score is greater than 0',
};
const AC_OVER = {
  when: 'The harness forces status to \'over\'',
  thenObservable: 'snapshot.status equals \'over\' and snapshot.gameOver is true',
};

describe('parseProbe', () => {
  it('parses the Space→running probe (ordered actions + assertions)', () => {
    const p = parseProbe(AC_RUN);
    expect(p.interpretable).toBe(true);
    expect(p.actions).toEqual([
      { type: 'key', key: 'Space' },
      { type: 'wait', ms: 2000 },
    ]);
    expect(p.assertions).toEqual([
      { field: 'status', op: 'eq', value: 'running' },
      { field: 'score', op: 'gt', value: 0 },
    ]);
  });

  it('parses the forceStatus(over)→game-over probe', () => {
    const p = parseProbe(AC_OVER);
    expect(p.interpretable).toBe(true);
    expect(p.actions).toEqual([{ type: 'harness', method: 'forceStatus', args: ['over'] }]);
    expect(p.assertions).toEqual([
      { field: 'status', op: 'eq', value: 'over' },
      { field: 'gameOver', op: 'eq', value: true },
    ]);
  });

  it('is not interpretable when there is no snapshot assertion', () => {
    const p = parseProbe({ when: 'press Space', thenObservable: 'the screen looks nice and polished' });
    expect(p.interpretable).toBe(false);
    expect(p.reason).toMatch(/no snapshot assertion/);
  });
});

// ── Fake Playwright ─────────────────────────────────────────────────────────

function fakePlaywright({ snapshots = [{}], harnessMounted = true } = {}) {
  let calls = 0;
  const page = {
    calls: { keys: [], harness: [], waits: 0 },
    goto: async () => {},
    waitForFunction: async () => {
      if (!harnessMounted) throw new Error('timeout');
    },
    keyboard: { press: async (k) => page.calls.keys.push(k) },
    waitForTimeout: async () => { page.calls.waits += 1; },
    evaluate: async (fn, arg) => {
      // harness action calls pass an arg object; snapshot() calls pass none.
      if (arg && arg.m) { page.calls.harness.push([arg.m, arg.args]); return undefined; }
      return snapshots[Math.min(calls++, snapshots.length - 1)];
    },
  };
  const browser = { newPage: async () => page, close: async () => {} };
  return { pw: { chromium: { launch: async () => browser } }, page };
}

describe('runBrowserProbe', () => {
  it('passes when the snapshot satisfies every assertion', async () => {
    const { pw, page } = fakePlaywright({ snapshots: [{ status: 'running', score: 42 }] });
    const r = await runBrowserProbe({
      url: 'http://127.0.0.1:3000/',
      actions: [{ type: 'key', key: 'Space' }, { type: 'wait', ms: 2000 }],
      assertions: [{ field: 'status', op: 'eq', value: 'running' }, { field: 'score', op: 'gt', value: 0 }],
      playwright: pw,
    });
    expect(r.passed).toBe(true);
    expect(page.calls.keys).toEqual(['Space']);
    expect(page.calls.waits).toBe(1);
  });

  it('fails and names the offending field when the snapshot is wrong', async () => {
    const { pw } = fakePlaywright({ snapshots: [{ status: 'idle', score: 0 }] });
    const r = await runBrowserProbe({
      url: 'http://127.0.0.1:3000/',
      actions: [],
      assertions: [{ field: 'status', op: 'eq', value: 'running' }, { field: 'score', op: 'gt', value: 0 }],
      playwright: pw,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/snapshot\.status/);
    expect(r.detail).toMatch(/snapshot\.score/);
  });

  it('runs a harness action then asserts (forceStatus → over)', async () => {
    const { pw, page } = fakePlaywright({ snapshots: [{ status: 'over', gameOver: true }] });
    const r = await runBrowserProbe({
      url: 'http://127.0.0.1:3000/',
      actions: [{ type: 'harness', method: 'forceStatus', args: ['over'] }],
      assertions: [{ field: 'status', op: 'eq', value: 'over' }, { field: 'gameOver', op: 'eq', value: true }],
      playwright: pw,
    });
    expect(r.passed).toBe(true);
    expect(page.calls.harness).toEqual([['forceStatus', ['over']]]);
  });

  it('fails closed when the __harness seam is not mounted', async () => {
    const { pw } = fakePlaywright({ harnessMounted: false });
    const r = await runBrowserProbe({
      url: 'http://127.0.0.1:3000/',
      actions: [],
      assertions: [{ field: 'status', op: 'eq', value: 'running' }],
      playwright: pw,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/__harness seam not mounted/);
  });
});

describe('makeBrowserExecutor', () => {
  const qaContext = { defaultPort: 3000, healthcheckPath: '/' };
  const okBoot = { bootDevServer: async () => ({ ok: true, port: 3000, stop: async () => {} }), drainPort: async () => {} };

  it('fails closed when no qaContext (cannot serve the app)', async () => {
    const exec = makeBrowserExecutor({ cwd: '/w', qaContext: undefined });
    const r = await exec(AC_RUN);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no qaContext/);
  });

  it('fails closed on an uninterpretable probe (no fake-pass)', async () => {
    const exec = makeBrowserExecutor({ cwd: '/w', qaContext, deps: { ...okBoot, playwright: fakePlaywright().pw } });
    const r = await exec({ when: 'do a thing', thenObservable: 'it looks good' });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not interpretable/);
  });

  it('boots, probes, and passes on the happy path', async () => {
    const { pw } = fakePlaywright({ snapshots: [{ status: 'running', score: 7 }] });
    const exec = makeBrowserExecutor({ cwd: '/w', qaContext, deps: { ...okBoot, playwright: pw } });
    const r = await exec(AC_RUN);
    expect(r.passed).toBe(true);
  });

  it('fails closed when the dev server will not boot', async () => {
    const exec = makeBrowserExecutor({
      cwd: '/w',
      qaContext,
      deps: { bootDevServer: async () => ({ ok: false, status: '000', stop: async () => {} }), drainPort: async () => {}, playwright: fakePlaywright().pw },
    });
    const r = await exec(AC_RUN);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/did not boot/);
  });
});
