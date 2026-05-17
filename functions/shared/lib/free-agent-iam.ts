/**
 * free-agent-iam.ts — Story 18.1 (Epic 18: Free Claude Code Agent)
 *
 * STS AssumeRole helpers for per-session free-agent credentials.
 *
 * Design contract:
 *   - Each free-agent session assumes its own short-lived role (1h max).
 *   - Session tags (project, sessionId, operator) flow through STS into the
 *     role's permissions policy, which gates DDB writes by sessionId and S3
 *     reads by project (see sst.config.ts:FreeAgentSessionRole).
 *   - Credentials are NEVER persisted: returned as an in-memory object,
 *     passed to the daemon over the existing encrypted job-dispatch envelope,
 *     and refreshed (not stored) when close to expiry.
 *   - Any thrown error has credential-looking values scrubbed before re-throw.
 *
 * Why this exists (Story 18.1 AC #1-3):
 *   The Free Agent has full Claude Code tool access. The IAM role's scope +
 *   explicit-deny block is the load-bearing security boundary. Per-session
 *   role assumption (with session tags resolving into the policy at runtime)
 *   means the role's effective permissions are tied to the operator's exact
 *   intent for THIS session — not a broader "free agent" capability.
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const DURATION_SECONDS = 3600; // 1h — STS max for tagged sessions without explicit configuration

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

// STS limit: RoleSessionName must be ≤64 chars
const ROLE_SESSION_NAME_MAX = 64;

let _stsClient: STSClient | undefined;

function getStsClient(): STSClient {
  if (!_stsClient) {
    _stsClient = new STSClient({ region: AWS_REGION });
  }
  return _stsClient;
}

/**
 * Read-only set of fields the daemon spawn-env needs to talk to AWS.
 * NEVER persist this. NEVER log this. NEVER include in event payloads.
 */
export type SessionCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string; // ISO-8601 UTC
};

type AssumeFreeAgentSessionRoleInput = {
  projectId: string;
  sessionId: string;
  operatorId: string;
};

/**
 * Assume the FreeAgentSessionRole with project/sessionId/operator session tags.
 *
 * Reads `process.env.FREE_AGENT_SESSION_ROLE_ARN` — provisioned by SST and
 * wired into the API Lambda env in `sst.config.ts`.
 */
export async function assumeFreeAgentSessionRole(
  input: AssumeFreeAgentSessionRoleInput,
): Promise<SessionCredentials> {
  const roleArn = process.env.FREE_AGENT_SESSION_ROLE_ARN;
  if (!roleArn) {
    throw new Error('assumeFreeAgentSessionRole: FREE_AGENT_SESSION_ROLE_ARN env var is not set');
  }

  const roleSessionName = buildRoleSessionName(input);

  try {
    const result = await getStsClient().send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: roleSessionName,
        DurationSeconds: DURATION_SECONDS,
        Tags: [
          { Key: 'project', Value: input.projectId },
          { Key: 'sessionId', Value: input.sessionId },
          { Key: 'operator', Value: input.operatorId },
        ],
      }),
    );

    const creds = result.Credentials;
    if (
      !creds ||
      !creds.AccessKeyId ||
      !creds.SecretAccessKey ||
      !creds.SessionToken ||
      !creds.Expiration
    ) {
      throw new Error('assumeFreeAgentSessionRole: STS returned incomplete credentials');
    }

    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
      expiration: creds.Expiration.toISOString(),
    };
  } catch (err) {
    throw redactCredentials(err);
  }
}

/**
 * If `session.expiration` is within REFRESH_THRESHOLD_MS of now (or already
 * past), re-assume the role with the same tags and return fresh credentials.
 * Otherwise returns null (caller keeps existing credentials).
 *
 * Caller responsibilities:
 *   - Update the daemon's in-memory session state with the returned credentials
 *   - Update the session row's `lastRefreshedAt` in DDB
 *   - Inject the new credentials into the NEXT subprocess spawn env
 *     (process.env CANNOT be patched on a running subprocess — refresh applies
 *     to the next turn, not the current one)
 */
export async function refreshSessionCredentials(session: {
  projectId: string;
  sessionId: string;
  operatorId: string;
  expiration: string;
}): Promise<SessionCredentials | null> {
  const expiryMs = Date.parse(session.expiration);
  if (Number.isNaN(expiryMs)) {
    // Malformed expiration → treat as expired and refresh.
    return assumeFreeAgentSessionRole({
      projectId: session.projectId,
      sessionId: session.sessionId,
      operatorId: session.operatorId,
    });
  }

  const msUntilExpiry = expiryMs - Date.now();
  if (msUntilExpiry > REFRESH_THRESHOLD_MS) {
    return null;
  }

  return assumeFreeAgentSessionRole({
    projectId: session.projectId,
    sessionId: session.sessionId,
    operatorId: session.operatorId,
  });
}

/**
 * Build the STS RoleSessionName from session identifiers, truncated to the
 * 64-char STS limit. Format: `<projectId>--<sessionId>--<operatorId>`.
 *
 * Exported for testing.
 */
export function buildRoleSessionName(input: AssumeFreeAgentSessionRoleInput): string {
  const raw = `${input.projectId}--${input.sessionId}--${input.operatorId}`;
  return raw.length <= ROLE_SESSION_NAME_MAX ? raw : raw.slice(0, ROLE_SESSION_NAME_MAX);
}

/**
 * Scrub credential-shaped values out of an Error before re-throwing. Best-effort:
 * matches the documented AWS access-key prefix (AKIA / ASIA), and bare hits on
 * the field names that AWS SDK errors sometimes embed.
 *
 * Exported for testing.
 */
export function redactCredentials(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const scrubbed = message
    // AWS access-key IDs: AKIA followed by 16 chars (production) or ASIA (temp)
    .replace(/A(?:KIA|SIA)[A-Z0-9]{16}/g, '[REDACTED-AKID]')
    // 40-char base64-ish secret keys
    .replace(/[A-Za-z0-9+/]{40}/g, '[REDACTED-SECRET]')
    // Field-name leaks (e.g., "accessKeyId: AKIA...")
    .replace(/accessKeyId\s*[:=]\s*\S+/gi, 'accessKeyId: [REDACTED]')
    .replace(/secretAccessKey\s*[:=]\s*\S+/gi, 'secretAccessKey: [REDACTED]')
    .replace(/sessionToken\s*[:=]\s*\S+/gi, 'sessionToken: [REDACTED]');

  const wrapped = new Error(scrubbed);
  if (err instanceof Error && err.stack) {
    // Also scrub stack for safety.
    wrapped.stack = err.stack
      .replace(/A(?:KIA|SIA)[A-Z0-9]{16}/g, '[REDACTED-AKID]')
      .replace(/[A-Za-z0-9+/]{40}/g, '[REDACTED-SECRET]');
  }
  return wrapped;
}

/**
 * Test-only seam to reset the memoized STS client. Used by vitest hooks to
 * isolate mocks between tests; should never be called from production code.
 */
export function __resetStsClientForTests(): void {
  _stsClient = undefined;
}
