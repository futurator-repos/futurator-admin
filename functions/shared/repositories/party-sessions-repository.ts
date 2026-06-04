import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { PartySession, PartySessionStatus } from '../types/party';

/**
 * Story 15.1 scope: stub with getSession + full structure. Full session-lifecycle
 * functions (create, lock, message, resume) are completed in Story 15.2.
 *
 * The stubs below are the contracts Story 15.2 will flesh out. Kept here so
 * Story 15.1 can compile end-to-end and the API layer can reference them.
 */

export async function getSession(sessionId: string): Promise<PartySession | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.partySessions, Key: { sessionId } }),
  );
  return (result.Item as PartySession) || null;
}

export async function listSessionsByProject(projectId: string): Promise<PartySession[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.partySessions,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': projectId },
      ScanIndexForward: false,
    }),
  );
  return (result.Items as PartySession[]) || [];
}

/**
 * Cheap "is anything actively turning?" check used by the refresh endpoint
 * (Story 15.4 AC #7). Returns true if any session for this project has
 * `status='PROCESSING'`. Caller treats true as a 409 PROJECT_BUSY response.
 */
export async function hasProcessingSession(projectId: string): Promise<boolean> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.partySessions,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      FilterExpression: '#status = :processing',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': projectId, ':processing': 'PROCESSING' },
      Limit: 1,
    }),
  );
  return (result.Items?.length ?? 0) > 0;
}

/**
 * Cross-project listing for the Debates page. Single-tenant, expected
 * cardinality is small (dozens of sessions per workspace), so a Scan is
 * cheaper than maintaining a second GSI keyed on a constant partition.
 */
export async function listAllSessions(): Promise<PartySession[]> {
  const out: PartySession[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAMES.partySessions, ExclusiveStartKey }),
    );
    if (result.Items) out.push(...(result.Items as PartySession[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE_NAMES.partySessions, Key: { sessionId } }),
  );
}

/**
 * Delete every session row for a project by scanning the GSI1 index and issuing
 * a DeleteCommand per row. Used when a project is removed so its session
 * history doesn't outlive it.
 */
export async function deleteSessionsByProject(projectId: string): Promise<number> {
  const sessions = await listSessionsByProject(projectId);
  await Promise.all(sessions.map((s) => deleteSession(s.sessionId)));
  return sessions.length;
}

export interface CreateSessionInput {
  projectId: string;
  projectPath: string;
  topic?: string;
  bmadVersionAtStart: string;
}

export async function createSession(input: CreateSessionInput): Promise<PartySession> {
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  // claudeSessionId is intentionally OMITTED (not null) so the daemon's
  // `attribute_not_exists(claudeSessionId)` conditional write in
  // setClaudeSessionId actually succeeds on the first turn. Storing it as
  // `null` would make `attribute_not_exists` return false and the daemon
  // would log "may already be set" on every first turn.
  const row: PartySession = {
    sessionId,
    projectId: input.projectId,
    projectPath: input.projectPath,
    claudeSessionId: null,
    status: 'ACTIVE',
    turnCount: 0,
    createdAt: now,
    topic: input.topic,
    bmadVersionAtStart: input.bmadVersionAtStart,
    GSI1PK: input.projectId,
    GSI1SK: now,
  };
  // Strip null/undefined fields before writing so the downstream DDB doc
  // client doesn't serialize them as NULL attributes (which defeats
  // attribute_not_exists on later writes). `Partial<PartySession>` keeps
  // the API's response shape happy — the read path returns null for missing.
  const itemForDdb: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    itemForDdb[k] = v;
  }
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.partySessions, Item: itemForDdb }));
  return row;
}

export type SessionLockResult =
  | { ok: true }
  | { ok: false; reason: 'SESSION_BUSY' | 'NOT_FOUND' | 'NOT_ACTIVE' };

/**
 * Atomically transition a session from ACTIVE|IDLE|ERROR to PROCESSING.
 * Fails with SESSION_BUSY when already PROCESSING, NOT_ACTIVE only for the
 * tombstoned ARCHIVED state, NOT_FOUND when the row is absent.
 *
 * ERROR is accepted as an auto-recovery path: a turn that ended in ERROR
 * (timeout, non-zero exit, daemon-side 401, etc.) leaves the row at status
 * ERROR with its claudeSessionId + worktreePath intact. The next user message
 * then transitions ERROR → PROCESSING and the daemon retries the round —
 * matching the UI's "Send a new message below to continue" affordance.
 * (See docs/concepts/party-push/ — this closes the gap where the UI invited
 * a retry but the API refused with 409 SESSION_NOT_ACTIVE.)
 */
