import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { queueRequests: 'test-queue-requests' },
}));

import {
  createRequest,
  getRequestById,
  listRequestsByStatus,
  updateRequestFields,
} from '../queue-requests-repository';
import { ingestQueueRequestSchema, setCapSchema } from '../../schemas/queue-request-schema';
import type { QueueRequest } from '../../types/queue-request';

function input(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

function makeRow(overrides: Partial<QueueRequest> = {}): QueueRequest {
  return {
    requestId: 'req-1',
    status: 'QUEUED',
    source: 'test',
    target: 'ec2',
    method: 'POST',
    path: '/api/queue/test',
    prompt: 'do a thing',
    autoRespond: false,
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    audit: [],
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

beforeEach(() => sendMock.mockReset());

describe('queue-request schemas', () => {
  it('ingest requires source and either prompt or body', () => {
    expect(
      ingestQueueRequestSchema.safeParse({ source: 'atlassinator', prompt: 'hi' }).success,
    ).toBe(true);
    expect(ingestQueueRequestSchema.safeParse({ source: 'x', body: { a: 1 } }).success).toBe(true);
    // Missing both prompt and body → invalid.
    expect(ingestQueueRequestSchema.safeParse({ source: 'x' }).success).toBe(false);
    // Missing source → invalid.
    expect(ingestQueueRequestSchema.safeParse({ prompt: 'hi' }).success).toBe(false);
    // Bad callbackUrl → invalid.
    expect(
      ingestQueueRequestSchema.safeParse({ source: 'x', prompt: 'hi', callbackUrl: 'not-a-url' })
        .success,
    ).toBe(false);
  });

  it('setCap enforces an integer in [1,16] and a known target', () => {
    expect(setCapSchema.safeParse({ target: 'ec2', maxConcurrent: 3 }).success).toBe(true);
    expect(setCapSchema.safeParse({ target: 'local', maxConcurrent: 1 }).success).toBe(true);
    expect(setCapSchema.safeParse({ target: 'ec2', maxConcurrent: 0 }).success).toBe(false);
    expect(setCapSchema.safeParse({ target: 'ec2', maxConcurrent: 17 }).success).toBe(false);
    expect(setCapSchema.safeParse({ target: 'ec2', maxConcurrent: 2.5 }).success).toBe(false);
    expect(setCapSchema.safeParse({ target: 'nope', maxConcurrent: 2 }).success).toBe(false);
  });
});

describe('queue-requests-repository', () => {
  it('createRequest writes the row to the queue-requests table', async () => {
    sendMock.mockResolvedValueOnce({});
    const row = makeRow();
    const out = await createRequest(row);
    expect(out).toBe(row);
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.TableName).toBe('test-queue-requests');
    expect(cmd.Item).toEqual(row);
  });

  it('getRequestById returns the row or null', async () => {
    sendMock.mockResolvedValueOnce({ Item: makeRow() });
    expect((await getRequestById('req-1'))?.requestId).toBe('req-1');
    sendMock.mockResolvedValueOnce({});
    expect(await getRequestById('missing')).toBeNull();
  });

  it('listRequestsByStatus queries the GSI newest-first', async () => {
    sendMock.mockResolvedValueOnce({ Items: [makeRow()] });
    const rows = await listRequestsByStatus('QUEUED');
    expect(rows).toHaveLength(1);
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.IndexName).toBe('status-createdAt-index');
    expect(cmd.ScanIndexForward).toBe(false);
    expect(cmd.ExpressionAttributeValues).toMatchObject({ ':s': 'QUEUED' });
  });

  it('updateRequestFields skips undefined and always bumps updatedAt', async () => {
    sendMock.mockResolvedValueOnce({});
    await updateRequestFields('req-1', { status: 'RUNNING', error: undefined });
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.UpdateExpression).toContain('#status = :status');
    expect(cmd.UpdateExpression).toContain('#updatedAt = :updatedAt');
    expect(cmd.UpdateExpression).not.toContain('error');
  });

  it('updateRequestFields is a no-op when nothing is set', async () => {
    await updateRequestFields('req-1', {});
    expect(sendMock).not.toHaveBeenCalled();
  });
});
