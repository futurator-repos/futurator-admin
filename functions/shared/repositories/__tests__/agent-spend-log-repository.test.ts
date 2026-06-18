import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { agentSpendLog: 'test-agent-spend-log' },
}));

import {
  writeSpendRow,
  getDailySpend,
  todayUtc,
  utcDateRange,
  listSpendByJobIds,
} from '../agent-spend-log-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('writeSpendRow', () => {
  it('builds a row with GSI1PK=YYYY-MM-DD + GSI1SK=createdAt and writes it', async () => {
    sendMock.mockResolvedValue({});
    const row = await writeSpendRow({
      jobId: 'job-1',
      sessionId: 'sid-1',
      projectId: 'snake-4',
      agentClass: 'free-agent',
      walltimeSec: 12,
      costUsd: 0.24,
      createdAt: '2026-05-27T20:00:00.000Z',
    });
    expect(row.GSI1PK).toBe('2026-05-27');
    expect(row.GSI1SK).toBe('2026-05-27T20:00:00.000Z');
    expect(row.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const input = extract(sendMock.mock.calls[0][0]);
    expect((input.Item as Record<string, unknown>).walltimeSec).toBe(12);
    expect((input.Item as Record<string, unknown>).costUsd).toBe(0.24);
  });

  it('clamps non-finite or negative metrics to 0', async () => {
    sendMock.mockResolvedValue({});
    const row = await writeSpendRow({
      agentClass: 'party',
      walltimeSec: -5,
      costUsd: NaN,
      createdAt: '2026-05-27T01:00:00.000Z',
    });
    expect(row.walltimeSec).toBe(0);
    expect(row.costUsd).toBe(0);
  });

  it('generates a uuid logId per row', async () => {
    sendMock.mockResolvedValue({});
    const a = await writeSpendRow({
      agentClass: 'free-agent',
      walltimeSec: 1,
      costUsd: 0.02,
      createdAt: '2026-05-27T00:00:00.000Z',
    });
    const b = await writeSpendRow({
      agentClass: 'free-agent',
      walltimeSec: 1,
      costUsd: 0.02,
      createdAt: '2026-05-27T00:00:01.000Z',
    });
    expect(a.logId).not.toBe(b.logId);
    expect(a.logId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('getDailySpend', () => {
  it('returns zeros when the day has no rows', async () => {
    sendMock.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const result = await getDailySpend('2026-05-27');
    expect(result).toEqual({
      date: '2026-05-27',
      totalCostUsd: 0,
      totalWalltimeSec: 0,
      rowCount: 0,
    });
  });

  it('sums across rows for a date', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { costUsd: 0.5, walltimeSec: 25 },
        { costUsd: 1.2, walltimeSec: 60 },
        { costUsd: 0.1, walltimeSec: 5 },
      ],
      LastEvaluatedKey: undefined,
    });
    const result = await getDailySpend('2026-05-27');
    expect(result.totalCostUsd).toBeCloseTo(1.8, 5);
    expect(result.totalWalltimeSec).toBe(90);
    expect(result.rowCount).toBe(3);
  });

  it('paginates across LastEvaluatedKey pages', async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [{ costUsd: 1, walltimeSec: 50 }],
        LastEvaluatedKey: { k: 1 },
      })
      .mockResolvedValueOnce({
        Items: [{ costUsd: 2, walltimeSec: 100 }],
        LastEvaluatedKey: undefined,
      });
    const result = await getDailySpend('2026-05-27');
    expect(result.totalCostUsd).toBe(3);
    expect(result.totalWalltimeSec).toBe(150);
    expect(result.rowCount).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('queries the date-createdAt-index with GSI1PK keyed on the date', async () => {
    sendMock.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await getDailySpend('2026-05-27');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.IndexName).toBe('date-createdAt-index');
    expect(input.KeyConditionExpression).toBe('GSI1PK = :d');
    expect(input.ExpressionAttributeValues).toEqual({ ':d': '2026-05-27' });
  });
});

describe('todayUtc', () => {
  it('formats the date in YYYY-MM-DD UTC', () => {
    expect(todayUtc(new Date('2026-05-27T23:30:00Z'))).toBe('2026-05-27');
    // 00:30 UTC the next day, regardless of local tz, is the next date
    expect(todayUtc(new Date('2026-05-28T00:30:00Z'))).toBe('2026-05-28');
  });
});

describe('utcDateRange', () => {
  it('returns a single date for a same-day window (plus the +1d completion pad)', () => {
    expect(utcDateRange('2026-06-18T07:14:54Z', '2026-06-18T10:15:49Z')).toEqual([
      '2026-06-18',
      '2026-06-19',
    ]);
  });

  it('spans multiple days inclusively', () => {
    expect(utcDateRange('2026-06-18T23:00:00Z', '2026-06-20T01:00:00Z')).toEqual([
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
    ]);
  });

  it('caps the fan-out at maxDays', () => {
    const out = utcDateRange('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 5);
    expect(out).toHaveLength(5);
  });

  it('handles a reversed/invalid window gracefully', () => {
    expect(utcDateRange('2026-06-20T00:00:00Z', '2026-06-18T00:00:00Z')).toEqual(['2026-06-20']);
    expect(utcDateRange('not-a-date', 'also-bad')).toEqual([]);
  });
});

describe('listSpendByJobIds', () => {
  it('returns [] without querying for empty inputs', async () => {
    expect(await listSpendByJobIds(new Set(), ['2026-06-18'])).toEqual([]);
    expect(await listSpendByJobIds(new Set(['j1']), [])).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('queries each date partition and keeps only rows whose jobId is in the set', async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [
          { jobId: 'j1', costUsd: 5 },
          { jobId: 'orphan', costUsd: 99 }, // present in partition but not in the plan
        ],
        LastEvaluatedKey: undefined,
      })
      .mockResolvedValueOnce({
        Items: [{ jobId: 'j2', costUsd: 7 }],
        LastEvaluatedKey: undefined,
      });
    const rows = await listSpendByJobIds(new Set(['j1', 'j2']), ['2026-06-18', '2026-06-19']);
    expect(rows.map((r) => r.jobId)).toEqual(['j1', 'j2']);
    expect(rows.reduce((s, r) => s + (r.costUsd ?? 0), 0)).toBe(12);
    const first = extract(sendMock.mock.calls[0][0]);
    expect(first.IndexName).toBe('date-createdAt-index');
    expect(first.ExpressionAttributeValues).toEqual({ ':d': '2026-06-18' });
  });

  it('paginates within a date partition', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [{ jobId: 'j1', costUsd: 1 }], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [{ jobId: 'j1', costUsd: 2 }], LastEvaluatedKey: undefined });
    const rows = await listSpendByJobIds(new Set(['j1']), ['2026-06-18']);
    expect(rows).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
