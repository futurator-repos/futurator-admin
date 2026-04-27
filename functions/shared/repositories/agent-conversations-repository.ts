// Pipeline v1 — Story 3.2. Repository for `futurator-agent-conversations`.

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AgentConversation } from '../types/agent-session';

export async function createConversation(c: AgentConversation): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.agentConversations, Item: c }));
}

export async function getConversationById(
  conversationId: string,
): Promise<AgentConversation | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.agentConversations,
      Key: { conversationId },
    }),
  );
  return (result.Item as AgentConversation) || null;
}

/** GSI `sessionId-index`. */
export async function listConversationsForSession(sessionId: string): Promise<AgentConversation[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.agentConversations,
      IndexName: 'sessionId-index',
      KeyConditionExpression: 'sessionId = :s',
      ExpressionAttributeValues: { ':s': sessionId },
    }),
  );
  return (result.Items as AgentConversation[]) || [];
}

export async function updateConversationFields(
  conversationId: string,
  patch: Partial<AgentConversation>,
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
      TableName: TABLE_NAMES.agentConversations,
      Key: { conversationId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Story 3.4 AC#3 — at most one OPEN conversation per session in v1. This
 * function lists existing conversations for the session and returns true
 * if any are OPEN (caller turns this into a 409).
 */
export async function hasOpenConversation(sessionId: string): Promise<boolean> {
  const all = await listConversationsForSession(sessionId);
  return all.some((c) => c.status === 'OPEN');
}
