import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { remediationPolicies: 'test-remediation-policies' },
}));

import { getPolicy, setPolicy, listAllPolicies } from '../remediation-policies-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('getPolicy', () => {
  it('returns "manual" when the row is absent (safe default)', async () => {
    sendMock.mockResolvedValue({});
    expect(await getPolicy('retry-exhausted')).toBe('manual');
  });

  it('returns the stored policy when present', async () => {
    sendMock.mockResolvedValue({
      Item: {
        category: 'retry-exhausted',
        policy: 'auto-draft',
        updatedBy: 'op',
        updatedAt: '2026-05-27T00:00:00Z',
      },
    });
    expect(await getPolicy('retry-exhausted')).toBe('auto-draft');
  });

  it('treats malformed/missing policy field as "manual"', async () => {
    sendMock.mockResolvedValue({ Item: { category: 'retry-exhausted' } });
    expect(await getPolicy('retry-exhausted')).toBe('manual');
  });
});

describe('setPolicy', () => {
  it('upserts the row with updatedBy + updatedAt', async () => {
    sendMock.mockResolvedValue({});
    const row = await setPolicy('test-gate-failed', 'auto-fix', 'op-rick');
    expect(row.policy).toBe('auto-fix');
    expect(row.updatedBy).toBe('op-rick');
    expect(Date.parse(row.updatedAt)).not.toBeNaN();
    const input = extract(sendMock.mock.calls[0][0]);
    expect((input.Item as Record<string, unknown>).category).toBe('test-gate-failed');
  });
});

describe('listAllPolicies', () => {
  it('returns [] when the table is empty', async () => {
    sendMock.mockResolvedValue({});
    expect(await listAllPolicies()).toEqual([]);
  });

  it('returns whatever the Scan returned', async () => {
    sendMock.mockResolvedValue({
      Items: [
        { category: 'retry-exhausted', policy: 'auto-draft' },
        { category: 'test-gate-failed', policy: 'manual' },
      ],
    });
    const all = await listAllPolicies();
    expect(all).toHaveLength(2);
  });
});
