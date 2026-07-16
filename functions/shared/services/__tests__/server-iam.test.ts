import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted spy on the AWS SDK send method so we can intercept IAM command
// invocations and assert on call order + input shape (pattern copied from
// functions/shared/lib/__tests__/free-agent-iam.test.ts).
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));

vi.mock('@aws-sdk/client-iam', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-iam')>();
  return {
    ...actual,
    IAMClient: class MockIamClient {
      send = sendSpy;
    },
  };
});

import {
  CreateUserCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  DetachUserPolicyCommand,
  DeleteUserCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { createServerIamUser, deleteServerIamUser, __resetIamClientForTests } from '../server-iam';

const POLICY_ARN = 'arn:aws:iam::421515025850:policy/ServerWorkerPolicy';

beforeEach(() => {
  sendSpy.mockReset();
  __resetIamClientForTests();
  process.env.SERVER_WORKER_POLICY_ARN = POLICY_ARN;
});

describe('createServerIamUser', () => {
  it('creates the user, attaches the worker policy, and creates one access key, in that order', async () => {
    sendSpy
      .mockResolvedValueOnce({}) // CreateUser
      .mockResolvedValueOnce({}) // AttachUserPolicy
      .mockResolvedValueOnce({
        AccessKey: {
          UserName: 'futurator-server-srv_1',
          AccessKeyId: 'AKIATESTONLY1234567X',
          SecretAccessKey: 'secret-value-abc',
        },
      }); // CreateAccessKey

    const result = await createServerIamUser('srv_1');

    expect(sendSpy).toHaveBeenCalledTimes(3);

    const [createUserCall, attachPolicyCall, createKeyCall] = sendSpy.mock.calls.map((c) => c[0]);

    expect(createUserCall).toBeInstanceOf(CreateUserCommand);
    expect(createUserCall.input).toMatchObject({
      UserName: 'futurator-server-srv_1',
      Path: '/futurator-servers/',
      Tags: [
        { Key: 'futurator', Value: 'server-worker' },
        { Key: 'serverId', Value: 'srv_1' },
      ],
    });

    expect(attachPolicyCall).toBeInstanceOf(AttachUserPolicyCommand);
    expect(attachPolicyCall.input).toMatchObject({
      UserName: 'futurator-server-srv_1',
      PolicyArn: POLICY_ARN,
    });

    expect(createKeyCall).toBeInstanceOf(CreateAccessKeyCommand);
    expect(createKeyCall.input).toMatchObject({ UserName: 'futurator-server-srv_1' });

    expect(result).toEqual({
      userName: 'futurator-server-srv_1',
      accessKeyId: 'AKIATESTONLY1234567X',
      secretAccessKey: 'secret-value-abc',
    });
  });

  it('throws a descriptive error when SERVER_WORKER_POLICY_ARN is not set', async () => {
    delete process.env.SERVER_WORKER_POLICY_ARN;
    await expect(createServerIamUser('srv_1')).rejects.toThrow(/SERVER_WORKER_POLICY_ARN/);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('deleteServerIamUser', () => {
  it('deletes every access key, detaches the policy, then deletes the user', async () => {
    sendSpy
      .mockResolvedValueOnce({
        AccessKeyMetadata: [{ AccessKeyId: 'AKIAKEY1' }, { AccessKeyId: 'AKIAKEY2' }],
      }) // ListAccessKeys
      .mockResolvedValueOnce({}) // DeleteAccessKey key1
      .mockResolvedValueOnce({}) // DeleteAccessKey key2
      .mockResolvedValueOnce({}) // DetachUserPolicy
      .mockResolvedValueOnce({}); // DeleteUser

    await deleteServerIamUser('futurator-server-srv_1');

    const calls = sendSpy.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBeInstanceOf(ListAccessKeysCommand);
    expect(calls[1]).toBeInstanceOf(DeleteAccessKeyCommand);
    expect(calls[1].input).toMatchObject({
      UserName: 'futurator-server-srv_1',
      AccessKeyId: 'AKIAKEY1',
    });
    expect(calls[2]).toBeInstanceOf(DeleteAccessKeyCommand);
    expect(calls[2].input).toMatchObject({
      UserName: 'futurator-server-srv_1',
      AccessKeyId: 'AKIAKEY2',
    });
    expect(calls[3]).toBeInstanceOf(DetachUserPolicyCommand);
    expect(calls[3].input).toMatchObject({
      UserName: 'futurator-server-srv_1',
      PolicyArn: POLICY_ARN,
    });
    expect(calls[4]).toBeInstanceOf(DeleteUserCommand);
    expect(calls[4].input).toMatchObject({ UserName: 'futurator-server-srv_1' });
  });

  it('is idempotent: swallows NoSuchEntityException at every step', async () => {
    sendSpy.mockRejectedValue(
      new NoSuchEntityException({ message: 'no such user', $metadata: {} }),
    );

    await expect(deleteServerIamUser('futurator-server-already-gone')).resolves.toBeUndefined();
  });

  it('is idempotent even when the user has no access keys', async () => {
    sendSpy
      .mockResolvedValueOnce({ AccessKeyMetadata: [] }) // ListAccessKeys
      .mockResolvedValueOnce({}) // DetachUserPolicy
      .mockResolvedValueOnce({}); // DeleteUser

    await deleteServerIamUser('futurator-server-srv_2');

    const calls = sendSpy.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBeInstanceOf(ListAccessKeysCommand);
    expect(calls[1]).toBeInstanceOf(DetachUserPolicyCommand);
    expect(calls[2]).toBeInstanceOf(DeleteUserCommand);
  });

  it('re-throws non-NoSuchEntity errors', async () => {
    sendSpy.mockRejectedValueOnce(new Error('AccessDenied: boom'));
    await expect(deleteServerIamUser('futurator-server-srv_3')).rejects.toThrow(/AccessDenied/);
  });
});