export async function tryAcquireSessionLock(sessionId: string): Promise<SessionLockResult> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.partySessions,
        Key: { sessionId },
        UpdateExpression: 'SET #status = :processing',
        ConditionExpression:
          'attribute_exists(sessionId) AND (#status = :active OR #status = :idle OR #status = :error)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'PROCESSING' as PartySessionStatus,
          ':active': 'ACTIVE' as PartySessionStatus,
          ':idle': 'IDLE' as PartySessionStatus,
          ':error': 'ERROR' as PartySessionStatus,
        },
      }),
    );
    return { ok: true };
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'ConditionalCheckFailedException') {
      const row = await getSession(sessionId);
      if (!row) return { ok: false, reason: 'NOT_FOUND' };
      if (row.status === 'PROCESSING') return { ok: false, reason: 'SESSION_BUSY' };
      return { ok: false, reason: 'NOT_ACTIVE' };
    }
    throw err;
  }
}

/** Full implementation in Story 15.2. */
export async function releaseSessionLock(
  sessionId: string,
  finalStatus: PartySessionStatus,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partySessions,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, lastTurnAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':s': finalStatus,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

/** Full implementation in Story 15.2. */
export async function incrementTurn(sessionId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partySessions,
      Key: { sessionId },
      UpdateExpression: 'ADD turnCount :one SET lastTurnAt = :now',
      ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
    }),
  );
}

/** Full implementation in Story 15.2. */
/**
 * Set the Claude session ID on first-turn capture. Accepts rows where the
 * attribute is missing OR stored as a legacy NULL value (pre-fix createSession
 * wrote `null`). Idempotent on same value; rejects mid-turn drift.
 */
export async function setClaudeSessionId(
  sessionId: string,
  claudeSessionId: string,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partySessions,
      Key: { sessionId },
      UpdateExpression: 'SET claudeSessionId = :cid',
      ConditionExpression:
        'attribute_exists(sessionId) AND (attribute_not_exists(claudeSessionId) OR attribute_type(claudeSessionId, :nullType))',
      ExpressionAttributeValues: {
        ':cid': claudeSessionId,
        ':nullType': 'NULL',
      },
    }),
  );
}

/**
 * Update mutable session metadata. Currently just `topic` (the session
 * title shown in the chat header). Returns the updated row. Used by
 * PATCH /api/party/sessions/:id when the user renames a session.
 */
export async function updateSessionMetadata(
  sessionId: string,
  patch: { topic?: string | null },
): Promise<PartySession | null> {
  const expr: string[] = [];
  const values: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'topic')) {
    if (patch.topic === null || patch.topic === undefined || patch.topic.length === 0) {
      // Clear the field rather than store an empty string — keeps the
      // "no topic" check on the client side simple (`!session.topic`).
      const result = await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAMES.partySessions,
          Key: { sessionId },
          UpdateExpression: 'REMOVE topic',
          ConditionExpression: 'attribute_exists(sessionId)',
          ReturnValues: 'ALL_NEW',
        }),
      );
      return (result.Attributes as PartySession | undefined) ?? null;
    }
    expr.push('topic = :topic');
    values[':topic'] = patch.topic.slice(0, 200);
  }
  if (expr.length === 0) {
    return getSession(sessionId);
  }
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partySessions,
      Key: { sessionId },
      UpdateExpression: `SET ${expr.join(', ')}`,
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return (result.Attributes as PartySession | undefined) ?? null;
}

/**
 * Story 19.4 (party-push Epic 19) — set the operator-cancel flag on a session.
 *
 * Written by `POST /api/party/sessions/:id/cancel` (route lives in Epic 22).
 * The daemon's shared cancel-poller polls for this flag and SIGTERMs the
 * subprocess on `true`. Clearing is handled atomically by `poller.stop()`
 * via {@link clearCancelFlag} below (§13.2 atomic-clear API).
 *
 * @example
 * await setCancelRequested('a1b2c3d4-...');
 */
export async function setCancelRequested(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partySessions,
      Key: { sessionId },
      UpdateExpression: 'SET cancelRequested = :true, cancelRequestedAt = :now, updatedAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':true': true, ':now': now },
    }),
  );
}

