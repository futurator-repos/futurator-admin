import { describe, it, expect } from 'vitest';
import {
  buildJobClaimParams,
  buildJobRenewParams,
  buildJobReleaseParams,
} from '../atomic-claim.mjs';

const NOW_ISO = '2026-07-16T12:00:00.000Z';
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

describe('buildJobClaimParams (server-aware CAS claim, agent jobs)', () => {
  it('builds the conditional claim UpdateCommand input + returns a claimToken', () => {
    const { params, claimToken } = buildJobClaimParams({
      tableName: 'futurator-agent-jobs',
      jobId: 'job-1',
      serverId: 'srv_ec2_main',
      nowIso: NOW_ISO,
    });

    expect(params.TableName).toBe('futurator-agent-jobs');
    expect(params.Key).toEqual({ jobId: 'job-1' });
    expect(params.ConditionExpression).toBe(
      '#status = :pending AND assignedServerId = :sid AND (attribute_not_exists(claimExpiresAt) OR claimExpiresAt < :now)'
    );
    expect(params.UpdateExpression).toBe(
      'SET #status = :running, claimOwner = :sid, claimToken = :tok, claimExpiresAt = :exp, startedAt = :now'
    );
    expect(params.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(params.ExpressionAttributeValues[':sid']).toBe('srv_ec2_main');
    expect(params.ExpressionAttributeValues[':now']).toBe(NOW_ISO);
    expect(typeof claimToken).toBe('string');
    expect(claimToken.length).toBeGreaterThan(0);
    expect(params.ExpressionAttributeValues[':tok']).toBe(claimToken);
  });

  it('defaults the lease to 15 minutes', () => {
    const { params } = buildJobClaimParams({
      tableName: 't',
      jobId: 'job-1',
      serverId: 'srv',
      nowIso: NOW_ISO,
    });
    const expected = new Date(new Date(NOW_ISO).getTime() + FIFTEEN_MIN_MS).toISOString();
    expect(params.ExpressionAttributeValues[':exp']).toBe(expected);
  });

  it('honors an explicit leaseMs override', () => {
    const { params } = buildJobClaimParams({
      tableName: 't',
      jobId: 'job-1',
      serverId: 'srv',
      nowIso: NOW_ISO,
      leaseMs: 60_000,
    });
    const expected = new Date(new Date(NOW_ISO).getTime() + 60_000).toISOString();
    expect(params.ExpressionAttributeValues[':exp']).toBe(expected);
  });

  it('mints a distinct claimToken on every call', () => {
    const a = buildJobClaimParams({ tableName: 't', jobId: 'job-1', serverId: 'srv', nowIso: NOW_ISO });
    const b = buildJobClaimParams({ tableName: 't', jobId: 'job-1', serverId: 'srv', nowIso: NOW_ISO });
    expect(a.claimToken).not.toBe(b.claimToken);
  });
});

describe('buildJobRenewParams', () => {
  it('builds the renew UpdateCommand input, condition on owner+token', () => {
    const params = buildJobRenewParams({
      tableName: 'futurator-agent-jobs',
      jobId: 'job-1',
      serverId: 'srv_ec2_main',
      claimToken: 'tok-abc',
      nowIso: NOW_ISO,
    });

    expect(params.TableName).toBe('futurator-agent-jobs');
    expect(params.Key).toEqual({ jobId: 'job-1' });
    expect(params.ConditionExpression).toBe('claimOwner = :sid AND claimToken = :tok');
    expect(params.ExpressionAttributeValues[':sid']).toBe('srv_ec2_main');
    expect(params.ExpressionAttributeValues[':tok']).toBe('tok-abc');
    const expectedExp = new Date(new Date(NOW_ISO).getTime() + FIFTEEN_MIN_MS).toISOString();
    expect(params.ExpressionAttributeValues[':exp']).toBe(expectedExp);
    expect(params.UpdateExpression).toContain('claimExpiresAt = :exp');
  });

  it('honors an explicit leaseMs override', () => {
    const params = buildJobRenewParams({
      tableName: 't',
      jobId: 'job-1',
      serverId: 'srv',
      claimToken: 'tok',
      nowIso: NOW_ISO,
      leaseMs: 5_000,
    });
    const expected = new Date(new Date(NOW_ISO).getTime() + 5_000).toISOString();
    expect(params.ExpressionAttributeValues[':exp']).toBe(expected);
  });
});

describe('buildJobReleaseParams', () => {
  it('builds the release UpdateCommand input, condition on owner+token, sets final status', () => {
    const params = buildJobReleaseParams({
      tableName: 'futurator-agent-jobs',
      jobId: 'job-1',
      serverId: 'srv_ec2_main',
      claimToken: 'tok-abc',
      status: 'COMPLETED',
    });

    expect(params.TableName).toBe('futurator-agent-jobs');
    expect(params.Key).toEqual({ jobId: 'job-1' });
    expect(params.ConditionExpression).toBe('claimOwner = :sid AND claimToken = :tok');
    expect(params.UpdateExpression).toContain('REMOVE claimOwner, claimToken, claimExpiresAt');
    expect(params.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(params.ExpressionAttributeValues[':status']).toBe('COMPLETED');
    expect(params.ExpressionAttributeValues[':sid']).toBe('srv_ec2_main');
    expect(params.ExpressionAttributeValues[':tok']).toBe('tok-abc');
  });

  it('sets whatever final status is passed (e.g. FAILED)', () => {
    const params = buildJobReleaseParams({
      tableName: 't',
      jobId: 'job-1',
      serverId: 'srv',
      claimToken: 'tok',
      status: 'FAILED',
    });
    expect(params.ExpressionAttributeValues[':status']).toBe('FAILED');
  });
});
