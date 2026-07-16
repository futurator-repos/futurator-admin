import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted spy on the AWS SDK send method so we can intercept SecretsManager
// commands and simulate exceptions. Mirrors the mocking style used in
// functions/shared/services/__tests__/provider-credentials-sm.test.ts.
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-secrets-manager')>();
  return {
    ...actual,
    SecretsManagerClient: class MockSecretsManagerClient {
      send = sendSpy;
    },
  };
});

// Mock the servers repository so the token lookup is deterministic.
const { findServerByEnrollTokenHash } = vi.hoisted(() => ({
  findServerByEnrollTokenHash: vi.fn(),
}));
vi.mock('../../repositories/servers-repository', () => ({
  findServerByEnrollTokenHash,
}));

import { GetSecretValueCommand, ResourceNotFoundException } from '@aws-sdk/client-secrets-manager';
import { getAgentCredentialsForToken, hashEnrollToken } from '../agent-credentials-relay';
import { AppError, AuthError } from '../../errors';
import type { ComputeServer } from '../../types/compute-server';

const server = (overrides: Partial<ComputeServer> = {}): ComputeServer =>
  ({
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
    enrollTokenHash: hashEnrollToken('good-token'),
    createdAt: '2026-07-16T00:00:00Z',
    updatedAt: '2026-07-16T00:00:00Z',
    ...overrides,
  }) as ComputeServer;

beforeEach(() => {
  sendSpy.mockReset();
  findServerByEnrollTokenHash.mockReset();
});

describe('hashEnrollToken', () => {
  it('produces a stable sha256 hex digest', () => {
    expect(hashEnrollToken('good-token')).toBe(hashEnrollToken('good-token'));
    expect(hashEnrollToken('good-token')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEnrollToken('a')).not.toBe(hashEnrollToken('b'));
  });
});

describe('getAgentCredentialsForToken', () => {
  it('returns the raw credentials JSON for a valid ACTIVE server token', async () => {
    findServerByEnrollTokenHash.mockResolvedValueOnce(server());
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: 'a' } });
    sendSpy.mockResolvedValueOnce({ SecretString: creds });

    const result = await getAgentCredentialsForToken('good-token');

    expect(findServerByEnrollTokenHash).toHaveBeenCalledWith(hashEnrollToken('good-token'));
    expect(sendSpy.mock.calls[0][0]).toBeInstanceOf(GetSecretValueCommand);
    expect(result).toBe(creds);
  });

  it('accepts a BOOTSTRAPPING server too', async () => {
    findServerByEnrollTokenHash.mockResolvedValueOnce(server({ status: 'BOOTSTRAPPING' }));
    sendSpy.mockResolvedValueOnce({ SecretString: '{}' });

    await expect(getAgentCredentialsForToken('good-token')).resolves.toBe('{}');
  });

  it('throws AuthError for an unknown token', async () => {
    findServerByEnrollTokenHash.mockResolvedValueOnce(null);

    await expect(getAgentCredentialsForToken('nope')).rejects.toBeInstanceOf(AuthError);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('throws AuthError when the server is DELETED (revoked)', async () => {
    findServerByEnrollTokenHash.mockResolvedValueOnce(server({ status: 'DELETED' }));

    await expect(getAgentCredentialsForToken('good-token')).rejects.toBeInstanceOf(AuthError);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('maps a missing secret to a 503 AppError', async () => {
    findServerByEnrollTokenHash.mockResolvedValueOnce(server());
    sendSpy.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} }),
    );

    const err = await getAgentCredentialsForToken('good-token').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(503);
  });

  it('maps an empty secret body to a 503 AppError', async () => {
    findServerByEnrollTokenHash.mockResolvedValueOnce(server());
    sendSpy.mockResolvedValueOnce({ SecretString: undefined });

    const err = await getAgentCredentialsForToken('good-token').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(503);
  });
});
