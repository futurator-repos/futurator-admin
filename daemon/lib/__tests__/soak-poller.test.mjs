/**
 * soak-poller.test.mjs — Pipeline v2 Phase 3-S / Story 3-S-2-1 (PR-98).
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateSoakSample,
  checkSoakProgress,
  buildSoakFailedAttention,
  requiresOperatorApproval,
  SOAK_CONSTANTS,
} from '../soak-poller.mjs';

function goodSample(takenAt = 0) {
  return {
    takenAt,
    fiveXxRatePct: 0.1,
    dependencyErrorRatePct: 0.3,
    smokeTestPassPct: 100,
  };
}

function badSample5xx(takenAt = 0) {
  return {
    takenAt,
    fiveXxRatePct: 1.2,
    dependencyErrorRatePct: 0.3,
    smokeTestPassPct: 100,
  };
}

describe('evaluateSoakSample', () => {
  it('green sample passes all three conditions', () => {
    const r = evaluateSoakSample(goodSample());
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.details).toEqual({ fiveXxOk: true, dependencyOk: true, smokeOk: true });
  });

  it('high 5xx → flagged + readable failure message', () => {
    const r = evaluateSoakSample({
      takenAt: 0,
      fiveXxRatePct: 0.6,
      dependencyErrorRatePct: 0.1,
      smokeTestPassPct: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/5xx rate 0\.60% .* 0\.5%/);
  });

  it('high dependency error → flagged', () => {
    const r = evaluateSoakSample({
      takenAt: 0,
      fiveXxRatePct: 0.1,
      dependencyErrorRatePct: 1.5,
      smokeTestPassPct: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/dependency error rate 1\.50%/);
  });

  it('partial smoke pass → flagged', () => {
    const r = evaluateSoakSample({
      takenAt: 0,
      fiveXxRatePct: 0.1,
      dependencyErrorRatePct: 0.1,
      smokeTestPassPct: 99,
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/smoke-test pass rate 99\.0%/);
  });

  it('multiple failures all surface', () => {
    const r = evaluateSoakSample({
      takenAt: 0,
      fiveXxRatePct: 1.0,
      dependencyErrorRatePct: 2.0,
      smokeTestPassPct: 50,
    });
    expect(r.failures).toHaveLength(3);
  });
});

describe('checkSoakProgress', () => {
  const START = 1_700_000_000_000;

  it('pending: elapsed < window, all samples green', () => {
    const result = checkSoakProgress({
      soakStartedAt: START,
      samples: [goodSample(START + 60_000)],
      now: () => START + 60_000,
    });
    expect(result.status).toBe('pending');
    expect(result.remainingMs).toBeGreaterThan(0);
  });

  it('passed: elapsed ≥ 24h, all samples green', () => {
    const result = checkSoakProgress({
      soakStartedAt: START,
      samples: [goodSample(START + 60_000), goodSample(START + 12 * 3600_000)],
      now: () => START + 24 * 3600_000 + 60_000,
    });
    expect(result.status).toBe('passed');
    expect(result.remainingMs).toBe(0);
  });

  it('failed: first failing sample halts the soak', () => {
    const result = checkSoakProgress({
      soakStartedAt: START,
      samples: [
        goodSample(START + 60_000),
        badSample5xx(START + 3600_000),
        goodSample(START + 4000_000), // ignored — already failed
      ],
      now: () => START + 5 * 3600_000,
    });
    expect(result.status).toBe('failed');
    expect(result.failedAt).toBe(START + 3600_000);
  });

  it('no samples yet → pending', () => {
    const result = checkSoakProgress({
      soakStartedAt: START,
      samples: [],
      now: () => START + 60_000,
    });
    expect(result.status).toBe('pending');
  });
});

describe('buildSoakFailedAttention', () => {
  it('renders a high-severity item with elapsed hours + failures', () => {
    const sample = evaluateSoakSample(badSample5xx());
    const item = buildSoakFailedAttention({
      planId: 'pln-1',
      projectSlug: 'songster',
      sample,
      elapsedMs: 5 * 3600_000,
    });
    expect(item.severity).toBe('high');
    expect(item.category).toBe('production-soak-failed');
    expect(item.body).toContain('5h elapsed');
    expect(item.body).toContain('5xx rate');
    expect(item.actions).toContain('restart-soak');
  });
});

describe('requiresOperatorApproval', () => {
  it('true when deploy-gate.requires contains operator-approval', () => {
    expect(requiresOperatorApproval(['all-tests-pass', 'operator-approval'])).toBe(true);
  });

  it('false when absent', () => {
    expect(requiresOperatorApproval(['all-tests-pass'])).toBe(false);
    expect(requiresOperatorApproval(undefined)).toBe(false);
    expect(requiresOperatorApproval(null)).toBe(false);
  });
});

describe('SOAK_CONSTANTS', () => {
  it('window is 24h', () => {
    expect(SOAK_CONSTANTS.windowMs).toBe(24 * 60 * 60 * 1000);
  });

  it('matches v2.5 §36 thresholds', () => {
    expect(SOAK_CONSTANTS.fiveXxThresholdPct).toBe(0.5);
    expect(SOAK_CONSTANTS.dependencyErrorThresholdPct).toBe(1.0);
    expect(SOAK_CONSTANTS.smokeTestPassRequiredPct).toBe(100.0);
  });
});
