import { createSign } from 'crypto';

/**
 * Google service-account authentication: mint an RS256 self-signed JWT and
 * exchange it at Google's OAuth2 token endpoint for a short-lived access token
 * scoped to Compute Engine. Tokens are cached in-memory for 5 minutes (keyed by
 * the service account's client_email) to avoid a token round-trip per adapter
 * call. No provider SDKs — plain `crypto` + `fetch`.
 */
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const COMPUTE_SCOPE = 'https://www.googleapis.com/auth/compute';
const CACHE_TTL_MS = 5 * 60_000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function base64url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function gcpAccessToken(saJson: string): Promise<string> {
  const sa = JSON.parse(saJson) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GCP service account JSON is missing client_email/private_key');
  }

  const now = Date.now();
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAt > now) return cached.token;

  const tokenUri = sa.token_uri ?? DEFAULT_TOKEN_URI;
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: sa.client_email, scope: COMPUTE_SCOPE, aud: tokenUri, iat, exp }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(sa.private_key, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!res.ok) {
    const detail = await res.text?.().catch(() => '');
    throw new Error(`GCP token exchange failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }

  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) {
    throw new Error('GCP token exchange returned no access_token');
  }

  // Cache conservatively: min(token lifetime, 5 min), minus a small skew.
  const lifetimeMs = body.expires_in ? body.expires_in * 1000 : CACHE_TTL_MS;
  tokenCache.set(sa.client_email, {
    token: body.access_token,
    expiresAt: now + Math.min(lifetimeMs, CACHE_TTL_MS),
  });
  return body.access_token;
}