/**
 * Story 19.4 — clear the cancel flag. Called by the daemon's shared
 * cancel-poller `stop()` (`daemon/pipelines/lib/cancel-poller.mjs`) on
 * every turn close (both cancelled and non-cancelled paths) so a stale
 * flag from a prior turn cannot pre-cancel the next turn.
 *
 * Idempotent — `REMOVE` against a missing attribute is a no-op in DDB.
 *
 * @example
 * await clearCancelFlag('a1b2c3d4-...');
 */
export async function clearCancelFlag(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partySessions,
      Key: { sessionId },
      UpdateExpression: 'REMOVE cancelRequested, cancelRequestedAt SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':now': now },
    }),
  );
}

/**
 * Story 19.8 (party-push Epic 19) — look up a `PartySession` by the first
 * 8 chars of its UUID (the form the filesystem path encodes via
 * `/home/ubuntu/worktrees/<app>/_party/<sidShort>/`).
 *
 * The worktree reaper (Story 19.7 walker → Story 20.15 classifier) calls
 * this to resolve a directory name back to its session row and decide
 * whether to reap. Implementation is a DDB `Scan` with
 * `begins_with(sessionId, prefix)` filter, `Limit: 5`. First match wins.
 * Collision probability across 4.3B UUID prefixes is ~10⁻¹⁰; we still
 * warn-log if more than one match comes back so a real collision
 * (impossible-but-not-zero) leaves an audit trail.
 *
 * Input validation: only lowercase hex 8-char prefixes are accepted.
 * This defends against accidentally passing a full UUID (which would
 * scan with a 36-char `begins_with` and return nothing, silently).
 *
 * @example
 * const session = await findBySessionIdShort('a1b2c3d4');
 * if (session) console.log(session.sessionId);
 */
const SESSION_ID_SHORT_REGEX = /^[a-f0-9]{8}$/;

export async function findBySessionIdShort(sessionIdShort: string): Promise<PartySession | null> {
  if (typeof sessionIdShort !== 'string' || !SESSION_ID_SHORT_REGEX.test(sessionIdShort)) {
    return null;
  }
  // 2026-05-27 bug fix: previously `Limit: 5` which DDB interprets as
  // "evaluate at most 5 items before applying the filter", NOT "return at
  // most 5 matches". With >5 sessions in the table, the scan returned 0
  // matches for sessions outside the first 5 scanned rows — and the
  // reaper's classifier interpreted that as `session-row-missing → reap`,
  // deleting active worktrees mid-flight (incident 2026-05-27 in
  // session 9fc4c7cd).
  //
  // Fix: paginate through the full table, stop early when we've
  // collected ≥3 matches (enough for the collision check). Hex prefix
  // is very selective so this typically completes in one Scan page.
  const items: PartySession[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.partySessions,
        FilterExpression: 'begins_with(sessionId, :p)',
        ExpressionAttributeValues: { ':p': sessionIdShort },
        ExclusiveStartKey,
      }),
    );
    if (result.Items?.length) items.push(...(result.Items as PartySession[]));
    if (items.length >= 3) break;
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  if (items.length === 0) return null;
  if (items.length > 1) {
    console.warn(
      `[party-sessions-repository] findBySessionIdShort('${sessionIdShort}'): ${items.length} matches — collision or rolled-back row? Returning first.`,
    );
  }
  return items[0];
}

/**
 * Story 19.4 — set the per-session worktree path during bootstrap (Story 20.6).
 *
 * Writes BOTH `worktreePath` (canonical post-party-push name) AND
 * `projectPath` (the field `party-turn.mjs` reads for the subprocess `cwd`).
 * Pinning them to the same value means the spawn code in `party-turn.mjs`
 * doesn't change: when bootstrap rewrites a legacy session's path to its
 * new worktree, the daemon picks it up on the next turn automatically.
 *
 * @example
 * await setWorktreePath('a1b2c3d4-...', '/home/ubuntu/worktrees/applicator/_party/a1b2c3d4/');
 */
export async function setWorktreePath(sessionId: string, worktreePath: string): Promise<void> {
  const now = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partySessions,
      Key: { sessionId },
      UpdateExpression: 'SET worktreePath = :wt, projectPath = :wt, updatedAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':wt': worktreePath, ':now': now },
    }),
  );
}
