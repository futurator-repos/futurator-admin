import { describe, it, expect } from 'vitest';
import {
  isFoundationStory,
  evaluateFoundationGate,
  makeStoryDevGateDeps,
} from '../foundation-gate.mjs';

describe('isFoundationStory (pure)', () => {
  it('is true when isFoundation===true', () => {
    expect(isFoundationStory({ isFoundation: true })).toBe(true);
  });
  it('is true when nodeKind==="foundation"', () => {
    expect(isFoundationStory({ nodeKind: 'foundation' })).toBe(true);
  });
  it('is false for a plain feature story', () => {
    expect(isFoundationStory({ nodeKind: 'feature' })).toBe(false);
    expect(isFoundationStory({ isFoundation: false })).toBe(false);
    expect(isFoundationStory({})).toBe(false);
    expect(isFoundationStory()).toBe(false);
  });
});

describe('evaluateFoundationGate (pure)', () => {
  it('passes when tsc, build, and boot all pass', () => {
    const r = evaluateFoundationGate({
      tsc: { passed: true },
      build: { passed: true },
      boot: { passed: true },
    });
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
  });

  it('fails on tsc with a reason', () => {
    const r = evaluateFoundationGate({
      tsc: { passed: false, detail: 'TS2304' },
      build: { passed: true },
      boot: { passed: true },
    });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['tsc']);
    expect(r.reasons[0]).toMatch(/foundation tsc failed: TS2304/);
  });

  it('fails on build with a reason', () => {
    const r = evaluateFoundationGate({
      tsc: { passed: true },
      build: { passed: false, detail: 'oom' },
      boot: { passed: true },
    });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['build']);
    expect(r.reasons[0]).toMatch(/foundation build failed: oom/);
  });

  it('fails on boot-liveness with a reason', () => {
    const r = evaluateFoundationGate({
      tsc: { passed: true },
      build: { passed: true },
      boot: { passed: false, detail: 'no synthetic input produced an observable state delta' },
    });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['boot']);
    expect(r.reasons[0]).toMatch(/boot-liveness failed: no synthetic input/);
  });

  it('reports all three failing dimensions and fails closed on missing results', () => {
    const r = evaluateFoundationGate({});
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['tsc', 'build', 'boot']);
    expect(r.reasons).toHaveLength(3);
  });

  // ── tests-presence semantics (P3_SUITE_GREEN) ──
  it('IGNORES the suite dimension when the tests key is ABSENT (3-dim behavior unchanged)', () => {
    const r = evaluateFoundationGate({
      tsc: { passed: true },
      build: { passed: true },
      boot: { passed: true },
    });
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
    expect(r.failing).not.toContain('tests');
  });

  it('fails CLOSED with a suite reason when a PRESENT tests result failed', () => {
    const r = evaluateFoundationGate({
      tsc: { passed: true },
      build: { passed: true },
      boot: { passed: true },
      tests: { passed: false, detail: 'exit 1: 2 failed' },
    });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['tests']);
    expect(r.reasons[0]).toMatch(/foundation suite failed: exit 1: 2 failed/);
  });
});

// ── Factory wiring (injected deps — no real dev server / playwright) ──────────
function fakePlaywright({ snapshots = [{}], harnessMounted = true } = {}) {
  let snapCalls = 0;
  const clickable = { click: async () => {} };
  const locator = { first: () => clickable, count: async () => 1 };
  const page = {
    goto: async () => {},
    waitForFunction: async () => {
      if (!harnessMounted) throw new Error('timeout');
    },
    keyboard: { press: async () => {} },
    getByRole: () => locator,
    getByText: () => locator,
    locator: () => locator,
    evaluate: async () => snapshots[Math.min(snapCalls++, snapshots.length - 1)],
  };
  const browser = { newPage: async () => page, close: async () => {} };
  return { chromium: { launch: async () => browser } };
}

