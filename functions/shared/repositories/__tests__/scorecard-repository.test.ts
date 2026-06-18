import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { scorecards: 'test-scorecards' },
}));

import {
  scorecardKey,
  putScorecardSlice,
  getScorecard,
  getScorecardStage,
  type ScorecardItemInput,
} from '../scorecard-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

const baseInput: ScorecardItemInput = {
  scores: { 'D-CC1': 3 },
  verdicts: { 'D-CC1': '🟡' },
  evidenceRefs: { 'D-CC1': { kind: 'forensic', ref: 'aggregate.byCategory.compile.count' } },
  rubricVersion: 'IGNORED',
  scoredBy: 'deterministic',
  scoredAt: '2026-06-18T00:00:00.000Z',
};

beforeEach(() => {
  sendMock.mockReset();
});

describe('scorecardKey', () => {
  it('joins stage and rubricVersion with #', () => {
    expect(scorecardKey('development', 'v0')).toBe('development#v0');
    expect(scorecardKey('overview', 'v1')).toBe('overview#v1');
  });
});

describe('putScorecardSlice', () => {
  it('writes a row keyed by planId + <stage>#<rubricVersion> and pins rubricVersion to the SK', async () => {
    sendMock.mockResolvedValue({});
    const row = await putScorecardSlice('plan_dino7_x', 'development', 'v0', baseInput);

    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.TableName).toBe('test-scorecards');
    const item = input.Item as Record<string, unknown>;
    expect(item.planId).toBe('plan_dino7_x');
    expect(item.scorecardKey).toBe('development#v0');
    expect(item.stage).toBe('development');
    // The SK is the authority: the caller's stale rubricVersion is overwritten.
    expect(item.rubricVersion).toBe('v0');
    expect(row.rubricVersion).toBe('v0');
    expect(row.scorecardKey).toBe('development#v0');
  });

  it('never hardcodes a planId — round-trips whatever caller passes', async () => {
    sendMock.mockResolvedValue({});
    const row = await putScorecardSlice('some_other_plan', 'overview', 'v0', {
      ...baseInput,
      pipelineHealth: 0.42,
      gradeBand: 'D',
    });
    expect(row.planId).toBe('some_other_plan');
    expect(row.pipelineHealth).toBe(0.42);
    expect(row.gradeBand).toBe('D');
  });
});

describe('getScorecardStage', () => {
  it('queries begins_with(<stage>#) descending, limit 1, returns newest', async () => {
    sendMock.mockResolvedValue({
      Items: [{ planId: 'p', scorecardKey: 'development#v1', stage: 'development' }],
    });
    const row = await getScorecardStage('p', 'development');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.KeyConditionExpression).toContain('begins_with(scorecardKey, :prefix)');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':prefix']).toBe(
      'development#',
    );
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(1);
    expect(row?.scorecardKey).toBe('development#v1');
  });

  it('returns null when no rows', async () => {
    sendMock.mockResolvedValue({ Items: [] });
    expect(await getScorecardStage('p', 'qa')).toBeNull();
  });
});

describe('getScorecard', () => {
  it('reduces to the latest rubricVersion per stage', async () => {
    sendMock.mockResolvedValue({
      Items: [
        { planId: 'p', scorecardKey: 'development#v0', stage: 'development' },
        { planId: 'p', scorecardKey: 'development#v1', stage: 'development' },
        { planId: 'p', scorecardKey: 'qa#v0', stage: 'qa' },
        { planId: 'p', scorecardKey: 'overview#v0', stage: 'overview' },
      ],
    });
    const rows = await getScorecard('p');
    const byStage = Object.fromEntries(rows.map((r) => [r.stage, r.scorecardKey]));
    // development#v1 wins over development#v0; others pass through.
    expect(byStage.development).toBe('development#v1');
    expect(byStage.qa).toBe('qa#v0');
    expect(byStage.overview).toBe('overview#v0');
    expect(rows).toHaveLength(3);
  });

  it('paginates via LastEvaluatedKey', async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [{ planId: 'p', scorecardKey: 'concept#v0', stage: 'concept' }],
        LastEvaluatedKey: { planId: 'p', scorecardKey: 'concept#v0' },
      })
      .mockResolvedValueOnce({
        Items: [{ planId: 'p', scorecardKey: 'qa#v0', stage: 'qa' }],
      });
    const rows = await getScorecard('p');
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    // Second Query carried the ExclusiveStartKey.
    expect(extract(sendMock.mock.calls[1][0]).ExclusiveStartKey).toEqual({
      planId: 'p',
      scorecardKey: 'concept#v0',
    });
  });
});
