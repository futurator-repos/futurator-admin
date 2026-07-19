import { describe, it, expect } from 'vitest';
import {
  parseProbe,
  runBrowserProbe,
  makeBrowserExecutor,
  runBrowserJourney,
  codeFor,
  focusApp,
  settleFrames,
  pollUntil,
  OBSERVE_ONLY_NOTE,
  classifyProbeFailure,
  findDirtyBasePathConfig,
  revertDirtyBasePathConfig,
} from '../browser-probe-executor.mjs';

// A no-op poll/settle clock so failing-poll windows don't spend real time.
const fastWait = async () => {};

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

  it('handles the CommonJS dynamic-import shape (chromium on .default)', async () => {
    const { pw } = fakePlaywright({ snapshots: [{ status: 'running', score: 42 }] });
    // Real `await import('playwright')` puts chromium on `.default`, not top-level.
    const r = await runBrowserProbe({
      url: 'http://127.0.0.1:3000/',
      actions: [],
      assertions: [{ field: 'status', op: 'eq', value: 'running' }],
      playwright: { default: pw },
    });
    expect(r.passed).toBe(true);
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

// ── Fake Playwright — journey variant (adds a screenshot() spy + call order) ─

function fakePlaywrightJourney({ snapshots = [{}], harnessMounted = true } = {}) {
  let snapCalls = 0;
  let shotCalls = 0;
  const order = [];
  const page = {
    gotoUrl: undefined,
    calls: { keys: [], harness: [], waits: 0, screenshots: 0, order },
    goto: async (url) => {
      page.gotoUrl = url;
    },
    waitForFunction: async () => {
      if (!harnessMounted) throw new Error('timeout');
    },
    keyboard: {
      press: async (k) => { page.calls.keys.push(k); order.push(`act:key:${k}`); },
      down: async (k) => { page.calls.down.push(k); order.push(`act:down:${k}`); },
      up: async (k) => { page.calls.up.push(k); order.push(`act:up:${k}`); },
    },
    waitForTimeout: async () => { page.calls.waits += 1; order.push('act:wait'); },
    screenshot: async () => {
      shotCalls += 1;
      page.calls.screenshots = shotCalls;
      order.push(`shot:${shotCalls}`);
      return Buffer.from(`frame-${shotCalls}`);
    },
    evaluate: async (fn, arg) => {
      // settleFrames marks its arg with __settle — it advances rAF, never a
      // snapshot read, so it must NOT consume the snapshot sequence.
      if (arg && arg.__settle) return undefined;
      // redispatchKey passes { k, c } (a synthetic KeyboardEvent) — not a read.
      if (arg && arg.k) { page.calls.redispatch += 1; order.push(`act:redispatch:${arg.k}`); return undefined; }
      if (arg && arg.m) { page.calls.harness.push([arg.m, arg.args]); order.push(`act:harness:${arg.m}`); return undefined; }
      return snapshots[Math.min(snapCalls++, snapshots.length - 1)];
    },
  };
  page.calls.down = [];
  page.calls.up = [];
  page.calls.redispatch = 0;
  const browser = { newPage: async () => page, close: async () => {} };
  return { pw: { chromium: { launch: async () => browser } }, page };
}

describe('runBrowserJourney', () => {
  const REMOTE_URL = 'https://dev.futurator.ai/plans/p-42';

  it('goes to the injected REMOTE url (no localhost, no dev-server boot)', async () => {
    const { pw, page } = fakePlaywrightJourney({ snapshots: [{ status: 'running' }] });
    const r = await runBrowserJourney({
      url: REMOTE_URL,
      steps: [{ label: 'start', action: { type: 'key', key: 'Space' }, assertions: [{ field: 'status', op: 'eq', value: 'running' }] }],
      playwright: pw,
    });
    expect(page.gotoUrl).toBe(REMOTE_URL);
    expect(page.gotoUrl).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(r.passed).toBe(true);
  });

  it('captures before/act/after frames in order, per step, only when capture:true', async () => {
    // TWO evaluate() calls per step now (the BEFORE-action snapshot feeds delta
    // assertions + the after snapshot): [beforeS1, afterS1, beforeS2, afterS2].
    const { pw, page } = fakePlaywrightJourney({
      snapshots: [
        { status: 'idle', score: 0 },
        { status: 'running', score: 5 },
        { status: 'running', score: 5 },
        { status: 'over', gameOver: true },
      ],
    });
    const steps = [
      { label: 'press Space', action: { type: 'key', key: 'Space' }, assertions: [{ field: 'status', op: 'eq', value: 'running' }] },
      { label: 'force over', action: { type: 'harness', method: 'forceStatus', args: ['over'] }, assertions: [{ field: 'gameOver', op: 'eq', value: true }] },
    ];
    const r = await runBrowserJourney({ url: REMOTE_URL, steps, playwright: pw, capture: true });

    expect(r.passed).toBe(true);
    expect(page.calls.order).toEqual([
      'shot:1', 'act:key:Space', 'shot:2',
      'shot:3', 'act:harness:forceStatus', 'shot:4',
    ]);
    expect(r.frames).toHaveLength(2);
    expect(r.frames[0].stepLabel).toBe('press Space');
    expect(Buffer.isBuffer(r.frames[0].before)).toBe(true);
    expect(Buffer.isBuffer(r.frames[0].after)).toBe(true);
    expect(r.frames[0].before.toString()).toBe('frame-1');
    expect(r.frames[0].after.toString()).toBe('frame-2');
    expect(r.frames[1].stepLabel).toBe('force over');
    expect(r.frames[1].before.toString()).toBe('frame-3');
    expect(r.frames[1].after.toString()).toBe('frame-4');
  });

  it('does not capture frames when capture is omitted (default false)', async () => {
    const { pw, page } = fakePlaywrightJourney({ snapshots: [{ status: 'running' }] });
    const r = await runBrowserJourney({
      url: REMOTE_URL,
      steps: [{ label: 'press Space', action: { type: 'key', key: 'Space' }, assertions: [{ field: 'status', op: 'eq', value: 'running' }] }],
      playwright: pw,
    });
    expect(r.frames).toEqual([]);
    expect(page.calls.screenshots).toBe(0);
  });

  it('fails closed when the __harness seam is not mounted — but still captures frames (DOM-fallback)', async () => {
    const { pw, page } = fakePlaywrightJourney({ harnessMounted: false });
    const r = await runBrowserJourney({
      url: REMOTE_URL,
      steps: [{ label: 'press Space', action: { type: 'key', key: 'Space' }, assertions: [] }],
      playwright: pw,
      capture: true,
    });
    // Deterministic verdict unchanged: seam missing = real app failure, blocks.
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/__harness seam not mounted/);
    // NEW (VQA power): actions still replay + frames still captured so Lane 2
    // and the operator get visual evidence instead of zero artifacts.
    expect(r.frames).toHaveLength(1);
    expect(Buffer.isBuffer(r.frames[0].before)).toBe(true);
    expect(Buffer.isBuffer(r.frames[0].after)).toBe(true);
    expect(page.calls.order).toContain('act:key:Space');
  });

  it('fails and names the offending step when a step assertion is wrong (never fake-passes)', async () => {
    const { pw } = fakePlaywrightJourney({ snapshots: [{ status: 'idle' }] });
    const r = await runBrowserJourney({
      url: REMOTE_URL,
      steps: [{ label: 'press Space', action: { type: 'key', key: 'Space' }, assertions: [{ field: 'status', op: 'eq', value: 'running' }] }],
      playwright: pw,
      wait: fastWait,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/press Space/);
    expect(r.detail).toMatch(/snapshot\.status/);
  });

  it('handles the CommonJS dynamic-import shape (chromium on .default)', async () => {
    const { pw } = fakePlaywrightJourney({ snapshots: [{ status: 'running' }] });
    const r = await runBrowserJourney({
      url: REMOTE_URL,
      steps: [{ label: 'noop', assertions: [{ field: 'status', op: 'eq', value: 'running' }] }],
      playwright: { default: pw },
    });
    expect(r.passed).toBe(true);
  });
});

describe('VQA power vocabulary (2026-07-04)', () => {
  it('parses clicks by quoted text and by named button', () => {
    const p = parseProbe({ when: 'The user clicks "Start Game" and then clicks the restart button', thenObservable: 'snapshot.status equals running' });
    expect(p.actions).toEqual([
      { type: 'click', target: 'Start Game' },
      { type: 'click', target: 'restart' },
    ]);
    expect(p.interpretable).toBe(true);
  });

  it('parses typing into a named field', () => {
    const p = parseProbe({ when: 'types "ricardo" into the name field', thenObservable: 'snapshot.player equals ricardo' });
    expect(p.actions).toEqual([{ type: 'type', text: 'ricardo', target: 'name' }]);
  });

  it('parses delta assertions (increases/changes) and deep paths', () => {
    const p = parseProbe({ when: 'presses ArrowUp', thenObservable: 'snapshot.score increases and snapshot.pacman.dir changes' });
    expect(p.assertions).toEqual([
      { field: 'score', op: 'increased' },
      { field: 'pacman.dir', op: 'changed' },
    ]);
  });

  it('falls back to a CHANGED-delta when a snapshot path is named without an operator (pacman3 class)', () => {
    const p = parseProbe({ when: 'pressing a direction key', thenObservable: "snapshot.entities for pacman reflects the new heading" });
    expect(p.interpretable).toBe(true);
    expect(p.assertions).toEqual([{ field: 'entities', op: 'changed' }]);
  });

  it('at least / is not operators parse', () => {
    const p = parseProbe({ when: 'press Space', thenObservable: 'snapshot.lives is at least 1 and snapshot.status is not idle' });
    expect(p.assertions).toEqual([
      { field: 'lives', op: 'gte', value: 1 },
      { field: 'status', op: 'ne', value: 'idle' },
    ]);
  });

  it('parses a HELD key (hold ArrowRight → { hold:true })', () => {
    const p = parseProbe({ when: 'The user holds ArrowRight', thenObservable: 'snapshot.x increases' });
    expect(p.actions).toEqual([{ type: 'key', key: 'ArrowRight', hold: true }]);
  });
});

// ── T9b: canvas-game hardening — codeFor / focusApp / settleFrames / pollUntil ─

describe('codeFor (pure KeyboardEvent.code map)', () => {
  it('maps arrows, space, letters, digits; passes named keys through', () => {
    expect(codeFor('ArrowUp')).toBe('ArrowUp');
    expect(codeFor('ArrowRight')).toBe('ArrowRight');
    expect(codeFor('Space')).toBe('Space');
    expect(codeFor(' ')).toBe('Space');
    expect(codeFor('a')).toBe('KeyA');
    expect(codeFor('X')).toBe('KeyX');
    expect(codeFor('5')).toBe('Digit5');
    expect(codeFor('Enter')).toBe('Enter');
    expect(codeFor('')).toBe('');
  });
});

describe('focusApp', () => {
  function fakeLocatorPage({ canvasCount }) {
    const clicks = [];
    const page = {
      clicks,
      locator: (sel) => ({
        count: async () => (sel === 'canvas' ? canvasCount : 1),
        first: () => ({ click: async () => clicks.push(sel) }),
      }),
    };
    return page;
  }

  it('clicks the canvas when one is present', async () => {
    const page = fakeLocatorPage({ canvasCount: 1 });
    expect(await focusApp(page)).toBe('canvas');
    expect(page.clicks).toEqual(['canvas']);
  });

  it('falls back to clicking the body when there is no canvas', async () => {
    const page = fakeLocatorPage({ canvasCount: 0 });
    expect(await focusApp(page)).toBe('body');
    expect(page.clicks).toEqual(['body']);
  });

  it('no-ops (returns none) on a page without locator', async () => {
    expect(await focusApp({})).toBe('none');
  });
});

describe('settleFrames', () => {
  it('advances rAF via page.evaluate with an __settle-marked arg', async () => {
    let seenArg;
    const page = { evaluate: async (_fn, arg) => { seenArg = arg; } };
    await settleFrames(page, 12);
    expect(seenArg).toEqual({ __settle: 12 });
  });

  it('falls back to the injected wait when page.evaluate throws', async () => {
    let waited = 0;
    const page = { evaluate: async () => { throw new Error('no rAF here'); } };
    await settleFrames(page, 4, { wait: async (ms) => { waited = ms; } });
    expect(waited).toBe(4 * 16);
  });

  it('is a no-op for zero/absent frames', async () => {
    let called = false;
    const page = { evaluate: async () => { called = true; } };
    await settleFrames(page, 0);
    expect(called).toBe(false);
  });
});

describe('pollUntil', () => {
  it('passes as soon as the assertion holds (value changes on the 3rd read)', async () => {
    let n = 0;
    const readFn = async () => ++n; // 1, 2, 3, …
    const assertFn = (v) => ({ ok: v >= 3, failures: v >= 3 ? [] : [`got ${v}`] });
    const r = await pollUntil(readFn, assertFn, { timeoutMs: 1000, stepMs: 100, wait: fastWait });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(3);
  });

  it('fails after the window when the value never satisfies the assertion', async () => {
    const readFn = async () => 0;
    const assertFn = (v) => ({ ok: false, failures: [`stuck at ${v}`] });
    const r = await pollUntil(readFn, assertFn, { timeoutMs: 300, stepMs: 100, wait: fastWait });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['stuck at 0']);
  });
});

// ── T9d: observe-only — DRIVE lane refused, INPUT lane preserved ────────────

describe('runBrowserJourney — observeOnly', () => {
  const REMOTE = 'https://dev.futurator.ai/plans/p-obs';

  it('observeOnly:true does NOT replay a harness DRIVE action (drops it)', async () => {
    const { pw, page } = fakePlaywrightJourney({ snapshots: [{ status: 'idle' }] });
    await runBrowserJourney({
      url: REMOTE,
      steps: [{ label: 'force over', action: { type: 'harness', method: 'forceStatus', args: ['over'] }, assertions: [] }],
      playwright: pw,
      observeOnly: true,
      wait: fastWait,
    });
    expect(page.calls.harness).toEqual([]); // the drive lane was refused
  });

  it('observeOnly:false (default for direct journeys) DOES replay a harness action', async () => {
    const { pw, page } = fakePlaywrightJourney({ snapshots: [{ status: 'over' }, { status: 'over' }] });
    await runBrowserJourney({
      url: REMOTE,
      steps: [{ label: 'force over', action: { type: 'harness', method: 'forceStatus', args: ['over'] }, assertions: [{ field: 'status', op: 'eq', value: 'over' }] }],
      playwright: pw,
      wait: fastWait,
    });
    expect(page.calls.harness).toEqual([['forceStatus', ['over']]]);
  });

  it('exports the observe-only note constant', () => {
    expect(OBSERVE_ONLY_NOTE).toMatch(/observe-only/);
  });
});

// ── R3 infra-attempt protection ─────────────────────────────────────────────

describe('classifyProbeFailure', () => {
  it('classifies a boot-result object with status=000', () => {
    expect(classifyProbeFailure({ ok: false, status: '000' })).toEqual({ infra: true, reason: 'boot-000' });
  });

  it('classifies a boot-result object with status=404', () => {
    expect(classifyProbeFailure({ ok: false, status: '404' })).toEqual({ infra: true, reason: 'boot-404' });
  });

  it('classifies a boot-result object with status=squatter', () => {
    expect(classifyProbeFailure({ ok: false, status: 'squatter' })).toEqual({ infra: true, reason: 'port-squatter' });
  });

  it('classifies the executor\'s own "did not boot (status=000)" detail string', () => {
    expect(classifyProbeFailure('dev server did not boot (status=000)')).toEqual({ infra: true, reason: 'boot-000' });
  });

  it('classifies the executor\'s own "did not boot (status=404)" detail string', () => {
    expect(classifyProbeFailure('dev server did not boot (status=404)')).toEqual({ infra: true, reason: 'boot-404' });
  });

  it('classifies a probe result object with a boot-404 detail', () => {
    expect(classifyProbeFailure({ passed: false, detail: 'dev server did not boot (status=404)' })).toEqual({ infra: true, reason: 'boot-404' });
  });

  it('classifies a Playwright navigation timeout as infra', () => {
    expect(classifyProbeFailure('browser probe error: page.goto: Timeout 30000ms exceeded')).toEqual({ infra: true, reason: 'boot-timeout' });
  });

  it('classifies a Playwright ACTION/LOCATOR timeout as an APP failure, NOT infra (R2 unwired control)', () => {
    // runBrowserJourney pushes `<label>: action failed: <playwright error>` — an
    // unwired control the AC drives times out waiting for the locator. That is a
    // real defect and must CONSUME an attempt, not earn free infra retries.
    expect(
      classifyProbeFailure(
        "story-ac: action failed: locator.click: Timeout 30000ms exceeded.\nwaiting for locator('button:has-text(\"Start\")')",
      ),
    ).toEqual({ infra: false, reason: 'app-fail' });
  });

  it('classifies a getByRole timeout (no boot signal) as an app failure', () => {
    expect(
      classifyProbeFailure({ passed: false, detail: 'getByRole timed out waiting for the Start button' }),
    ).toEqual({ infra: false, reason: 'app-fail' });
  });

  it('classifies an unrecognized non-boot status as an app failure, NOT infra', () => {
    expect(classifyProbeFailure({ ok: false, status: '500' })).toEqual({ infra: false, reason: 'app-fail' });
  });

  it('classifies a named assertion failure as an app failure', () => {
    expect(classifyProbeFailure({ passed: false, detail: 'snapshot.status expected \'running\' got \'idle\'' })).toEqual({ infra: false, reason: 'app-fail' });
  });

  it('classifies "seam not mounted" as an app failure (real integration gap, not infra)', () => {
    expect(classifyProbeFailure('__harness seam not mounted')).toEqual({ infra: false, reason: 'app-fail' });
  });
});

describe('findDirtyBasePathConfig / revertDirtyBasePathConfig', () => {
  it('finds and reverts an uncommitted next.config.ts declaring a basePath', async () => {
    const calls = [];
    const shell = async (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith('git status --porcelain -- next.config.ts')) return { stdout: ' M next.config.ts\n' };
      if (cmd.startsWith('cat next.config.ts')) return { stdout: "module.exports = { basePath: '/snake-classic-feda6e' }" };
      if (cmd.startsWith('git checkout --')) return { stdout: '' };
      return { stdout: '' };
    };
    const file = await findDirtyBasePathConfig({ cwd: '/w', shell });
    expect(file).toBe('next.config.ts');

    const log = [];
    const reverted = await revertDirtyBasePathConfig({ cwd: '/w', shell, log: (m) => log.push(m) });
    expect(reverted).toBe(true);
    expect(calls).toContain('git checkout -- next.config.ts');
    expect(log[0]).toMatch(/dirty-config: reverting uncommitted basePath/);
  });

  it('does NOT revert a committed basePath (git status clean)', async () => {
    const shell = async (cmd) => {
      if (cmd.startsWith('git status --porcelain')) return { stdout: '' }; // clean
      if (cmd.startsWith('cat next.config.ts')) return { stdout: "basePath: '/x'" };
      return { stdout: '' };
    };
    const file = await findDirtyBasePathConfig({ cwd: '/w', shell });
    expect(file).toBeNull();
    const reverted = await revertDirtyBasePathConfig({ cwd: '/w', shell });
    expect(reverted).toBe(false);
  });

  it('does NOT revert a COMMITTED basePath even when the file is dirty for another reason', async () => {
    // The working copy declares a basePath (matches the regex) AND is dirty — but
    // HEAD already declares that basePath, so it is real committed app config, not
    // the deploy job's leftover mutation. Reverting would neither remove it nor be
    // safe (it would discard the unrelated uncommitted edit). Must be a no-op.
    const calls = [];
    const shell = async (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith('git status --porcelain -- next.config.ts')) return { stdout: ' M next.config.ts\n' };
      if (cmd.startsWith('cat next.config.ts')) return { stdout: "module.exports = { basePath: '/app', reactStrictMode: false }" };
      if (cmd.startsWith('git show HEAD:./next.config.ts')) return { stdout: "module.exports = { basePath: '/app', reactStrictMode: true }" };
      return { stdout: '' };
    };
    const file = await findDirtyBasePathConfig({ cwd: '/w', shell });
    expect(file).toBeNull();
    const reverted = await revertDirtyBasePathConfig({ cwd: '/w', shell });
    expect(reverted).toBe(false);
    expect(calls.some((c) => c.startsWith('git checkout --'))).toBe(false);
  });

  it('does NOT revert an uncommitted config with no basePath (unrelated dirt)', async () => {
    const shell = async (cmd) => {
      if (cmd.startsWith('git status --porcelain -- next.config.ts')) return { stdout: ' M next.config.ts\n' };
      if (cmd.startsWith('cat next.config.ts')) return { stdout: 'module.exports = { reactStrictMode: true }' };
      return { stdout: '' };
    };
    const reverted = await revertDirtyBasePathConfig({ cwd: '/w', shell });
    expect(reverted).toBe(false);
  });

  it('fails open on a shell error (never throws)', async () => {
    const shell = async () => { throw new Error('boom'); };
    const reverted = await revertDirtyBasePathConfig({ cwd: '/w', shell });
    expect(reverted).toBe(false);
  });
});

