// Tests for timing-summary-repository.ts (Story 1.8.6)
//
// Covers:
//   - getCohortByKey: hit (returns row), miss (returns null)
//   - upsertCohort: calls PutCommand with correct table + item
//   - listAllCohorts: returns all scanned items, handles pagination

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    timingSummary: 'test-timing-summary',
    agentJobs: 'test-agent-jobs',
    projects: 'test-projects',
    costs: 'test-costs',
    resources: 'test-resources',
    audits: 'test-audits',
    schedules: 'test-schedules',
    users: 'test-users',
    alerts: 'test-alerts',
    agentEvents: 'test-agent-events',
    epicWorkflows: 'test-epic-workflows',
    projectRegistry: 'test-project-registry',
    partyProjects: 'test-party-projects',
    partySessions: 'test-party-sessions',
    plans: 'test-plans',
    apps: 'test-apps',
    attentionItems: 'test-attention-items',
    agentSessions: 'test-agent-sessions',
    agentConversations: 'test-agent-conversations',
  },
}));

import { getCohortByKey, upsertCohort, listAllCohorts } from '../timing-summary-repository';
import type { TimingSummary } from '../timing-summary-repository';

function stubSummary(overrides: Partial<TimingSummary> = {}): TimingSummary {
  return {
    cohortKey: 'nextjs#initial#1',
    lastUpdated: '2026-04-28T06:00:00.000Z',
    samples: 7,
    medianMs: 120_000,
    p90Ms: 180_000,
    byCategory: {} as TimingSummary['byCategory'],
    lastSampleIds: ['plan-1', 'plan-2'],
    ...overrides,
  };
}

function getCommandInput(call: unknown) {
  return (call as { input: Record<string, unknown> }).input;
}

describe('getCohortByKey', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('returns the first item when the query returns a row', async () => {
    const row = stubSummary();
    sendMock.mockResolvedValueOnce({ Items: [row] });

    const result = await getCohortByKey('nextjs#initial#1');

    expect(result).toEqual(row);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = getCommandInput(sendMock.mock.calls[0][0]);
    expect(input.TableName).toBe('test-timing-summary');
    expect(input.KeyConditionExpression).toContain('cohortKey');
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(1);
  });

  it('returns null when the query returns no items', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    const result = await getCohortByKey('nextjs#initial#1');
    expect(result).toBeNull();
  });

  it('returns null when the query returns undefined Items', async () => {
    sendMock.mockResolvedValueOnce({});

    const result = await getCohortByKey('nextjs#initial#1');
    expect(result).toBeNull();
  });
});

describe('upsertCohort', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it('calls PutCommand with the correct table name and item', async () => {
    const row = stubSummary({ cohortKey: 'nextjs#change#3', samples: 8 });

    await upsertCohort(row);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = getCommandInput(sendMock.mock.calls[0][0]);
    expect(input.TableName).toBe('test-timing-summary');
    expect(input.Item).toEqual(row);
  });
});

describe('listAllCohorts', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('returns all items from a single page scan', async () => {
    const rows = [
      stubSummary({ cohortKey: 'nextjs#initial#1' }),
      stubSummary({ cohortKey: 'nextjs#change#3' }),
    ];
    sendMock.mockResolvedValueOnce({ Items: rows, LastEvaluatedKey: undefined });

    const result = await listAllCohorts();
    expect(result).toHaveLength(2);
    expect(result[0].cohortKey).toBe('nextjs#initial#1');
    expect(result[1].cohortKey).toBe('nextjs#change#3');
  });

  it('paginates: concatenates items from multiple scan pages', async () => {
    const page1 = [stubSummary({ cohortKey: 'nextjs#initial#1' })];
    const page2 = [stubSummary({ cohortKey: 'nextjs#change#3' })];

    sendMock
      .mockResolvedValueOnce({ Items: page1, LastEvaluatedKey: { cohortKey: 'nextjs#initial#1' } })
      .mockResolvedValueOnce({ Items: page2, LastEvaluatedKey: undefined });

    const result = await listAllCohorts();
    expect(result).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty array when scan returns no items', async () => {
    sendMock.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const result = await listAllCohorts();
    expect(result).toHaveLength(0);
  });
});
