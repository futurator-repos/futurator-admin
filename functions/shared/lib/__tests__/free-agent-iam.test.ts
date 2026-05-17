import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted spy on the AWS SDK send method so we can intercept AssumeRoleCommand
// invocations and assert on input shape.
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: class MockStsClient {
      send = sendSpy;
    },
  };
});

import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  assumeFreeAgentSessionRole,
  refreshSessionCredentials,
  redactCredentials,
  buildRoleSessionName,
  __resetStsClientForTests,
} from '../free-agent-iam';

const ROLE_ARN = 'arn:aws:iam::123456789012:role/FreeAgentSessionRole';

beforeEach(() => {
  sendSpy.mockReset();
  __resetStsClientForTests();
  process.env.FREE_AGENT_SESSION_ROLE_ARN = ROLE_ARN;
});

describe('assumeFreeAgentSessionRole (AC #2)', () => {
  it('calls AssumeRole with the correct tags, role-session-name, and 3600s duration', async () => {
    const futureExpiry = new Date(Date.now() + 3600 * 1000);
    sendSpy.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIATESTONLY1234567X',
        SecretAccessKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        SessionToken: 'token-xyz',
        Expiration: futureExpiry,
      },
    });

    const creds = await assumeFreeAgentSessionRole({
      projectId: 'dino-7',
      sessionId: 'sess-abc-123',
      operatorId: 'op-rick',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const cmd = sendSpy.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(AssumeRoleCommand);
    // AssumeRoleCommand stores input under `.input`
    expect(cmd.input).toMatchObject({
      RoleArn: ROLE_ARN,
      RoleSessionName: 'dino-7--sess-abc-123--op-rick',
      DurationSeconds: 3600,
      Tags: [
        { Key: 'project', Value: 'dino-7' },
        { Key: 'sessionId', Value: 'sess-abc-123' },
        { Key: 'operator', Value: 'op-rick' },
      ],
    });

    expect(creds.accessKeyId).toBe('ASIATESTONLY1234567X');
    expect(creds.expiration).toBe(futureExpiry.toISOString());
  });

  it('throws a descriptive error when FREE_AGENT_SESSION_ROLE_ARN is not set', async () => {
    delete process.env.FREE_AGENT_SESSION_ROLE_ARN;
    await expect(
      assumeFreeAgentSessionRole({
        projectId: 'p',
        sessionId: 's',
        operatorId: 'o',
      }),
    ).rejects.toThrow(/FREE_AGENT_SESSION_ROLE_ARN/);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('throws when STS returns incomplete credentials', async () => {
    sendSpy.mockResolvedValue({ Credentials: undefined });
    await expect(
      assumeFreeAgentSessionRole({ projectId: 'p', sessionId: 's', operatorId: 'o' }),
    ).rejects.toThrow(/incomplete credentials/i);
  });

  it('scrubs credential-looking values from thrown error messages', async () => {
    // Simulate STS throwing an error whose message includes a fake access key id
    const fakeAkid = 'AKIATESTONLY1234567Y'; // matches AKIA-prefix pattern in redactor
    sendSpy.mockRejectedValue(
      new Error(`AccessDenied: principal accessKeyId=${fakeAkid} not authorized`),
    );

    let caught: Error | undefined;
    try {
      await assumeFreeAgentSessionRole({
        projectId: 'p',
        sessionId: 's',
        operatorId: 'o',
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    // The raw key must not appear in any form.
    expect(caught!.message).not.toContain(fakeAkid);
    // The redaction must leave a visible marker (either the AKID-specific token
    // or the broader field-name redaction — order of regex application can
    // produce either). The point is: no raw secret.
    expect(caught!.message).toMatch(/\[REDACTED(-AKID)?\]/);
    expect(caught!.message).not.toMatch(/accessKeyId\s*[:=]\s*AKIA/i);
  });
});

describe('buildRoleSessionName (AC #2 truncation)', () => {
  it('returns the raw concatenation when under 64 chars', () => {
    const name = buildRoleSessionName({
      projectId: 'dino-7',
      sessionId: 'sess-abc',
      operatorId: 'op-rick',
    });
    expect(name).toBe('dino-7--sess-abc--op-rick');
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('truncates to exactly 64 chars when raw is longer', () => {
    const name = buildRoleSessionName({
      projectId: 'a-very-long-project-identifier-with-lots-of-chars',
      sessionId: 'b-very-long-session-uuid-12345678',
      operatorId: 'c-very-long-operator-id-foo-bar',
    });
    expect(name.length).toBe(64);
  });
});

describe('refreshSessionCredentials (AC #3)', () => {
  it('returns null when current credentials have >5 min remaining', async () => {
    const result = await refreshSessionCredentials({
      projectId: 'p',
      sessionId: 's',
      operatorId: 'o',
      expiration: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    expect(result).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('re-assumes the role when expiration is within 5 min', async () => {
    const futureExpiry = new Date(Date.now() + 3600 * 1000);
    sendSpy.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIANEWCREDS1234567Z',
        SecretAccessKey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        SessionToken: 'new-token',
        Expiration: futureExpiry,
      },
    });

    const result = await refreshSessionCredentials({
      projectId: 'p',
      sessionId: 's',
      operatorId: 'o',
      expiration: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min left
    });

    expect(result).not.toBeNull();
    expect(result!.accessKeyId).toBe('ASIANEWCREDS1234567Z');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('re-assumes the role when expiration is already past', async () => {
    const futureExpiry = new Date(Date.now() + 3600 * 1000);
    sendSpy.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIAEXPIREDRENEW123X',
        SecretAccessKey: 'cccccccccccccccccccccccccccccccccccccccc',
        SessionToken: 'renewed',
        Expiration: futureExpiry,
      },
    });

    const result = await refreshSessionCredentials({
      projectId: 'p',
      sessionId: 's',
      operatorId: 'o',
      expiration: new Date(Date.now() - 60_000).toISOString(), // already expired
    });

    expect(result).not.toBeNull();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes when expiration is malformed (defensive fallback)', async () => {
    const futureExpiry = new Date(Date.now() + 3600 * 1000);
    sendSpy.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIAMALFORMEDFIX12XX',
        SecretAccessKey: 'dddddddddddddddddddddddddddddddddddddddd',
        SessionToken: 'fix',
        Expiration: futureExpiry,
      },
    });

    const result = await refreshSessionCredentials({
      projectId: 'p',
      sessionId: 's',
      operatorId: 'o',
      expiration: 'not-a-real-iso-date',
    });

    expect(result).not.toBeNull();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('redactCredentials (AC #2 — scrubbing)', () => {
  it('redacts AKIA- and ASIA-prefixed keys', () => {
    const err = new Error('failure with AKIAEXAMPLEKEY12345Q and ASIAEXAMPLEKEY67890W');
    const scrubbed = redactCredentials(err);
    expect(scrubbed.message).not.toContain('AKIAEXAMPLEKEY12345Q');
    expect(scrubbed.message).not.toContain('ASIAEXAMPLEKEY67890W');
    expect(scrubbed.message).toContain('[REDACTED-AKID]');
  });

  it('redacts field-name leaks of accessKeyId / secretAccessKey / sessionToken', () => {
    const err = new Error(
      'Got accessKeyId: AKIAFOO, secretAccessKey: 1234567890abcdef, sessionToken: abc-xyz',
    );
    const scrubbed = redactCredentials(err);
    expect(scrubbed.message).toContain('accessKeyId: [REDACTED]');
    expect(scrubbed.message).toContain('secretAccessKey: [REDACTED]');
    expect(scrubbed.message).toContain('sessionToken: [REDACTED]');
  });

  it('preserves stack traces with the same scrubbing applied', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at AKIATESTONLY1234567Y handler';
    const scrubbed = redactCredentials(err);
    expect(scrubbed.stack).toBeDefined();
    expect(scrubbed.stack).not.toContain('AKIATESTONLY1234567Y');
  });

  it('handles non-Error inputs gracefully', () => {
    const scrubbed = redactCredentials('plain string with AKIATESTONLY1234567X');
    expect(scrubbed).toBeInstanceOf(Error);
    expect(scrubbed.message).not.toContain('AKIATESTONLY1234567X');
  });
});
