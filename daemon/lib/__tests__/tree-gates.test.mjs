import { describe, it, expect } from 'vitest';
import { runTreeTypecheck, runTreeBuild, evaluateGreenTrunk } from '../tree-gates.mjs';

// A spawnSync stub: canned { status, stdout, stderr } (or { error }).
function fakeSpawn(result) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  fn.calls = calls;
  return fn;
}

describe('runTreeTypecheck', () => {
  it('passes on exit 0 and runs `npx tsc --noEmit` in cwd', () => {
    const spawnSync = fakeSpawn({ status: 0, stdout: '', stderr: '' });
    const r = runTreeTypecheck({ cwd: '/app', spawnSync });
    expect(r.passed).toBe(true);
    expect(r.detail).toBe('pass');
    expect(spawnSync.calls[0].cmd).toBe('npx');
    expect(spawnSync.calls[0].args).toEqual(['tsc', '--noEmit']);
    expect(spawnSync.calls[0].opts.cwd).toBe('/app');
  });

  it('fails on non-zero exit and surfaces the output tail in detail', () => {
    const spawnSync = fakeSpawn({ status: 2, stdout: '', stderr: 'error TS2304: Cannot find name X' });
    const r = runTreeTypecheck({ cwd: '/app', spawnSync });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/exit 2/);
    expect(r.detail).toMatch(/TS2304/);
  });

  it('fails closed when spawn returns an error', () => {
    const spawnSync = fakeSpawn({ error: new Error('ENOENT') });
    const r = runTreeTypecheck({ cwd: '/app', spawnSync });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/ENOENT/);
  });
});

describe('runTreeBuild', () => {
  it('passes on exit 0 and runs `npm run build` in cwd', () => {
    const spawnSync = fakeSpawn({ status: 0, stdout: 'built', stderr: '' });
    const r = runTreeBuild({ cwd: '/app', spawnSync });
    expect(r.passed).toBe(true);
    expect(spawnSync.calls[0].cmd).toBe('npm');
    expect(spawnSync.calls[0].args).toEqual(['run', 'build']);
  });

  it('fails on non-zero exit', () => {
    const spawnSync = fakeSpawn({ status: 1, stdout: '', stderr: 'Build failed' });
    const r = runTreeBuild({ cwd: '/app', spawnSync });
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
