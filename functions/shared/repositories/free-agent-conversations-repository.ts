/**
 * free-agent-conversations-repository.ts — Story 18.6 (Epic 18: Free Claude Code Agent)
 *
 * One row per message in a free-agent session. The session metadata lives in
 * `futurator-free-agent-sessions` (Story 18.2); this table stores the actual
 * conversation contents with a 90-day TTL — long enough to outlast the 7-day
 * TTL on `futurator-agent-events`.
 *
 * v1 writes USER messages from the API layer (POST /api/free-agent/sessions/:id/messages).
 * Assistant-message writes from the daemon (on `free-agent.turn.complete`) are
 * deferred to v1.1 — they require a daemon-side facade duplicating the DDB
 * operations here, matching the Story 18.2 sessions-facade pattern.
 *
 * `listSessionsByOperator` and `listSessionsByScope` delegate directly to
 * `free-agent-sessions-repository` (Story 18.2 GSIs). No need to duplicate the
 * GSI queries — the conversations repo just re-exports them for the consumer's
 * convenience.
 */

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { FreeAgentConversationMessage } from '../types/free-agent';
import type { FreeAgentSession } from '../types/free-agent';
import {
  listSessionsByOperator as sessionsListByOperator,
  listSessionsByScope as sessionsListByScope,
} from './free-agent-sessions-repository';

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;
const MESSAGE_INDEX_WIDTH = 6;

export interface AppendMessageInput {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  toolCalls?: Array<{ id: string; name: string; input?: unknown }>;
}

/**
 * Append a new message to a session's conversation. Computes `messageIndex` as
 * `count(existing rows) + 1` zero-padded to 6 digits. Race-free per session in
 * v1 because Story 18.2's `acquireProcessingLock` guarantees only one POST
 * /messages is in-flight at a time per session. v1.1 daemon-side writes will
 * need an atomic counter approach (likely a `messageCount` attribute on the
 * session row + a conditional UpdateCommand).
 */
export async function appendMessage(
  input: AppendMessageInput,
): Promise<FreeAgentConversationMessage> {
  const existing = await getMessages(input.sessionId);
  const nextIndex = (existing.length + 1).toString().padStart(MESSAGE_INDEX_WIDTH, '0');
  const now = new Date();
  const message: FreeAgentConversationMessage = {
    sessionId: input.sessionId,
    messageIndex: nextIndex,
    role: input.role,
    content: input.content,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    costUsd: input.costUsd,
    toolCalls: input.toolCalls,
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + NINETY_DAYS_SECONDS,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.freeAgentConversations,
      Item: message,
      // Defensive: prevent duplicate write at the same (sessionId, messageIndex).
      ConditionExpression: 'attribute_not_exists(sessionId) AND attribute_not_exists(messageIndex)',
    }),
  );

  return message;
}

/**
 * Get all messages for a session, sorted ascending by messageIndex.
 * Paginates through DDB pages; bounded by the 90-day TTL.
 */
export async function getMessages(sessionId: string): Promise<FreeAgentConversationMessage[]> {
  const out: FreeAgentConversationMessage[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.freeAgentConversations,
        KeyConditionExpression: 'sessionId = :sid',
        ExpressionAttributeValues: { ':sid': sessionId },
        ScanIndexForward: true,
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as FreeAgentConversationMessage[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/** Delegate — recent sessions for the operator (Story 18.2 GSI1). */
export async function listSessionsByOperator(
  operatorId: string,
  limit?: number,
): Promise<FreeAgentSession[]> {
  return sessionsListByOperator(operatorId, limit);
}

/** Delegate — recent sessions for a scope (Story 18.2 GSI2). */
export async function listSessionsByScope(
  scope: { kind: string; id?: string },
  limit?: number,
): Promise<FreeAgentSession[]> {
  return sessionsListByScope(scope, limit);
}

/**
 * Best-effort first-user-message preview for a session (used by the thread
 * list UI). Returns null if no user message exists yet (e.g., session created
 * but never sent to).
 */
export async function getFirstUserMessagePreview(
  sessionId: string,
  maxChars = 80,
): Promise<string | null> {
  const messages = await getMessages(sessionId);
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return null;
  const trimmed = firstUser.content.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}
