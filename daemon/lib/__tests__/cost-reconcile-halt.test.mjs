import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideWaveBudget, reconcileWaveCost } from '../cost-reconcile-gate.mjs';
import { readHalt, clearHalt, checkAndSignalHalt } from '../halt-watch.mjs';
import { writeHarnessCost } from '../harness-cost-bridge.mjs';

describe('decideWaveBudget', () => {
  it('allows under budget, warns near, blocks over (with tolerance)', () => {
    expect(decideWaveBudget({ total: 5, ceiling: 10 }).action).toBe('allow');
    expect(decideWaveBudget({ total: 9, ceiling: 10 }).action).toBe('warn');
    expect(decideWaveBudget({ total: 11, ceiling: 10 }).action).toBe('block'); // >10*1.05=10.5
    expect(decideWaveBudget({ total: 10.4, ceiling: 10 }).action).not.toBe('block'); // within 5% tolerance
  });
  it('no ceiling → always allow', () => {
    expect(decideWaveBudget({ total: 999, ceiling: 0 }).action).toBe('allow');
  });
});

describe('reconcileWaveCost', () => {
  function dirWith(spend) {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    let i = 0;
    for (const s of spend) writeHarnessCost(`sess-${i++}`, { usd: s }, dir);
    return dir;
  }
  it('observe keeps the internal total but logs the gap', () => {
    const dir = dirWith([5, 5, 4]); // reconciled 14
    const logs = [];
    const r = reconcileWaveCost({ harnessCostDir: dir, internalTotalUsd: 1.4, ceilingUsd: 10, mode: 'observe', log: (l, m) => logs.push(m) });
    expect(r.reconciledUsd).toBe(14);
    expect(r.effectiveTotal).toBe(1.4); // unchanged in observe
    expect(r.gap.ratio).toBe(10);
    expect(logs.join()).toMatch(/under-report/);
    expect(r.decision.action).toBe('allow'); // gate sees internal 1.4
  });
  it('enforce uses the reconciled total → ceiling fires on real spend', () => {
    const dir = dirWith([8, 8]); // reconciled 16
    const r = reconcileWaveCost({ harnessCostDir: dir, internalTotalUsd: 1.6, ceilingUsd: 10, mode: 'enforce' });
    expect(r.effectiveTotal).toBe(16);
    expect(r.decision.action).toBe('block');
  });
  it('off → no change, internal total stands', () => {
    const dir = dirWith([100]);
    const r = reconcileWaveCost({ harnessCostDir: dir, internalTotalUsd: 1, ceilingUsd: 10, mode: 'off' });
    expect(r.effectiveTotal).toBe(1);
    expect(r.decision.action).toBe('allow');
  });
  it('a reconcile error fails open to the internal total', () => {
    const r = reconcileWaveCost({ harnessCostDir: '/no/such/dir/ever', internalTotalUsd: 2, ceilingUsd: 10, mode: 'enforce' });
    expect(r.effectiveTotal).toBe(2);
  });
});

describe('halt-watch', () => {
  function dirWithHalt(reason) {
    const dir = mkdtempSync(join(tmpdir(), 'halt-'));
    mkdirSync(join(dir, '.futurator'), { recursive: true });
    writeFileSync(join(dir, '.futurator', 'halt'), JSON.stringify({ reason }));
    return dir;
  }
  it('readHalt returns the sentinel, null when absent', () => {
    const dir = dirWithHalt('ceiling reached');
    expect(readHalt(dir).reason).toBe('ceiling reached');
    clearHalt(dir);
    expect(readHalt(dir)).toBe(null);
  });
  it('checkAndSignalHalt signals children once and clears the sentinel', () => {
    const dir = dirWithHalt('over budget');
    const signalled = [];
    const r = checkAndSignalHalt({ dir, jobId: 'j1', signalChildren: (id, sig) => signalled.push([id, sig]) });
    expect(r.halted).toBe(true);
    expect(r.reason).toBe('over budget');
    expect(signalled).toEqual([['j1', 'SIGTERM']]);
    expect(existsSync(join(dir, '.futurator', 'halt'))).toBe(false);
    // second check is a no-op (fired once)
    expect(checkAndSignalHalt({ dir, jobId: 'j1', signalChildren: () => signalled.push('again') }).halted).toBe(false);
  });
  it('no sentinel → not halted, no signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'halt-'));
    let called = false;
    expect(checkAndSignalHalt({ dir, jobId: 'j', signalChildren: () => { called = true; } }).halted).toBe(false);
    expect(called).toBe(false);
  });
});