describe('makeStoryDevGateDeps (wiring)', () => {
  it('greenTrunk composes tsc+build via injected async runner', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    // storyBootGate off → isolate the tsc+build dimensions (the per-story boot
    // gate, default ON, has its own dedicated describe below).
    const deps = makeStoryDevGateDeps({ cwd: '/app', runner, deps: { storyBootGate: 'off' } });
    const r = await deps.greenTrunk({ cwd: '/app' });
    expect(r.passed).toBe(true);
  });

  it('greenTrunk fails closed when tsc exits non-zero', async () => {
    const runner = async (cmd, args) =>
      args[0] === 'tsc' ? { status: 1, stderr: 'TS' } : { status: 0, stdout: '' };
    const deps = makeStoryDevGateDeps({ cwd: '/app', runner, deps: { storyBootGate: 'off' } });
    const r = await deps.greenTrunk({ cwd: '/app' });
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('tsc');
  });

  it('foundationGate composes tsc+build+boot-liveness to a green verdict', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      qaContext: { defaultPort: 3000 },
      deps: {
        // boot succeeds; playwright fake yields a NON-ambient state delta on the
        // first input (before={}, control={}, after={x:1}).
        bootDevServer: async () => ({ ok: true, port: 3000, stop: async () => {} }),
        playwright: fakePlaywright({ snapshots: [{}, {}, { x: 1 }] }),
        shell: async () => ({ stdout: '', stderr: '' }),
      },
    });
    const r = await deps.foundationGate({ cwd: '/app', headSha: 'abc', qaContext: { defaultPort: 3000 } });
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
  });

  it('foundationGate fails closed when the dev server does not boot', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      deps: {
        bootDevServer: async () => ({ ok: false, status: '000', stop: async () => {} }),
        playwright: fakePlaywright(),
        shell: async () => ({ stdout: '', stderr: '' }),
      },
    });
    const r = await deps.foundationGate({ cwd: '/app' });
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('boot');
    expect(r.reasons.join(' ')).toMatch(/dev server did not boot/);
  });

  it('greenTrunk fails closed (tree-moved) when HEAD moves during the check (SHA-pin)', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    // git reports a DIFFERENT head on the second read (a sibling committed mid-check).
    let reads = 0;
    const git = async () => ({ code: 0, stdout: reads++ === 0 ? 'aaaaaaa\n' : 'bbbbbbb\n', stderr: '' });
    const deps = makeStoryDevGateDeps({ cwd: '/app', runner, git, deps: { storyBootGate: 'off' } });
    const r = await deps.greenTrunk({ cwd: '/app' });
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('tree-moved');
    expect(r.reasons.join(' ')).toMatch(/MOVING tree/);
  });

  it('greenTrunk passes when HEAD is stable across the check (SHA-pin no-op)', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    const git = async () => ({ code: 0, stdout: 'aaaaaaa\n', stderr: '' });
    const deps = makeStoryDevGateDeps({ cwd: '/app', runner, git, deps: { storyBootGate: 'off' } });
    const r = await deps.greenTrunk({ cwd: '/app' });
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
  });
});

// ── P3_SUITE_GREEN wiring (the cross-plan regression guardrail) ───────────────
// A runner keyed by command: tsc/build always green, but `npm run test` is RED,
// so the ONLY way a gate can fail here is if it actually ran the whole suite.
function keyedRunner({ testStatus }) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    const isSuite = cmd === 'npm' && args[0] === 'run' && args[1] === 'test';
    if (isSuite) return { status: testStatus, stdout: '', stderr: '1 failed | 11 passed' };
    return { status: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  fn.ranSuite = () => calls.some((c) => c.cmd === 'npm' && c.args[0] === 'run' && c.args[1] === 'test');
  return fn;
}

describe('makeStoryDevGateDeps — P3_SUITE_GREEN flag', () => {
  it('flag ON: greenTrunk runs the whole suite and folds a RED suite into the verdict', async () => {
    const runner = keyedRunner({ testStatus: 1 });
    // storyBootGate off → isolate the suite dimension from the per-story boot gate.
    const deps = makeStoryDevGateDeps({ cwd: '/app', runner, deps: { suiteGreen: 'on', storyBootGate: 'off' } });
    const r = await deps.greenTrunk({ cwd: '/app' });
    expect(runner.ranSuite()).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('tests');
    expect(r.reasons.join(' ')).toMatch(/green-trunk suite failed/);
  });

  it('flag ON: greenTrunk passes when tsc+build AND the whole suite are green', async () => {
    const runner = keyedRunner({ testStatus: 0 });
    const deps = makeStoryDevGateDeps({ cwd: '/app', runner, deps: { suiteGreen: 'on', storyBootGate: 'off' } });
    const r = await deps.greenTrunk({ cwd: '/app' });
    expect(runner.ranSuite()).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
  });

  it('flag ON: foundationGate fails on a RED suite (with a suite reason)', async () => {
    const runner = keyedRunner({ testStatus: 1 });
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      qaContext: { defaultPort: 3000 },
      deps: {
        suiteGreen: 'on',
        bootDevServer: async () => ({ ok: true, port: 3000, stop: async () => {} }),
        playwright: fakePlaywright({ snapshots: [{}, {}, { x: 1 }] }),
        shell: async () => ({ stdout: '', stderr: '' }),
      },
    });
    const r = await deps.foundationGate({ cwd: '/app', qaContext: { defaultPort: 3000 } });
    expect(runner.ranSuite()).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('tests');
    expect(r.reasons.join(' ')).toMatch(/foundation suite failed/);
  });

  it('flag OFF: greenTrunk never runs the suite — byte-identical legacy 2-dim verdict', async () => {
    // Even with a RED suite runner, flag-off greenTrunk must NOT run `npm run
    // test` and must pass on green tsc+build alone (pre-redesign behavior).
    const runner = keyedRunner({ testStatus: 1 });
    const deps = makeStoryDevGateDeps({ cwd: '/app', runner, deps: { suiteGreen: 'off', storyBootGate: 'off' } });
    const r = await deps.greenTrunk({ cwd: '/app' });
    expect(runner.ranSuite()).toBe(false);
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
    expect(r.failing).not.toContain('tests');
  });

  it('flag OFF: foundationGate never runs the suite — byte-identical legacy 3-dim verdict', async () => {
    const runner = keyedRunner({ testStatus: 1 });
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      qaContext: { defaultPort: 3000 },
      deps: {
        suiteGreen: 'off',
        bootDevServer: async () => ({ ok: true, port: 3000, stop: async () => {} }),
        playwright: fakePlaywright({ snapshots: [{}, {}, { x: 1 }] }),
        shell: async () => ({ stdout: '', stderr: '' }),
      },
    });
    const r = await deps.foundationGate({ cwd: '/app', qaContext: { defaultPort: 3000 } });
    expect(runner.ranSuite()).toBe(false);
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
  });

  it('resolves the flag from an injected env map (deps.env) when suiteGreen is not given', async () => {
    const runner = keyedRunner({ testStatus: 1 });
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      deps: { env: { P3_SUITE_GREEN: 'on' }, storyBootGate: 'off' },
    });
    const r = await deps.greenTrunk({ cwd: '/app' });
    expect(runner.ranSuite()).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('tests');
  });
});

