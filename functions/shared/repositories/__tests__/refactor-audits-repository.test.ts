import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { refactorAudits: 'test-refactor-audits' },
}));

import {
  putAudit,
  getAudit,
  listAuditsByProject,
  deleteAuditsForProject,
} from '../refactor-audits-repository';
import type { RefactorAuditRecord } from '../../types/refactor-audit';

const record = (over: Partial<RefactorAuditRecord> = {}): RefactorAuditRecord => ({
  auditId: 'a1',
  projectId: 'applicator',
  projectPath: '/home/ubuntu/projects/applicator',
  jobId: 'job-1',
  status: 'adjudicated',
  counts: { 'god-object': 1 },
  hotspots: [],
  createdAt: '2026-06-23T00:00:00.000Z',
  createdBy: 'u1',
  ...over,
});

beforeEach(() => sendMock.mockReset());

describe('refactor-audits-repository', () => {
  it('putAudit issues a PutCommand to the audits table', async () => {
    sendMock.mockResolvedValueOnce({});
    await putAudit(record());
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.TableName).toBe('test-refactor-audits');
    expect(cmd.input.Item.auditId).toBe('a1');
  });

  it('getAudit returns the item or null', async () => {
    sendMock.mockResolvedValueOnce({ Item: record() });
    expect((await getAudit('a1'))?.auditId).toBe('a1');
    sendMock.mockResolvedValueOnce({});
    expect(await getAudit('missing')).toBeNull();
  });

  it('listAuditsByProject queries the GSI newest-first', async () => {
    sendMock.mockResolvedValueOnce({ Items: [record(), record({ auditId: 'a2' })] });
    const rows = await listAuditsByProject('applicator', 5);
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.IndexName).toBe('projectId-createdAt-index');
    expect(cmd.input.ScanIndexForward).toBe(false);
    expect(cmd.input.Limit).toBe(5);
    expect(rows).toHaveLength(2);
  });

  it('deleteAuditsForProject lists then deletes each, returning the count', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [record(), record({ auditId: 'a2' })] }) // list
      .mockResolvedValueOnce({}) // delete a1
      .mockResolvedValueOnce({}); // delete a2
    const n = await deleteAuditsForProject('applicator');
    expect(n).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
});
