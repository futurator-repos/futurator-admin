import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  DescribeSecretCommand,
  ResourceExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import type { ComputeProviderId } from '../types/compute-server';

const sm = new SecretsManagerClient({});

/**
 * Canonical Secrets Manager path for a compute provider's credentials.
 * Mirrors the shared-structure convention in `functions/shared/broker-credentials-sm.ts`.
 */
function providerSecretName(provider: ComputeProviderId): string {
  return `futurator/compute-providers/${provider}`;
}

/**
 * Create-or-update the credentials secret for a provider. Idempotent: if the
 * secret doesn't exist yet, create it; if it does, write a new version.
 */
export async function putProviderCredentials(
  provider: ComputeProviderId,
  credentials: unknown,
): Promise<void> {
  const name = providerSecretName(provider);
  const payload = JSON.stringify(credentials);

  try {
    await sm.send(
      new CreateSecretCommand({
        Name: name,
        Description: `Compute provider credentials for ${provider} — managed by admin.futurator.ai`,
        SecretString: payload,
        Tags: [
          { Key: 'futurator:provider', Value: provider },
          { Key: 'futurator:managed-by', Value: 'admin-hub' },
          { Key: 'futurator:kind', Value: 'compute-provider-credentials' },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceExistsException)) throw err;
    // Already exists — put a new version
    await sm.send(
      new PutSecretValueCommand({
        SecretId: name,
        SecretString: payload,
      }),
    );
  }
}

/**
 * Returns `null` if the secret does not exist yet; otherwise the parsed
 * credentials document for the given provider.
 */
export async function getProviderCredentials<T = unknown>(
  provider: ComputeProviderId,
): Promise<T | null> {
  const name = providerSecretName(provider);
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: name }));
    if (!res.SecretString) return null;
    return JSON.parse(res.SecretString) as T;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
}

/**
 * Whether a provider's credentials secret exists, without fetching its
 * value — cheaper than `getProviderCredentials` when only presence matters.
 */
export async function isProviderConfigured(provider: ComputeProviderId): Promise<boolean> {
  const name = providerSecretName(provider);
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: name }));
    return true;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return false;
    throw err;
  }
}
