/**
 * metrics-csv.test.mjs — Pipeline v2 Phase 2-A / Story 2-A-7-2 (PR-84).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendStepEvent,
  readMetricsRows,
  computeRollingMedians,
  checkWaveThreshold,
} from '../metrics-csv.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'metrics-csv-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('appendStepEvent', () => {
  it('writes header on first append', () => {
    const path = appendStepEvent({
      workingDir: tmp,
      event: { planId: 'p1', stepId: 'dev', durationMs: 1000 },
    });
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content.split('\n')[0]).toContain('timestamp,planId');
  });

  it('appends second event without re-writing header', () => {
    appendStepEvent({ workingDir: tmp, event: { planId: 'p1', stepId: 'dev' } });
    appendStepEvent({ workingDir: tmp, event: { planId: 'p1', stepId: 'review' } });
    const rows = readMetricsRows(tmp);
    expect(rows).toHaveLength(2);
    expect(rows[0].stepId).toBe('dev');
    expect(rows[1].stepId).toBe('review');
  });

  it('csv-escapes values containing commas', () => {
    appendStepEvent({
      workingDir: tmp,
      event: { planId: 'p1', stepId: 'dev', agentRole: 'DEV', storyId: 's,1' },
    });
    const path = join(tmp, '.pipeline', 'metrics.csv');
    const text = readFileSync(path, 'utf-8');
    expect(text).toContain('"s,1"');
  });

  it('creates .pipeline/ directory when missing', () => {
    appendStepEvent({ workingDir: tmp, event: { planId: 'p1', stepId: 'dev' } });
    expect(existsSync(join(tmp, '.pipeline'))).toBe(true);
  });
});

describe('readMetricsRows', () => {
  it('returns empty when file missing', () => {
    expect(readMetricsRows(tmp)).toEqual([]);
  });

  it('round-trips written rows', () => {
    appendStepEvent({
      workingDir: tmp,
      event: {
        planId: 'p1',
        waveId: 'w1',
        storyId: 's1',
        stepId: 'dev',
        agentRole: 'DEV',
        durationMs: 1234,
        inputTokens: 500,
        outputTokens: 200,
        exitCode: 0,
        numTurns: 5,
      },
    });
    const rows = readMetricsRows(tmp);
    expect(rows[0]).toMatchObject({
      planId: 'p1',
      waveId: 'w1',
      storyId: 's1',
      stepId: 'dev',
      agentRole: 'DEV',
      durationMs: '1234',
    });
  });
});

describe('computeRollingMedians', () => {
  it('returns empty for empty input', () => {
    expect(computeRollingMedians([])).toEqual(new Map());
  });

  it('groups by stepId+agentRole', () => {
    const rows = [
      { stepId: 'dev', agentRole: 'DEV', durationMs: '100' },
      { stepId: 'dev', agentRole: 'DEV', durationMs: '300' },
      { stepId: 'dev', agentRole: 'DEV', durationMs: '500' },
      { stepId: 'review', agentRole: 'REVIEWER', durationMs: '200' },
    ];
    const m = computeRollingMedians(rows);
    expect(m.get('dev::DEV')).toBe(300);
    expect(m.get('review::REVIEWER')).toBe(200);
  });

  it('handles even count (averages two middle values)', () => {
    const rows = [
      { stepId: 'x', agentRole: 'Y', durationMs: '100' },
      { stepId: 'x', agentRole: 'Y', durationMs: '300' },
    ];
    expect(computeRollingMedians(rows).get('x::Y')).toBe(200);
  });

  it('skips non-numeric or negative durations', () => {
    const rows = [
      { stepId: 'x', agentRole: 'Y', durationMs: 'NaN' },
      { stepId: 'x', agentRole: 'Y', durationMs: '-50' },
      { stepId: 'x', agentRole: 'Y', durationMs: '100' },
    ];
    expect(computeRollingMedians(rows).get('x::Y')).toBe(100);
  });
});

describe('checkWaveThreshold', () => {
  it('flags steps exceeding 1.5× cohort median', () => {
    const cohort = [
      { stepId: 'dev', agentRole: 'DEV', durationMs: '100' },
      { stepId: 'dev', agentRole: 'DEV', durationMs: '100' },
      { stepId: 'dev', agentRole: 'DEV', durationMs: '100' },
    ];
    const wave = [
      { stepId: 'dev', agentRole: 'DEV', durationMs: '200' },
      { stepId: 'dev', agentRole: 'DEV', durationMs: '200' },
    ];
    const flagged = checkWaveThreshold({ waveRows: wave, cohortRows: cohort });
    expect(flagged).toHaveLength(1);
    expect(flagged[0].stepId).toBe('dev');
    expect(flagged[0].ratio).toBe(2);
  });

  it('does not flag when within threshold', () => {
    const cohort = [
      { stepId: 'dev', agentRole: 'DEV', durationMs: '100' },
      { stepId: 'dev', agentRole: 'DEV', durationMs: '100' },
    ];
    const wave = [{ stepId: 'dev', agentRole: 'DEV', durationMs: '130' }];
    expect(checkWaveThreshold({ waveRows: wave, cohortRows: cohort })).toEqual([]);
  });

  it('respects custom multiplier', () => {
    const cohort = [{ stepId: 'x', agentRole: 'Y', durationMs: '100' }];
    const wave = [{ stepId: 'x', agentRole: 'Y', durationMs: '120' }];
    expect(checkWaveThreshold({ waveRows: wave, cohortRows: cohort, multiplier: 1.1 })).toHaveLength(1);
    expect(checkWaveThreshold({ waveRows: wave, cohortRows: cohort, multiplier: 1.5 })).toEqual([]);
  });

  it('sorts flagged buckets by ratio descending', () => {
    const cohort = [
      { stepId: 'a', agentRole: 'X', durationMs: '100' },
      { stepId: 'b', agentRole: 'X', durationMs: '100' },
    ];
    const wave = [
      { stepId: 'a', agentRole: 'X', durationMs: '160' },
      { stepId: 'b', agentRole: 'X', durationMs: '500' },
    ];
    const flagged = checkWaveThreshold({ waveRows: wave, cohortRows: cohort });
    expect(flagged[0].stepId).toBe('b');
    expect(flagged[1].stepId).toBe('a');
  });
});
