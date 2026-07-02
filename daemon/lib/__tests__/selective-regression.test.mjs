import { describe, it, expect } from 'vitest';
import {
  selectiveRegressionMode,
  collectCoveringTests,
  runSelectiveRegression,
} from '../selective-regression.mjs';

const driver = {}; // opaque; queryImpact is injected
const queryImpact = async (nodeId) => {
  const map = {
    'code/login.ts': { tests: ['t/login.test.ts', 't/session.test.ts'] },
    'code/token.ts': { tests: ['t/session.test.ts'] }, // overlaps → union dedupes
    'code/orphan.ts': { tests: [] },
  };
  return map[nodeId] || { tests: [] };
};

describe('selectiveRegressionMode', () => {
  it('defaults to off', () => {
    expect(selectiveRegressionMode(undefined)).toBe('off');
    expect(selectiveRegressionMode('on')).toBe('on');
    expect(selectiveRegressionMode('shadow')).toBe('shadow');
  });
});

describe('collectCoveringTests', () => {
  it('unions + dedupes covering tests across changed nodes', async () => {
    const t = await collectCoveringTests(['code/login.ts', 'code/token.ts'], driver, { queryImpact });
    expect(t).toEqual(['t/login.test.ts', 't/session.test.ts']);
  });
  it('empty when nothing covers the change', async () => {
    expect(await collectCoveringTests(['code/orphan.ts'], driver, { queryImpact })).toEqual([]);
    expect(await collectCoveringTests([], driver, { queryImpact })).toEqual([]);
  });
});

describe('runSelectiveRegression', () => {
  it('off → no-op', async () => {
    const r = await runSelectiveRegression({ flag: 'off', changedNodeIds: ['code/login.ts'], driver, queryImpact, runTest: async () => ({ passed: true }) });
    expect(r).toMatchObject({ mode: 'off', ran: 0, skipped: 'off' });
  });
  it('shadow → selects but does not run', async () => {
    const r = await runSelectiveRegression({ flag: 'shadow', changedNodeIds: ['code/login.ts'], driver, queryImpact, runTest: async () => ({ passed: true }) });
    expect(r.selected).toEqual(['t/login.test.ts', 't/session.test.ts']);
    expect(r.ran).toBe(0);
  });
  it('on → runs the covering tests and reports regressions', async () => {
    const runTest = async (t) => ({ passed: t !== 't/session.test.ts' }); // session regressed
    const r = await runSelectiveRegression({ flag: 'on', changedNodeIds: ['code/login.ts'], driver, queryImpact, runTest });
    expect(r.ran).toBe(2);
    expect(r.regressions).toEqual(['t/session.test.ts']);
  });
  it('on with empty covering set → no-op (skipped=empty)', async () => {
    const r = await runSelectiveRegression({ flag: 'on', changedNodeIds: ['code/orphan.ts'], driver, queryImpact, runTest: async () => ({ passed: true }) });
    expect(r).toMatchObject({ ran: 0, skipped: 'empty' });
  });
});
