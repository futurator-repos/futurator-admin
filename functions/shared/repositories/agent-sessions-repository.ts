// Pipeline v1 — Story 3.1. Repository for `futurator-agent-sessions`.

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AgentSession, SessionWarmth } from '../types/agent-session';

export async function createSession(session: AgentSession): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.agentSessions, Item: session }));
}

export async function getSessionById(sessionId: string): Promise<AgentSession | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.agentSessions, Key: { sessionId } }),
  );
  return (result.Item as AgentSession) || null;
}

/**
 * GSI `jobId-stepId-index` lookup. Returns the first match — caller can
 * decide whether to filter further (e.g. ACTIVE-only).
 */
export async function findByJobAndStep(
  jobId: string,
  stepId: string,
): Promise<AgentSession | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.agentSessions,
      IndexName: 'jobId-stepId-index',
      KeyConditionExpression: 'jobId = :j AND stepId = :s',
      ExpressionAttributeValues: { ':j': jobId, ':s': stepId },
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as AgentSession) || null;
}

export async function updateSessionFields(
  sessionId: string,
  patch: Partial<AgentSession>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const expressions: string[] = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    expressions.push(`#${k} = :${k}`);
  }
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.agentSessions,
      Key: { sessionId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

const HOT_THRESHOLD_MS = 60_000; // 1 min
const WARM_THRESHOLD_MS = 5 * 60_000; // 5 min
const COLD_THRESHOLD_MS = 30 * 60_000; // 30 min

export function getSessionWarmth(
  session: Pick<AgentSession, 'lastTurnAt'>,
  now: number = Date.now(),
): SessionWarmth {
  if (!session.lastTurnAt) return 'COLD';
  const age = now - new Date(session.lastTurnAt).getTime();
  if (age < HOT_THRESHOLD_MS) return 'HOT';
  if (age < WARM_THRESHOLD_MS) return 'WARM';
  if (age < COLD_THRESHOLD_MS) return 'COLD';
  return 'STALE';
}
