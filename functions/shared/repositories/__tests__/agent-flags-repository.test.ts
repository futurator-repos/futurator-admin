import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { agentFlags: 'test-agent-flags' },
}));

import {
  getFlag,
  setFlag,
  listAllFlags,
  isAgentPaused,
  AGENT_FLAG_KEYS,
} from '../agent-flags-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('AGENT_FLAG_KEYS', () => {
  it('exposes the canonical pause key', () => {
    expect(AGENT_FLAG_KEYS.paused).toBe('agent.paused');
  });
});

describe('getFlag', () => {
  it('returns null when the row is absent', async () => {
    sendMock.mockResolvedValue({});
    expect(await getFlag('agent.paused')).toBeNull();
  });

  it('returns the row when present', async () => {
    sendMock.mockResolvedValue({
      Item: {
        flagName: 'agent.paused',
        value: 'true',
        updatedBy: 'op-rick',
        updatedAt: '2026-05-27T00:00:00Z',
      },
    });
    const row = await getFlag('agent.paused');
    expect(row?.value).toBe('true');
    expect(row?.updatedBy).toBe('op-rick');
  });

  it('passes the flagName through to the GetCommand key', async () => {
    sendMock.mockResolvedValue({});
    await getFlag('agent.custom');
    expect(extract(sendMock.mock.calls[0][0]).Key).toEqual({ flagName: 'agent.custom' });
  });
});

describe('isAgentPaused', () => {
  it('returns true only when the row has value === "true"', async () => {
    sendMock.mockResolvedValue({ Item: { value: 'true' } });
    expect(await isAgentPaused()).toBe(true);
  });

  it('returns false for any other value', async () => {
    sendMock.mockResolvedValue({ Item: { value: 'false' } });
    expect(await isAgentPaused()).toBe(false);
  });

  it('returns false when the row is absent', async () => {
    sendMock.mockResolvedValue({});
    expect(await isAgentPaused()).toBe(false);
  });

  it('does not match truthy-like strings', async () => {
    sendMock.mockResolvedValue({ Item: { value: '1' } });
    expect(await isAgentPaused()).toBe(false);
  });
});

describe('setFlag', () => {
  it('upserts the flag with updatedBy + updatedAt', async () => {
    sendMock.mockResolvedValue({});
    const row = await setFlag('agent.paused', 'true', 'op-rick');
    expect(row.flagName).toBe('agent.paused');
    expect(row.value).toBe('true');
    expect(row.updatedBy).toBe('op-rick');
    expect(Date.parse(row.updatedAt)).not.toBeNaN();
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.Item).toMatchObject({
      flagName: 'agent.paused',
      value: 'true',
      updatedBy: 'op-rick',
    });
  });
});

describe('listAllFlags', () => {
  it('returns an empty array when the table is empty', async () => {
    sendMock.mockResolvedValue({});
    expect(await listAllFlags()).toEqual([]);
  });

  it('returns whatever the Scan returned', async () => {
    sendMock.mockResolvedValue({
      Items: [{ flagName: 'agent.paused', value: 'true' }],
    });
    const all = await listAllFlags();
    expect(all).toHaveLength(1);
    expect(all[0].flagName).toBe('agent.paused');
  });
});
