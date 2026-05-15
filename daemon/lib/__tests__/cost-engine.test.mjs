/**
 * cost-engine.test.mjs — Pipeline v2 Phase 2-D / Story 2-D-9-1 (PR-97)
 *                       + 2-D-16-1 (PR-99) cost-history.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  estimateService,
  estimateEnvironmentCost,
  estimateManifestCost,
  checkCostEnvelope,
  registerShim,
  appendCostHistoryRow,
  readCostHistory,
  rollupCostHistory,
  REGISTERED_SHIM_KINDS,
} from '../cost-engine.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cost-engine-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('estimateService — built-in shims', () => {
  it('s3 scales with expectedGb', () => {
    expect(estimateService({ kind: 's3', name: 'b', expectedGb: 100 })).toBeCloseTo(2.3);
  });

  it('dynamodb pay-per-request returns nominal value', () => {
    expect(estimateService({ kind: 'dynamodb', name: 't' })).toBe(8);
  });

  it('dynamodb provisioned costs scale with RCU/WCU', () => {
    expect(
      estimateService({
        kind: 'dynamodb',
        name: 't',
        billing: 'provisioned',
        'provisioned-rcu': 10,
        'provisioned-wcu': 10,
      }),
    ).toBeCloseTo(7.8);
  });

  it('ecs-fargate scales with cpu/memory/desired', () => {
    const usd = estimateService({ kind: 'ecs-fargate', name: 's', cpu: 1024, memory: 2048, desired: 1 });
    expect(usd).toBeGreaterThan(0);
    // 1 vCPU * 0.04048 + 2 GB * 0.004445 ≈ 0.0494/hr * 730 ≈ $36
    expect(usd).toBeGreaterThan(30);
    expect(usd).toBeLessThan(50);
  });

  it('ecs-fargate-gpu desired=0 returns scale-to-zero floor ($5)', () => {
    expect(estimateService({ kind: 'ecs-fargate-gpu', name: 'w', desired: 0 })).toBe(5);
  });

  it('bedrock provisioned MU @ ~$15/hr', () => {
    expect(
      estimateService({
        kind: 'bedrock-model-access',
        name: 'b',
        'provisioned-throughput': true,
        'provisioned-units': 1,
      }),
    ).toBeCloseTo(15 * 730);
  });

  it('bedrock on-demand returns $50 baseline', () => {
    expect(estimateService({ kind: 'bedrock-model-access', name: 'b' })).toBe(50);
  });

  it('unknown kind returns 0', () => {
    expect(estimateService({ kind: 'glacier', name: 'g' })).toBe(0);
  });

  it('lambda scales with invocations + memory', () => {
    const usd = estimateService({
      kind: 'lambda',
      name: 'f',
      expectedMonthlyInvocations: 1_000_000,
      expectedAvgMs: 200,
      memory: 256,
    });
    expect(usd).toBeGreaterThan(0);
  });
});

describe('REGISTERED_SHIM_KINDS', () => {
  it('exposes the built-in kinds', () => {
    const kinds = REGISTERED_SHIM_KINDS();
    expect(kinds).toContain('s3');
    expect(kinds).toContain('dynamodb');
    expect(kinds).toContain('lambda');
    expect(kinds).toContain('ecs-fargate');
    expect(kinds).toContain('bedrock-model-access');
    expect(kinds).toEqual([...kinds].sort());
  });
});

describe('registerShim', () => {
  it('allows extending kinds at runtime', () => {
    registerShim('demo-only', () => 99);
    expect(estimateService({ kind: 'demo-only', name: 'x' })).toBe(99);
  });

  it('throws for non-function shim', () => {
    expect(() => registerShim('bad', 'not a fn')).toThrow();
  });
});

describe('estimateEnvironmentCost', () => {
  it('aggregates per-service costs', () => {
    const result = estimateEnvironmentCost({
      services: [
        { kind: 's3', name: 'a', expectedGb: 100 },
        { kind: 'dynamodb', name: 'b' },
      ],
    });
    expect(result.totalUsd).toBeCloseTo(2.3 + 8);
    expect(result.perService).toHaveLength(2);
  });

  it('flags unsupported kinds + counts cost as 0', () => {
    const result = estimateEnvironmentCost({
      services: [{ kind: 'cosmic-db', name: 'x' }],
    });
    expect(result.unsupported).toEqual(['cosmic-db (x)']);
    expect(result.totalUsd).toBe(0);
  });

  it('empty env → 0', () => {
    expect(estimateEnvironmentCost({}).totalUsd).toBe(0);
    expect(estimateEnvironmentCost({ services: [] }).totalUsd).toBe(0);
  });
});

describe('estimateManifestCost', () => {
  it('estimates per env independently', () => {
    const result = estimateManifestCost({
      environments: {
        dev: { services: [{ kind: 's3', name: 'a', expectedGb: 1 }] },
        production: { services: [{ kind: 's3', name: 'a', expectedGb: 1000 }] },
      },
    });
    expect(result.dev.totalUsd).toBeLessThan(result.production.totalUsd);
  });
});

describe('checkCostEnvelope', () => {
  it('flags high when estimate crosses monthly-usd-max', () => {
    const flags = checkCostEnvelope({
      manifest: {
        'cost-envelope': { production: { 'monthly-usd-max': 100 } },
      },
      estimatedByEnv: { production: { totalUsd: 150 } },
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('high');
    expect(flags[0].ratio).toBeCloseTo(1.5);
  });

  it('flags medium when estimate crosses alert-at but not max', () => {
    const flags = checkCostEnvelope({
      manifest: {
        'cost-envelope': {
          production: { 'monthly-usd-max': 600, 'alert-at': 480 },
        },
      },
      estimatedByEnv: { production: { totalUsd: 500 } },
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('medium');
  });

  it('no flag when within envelope', () => {
    const flags = checkCostEnvelope({
      manifest: {
        'cost-envelope': { production: { 'monthly-usd-max': 600, 'alert-at': 480 } },
      },
      estimatedByEnv: { production: { totalUsd: 300 } },
    });
    expect(flags).toEqual([]);
  });
});

describe('cost-history (Story 2-D-16)', () => {
  it('appendCostHistoryRow creates file with header on first call', () => {
    const path = appendCostHistoryRow({
      workingDir: tmp,
      snapshot: {
        timestamp: '2026-05-15T00:00:00Z',
        month: '2026-05',
        env: 'production',
        kind: 's3',
        usd: 12.5,
      },
    });
    expect(existsSync(path)).toBe(true);
    const rows = readCostHistory(tmp);
    expect(rows).toHaveLength(1);
    expect(rows[0].usd).toBe(12.5);
  });

  it('rolls up by (month, env)', () => {
    appendCostHistoryRow({
      workingDir: tmp,
      snapshot: { timestamp: 't1', month: '2026-04', env: 'dev', kind: 's3', usd: 5 },
    });
    appendCostHistoryRow({
      workingDir: tmp,
      snapshot: { timestamp: 't1', month: '2026-04', env: 'dev', kind: 'dynamodb', usd: 8 },
    });
    appendCostHistoryRow({
      workingDir: tmp,
      snapshot: { timestamp: 't2', month: '2026-05', env: 'dev', kind: 's3', usd: 6 },
    });
    const rollup = rollupCostHistory(tmp);
    expect(rollup).toEqual([
      { month: '2026-04', env: 'dev', totalUsd: 13 },
      { month: '2026-05', env: 'dev', totalUsd: 6 },
    ]);
  });

  it('readCostHistory returns empty when file missing', () => {
    expect(readCostHistory(tmp)).toEqual([]);
  });

  it('rollupCostHistory returns empty when file missing', () => {
    expect(rollupCostHistory(tmp)).toEqual([]);
  });
});
