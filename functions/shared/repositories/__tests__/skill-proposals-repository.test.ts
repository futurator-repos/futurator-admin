/**
 * skill-proposals-repository.test.ts — Skills Institution, Story 3.1.
 *
 * Locks the DDB command shapes: GSI Query for listByStatus (newest-first),
 * Scan for listAll, conditional UpdateExpression for status/field patches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { skillProposals: 'test-skill-proposals' },
}));

import {
  putProposal,
  getProposal,
  listByStatus,
  listAllProposals,
  updateStatus,
  patchProposalFields,
} from '../skill-proposals-repository';
import type { SkillProposal } from '../../schemas/skill-proposal-schema';

function input(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

const row: SkillProposal = {
  proposalId: '01HZ-abc',
  source: 'create',
  skillName: 'fix-flaky-tests',
  kind: 'core',
  proposedBody: '# Fix flaky tests',
  proposedEntry: {
    name: 'fix-flaky-tests',
    kind: 'core',
    framework: false,
    version: 'sha:HEAD',
    license: 'MIT',
    description: 'Find and fix flaky tests',
  },
  gist: 'Stabilize flaky tests',
  securityStatus: 'clean',
  qualityGrade: 'ungraded',
  status: 'pending',
  createdAt: '2026-06-17T10:00:00.000Z',
};

beforeEach(() => sendMock.mockReset());

describe('putProposal', () => {
  it('writes the row to the table and returns it', async () => {
    sendMock.mockResolvedValue({});
    const out = await putProposal(row);
    expect(out).toBe(row);
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.TableName).toBe('test-skill-proposals');
    expect(cmd.Item).toEqual(row);
  });
});

describe('getProposal', () => {
  it('returns null when absent', async () => {
    sendMock.mockResolvedValue({});
    expect(await getProposal('nope')).toBeNull();
  });
  it('returns the row by key', async () => {
    sendMock.mockResolvedValue({ Item: row });
    expect((await getProposal('01HZ-abc'))?.skillName).toBe('fix-flaky-tests');
    expect(input(sendMock.mock.calls[0][0]).Key).toEqual({ proposalId: '01HZ-abc' });
  });
});

describe('listByStatus', () => {
  it('queries the GSI newest-first and paginates', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [row], LastEvaluatedKey: { proposalId: 'x' } })
      .mockResolvedValueOnce({ Items: [{ ...row, proposalId: '01HZ-def' }] });
    const out = await listByStatus('pending');
    expect(out).toHaveLength(2);
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.IndexName).toBe('status-createdAt-index');
    expect(cmd.ScanIndexForward).toBe(false);
    expect(cmd.ExpressionAttributeValues).toEqual({ ':status': 'pending' });
    // second call carries the continuation key
    expect(input(sendMock.mock.calls[1][0]).ExclusiveStartKey).toEqual({ proposalId: 'x' });
  });
});

describe('listAllProposals', () => {
  it('scans and sorts newest-first', async () => {
    sendMock.mockResolvedValue({
      Items: [
        { ...row, proposalId: 'a', createdAt: '2026-06-15T00:00:00Z' },
        { ...row, proposalId: 'b', createdAt: '2026-06-17T00:00:00Z' },
      ],
    });
    const out = await listAllProposals();
    expect(out.map((p) => p.proposalId)).toEqual(['b', 'a']);
    expect(input(sendMock.mock.calls[0][0]).TableName).toBe('test-skill-proposals');
  });
});

describe('updateStatus', () => {
  it('builds a conditional SET with decision metadata', async () => {
    sendMock.mockResolvedValue({
      Attributes: { ...row, status: 'ratified', ratifiedBy: 'op-rick' },
    });
    const out = await updateStatus('01HZ-abc', {
      status: 'ratified',
      ratifiedBy: 'op-rick',
      ratifiedAt: '2026-06-17T11:00:00Z',
    });
    expect(out?.status).toBe('ratified');
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.ConditionExpression).toBe('attribute_exists(proposalId)');
    expect(cmd.UpdateExpression).toContain('#status = :status');
    expect(cmd.UpdateExpression).toContain('#ratifiedBy = :ratifiedBy');
    expect(cmd.ExpressionAttributeValues).toMatchObject({
      ':status': 'ratified',
      ':ratifiedBy': 'op-rick',
    });
  });
  it('returns null when the row is gone', async () => {
    sendMock.mockResolvedValue({});
    expect(await updateStatus('gone', { status: 'rejected' })).toBeNull();
  });
});

describe('patchProposalFields', () => {
  it('attaches advisory fields without touching status', async () => {
    sendMock.mockResolvedValue({ Attributes: { ...row, qualityGrade: 'B' } });
    await patchProposalFields('01HZ-abc', {
      llmReview: {
        verdict: 'concerns',
        summary: 'broad trigger',
        reviewedAt: '2026-06-17T12:00:00Z',
      },
      qualityGrade: 'B',
    });
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.UpdateExpression).not.toContain('#status');
    expect(cmd.UpdateExpression).toContain('#llmReview = :llmReview');
    expect(cmd.UpdateExpression).toContain('#qualityGrade = :qualityGrade');
  });
  it('no-ops to a get when nothing to patch', async () => {
    sendMock.mockResolvedValue({ Item: row });
    const out = await patchProposalFields('01HZ-abc', {});
    expect(out?.proposalId).toBe('01HZ-abc');
    // only a GetCommand was issued (no Update)
    expect(input(sendMock.mock.calls[0][0]).Key).toEqual({ proposalId: '01HZ-abc' });
  });
});
