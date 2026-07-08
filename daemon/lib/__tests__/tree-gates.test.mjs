import { describe, it, expect } from 'vitest';
import { runTreeTypecheck, runTreeBuild, evaluateGreenTrunk } from '../tree-gates.mjs';

// An async runner stub: resolves canned { status, stdout, stderr } (or { error }).
// The gate runner is now event-based/async (non-blocking) — no more sync spawnSync.
function fakeRunner(result) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  fn.calls = calls;
  return fn;
}

describe('runTreeTypecheck', () => {
  it('passes on exit 0 and runs `npx tsc --noEmit` in cwd', async () => {
    const runner = fakeRunner({ status: 0, stdout: '', stderr: '' });
    const r = await runTreeTypecheck({ cwd: '/app', runner });
    expect(r.passed).toBe(true);
    expect(r.detail).toBe('pass');
    expect(runner.calls[0].cmd).toBe('npx');
    expect(runner.calls[0].args).toEqual(['tsc', '--noEmit']);
    expect(runner.calls[0].opts.cwd).toBe('/app');
  });

  it('fails on non-zero exit and surfaces the output tail in detail', async () => {
    const runner = fakeRunner({ status: 2, stdout: '', stderr: 'error TS2304: Cannot find name X' });
    const r = await runTreeTypecheck({ cwd: '/app', runner });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/exit 2/);
    expect(r.detail).toMatch(/TS2304/);
  });

  it('fails closed when the runner returns an error', async () => {
    const runner = fakeRunner({ error: new Error('ENOENT') });
    const r = await runTreeTypecheck({ cwd: '/app', runner });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/ENOENT/);
  });
});

describe('runTreeBuild', () => {
  it('passes on exit 0 and runs `npm run build` in cwd', async () => {
    const runner = fakeRunner({ status: 0, stdout: 'built', stderr: '' });
    const r = await runTreeBuild({ cwd: '/app', runner });
    expect(r.passed).toBe(true);
    expect(runner.calls[0].cmd).toBe('npm');
    expect(runner.calls[0].args).toEqual(['run', 'build']);
  });

  it('fails on non-zero exit', async () => {
    const runner = fakeRunner({ status: 1, stdout: '', stderr: 'Build failed' });
    const r = await runTreeBuild({ cwd: '/app', runner });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/exit 1/);
    expect(r.detail).toMatch(/Build failed/);
  });
});

describe('evaluateGreenTrunk (pure)', () => {
  it('passes when both tsc and build pass', () => {
    const r = evaluateGreenTrunk({ tsc: { passed: true }, build: { passed: true } });
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
    expect(r.reasons).toEqual([]);
  });

  it('fails with a tsc reason when tsc fails', () => {
    const r = evaluateGreenTrunk({ tsc: { passed: false, detail: 'TS2304' }, build: { passed: true } });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['tsc']);
    expect(r.reasons[0]).toMatch(/green-trunk tsc failed: TS2304/);
  });

  it('fails with a build reason when build fails', () => {
    const r = evaluateGreenTrunk({ tsc: { passed: true }, build: { passed: false, detail: 'oom' } });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['build']);
    expect(r.reasons[0]).toMatch(/green-trunk build failed: oom/);
  });

  it('reports both failing dimensions', () => {
    const r = evaluateGreenTrunk({ tsc: { passed: false }, build: { passed: false } });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['tsc', 'build']);
    expect(r.reasons).toHaveLength(2);
  });

  it('fails closed when a result is missing entirely', () => {
    const r = evaluateGreenTrunk({});
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(['tsc', 'build']);
  });
});
