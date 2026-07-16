import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted spy on the AWS SDK send method so we can intercept SecretsManager
// commands and assert on input shape / simulate exceptions. Mirrors the
// mocking style used in functions/shared/lib/__tests__/free-agent-iam.test.ts.
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

import {
  ResourceExistsException,
  ResourceNotFoundException,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  putProviderCredentials,
  getProviderCredentials,
  isProviderConfigured,
} from '../provider-credentials-sm';

beforeEach(() => {
  sendSpy.mockReset();
});

describe('putProviderCredentials', () => {
  it('creates the secret when it does not exist yet', async () => {
    sendSpy.mockResolvedValueOnce({ ARN: 'arn:aws:secretsmanager:...', VersionId: 'v1' });

    await putProviderCredentials('hetzner', { token: 'abc' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(CreateSecretCommand);
    expect(cmd.input.Name).toBe('futurator/compute-providers/hetzner');
    expect(JSON.parse(cmd.input.SecretString as string)).toEqual({ token: 'abc' });
  });

  it('falls back to PutSecretValue when the secret already exists', async () => {
    sendSpy.mockRejectedValueOnce(
      new ResourceExistsException({ message: 'exists', $metadata: {} }),
    );
    sendSpy.mockResolvedValueOnce({ ARN: 'arn:aws:secretsmanager:...', VersionId: 'v2' });

    await putProviderCredentials('gcp', {
      serviceAccountJson: '{}',
      projectId: 'p',
      zone: 'europe-west3-a',
    });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const secondCmd = sendSpy.mock.calls[1][0];
    expect(secondCmd).toBeInstanceOf(PutSecretValueCommand);
    expect(secondCmd.input.SecretId).toBe('futurator/compute-providers/gcp');
  });
});

describe('getProviderCredentials', () => {
  it('parses the JSON secret string', async () => {
    sendSpy.mockResolvedValueOnce({ SecretString: JSON.stringify({ token: 'xyz' }) });

    const creds = await getProviderCredentials<{ token: string }>('hetzner');

    expect(sendSpy.mock.calls[0][0]).toBeInstanceOf(GetSecretValueCommand);
    expect(creds).toEqual({ token: 'xyz' });
  });

  it('returns null when the secret does not exist', async () => {
    sendSpy.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} }),
    );

    const creds = await getProviderCredentials('oracle');

    expect(creds).toBeNull();
  });
});

describe('isProviderConfigured', () => {
  it('returns true when DescribeSecret succeeds', async () => {
    sendSpy.mockResolvedValueOnce({ ARN: 'arn:aws:secretsmanager:...' });

    const configured = await isProviderConfigured('hetzner');

    expect(sendSpy.mock.calls[0][0]).toBeInstanceOf(DescribeSecretCommand);
    expect(configured).toBe(true);
  });

  it('returns false when DescribeSecret raises ResourceNotFoundException', async () => {
    sendSpy.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} }),
    );

    const configured = await isProviderConfigured('gcp');

    expect(configured).toBe(false);
  });
});
