import { describe, it, expect } from 'vitest';
import {
  getSessionWarmth,
  isStaleSession,
  estimateResumeCostUsd,
  shouldCompact,
} from '../session-warmth.mjs';

const NOW = Date.parse('2026-04-26T12:00:00.000Z');

describe('getSessionWarmth', () => {
  it('COLD when never turned', () => {
    expect(getSessionWarmth({}, NOW)).toBe('COLD');
  });

  it('HOT under 1 minute', () => {
    expect(
      getSessionWarmth({ lastTurnAt: new Date(NOW - 30_000).toISOString() }, NOW),
    ).toBe('HOT');
  });

  it('WARM between 1m and 5m', () => {
    expect(
      getSessionWarmth({ lastTurnAt: new Date(NOW - 3 * 60_000).toISOString() }, NOW),
    ).toBe('WARM');
  });

  it('COLD between 5m and 30m', () => {
    expect(
      getSessionWarmth({ lastTurnAt: new Date(NOW - 20 * 60_000).toISOString() }, NOW),
    ).toBe('COLD');
  });

  it('STALE after 30m', () => {
    expect(
      getSessionWarmth({ lastTurnAt: new Date(NOW - 45 * 60_000).toISOString() }, NOW),
    ).toBe('STALE');
  });
});

describe('estimateResumeCostUsd', () => {
  it('returns 0 for empty / invalid tokenCount', () => {
    expect(estimateResumeCostUsd(0, 'HOT')).toBe(0);
    expect(estimateResumeCostUsd(NaN, 'HOT')).toBe(0);
  });

  it('warm/hot use the cache-read rate', () => {
    const cold = estimateResumeCostUsd(100_000, 'COLD');
    const warm = estimateResumeCostUsd(100_000, 'WARM');
    expect(warm).toBeLessThan(cold);
    expect(warm).toBeGreaterThan(0);
  });
});

describe('shouldCompact', () => {
  it('skips when not IDLE', () => {
    expect(shouldCompact({ status: 'ACTIVE', tokenCount: 200_000 })).toBe(false);
  });

  it('skips when below threshold', () => {
    expect(shouldCompact({ status: 'IDLE', tokenCount: 1000 })).toBe(false);
  });

  it('skips already-compacted artifacts', () => {
    expect(
      shouldCompact({ status: 'IDLE', tokenCount: 200_000, compactedFrom: 'prev' }),
    ).toBe(false);
  });

  it('triggers when IDLE + over threshold', () => {
    expect(shouldCompact({ status: 'IDLE', tokenCount: 200_000 })).toBe(true);
  });
});

describe('isStaleSession', () => {
  it('returns false for never-turned sessions', () => {
    expect(isStaleSession({}, NOW)).toBe(false);
  });

  it('returns true for sessions older than the threshold', () => {
    expect(
      isStaleSession({ lastTurnAt: new Date(NOW - 60 * 60_000).toISOString() }, NOW),
    ).toBe(true);
  });
});
