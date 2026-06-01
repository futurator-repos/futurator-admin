import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AgentEvent } from '../types/agent-orchestrator';

// Party chat transcript events. Schema mirrors agent-events (jobId PK, where
// jobId carries the sessionId for party turns; eventSeq SK) but this table
// has NO TTL — debate transcripts must persist.

export async function pushEvent(event: Omit<AgentEvent, 'expireAt'>): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.partyEvents,
      Item: { ...event },
    }),
  );
}

export async function getEventsAfter(
  sessionId: string,
  afterSeq: string,
  limit = 50,
): Promise<{ events: AgentEvent[]; lastSeq: string }> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.partyEvents,
      KeyConditionExpression: 'jobId = :jobId AND eventSeq > :after',
      ExpressionAttributeValues: {
        ':jobId': sessionId,
        ':after': afterSeq,
      },
      ScanIndexForward: true,
      Limit: limit,
    }),
  );

  const events = (result.Items || []) as AgentEvent[];
  const lastSeq = events.length > 0 ? events[events.length - 1].eventSeq : afterSeq;

  return { events, lastSeq };
}
