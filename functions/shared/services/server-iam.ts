/**
 * server-iam.ts — Servers module Task 10 (per-server IAM users).
 *
 * Each compute server gets its own scoped IAM user under
 * `/futurator-servers/` so a compromised/leaked daemon credential on one
 * box can only touch the tables + bundle bucket the worker policy grants —
 * never the API Lambda's broader role.
 *
 * Design contract:
 *   - createServerIamUser: CreateUser -> AttachUserPolicy -> CreateAccessKey,
 *     in that order. One access key per user (v1 has no rotation).
 *   - deleteServerIamUser: idempotent teardown (ListAccessKeys -> delete each
 *     -> DetachUserPolicy -> DeleteUser). Any `NoSuchEntityException` at any
 *     step is swallowed so re-running delete against an already-gone user
 *     (or a partially-torn-down one) is a no-op, not an error.
 *
 * Reads `process.env.SERVER_WORKER_POLICY_ARN` — provisioned by SST
 * (Task 2's `ServerWorkerPolicy`) and wired into the API Lambda env.
 */

import {
  IAMClient,
  CreateUserCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  DetachUserPolicyCommand,
  DeleteUserCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const AWS_REGION = process.env.AWS_REGION || 'eu-central-1';

// IAM is a global service but the SDK client still wants a region for
// signing — never hardcode us-east-1 (Global Constraints).
let _iamClient: IAMClient | undefined;

function getIamClient(): IAMClient {
  if (!_iamClient) {
    _iamClient = new IAMClient({ region: AWS_REGION });
  }
  return _iamClient;
}

export interface ServerIamCredentials {
  userName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function serverIamUserName(serverId: string): string {
  return `futurator-server-${serverId}`;
}

function getWorkerPolicyArn(): string {
  const arn = process.env.SERVER_WORKER_POLICY_ARN;
  if (!arn) {
    throw new Error('createServerIamUser: SERVER_WORKER_POLICY_ARN env var is not set');
  }
  return arn;
}

/**
 * Create a scoped IAM user for a single compute server: CreateUser (tagged,
 * path-scoped) -> AttachUserPolicy (the shared worker policy) ->
 * CreateAccessKey (exactly one key). Returns the access key so the caller
 * can hand it to the bootstrap script (Task 11) / store it via the secrets
 * service (Task 9) — this function never persists credentials itself.
 */
export async function createServerIamUser(serverId: string): Promise<ServerIamCredentials> {
  const policyArn = getWorkerPolicyArn();
  const userName = serverIamUserName(serverId);
  const client = getIamClient();

  await client.send(
    new CreateUserCommand({
      UserName: userName,
      Path: '/futurator-servers/',
      Tags: [
        { Key: 'futurator', Value: 'server-worker' },
        { Key: 'serverId', Value: serverId },
      ],
    }),
  );

  await client.send(
    new AttachUserPolicyCommand({
      UserName: userName,
      PolicyArn: policyArn,
    }),
  );

  const created = await client.send(new CreateAccessKeyCommand({ UserName: userName }));
  const accessKey = created.AccessKey;
  if (!accessKey?.AccessKeyId || !accessKey.SecretAccessKey) {
    throw new Error('createServerIamUser: IAM returned an incomplete access key');
  }

  return {
    userName,
    accessKeyId: accessKey.AccessKeyId,
    secretAccessKey: accessKey.SecretAccessKey,
  };
}

function isNoSuchEntity(err: unknown): boolean {
  return (
    err instanceof NoSuchEntityException ||
    (err as { name?: string })?.name === 'NoSuchEntityException'
  );
}

/**
 * Tear down a per-server IAM user: delete every access key, detach the
 * worker policy, delete the user. Idempotent — safe to call on a user that
 * is already partially or fully deleted.
 */
export async function deleteServerIamUser(userName: string): Promise<void> {
  const client = getIamClient();
  const policyArn = process.env.SERVER_WORKER_POLICY_ARN;

  try {
    const listed = await client.send(new ListAccessKeysCommand({ UserName: userName }));
    for (const key of listed.AccessKeyMetadata ?? []) {
      if (!key.AccessKeyId) continue;
      try {
        await client.send(
          new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: key.AccessKeyId }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    }
  } catch (err) {
    if (!isNoSuchEntity(err)) throw err;
  }

  if (policyArn) {
    try {
      await client.send(new DetachUserPolicyCommand({ UserName: userName, PolicyArn: policyArn }));
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }
  }

  try {
    await client.send(new DeleteUserCommand({ UserName: userName }));
  } catch (err) {
    if (!isNoSuchEntity(err)) throw err;
  }
}

/**
 * Test-only seam to reset the memoized IAM client. Used by vitest hooks to
 * isolate mocks between tests; should never be called from production code.
 */
export function __resetIamClientForTests(): void {
  _iamClient = undefined;
}
