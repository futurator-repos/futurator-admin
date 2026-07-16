import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { servers: 'test-servers' },
}));

import {
  createServer,
  getServerById,
  listServers,
  updateServerFields,
  findServerByEnrollTokenHash,
} from '../servers-repository';
import type { ComputeServer } from '../../types/compute-server';

function input(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

const row: ComputeServer = {
  serverId: 'srv_test_1',
  name: 't',
  provider: 'hetzner',
  serviceType: 'vm',
  region: 'fsn1',
  size: 'cax11',
  arch: 'arm64',
  status: 'ACTIVE',
  enabled: true,
  maxConcurrent: 2,
  costPerHour: 0.01,
  providerRef: {},
  enrollTokenHash: 'h1',
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
};

beforeEach(() => sendMock.mockReset());

describe('servers-repository', () => {
  it('createServer puts the row', async () => {
    sendMock.mockResolvedValueOnce({});
    await createServer(row);
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.TableName).toBe('test-servers');
    expect((cmd.Item as ComputeServer).serverId).toBe('srv_test_1');
  });

  it('getServerById returns null when missing', async () => {
    sendMock.mockResolvedValueOnce({});
    expect(await getServerById('nope')).toBeNull();
  });

  it('getServerById returns the row when present', async () => {
    sendMock.mockResolvedValueOnce({ Item: row });
    expect((await getServerById('srv_test_1'))?.serverId).toBe('srv_test_1');
  });

  it('listServers filters DELETED by default', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [row, { ...row, serverId: 'srv_2', status: 'DELETED' }],
    });
    const list = await listServers();
    expect(list.map((s) => s.serverId)).toEqual(['srv_test_1']);
  });

  it('listServers includes DELETED when includeDeleted is true', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [row, { ...row, serverId: 'srv_2', status: 'DELETED' }],
    });
    const list = await listServers({ includeDeleted: true });
    expect(list.map((s) => s.serverId).sort()).toEqual(['srv_2', 'srv_test_1']);
  });

  it('updateServerFields builds a partial SET and bumps updatedAt', async () => {
    sendMock.mockResolvedValueOnce({});
    await updateServerFields('srv_test_1', { enabled: false, statusMessage: 'x' });
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.UpdateExpression).toContain('updatedAt');
    expect(cmd.UpdateExpression).toContain('enabled');
    expect(cmd.UpdateExpression).toContain('statusMessage');
  });

  it('updateServerFields aliases the reserved word status', async () => {
    sendMock.mockResolvedValueOnce({});
    await updateServerFields('srv_test_1', { status: 'PAUSED' });
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.UpdateExpression).toContain('#status = :status');
    expect((cmd.ExpressionAttributeNames as Record<string, string>)['#status']).toBe('status');
  });

  it('updateServerFields is a no-op when nothing is set', async () => {
    await updateServerFields('srv_test_1', {});
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('findServerByEnrollTokenHash scans for the hash', async () => {
    sendMock.mockResolvedValueOnce({ Items: [row] });
    const s = await findServerByEnrollTokenHash('h1');
    expect(s?.serverId).toBe('srv_test_1');
  });

  it('findServerByEnrollTokenHash returns null when not found', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    expect(await findServerByEnrollTokenHash('missing')).toBeNull();
  });
});
