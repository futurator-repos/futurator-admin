import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { planSpecGraph: 'test-plan-spec-graph' },
}));

const { deletePlanStoryNodes } = await import('../story-node-repository');

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ storyId: `s${i}`, planId: 'p1' }));
}

describe('deletePlanStoryNodes', () => {
  beforeEach(() => sendMock.mockReset());

  it('queries the plan then batch-deletes every StoryNode by storyId', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: rows(3) }) // getPlanStoryNodes (single page)
      .mockResolvedValueOnce({}); // one BatchWrite (< 25)

    const deleted = await deletePlanStoryNodes('p1');

    expect(deleted).toBe(3);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const batch = sendMock.mock.calls[1][0].input;
    const reqs = batch.RequestItems['test-plan-spec-graph'];
    expect(reqs).toHaveLength(3);
    expect(reqs[0]).toEqual({ DeleteRequest: { Key: { storyId: 's0' } } });
  });

  it('chunks deletes at DynamoDB’s 25-item BatchWrite limit', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: rows(30) }) // 30 rows in one query page
      .mockResolvedValueOnce({}) // BatchWrite chunk 1 (25)
      .mockResolvedValueOnce({}); // BatchWrite chunk 2 (5)

    const deleted = await deletePlanStoryNodes('p1');

    expect(deleted).toBe(30);
    expect(sendMock).toHaveBeenCalledTimes(3); // 1 query + 2 batch writes
    expect(sendMock.mock.calls[1][0].input.RequestItems['test-plan-spec-graph']).toHaveLength(25);
    expect(sendMock.mock.calls[2][0].input.RequestItems['test-plan-spec-graph']).toHaveLength(5);
  });

  it('is a no-op returning 0 when the plan was never ingested', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] }); // getPlanStoryNodes → none

    const deleted = await deletePlanStoryNodes('never-ingested');

    expect(deleted).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1); // query only, no BatchWrite
  });
});
