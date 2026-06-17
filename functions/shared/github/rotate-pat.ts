/**
 * rotate-pat.ts — Story 1.7.1 (Pipeline v2 Phase 1)
 *
 * Encapsulates the SSM writes needed for a PAT rotation:
 *
 * 1. Validates the candidate token by calling GitHub GET /user with it
 *    directly (NOT via loadPat()) — uses a raw fetch so the connector is
 *    not involved.
 * 2. Writes the new PAT to SSM at `/futurator/_pipeline/github-pat`.
 *    Phase-2 note: SST stores `GithubPat` secrets at
 *    `/sst/<app>/<stage>/Secret/GithubPat/value`. Aligning this write path
 *    with the SST-managed secret requires deploying with the `sst secret set`
 *    command (operator-side), not a Lambda write — that path is controlled
 *    by SST. Writing to the custom `/futurator/_pipeline/github-pat` path
 *    decouples the rotation UI from the SST deployment cycle; the daemon
 *    reads from whichever path is configured.
 * 3. Writes `/futurator/_pipeline/github-pat-rotated-at` = ISO timestamp.
 *
 * SECURITY RULES:
 *  - The PAT value MUST NOT appear in any log line, error message, or return value.
 *  - Callers receive only `{ login, rotatedAt }` on success.
 */

import {
  SSMClient,
  PutParameterCommand,
  GetParameterCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';

export const SSM_PAT_PATH = '/futurator/_pipeline/github-pat';
export const SSM_PAT_ROTATED_AT_PATH = '/futurator/_pipeline/github-pat-rotated-at';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'Futurator-Admin-GitHub/1.0';

/**
 * Result from a successful PAT rotation.
 * The PAT itself is never returned.
 */
export interface RotatePATResult {
  login: string;
  rotatedAt: string;
}

export class InvalidPatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPatError';
  }
}

/**
 * Validate a candidate PAT by calling GitHub GET /user with it directly.
 * Does NOT use loadPat() or the connector — one-off raw fetch.
 *
 * Returns the GitHub login on success.
 * Throws InvalidPatError if the token is rejected (HTTP 401).
 * Throws Error on network/other failures.
 *
 * IMPORTANT: the PAT value is used only in the Authorization header.
 * It is never logged, stored in a variable named "pat", or returned.
 */
async function validateCandidatePat(candidateToken: string): Promise<string> {
  const response = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${candidateToken}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (response.status === 401) {
    // The error message does NOT include the token.
    throw new InvalidPatError(
      'GitHub rejected the token — check that it has the correct scopes and is not expired',
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ message: response.statusText }))) as {
      message?: string;
    };
    throw new Error(
      `GitHub validation returned ${response.status}: ${body.message ?? response.statusText}`,
    );
  }

  const data = (await response.json()) as { login: string };
  return data.login;
}

/**
 * 2026-06-17 — repo-capability probe. `/user` only proves the token
 * AUTHENTICATES; a fine-grained PAT can authenticate yet lack the per-repo
 * permissions the app actually needs (brick1: rotation "succeeded" but the token
 * had no Pull requests permission, so GitGraph 403'd with "Resource not
 * accessible by personal access token"). This probes the two reads the
 * git-graph + pipeline depend on — Contents (commits) and Pull requests — and
 * rejects the rotation LOUDLY if either is denied, naming the missing
 * permission, so the operator fixes it before the token goes live.
 *
 * Soft on enumeration: if the token can't list any repo (fresh account / odd
 * scope) we don't block — we only hard-fail on an explicit 403 from a probe,
 * which is the precise failure mode we're guarding against.
 */
async function validateRepoCapabilities(candidateToken: string): Promise<void> {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${candidateToken}`,
    'User-Agent': USER_AGENT,
  };
  const reposRes = await fetch(`${GITHUB_API}/user/repos?per_page=1&sort=created&direction=desc`, {
    headers,
  });
  if (!reposRes.ok) return; // can't enumerate — don't false-reject
  const repos = (await reposRes.json().catch(() => [])) as Array<{ full_name?: string }>;
  const full = repos[0]?.full_name;
  if (!full) return; // no repo visible to probe — soft pass

  const probes: Array<{ perm: string; path: string }> = [
    { perm: 'Contents: Read-only', path: 'commits' },
    { perm: 'Pull requests: Read-only', path: 'pulls' },
  ];
  for (const { perm, path } of probes) {
    const r = await fetch(`${GITHUB_API}/repos/${full}/${path}?per_page=1`, { headers });
    if (r.status === 403) {
      throw new InvalidPatError(
        `Token authenticates but cannot read ${path} on ${full} — grant "${perm}" on the ` +
          `fine-grained token (Settings → the token → Permissions → Add permissions), or use a ` +
          `classic PAT with the "repo" scope, then retry. GitGraph and PR features need this.`,
      );
    }
  }
}

/**
 * rotatePat — validate + write a new GitHub PAT to SSM.
 *
 * @param candidateToken  The new PAT. MUST NOT be logged or echoed.
 * @param ssmClient       Injected SSM client (allows test overrides).
 * @returns { login, rotatedAt }
 */
export async function rotatePat(
  candidateToken: string,
  ssmClient: SSMClient,
): Promise<RotatePATResult> {
  // Step 1: validate the PAT against GitHub (authenticates?).
  const login = await validateCandidatePat(candidateToken);

  // Step 1b: validate it actually has the repo reads the app needs (catches the
  // brick1 failure mode — authenticates but missing Pull requests permission).
  await validateRepoCapabilities(candidateToken);

  const rotatedAt = new Date().toISOString();

  // Step 2: write the new PAT as a SecureString to SSM.
  // PutParameter with Overwrite:true acts as an upsert.
  await ssmClient.send(
    new PutParameterCommand({
      Name: SSM_PAT_PATH,
      Value: candidateToken,
      Type: 'SecureString',
      Overwrite: true,
      Description: 'GitHub PAT for Futurator-Admin pipeline operations',
    }),
  );

  // Step 3: record the rotation timestamp (plain String — not sensitive).
  await ssmClient.send(
    new PutParameterCommand({
      Name: SSM_PAT_ROTATED_AT_PATH,
      Value: rotatedAt,
      Type: 'String',
      Overwrite: true,
      Description: 'ISO-8601 timestamp of the last GitHub PAT rotation',
    }),
  );

  return { login, rotatedAt };
}

/**
 * readRotatedAt — reads the last-rotated timestamp from SSM.
 * Returns null if the parameter has never been written.
 */
export async function readRotatedAt(ssmClient: SSMClient): Promise<string | null> {
  try {
    const result = await ssmClient.send(new GetParameterCommand({ Name: SSM_PAT_ROTATED_AT_PATH }));
    return result.Parameter?.Value ?? null;
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}
