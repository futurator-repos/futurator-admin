import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  DescribeSecretCommand,
  ResourceExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});

export interface BrokerCredentialsSecret {
  appId: string;
  brokerUrl: string;
  jwksUrl: string;
  jwtIssuer: string;
  clientId: string;
  clientSecret: string;
  // metadata for drift detection
  writtenAt: string;
  secretUpdatedAt?: string;
}

/**
 * Canonical Secrets Manager path for an app's broker credentials.
 *
 * We enforce a shared structure: `futurator/{appId}/broker-credentials`.
 * Consumer apps import via `Secret.fromSecretNameV2(this, 'BrokerCreds',
 * this.secretName)`. Using a predictable name instead of ARN avoids the
 * bootstrap problem of "how does the app know the ARN before the secret
 * exists" — the app only needs the appId.
 */
export function brokerSecretName(appId: string): string {
  return `futurator/${appId}/broker-credentials`;
}

/**
 * Create-or-update the broker credentials secret for an app. Idempotent:
 * if the secret doesn't exist yet, create it; if it does, write a new
 * version.
 */
export async function writeBrokerCredentials(
  credentials: BrokerCredentialsSecret,
): Promise<{ arn: string; versionId: string | undefined }> {
  const name = brokerSecretName(credentials.appId);
  const payload = JSON.stringify(credentials);

  try {
    const result = await sm.send(
      new CreateSecretCommand({
        Name: name,
        Description: `Identity Broker credentials for ${credentials.appId} — managed by admin.futurator.ai`,
        SecretString: payload,
        Tags: [
          { Key: 'futurator:appId', Value: credentials.appId },
          { Key: 'futurator:managed-by', Value: 'admin-hub' },
          { Key: 'futurator:kind', Value: 'broker-credentials' },
        ],
      }),
    );
    return { arn: result.ARN!, versionId: result.VersionId };
  } catch (err) {
    if (!(err instanceof ResourceExistsException)) throw err;
    // Already exists — put a new version
    const put = await sm.send(
      new PutSecretValueCommand({
        SecretId: name,
        SecretString: payload,
      }),
    );
    return { arn: put.ARN!, versionId: put.VersionId };
  }
}

/**
 * Returns `null` if the secret does not exist yet; otherwise the parsed
 * credentials document. Used for drift detection.
 */
export async function readBrokerCredentials(
  appId: string,
): Promise<BrokerCredentialsSecret | null> {
  const name = brokerSecretName(appId);
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: name }));
    if (!res.SecretString) return null;
    return JSON.parse(res.SecretString) as BrokerCredentialsSecret;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
}

/**
 * Returns ARN + last-modified timestamp without fetching the secret body.
 * Cheaper than `readBrokerCredentials` when the body isn't needed.
 */
export async function describeBrokerCredentials(
  appId: string,
): Promise<{ arn: string; lastChangedDate?: Date } | null> {
  const name = brokerSecretName(appId);
  try {
    const res = await sm.send(new DescribeSecretCommand({ SecretId: name }));
    return {
      arn: res.ARN!,
      lastChangedDate: res.LastChangedDate,
    };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
}
