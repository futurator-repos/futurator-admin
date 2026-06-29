import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCostTracker } from '../cost-tracker.mjs';
import {
  harnessCostPath,
  writeHarnessCost,
  readHarnessCost,
  reconcile,
  reconcileGap,
} from '../harness-cost-bridge.mjs';
import { selectModel, resolveModelIds, DEFAULT_MODEL_IDS } from '../model-router.mjs';
import { decideCeiling } from '../../hooks/posttool-ceiling.mjs';
import { extractCost, processStatusline } from '../../hooks/statusline-cost.mjs';

describe('cost-tracker (immutable)', () => {
  it('add returns a new tracker, original unchanged', () => {
    const a = createCostTracker(1, 10);
    const b = a.add(2);
    expect(a.usd).toBe(1);
    expect(b.usd).toBe(3);
    expect(Object.isFrozen(a)).toBe(true);
  });
  it('overBudget / warnThreshold / remaining boundaries', () => {
    const t = createCostTracker(8, 10, 0.8);
    expect(t.warnThreshold()).toBe(true);
    expect(t.overBudget()).toBe(false);
    expect(t.remaining()).toBe(2);
    expect(t.add(2).overBudget()).toBe(true);
    expect(t.add(2).warnThreshold()).toBe(false);
  });
  it('no ceiling → never over budget, infinite remaining', () => {
    const t = createCostTracker(999);
    expect(t.overBudget()).toBe(false);
    expect(t.remaining()).toBe(Infinity);
    expect(t.fraction()).toBe(0);
  });
});

describe('harness-cost-bridge', () => {
  it('round-trips a per-process cost file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcost-'));
    const p = writeHarnessCost('sess-1', { usd: 1.23 }, dir);
    expect(p).toBe(harnessCostPath('sess-1', dir));
    expect(readHarnessCost('sess-1', dir)).toBe(1.23);
  });
  it('missing file → null (a miss, not 0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcost-'));
    expect(readHarnessCost('nope', dir)).toBe(null);
  });
  it('corrupt file → null (a miss)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcost-'));
    writeFileSync(harnessCostPath('bad', dir), '{ not json');
    expect(readHarnessCost('bad', dir)).toBe(null);
  });
  it('reconcile sums all sessions, dedups by sessionId, skips corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcost-'));
    writeHarnessCost('orch', { usd: 2.0 }, dir);
    writeHarnessCost('dev-1', { usd: 5.0 }, dir);
    writeHarnessCost('dev-2', { usd: 3.0 }, dir);
    writeFileSync(harnessCostPath('corrupt', dir), 'nope');
    const r = reconcile({ dir });
    expect(r.totalUsd).toBe(10.0);
    expect(r.files).toBe(3);
    expect(r.missed).toBe(1);
  });
  it('reconcile can restrict to a job session set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcost-'));
    writeHarnessCost('a', { usd: 1 }, dir);
    writeHarnessCost('b', { usd: 2 }, dir);
    writeHarnessCost('other', { usd: 100 }, dir);
    expect(reconcile({ dir, sessionIds: ['a', 'b'] }).totalUsd).toBe(3);
  });
  it('reconcileGap exposes the under-report ratio', () => {
    const g = reconcileGap(1.4, 14.0);
    expect(g.ratio).toBe(10);
    expect(g.deltaUsd).toBe(12.6);
  });
});

describe('model-router', () => {
  it('off by default → returns the caller default unchanged', () => {
    expect(selectModel({ role: 'orchestrator', defaultModel: 'x', env: {} })).toBe('x');
  });
  it('routes when opted in', () => {
    const env = { P3_MODEL_ROUTING: 'on' };
    const ids = resolveModelIds(env);
    expect(selectModel({ role: 'orchestrator', env })).toBe(ids.opus);
    expect(selectModel({ role: 'review', rigor: 'production', env })).toBe(ids.opus);
    expect(selectModel({ role: 'dev', complexity: 'trivial', env })).toBe(ids.haiku);
    expect(selectModel({ role: 'dev', complexity: 'standard', env })).toBe(ids.sonnet);
    expect(selectModel({ role: 'dev', chars: 20000, env })).toBe(ids.sonnet);
    expect(selectModel({ role: 'dev', items: 40, env })).toBe(ids.sonnet);
  });
  it('honors env model-id overrides', () => {
    const env = { P3_MODEL_ROUTING: 'on', P3_MODEL_OPUS: 'opus-custom' };
    expect(selectModel({ role: 'orchestrator', env })).toBe('opus-custom');
    expect(DEFAULT_MODEL_IDS.opus).toMatch(/opus/);
  });
});

describe('posttool-ceiling decideCeiling', () => {
  it('allow / warn / halt boundaries', () => {
    expect(decideCeiling({ spend: 5, ceiling: 10 }).action).toBe('allow');
    expect(decideCeiling({ spend: 8, ceiling: 10 }).action).toBe('warn');
    expect(decideCeiling({ spend: 10, ceiling: 10 }).action).toBe('halt');
    expect(decideCeiling({ spend: 11, ceiling: 10 }).action).toBe('halt');
  });
  it('no ceiling → always allow', () => {
    expect(decideCeiling({ spend: 999, ceiling: 0 }).action).toBe('allow');
  });
});

describe('statusline-cost', () => {
  it('extractCost reads session + cumulative usd from statusLine shapes', () => {
    expect(extractCost({ session_id: 's', cost: { total_cost_usd: 1.5 } })).toEqual({ sessionId: 's', usd: 1.5 });
    expect(extractCost({ total_cost_usd: 2 })).toEqual({ sessionId: 'nosession', usd: 2 });
  });
  it('processStatusline persists spend and returns a status line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcost-'));
    const line = processStatusline({ session_id: 's1', cost: { total_cost_usd: 0.5 } }, { dir });
    expect(line).toMatch(/\$0\.5000/);
    expect(readHarnessCost('s1', dir)).toBe(0.5);
  });
});
