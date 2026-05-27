import { describe, it, expect } from 'vitest';
import { classifyAlarm, buildAttentionFromAlarm } from '../cw-to-attention';

/**
 * 2026-05-27 PR D.c — CloudWatch alarm classifier unit tests.
 */

describe('classifyAlarm', () => {
  it('maps daemon heartbeat → daemon-shutdown-timeout critical', () => {
    expect(classifyAlarm({ AlarmName: 'futurator-daemon-heartbeat-missing' })).toEqual({
      category: 'daemon-shutdown-timeout',
      severity: 'critical',
    });
  });

  it('maps Lambda errors → policy-violation high', () => {
    expect(classifyAlarm({ AlarmName: 'api-lambda-errors-high' })).toEqual({
      category: 'policy-violation',
      severity: 'high',
    });
  });

  it('maps API 5xx → policy-violation high', () => {
    expect(classifyAlarm({ AlarmName: 'admin-api-5xx-rate' })).toEqual({
      category: 'policy-violation',
      severity: 'high',
    });
  });

  it('maps DDB throttling → policy-violation medium', () => {
    expect(classifyAlarm({ AlarmName: 'ddb-throttle-spike' })).toEqual({
      category: 'policy-violation',
      severity: 'medium',
    });
  });

  it('falls back to other/medium for unrecognized names', () => {
    expect(classifyAlarm({ AlarmName: 'some-other-thing' })).toEqual({
      category: 'other',
      severity: 'medium',
    });
  });

  it('falls back to other/medium when AlarmName is missing', () => {
    expect(classifyAlarm({})).toEqual({ category: 'other', severity: 'medium' });
  });
});

describe('buildAttentionFromAlarm', () => {
  it('produces a well-formed AttentionItem', () => {
    const item = buildAttentionFromAlarm({
      AlarmName: 'futurator-daemon-heartbeat-missing',
      NewStateValue: 'ALARM',
      NewStateReason: 'No heartbeat for 5 minutes',
      StateChangeTime: '2026-05-27T20:00:00.000Z',
      Region: 'us-east-1',
      Trigger: { MetricName: 'HeartbeatAge', Namespace: 'Futurator/Daemon' },
    });
    expect(item.planId).toBe('__cloudwatch__');
    expect(item.severity).toBe('critical');
    expect(item.category).toBe('daemon-shutdown-timeout');
    expect(item.status).toBe('open');
    expect(item.dedupKey).toBe('cw:futurator-daemon-heartbeat-missing:2026-05-27T20:00:00.000Z');
    expect(item.title).toContain('futurator-daemon-heartbeat-missing');
    expect(item.body).toContain('No heartbeat');
    expect(item.body).toContain('Futurator/Daemon');
    expect(item.body).toContain('HeartbeatAge');
  });

  it('handles missing optional fields cleanly', () => {
    const item = buildAttentionFromAlarm({ AlarmName: 'minimal' });
    expect(item.body).toContain('minimal');
    expect(item.body).toContain('(no reason provided)');
  });

  it('emits a stable dedupKey for retry-safe SNS delivery', () => {
    const a = buildAttentionFromAlarm({
      AlarmName: 'x',
      StateChangeTime: '2026-05-27T20:00:00.000Z',
    });
    const b = buildAttentionFromAlarm({
      AlarmName: 'x',
      StateChangeTime: '2026-05-27T20:00:00.000Z',
    });
    expect(a.dedupKey).toBe(b.dedupKey);
    expect(a.itemId).not.toBe(b.itemId); // itemIds differ — dedup is via dedupKey upstream
  });
});