// ── P3_STORY_BOOT_GATE wiring (B1, Incident G — per-story boot-liveness) ───────
// A bootDevServer spy that records how many times it was invoked, so a test can
// prove the flag-off greenTrunk NEVER boots (byte-identical legacy verdict) and
// the flag-on greenTrunk DOES.
function bootSpy({ ok = true } = {}) {
  const fn = async () => {
    fn.calls += 1;
    return { ok, port: 3000, status: ok ? '200' : '000', stop: async () => {} };
  };
  fn.calls = 0;
  return fn;
}

describe('makeStoryDevGateDeps — P3_STORY_BOOT_GATE flag (greenTrunk per-story boot)', () => {
  it('flag ON: greenTrunk runs boot-liveness and FAILS a non-foundation story on a dead boot', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    const boot = bootSpy({ ok: false }); // dev server never boots
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      qaContext: { defaultPort: 3000 },
      deps: { storyBootGate: 'on', bootDevServer: boot, playwright: fakePlaywright(), shell: async () => ({ stdout: '', stderr: '' }) },
    });
    const r = await deps.greenTrunk({ cwd: '/app', qaContext: { defaultPort: 3000 } });
    expect(boot.calls).toBe(1); // it actually booted the app
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('boot');
    expect(r.reasons.join(' ')).toMatch(/green-trunk boot-liveness failed/);
  });

  it('flag ON: greenTrunk passes when tsc+build AND the live app boots + is interactive', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    const boot = bootSpy({ ok: true });
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      qaContext: { defaultPort: 3000 },
      deps: {
        storyBootGate: 'on',
        bootDevServer: boot,
        // NON-ambient state delta on the first synthetic input → liveness passes.
        playwright: fakePlaywright({ snapshots: [{}, {}, { x: 1 }] }),
        shell: async () => ({ stdout: '', stderr: '' }),
      },
    });
    const r = await deps.greenTrunk({ cwd: '/app', qaContext: { defaultPort: 3000 } });
    expect(boot.calls).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
  });

  it('flag OFF: greenTrunk NEVER boots — byte-identical legacy tsc+build verdict', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    const boot = bootSpy({ ok: false }); // would fail IF it ran
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      qaContext: { defaultPort: 3000 },
      deps: { storyBootGate: 'off', bootDevServer: boot, playwright: fakePlaywright(), shell: async () => ({ stdout: '', stderr: '' }) },
    });
    const r = await deps.greenTrunk({ cwd: '/app', qaContext: { defaultPort: 3000 } });
    expect(boot.calls).toBe(0); // no boot on the pre-change green-trunk
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
    expect(r.failing).not.toContain('boot');
  });

  it('resolves the flag from an injected env map (deps.env) when storyBootGate is not given', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    const boot = bootSpy({ ok: false });
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      qaContext: { defaultPort: 3000 },
      deps: { env: { P3_STORY_BOOT_GATE: 'on' }, bootDevServer: boot, playwright: fakePlaywright(), shell: async () => ({ stdout: '', stderr: '' }) },
    });
    const r = await deps.greenTrunk({ cwd: '/app', qaContext: { defaultPort: 3000 } });
    expect(boot.calls).toBe(1);
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('boot');
  });

  it('foundation path is UNAFFECTED by the flag: foundationGate always boots (fails a dead boot even when P3_STORY_BOOT_GATE=off)', async () => {
    const runner = async () => ({ status: 0, stdout: '', stderr: '' });
    const boot = bootSpy({ ok: false });
    const deps = makeStoryDevGateDeps({
      cwd: '/app',
      runner,
      qaContext: { defaultPort: 3000 },
      deps: { storyBootGate: 'off', bootDevServer: boot, playwright: fakePlaywright(), shell: async () => ({ stdout: '', stderr: '' }) },
    });
    const r = await deps.foundationGate({ cwd: '/app', qaContext: { defaultPort: 3000 } });
    expect(boot.calls).toBe(1); // foundationGate boots regardless of the story-boot flag
    expect(r.passed).toBe(false);
    expect(r.failing).toContain('boot');
  });
});
