/**
 * free-agent-pat-loader.ts — 2026-05-27 PR B.d.
 *
 * Resolve the contents:write + pull_requests:write PAT for a free-agent
 * session's target project. Two cases:
 *
 *   - `futurator-admin` (self-edit) → `futurator/admin-self-edit-pat`
 *     (introduced by PR B.a; bootstrap-self-edit-repo creates the bare
 *     clone with this PAT, Rung 1 reuses it for push + PR creation).
 *
 *   - Any other project (brownfield) → `futurator/brownfield-pat/<projectId>`
 *     (party-push Story 21.2's per-project contents:write PAT slot;
 *     operator opts in by uploading a write-scoped PAT via the Migrate UI).
 *
 * The secret body is either a raw token string OR a JSON document with
 * either `{ pat: "..." }` or `{ token: "..." }`. Matches the daemon's
 * `loadBrownfieldPat` shape so the same secrets work for both surfaces.
 *
 * No process-wide cache here — the Lambda lifecycle is short-lived enough
 * that the marginal benefit of a 5-min cache isn't worth the staleness
 * risk after a PAT rotation.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ADMIN_SELF_EDIT_PAT_SECRET_NAME } from './admin-self-edit-bootstrap';

const sm = new SecretsManagerClient({});

export function patSecretNameFor(projectId: string): string {
  if (projectId === 'futurator-admin') return ADMIN_SELF_EDIT_PAT_SECRET_NAME;
  return `futurator/brownfield-pat/${projectId}`;
}

export interface FreeAgentPatResult {
  pat: string;
  secretName: string;
}

/**
 * Load the contents:write PAT for the given project. Throws when the
 * secret is missing or malformed; the caller should map that to a 400
 * `PAT_MISSING` response so the operator knows to upload a PAT.
 */
export async function loadFreeAgentPat(projectId: string): Promise<FreeAgentPatResult> {
  const secretName = patSecretNameFor(projectId);
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!res.SecretString) {
    throw new Error(`Secret ${secretName} has no SecretString`);
  }
  const raw = res.SecretString;
  let pat = raw;
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { pat?: string; token?: string };
      pat = parsed.pat ?? parsed.token ?? '';
    } catch {
      // fall through to raw value
    }
  }
  if (!pat || typeof pat !== 'string') {
    throw new Error(
      `Secret ${secretName} present but missing a 'pat' / 'token' field (and not a raw token string)`,
    );
  }
  return { pat, secretName };
}
