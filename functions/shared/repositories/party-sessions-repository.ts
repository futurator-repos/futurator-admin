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
 * Atomically transition a session from ACTIVE|IDLE to PROCESSING. Fails with
 * SESSION_BUSY if already PROCESSING.
 *
 * Full implementation in Story 15.2.
 */
export async function tryAcquireSessionLock(sessionId: string): Promise<SessionLockResult> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.partySessions,
        Key: { sessionId },
        UpdateExpression: 'SET #status = :processing',
        ConditionExpression:
          'attribute_exists(sessionId) AND (#status = :active OR #status = :idle)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'PROCESSING' as PartySessionStatus,
          ':active': 'ACTIVE' as PartySessionStatus,
          ':idle': 'IDLE' as PartySessionStatus,
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
