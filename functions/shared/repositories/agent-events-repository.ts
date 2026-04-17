import { BatchWriteCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AgentEvent } from '../types/agent-orchestrator';

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export async function pushEvent(event: Omit<AgentEvent, 'expireAt'>): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.agentEvents,
      Item: {
        ...event,
        expireAt: Math.floor(Date.now() / 1000) + SEVEN_DAYS_SECONDS,
      },
    }),
  );
}

export async function deleteEventsForJob(jobId: string): Promise<number> {
  let deleted = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.agentEvents,
        KeyConditionExpression: 'jobId = :jobId',
        ExpressionAttributeValues: { ':jobId': jobId },
        ProjectionExpression: 'jobId, eventSeq',
        ExclusiveStartKey: lastKey,
      }),
    );

    const items = result.Items || [];
    lastKey = result.LastEvaluatedKey;

    // BatchWrite in chunks of 25 (DynamoDB limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAMES.agentEvents]: batch.map((item) => ({
              DeleteRequest: { Key: { jobId: item.jobId, eventSeq: item.eventSeq } },
            })),
          },
        }),
      );
      deleted += batch.length;
    }
  } while (lastKey);

  return deleted;
}

/**
 * Paginated scan of the agent-events table. Used by offline reporting
 * (EO-7.3 metrics dashboard) — never on a hot path. The 7-day TTL keeps the
 * table bounded, so a full scan is acceptable here.
 */
export async function scanAllEvents(): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.agentEvents,
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as AgentEvent[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

export async function getEventsAfter(
  jobId: string,
  afterSeq: string,
  limit = 50,
): Promise<{ events: AgentEvent[]; lastSeq: string }> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.agentEvents,
      KeyConditionExpression: 'jobId = :jobId AND eventSeq > :after',
      ExpressionAttributeValues: {
        ':jobId': jobId,
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
