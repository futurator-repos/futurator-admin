import { createHash } from 'crypto';

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

import {
  brokerSecretName,
  describeBrokerCredentials,
  readBrokerCredentials,
  writeBrokerCredentials,
  type BrokerCredentialsSecret,
} from '../broker-credentials-sm';

const ssm = new SSMClient({});

const BROKER_URL = (process.env.IDENTITY_BROKER_URL || '').replace(/\/+$/, '');
const BROKER_JWKS_URL = process.env.IDENTITY_BROKER_JWKS_URL || '';
const BROKER_JWT_ISSUER = process.env.IDENTITY_BROKER_JWT_ISSUER || 'https://api.futurator.com/v1';
const REGISTRATION_KEY_SSM_PATH =
  process.env.IDENTITY_BROKER_REGISTRATION_KEY_SSM_PATH ||
  '/futurator-core/prod/REGISTRATION_API_KEY';

let cachedKey: string | null = null;

async function getRegistrationKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const res = await ssm.send(
    new GetParameterCommand({ Name: REGISTRATION_KEY_SSM_PATH, WithDecryption: true }),
  );
  const value = res.Parameter?.Value;
  if (!value) {
    throw new Error(`Registration key not found at SSM ${REGISTRATION_KEY_SSM_PATH}`);
  }
  cachedKey = value;
  return value;
}

function clientIdFingerprint(clientId: string): string {
  return createHash('sha256').update(clientId).digest('hex').slice(0, 16);
}

export interface IdentityBrokerApp {
  appId: string;
  name: string;
  type: string;
  clientId: string;
  clientIdFingerprint: string;
  secretUpdatedAt?: string;
  previousSecretExpiresAt?: string;
  redirectUris: string[];
  allowedOrigins: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  displayName?: string;
  emailFromName?: string;
  emailSubject?: string;
  emailTagline?: string;
  emailPrimaryColor?: string;
  emailLogoUrl?: string;
  appUrl?: string;
}

export type IdentityBrokerReadResult =
  | { found: true; app: IdentityBrokerApp }
  | { found: false };

export interface IdentityBrokerRegisterInput {
  appId: string;
  name: string;
  type?: 'web' | 'mobile' | 'service';
  baseUrl?: string;
  redirectUris?: string[];
  allowedOrigins?: string[];
}

export interface IdentityBrokerRegisterSanitized {
  alreadyExisted: boolean;
  appId: string;
  clientId: string;
  clientIdFingerprint: string;
  createdAt: string;
  secretArn: string;
  secretName: string;
  secretWritten: boolean;
  config: {
    name: string;
    type: string;
    redirectUris: string[];
    allowedOrigins: string[];
  };
}

export interface IdentityBrokerRotateSanitized {
  appId: string;
  clientId: string;
  clientIdFingerprint: string;
  rotatedAt: string;
  previousSecretExpiresAt: string;
  secretArn: string;
  secretName: string;
}

export type DriftStatus = 'in_sync' | 'drift' | 'no_local_secret' | 'broker_missing';

export interface DriftReport {
  status: DriftStatus;
  detail: string;
  appId: string;
  brokerClientId?: string;
  brokerFingerprint?: string;
  localClientId?: string;
  localFingerprint?: string;
  brokerSecretUpdatedAt?: string;
  localSecretWrittenAt?: string;
  secretName: string;
  secretArn?: string;
  previousSecretExpiresAt?: string;
}

/**
 * Fetches an app's configuration from the Identity Broker via its
 * self-service GET endpoint.
 */
