import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, sessionsListByOperatorMock, sessionsListByScopeMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  sessionsListByOperatorMock: vi.fn(),
  sessionsListByScopeMock: vi.fn(),
}));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    freeAgentConversations: 'test-free-agent-conversations',
    freeAgentSessions: 'test-free-agent-sessions',
  },
}));

vi.mock('../free-agent-sessions-repository', () => ({
  listSessionsByOperator: sessionsListByOperatorMock,
  listSessionsByScope: sessionsListByScopeMock,
}));

import {
  appendMessage,
  getMessages,
  listSessionsByOperator,
  listSessionsByScope,
  getFirstUserMessagePreview,
} from '../free-agent-conversations-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
  sessionsListByOperatorMock.mockReset();
  sessionsListByScopeMock.mockReset();
});

describe('appendMessage (AC #2, AC #3)', () => {
  it('writes a row with zero-padded messageIndex=000001 when no prior messages', async () => {
    // First call: getMessages → no items
    sendMock.mockResolvedValueOnce({ Items: [] });
    // Second call: PutCommand
    sendMock.mockResolvedValueOnce({});

    const result = await appendMessage({
      sessionId: 'sid-1',
      role: 'user',
      content: 'hello world',
    });

    expect(result.messageIndex).toBe('000001');
    expect(result.role).toBe('user');
    expect(result.content).toBe('hello world');
    expect(result.sessionId).toBe('sid-1');
    expect(typeof result.createdAt).toBe('string');
    expect(typeof result.expiresAt).toBe('number');

    // Verify the PutCommand input
    const putInput = extract(sendMock.mock.calls[1][0]);
    expect(putInput.TableName).toBe('test-free-agent-conversations');
    expect(putInput.ConditionExpression).toBe(
      'attribute_not_exists(sessionId) AND attribute_not_exists(messageIndex)',
    );
    expect(putInput.Item).toMatchObject({
      sessionId: 'sid-1',
      messageIndex: '000001',
      role: 'user',
      content: 'hello world',
    });
  });

  it('increments messageIndex based on existing message count', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { sessionId: 'sid-1', messageIndex: '000001' },
        { sessionId: 'sid-1', messageIndex: '000002' },
      ],
    });
    sendMock.mockResolvedValueOnce({});

    const result = await appendMessage({
      sessionId: 'sid-1',
      role: 'user',
      content: 'third message',
    });

    expect(result.messageIndex).toBe('000003');
  });

  it('sets 90-day TTL on expiresAt', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    sendMock.mockResolvedValueOnce({});

    const before = Math.floor(Date.now() / 1000);
    const result = await appendMessage({
      sessionId: 'sid-1',
      role: 'user',
      content: 'x',
    });
    const ninetyDays = 90 * 24 * 60 * 60;

    expect(result.expiresAt).toBeGreaterThanOrEqual(before + ninetyDays - 2);
    expect(result.expiresAt).toBeLessThanOrEqual(before + ninetyDays + 2);
  });

  it('persists tokens + cost + toolCalls when provided', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    sendMock.mockResolvedValueOnce({});

    const result = await appendMessage({
      sessionId: 'sid-1',
      role: 'assistant',
      content: 'response',
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.0123,
      toolCalls: [{ id: 'tu-1', name: 'Read', input: { file: 'a.md' } }],
    });

    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(50);
    expect(result.costUsd).toBe(0.0123);
    expect(result.toolCalls).toEqual([{ id: 'tu-1', name: 'Read', input: { file: 'a.md' } }]);
  });
});

describe('getMessages (AC #2)', () => {
  it('queries by sessionId ascending', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { sessionId: 'sid-1', messageIndex: '000001', role: 'user', content: 'a' },
        { sessionId: 'sid-1', messageIndex: '000002', role: 'assistant', content: 'b' },
      ],
    });

    const result = await getMessages('sid-1');
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('a');
    expect(result[1].content).toBe('b');

    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.KeyConditionExpression).toBe('sessionId = :sid');
    expect(input.ExpressionAttributeValues).toEqual({ ':sid': 'sid-1' });
    expect(input.ScanIndexForward).toBe(true);
  });

  it('paginates through multiple pages', async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [{ sessionId: 'sid-1', messageIndex: '000001' }],
        LastEvaluatedKey: { sessionId: 'sid-1', messageIndex: '000001' },
      })
      .mockResolvedValueOnce({
        Items: [{ sessionId: 'sid-1', messageIndex: '000002' }],
        LastEvaluatedKey: undefined,
      });

    const result = await getMessages('sid-1');
    expect(result).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no messages', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    expect(await getMessages('sid-1')).toEqual([]);
  });
});

describe('listSessionsByOperator / listSessionsByScope (AC #2 delegates)', () => {
  it('listSessionsByOperator delegates to the sessions repo', async () => {
    sessionsListByOperatorMock.mockResolvedValue([
      { sessionId: 's1', operatorId: 'op-rick' } as never,
    ]);
    const result = await listSessionsByOperator('op-rick', 5);
    expect(sessionsListByOperatorMock).toHaveBeenCalledWith('op-rick', 5);
    expect(result).toHaveLength(1);
  });

  it('listSessionsByScope delegates to the sessions repo', async () => {
    sessionsListByScopeMock.mockResolvedValue([
      { sessionId: 's1', scope: { kind: 'plan', id: 'dino-7' } } as never,
    ]);
    const result = await listSessionsByScope({ kind: 'plan', id: 'dino-7' }, 7);
    expect(sessionsListByScopeMock).toHaveBeenCalledWith({ kind: 'plan', id: 'dino-7' }, 7);
    expect(result).toHaveLength(1);
  });
});

describe('getFirstUserMessagePreview (AC #4 framing)', () => {
  it('returns the first user message trimmed to maxChars', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { sessionId: 's', messageIndex: '000001', role: 'system', content: 'system msg' },
        { sessionId: 's', messageIndex: '000002', role: 'user', content: 'investigate the plan' },
        { sessionId: 's', messageIndex: '000003', role: 'assistant', content: 'response' },
      ],
    });
    const preview = await getFirstUserMessagePreview('s', 80);
    expect(preview).toBe('investigate the plan');
  });

  it('appends an ellipsis when content exceeds maxChars', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          sessionId: 's',
          messageIndex: '000001',
          role: 'user',
          content: 'a'.repeat(120),
        },
      ],
    });
    const preview = await getFirstUserMessagePreview('s', 80);
    expect(preview).toHaveLength(81); // 80 + ellipsis
    expect(preview!.endsWith('…')).toBe(true);
  });

  it('returns null when no user message exists', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ sessionId: 's', messageIndex: '000001', role: 'system', content: 'only system' }],
    });
    expect(await getFirstUserMessagePreview('s')).toBeNull();
  });

  it('returns null on a fresh session with no messages', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    expect(await getFirstUserMessagePreview('s')).toBeNull();
  });
});