describe('makeBrowserExecutor — 404-at-root dirty-config guard', () => {
  const qaContext = { defaultPort: 3000, healthcheckPath: '/' };

  it('reverts a dirty basePath on a 404 boot and retries the boot exactly ONCE', async () => {
    const { pw } = fakePlaywright({ snapshots: [{ status: 'running', score: 7 }] });
    let bootCalls = 0;
    const bootDevServer = async () => {
      bootCalls += 1;
      if (bootCalls === 1) return { ok: false, status: '404', stop: async () => {} };
      return { ok: true, port: 3000, stop: async () => {} };
    };
    const shellCalls = [];
    const shell = async (cmd) => {
      shellCalls.push(cmd);
      if (cmd.startsWith('git status --porcelain -- next.config.ts')) return { stdout: ' M next.config.ts\n' };
      if (cmd.startsWith('cat next.config.ts')) return { stdout: "basePath: '/x'" };
      return { stdout: '' };
    };
    const exec = makeBrowserExecutor({
      cwd: '/w',
      qaContext,
      deps: { bootDevServer, drainPort: async () => {}, shell, playwright: pw },
    });
    const r = await exec(AC_RUN);
    expect(r.passed).toBe(true);
    expect(bootCalls).toBe(2); // exactly one retry
    expect(shellCalls).toContain('git checkout -- next.config.ts');
  });

  it('does NOT retry the boot when there is no dirty basePath (plain 404)', async () => {
    let bootCalls = 0;
    const bootDevServer = async () => {
      bootCalls += 1;
      return { ok: false, status: '404', stop: async () => {} };
    };
    const shell = async (cmd) => ({ stdout: '' }); // no dirty config anywhere
    const exec = makeBrowserExecutor({
      cwd: '/w',
      qaContext,
      deps: { bootDevServer, drainPort: async () => {}, shell, playwright: fakePlaywright().pw },
    });
    const r = await exec(AC_RUN);
    expect(r.passed).toBe(false);
    expect(bootCalls).toBe(1); // no retry — nothing to fix
    expect(r.detail).toMatch(/status=404/);
  });

  it('does NOT touch the 000/squatter no-boot path (guard is 404-only)', async () => {
    let bootCalls = 0;
    const bootDevServer = async () => {
      bootCalls += 1;
      return { ok: false, status: '000', stop: async () => {} };
    };
    const shell = async () => ({ stdout: ' M next.config.ts\n' }); // even if dirty, 000 is not 404
    const exec = makeBrowserExecutor({
      cwd: '/w',
      qaContext,
      deps: { bootDevServer, drainPort: async () => {}, shell, playwright: fakePlaywright().pw },
    });
    const r = await exec(AC_RUN);
    expect(bootCalls).toBe(1);
    expect(r.detail).toMatch(/status=000/);
  });
});