export async function fetchAppConfig(appId: string): Promise<IdentityBrokerReadResult> {
  if (!BROKER_URL) throw new Error('IDENTITY_BROKER_URL env var is not set');
  const key = await getRegistrationKey();
  const res = await fetch(`${BROKER_URL}/apps/${encodeURIComponent(appId)}`, {
    method: 'GET',
    headers: { 'X-Registration-Key': key },
  });

  if (res.status === 404) return { found: false };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Broker GET /apps/${appId} failed: ${res.status} ${body}`);
  }
  const app = (await res.json()) as IdentityBrokerApp;
  return { found: true, app };
}

/**
 * Registers a new app. On successful first-time registration, writes the
 * plain clientSecret into AWS Secrets Manager at the canonical path
 * (`futurator/{appId}/broker-credentials`) so the human never sees it.
 * The returned payload is sanitized — the secret is NEVER returned to
 * the caller.
 *
 * On idempotent re-register (broker returns `clientSecret: null`), no
 * SM write is performed — drift detection surfaces any mismatch.
 */
export async function registerApp(
  input: IdentityBrokerRegisterInput,
): Promise<IdentityBrokerRegisterSanitized> {
  if (!BROKER_URL) throw new Error('IDENTITY_BROKER_URL env var is not set');
  const key = await getRegistrationKey();

  const res = await fetch(`${BROKER_URL}/apps/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Registration-Key': key,
    },
    body: JSON.stringify({
      appId: input.appId,
      name: input.name,
      type: input.type ?? 'web',
      baseUrl: input.baseUrl,
      redirectUris: input.redirectUris,
      allowedOrigins: input.allowedOrigins,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Broker POST /apps/register failed: ${res.status} ${body}`);
  }
  const broker = (await res.json()) as {
    alreadyExisted: boolean;
    appId: string;
    clientId: string;
    clientSecret: string | null;
    createdAt: string;
    config: {
      name: string;
      type: string;
      redirectUris: string[];
      allowedOrigins: string[];
    };
  };

  // Default the SM ARN to the theoretical path; populated on actual write.
  let secretArn = `pending:${brokerSecretName(broker.appId)}`;
  let secretWritten = false;

  if (broker.clientSecret) {
    const credentials: BrokerCredentialsSecret = {
      appId: broker.appId,
      brokerUrl: BROKER_URL,
      jwksUrl: BROKER_JWKS_URL || `${BROKER_URL}/.well-known/jwks.json`,
      jwtIssuer: BROKER_JWT_ISSUER,
      clientId: broker.clientId,
      clientSecret: broker.clientSecret,
      writtenAt: new Date().toISOString(),
    };
    const written = await writeBrokerCredentials(credentials);
    secretArn = written.arn;
    secretWritten = true;
  } else {
    // App pre-existed — see if we already have a local record to report.
    const existing = await describeBrokerCredentials(broker.appId);
    if (existing) secretArn = existing.arn;
  }

  return {
    alreadyExisted: broker.alreadyExisted,
    appId: broker.appId,
    clientId: broker.clientId,
    clientIdFingerprint: clientIdFingerprint(broker.clientId),
    createdAt: broker.createdAt,
    secretArn,
    secretName: brokerSecretName(broker.appId),
    secretWritten,
    config: broker.config,
  };
}

/**
 * Rotates an app's client secret with a 1-hour overlap window on the
 * broker, then writes the new secret into Secrets Manager. The human
 * never sees the secret — consumer Lambdas pick it up on natural cold
 * starts during the overlap window.
 */
export async function rotateAppSecret(
  appId: string,
): Promise<IdentityBrokerRotateSanitized> {
  if (!BROKER_URL) throw new Error('IDENTITY_BROKER_URL env var is not set');
  const key = await getRegistrationKey();

  const res = await fetch(`${BROKER_URL}/apps/${encodeURIComponent(appId)}/rotate-secret`, {
    method: 'POST',
    headers: { 'X-Registration-Key': key },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Broker rotate failed for ${appId}: ${res.status} ${body}`);
  }
  const broker = (await res.json()) as {
    appId: string;
    clientId: string;
    clientSecret: string;
    rotatedAt: string;
    previousSecretExpiresAt: string;
  };

  const credentials: BrokerCredentialsSecret = {
    appId: broker.appId,
    brokerUrl: BROKER_URL,
    jwksUrl: BROKER_JWKS_URL || `${BROKER_URL}/.well-known/jwks.json`,
    jwtIssuer: BROKER_JWT_ISSUER,
    clientId: broker.clientId,
    clientSecret: broker.clientSecret,
    writtenAt: broker.rotatedAt,
    secretUpdatedAt: broker.rotatedAt,
  };
  const written = await writeBrokerCredentials(credentials);

  return {
    appId: broker.appId,
    clientId: broker.clientId,
    clientIdFingerprint: clientIdFingerprint(broker.clientId),
    rotatedAt: broker.rotatedAt,
    previousSecretExpiresAt: broker.previousSecretExpiresAt,
    secretArn: written.arn,
    secretName: brokerSecretName(broker.appId),
  };
}

/**
 * Compares the broker's view of an app's registration against what's in
 * the admin-hub-owned Secrets Manager entry. Used by the UI to surface
 * drift without requiring engineer laptops to hold anything.
 */
export async function describeDrift(appId: string): Promise<DriftReport> {
  const [broker, local] = await Promise.all([
    fetchAppConfig(appId),
    readBrokerCredentials(appId),
  ]);
  const secretName = brokerSecretName(appId);

  if (!broker.found) {
    return {
      status: 'broker_missing',
      detail: `App ${appId} is not registered in the broker.`,
      appId,
      secretName,
      localClientId: local?.clientId,
      localFingerprint: local ? clientIdFingerprint(local.clientId) : undefined,
      localSecretWrittenAt: local?.writtenAt,
    };
  }

  const brokerApp = broker.app;
  if (!local) {
    return {
      status: 'no_local_secret',
      detail: `Broker has ${appId} registered but there is no local secret in Secrets Manager. Rotate the secret to provision one.`,
      appId,
      brokerClientId: brokerApp.clientId,
      brokerFingerprint: brokerApp.clientIdFingerprint,
      brokerSecretUpdatedAt: brokerApp.secretUpdatedAt,
      previousSecretExpiresAt: brokerApp.previousSecretExpiresAt,
      secretName,
    };
  }

  const localFp = clientIdFingerprint(local.clientId);
  if (localFp !== brokerApp.clientIdFingerprint) {
    return {
      status: 'drift',
      detail: `Local clientId (${localFp}) does not match broker (${brokerApp.clientIdFingerprint}). Rotate to re-sync.`,
      appId,
      brokerClientId: brokerApp.clientId,
      brokerFingerprint: brokerApp.clientIdFingerprint,
      brokerSecretUpdatedAt: brokerApp.secretUpdatedAt,
      localClientId: local.clientId,
      localFingerprint: localFp,
      localSecretWrittenAt: local.writtenAt,
      previousSecretExpiresAt: brokerApp.previousSecretExpiresAt,
      secretName,
    };
  }

  return {
    status: 'in_sync',
    detail: 'Broker and local secret agree.',
    appId,
    brokerClientId: brokerApp.clientId,
    brokerFingerprint: brokerApp.clientIdFingerprint,
    brokerSecretUpdatedAt: brokerApp.secretUpdatedAt,
    localClientId: local.clientId,
    localFingerprint: localFp,
    localSecretWrittenAt: local.writtenAt,
    previousSecretExpiresAt: brokerApp.previousSecretExpiresAt,
    secretName,
  };
}
