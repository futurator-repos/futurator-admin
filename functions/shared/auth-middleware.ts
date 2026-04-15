import { createMiddleware } from 'hono/factory';
import * as jose from 'jose';

const JWKS_URL = process.env.IDENTITY_BROKER_JWKS_URL || '';
const ISSUER = 'https://api.futurator.com/v1';

let jwks: jose.JSONWebKeySet | null = null;
let jwksFetchedAt = 0;
const JWKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getJWKS(): Promise<jose.JSONWebKeySet> {
  const now = Date.now();
  if (jwks && now - jwksFetchedAt < JWKS_CACHE_TTL) {
    return jwks;
  }
  const response = await fetch(JWKS_URL);
  jwks = await response.json();
  jwksFetchedAt = now;
  return jwks!;
}

/**
 * Bearer token auth middleware.
 * Frontend sends: Authorization: Bearer <accessToken>
 * Validates JWT against Identity Broker JWKS (cached 1 hour).
 */
export const authMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (!token) {
    return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } }, 401);
  }

  try {
    const keySet = await getJWKS();
    const JWKS = jose.createLocalJWKSet(keySet);
    const { payload } = await jose.jwtVerify(token, JWKS, { issuer: ISSUER });
    c.set('user', {
      userId: payload.userId || payload.sub,
      email: payload.email,
      name: payload.name,
    });
    await next();
  } catch {
    return c.json({ error: { code: 'AUTH_EXPIRED', message: 'Token expired or invalid' } }, 401);
  }
});
