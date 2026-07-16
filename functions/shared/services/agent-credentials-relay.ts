/**
 * Servers module — Claude OAuth relay (Task 9).
 *
 * Fleet servers (Hetzner/Oracle/GCP/local — outside our AWS account) cannot
 * read the operator's Claude Code OAuth tokens from Keychain or SSM. Instead
 * `scripts/mac-oauth-sync.sh` mirrors those tokens into Secrets Manager
 * (`futurator/claude-oauth-credentials`) on every re-auth, and each daemon
 * fetches them through the admin API using its per-server enrollment token.
 *
 * This module authenticates that fetch: the daemon presents its raw enroll
 * token, we sha256-hash it, look up the owning server row, verify the server
 * is live (ACTIVE/BOOTSTRAPPING), and return the raw credentials JSON.
 */

import crypto from 'node:crypto';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { findServerByEnrollTokenHash } from '../repositories/servers-repository';
import { AppError, AuthError } from '../errors';

const sm = new SecretsManagerClient({});

/**
 * Canonical Secrets Manager path for the mirrored Claude Code OAuth tokens.
 * Written by `scripts/mac-oauth-sync.sh`; read here on behalf of the fleet.
 */
export const CLAUDE_OAUTH_SECRET_NAME = 'futurator/claude-oauth-credentials';

/**
 * sha256-hex of an enrollment token. We only ever persist the hash on the
 * server row, so the raw token is never recoverable from DynamoDB. Task 15
 * uses this when minting tokens.
 */
export function hashEnrollToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Resolve a raw enrollment token to the mirrored Claude OAuth credentials JSON.
 *
 * @throws AuthError — 401 — token maps to no server, or the server is not in a
 *   live state (only ACTIVE/BOOTSTRAPPING may fetch; a DELETED/PAUSED/ERROR row
 *   is treated as revoked).
 * @throws AppError('CREDENTIALS_UNAVAILABLE', 503) — the secret has not been
 *   mirrored yet (or is empty). The daemon should retry later.
 */
export async function getAgentCredentialsForToken(token: string): Promise<string> {
  const hash = hashEnrollToken(token);
  const server = await findServerByEnrollTokenHash(hash);
  if (!server) {
    throw new AuthError('Unknown or revoked server token');
  }
  if (server.status !== 'ACTIVE' && server.status !== 'BOOTSTRAPPING') {
    throw new AuthError(`Server ${server.serverId} is not active (status ${server.status})`);
  }

  let secretString: string | undefined;
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: CLAUDE_OAUTH_SECRET_NAME }));
    secretString = res.SecretString;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      throw new AppError(
        'CREDENTIALS_UNAVAILABLE',
        'Claude OAuth credentials have not been mirrored yet',
        503,
      );
    }
    throw err;
  }

  if (!secretString) {
    throw new AppError(
      'CREDENTIALS_UNAVAILABLE',
      'Claude OAuth credentials have not been mirrored yet',
      503,
    );
  }
  return secretString;
}
