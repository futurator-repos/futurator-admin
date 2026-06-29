/**
 * story-node-repository — persistence for plan-spec-graph StoryNode rows
 * (development-plan §5.1). One concern per table (multi-table law).
 *
 * Implements the `StoryNodeRepository` the ingest service depends on, plus the
 * frontier/grouping reads the daemon dispatcher uses (GSI planId-state-index).
 */

import { BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { StoryNodeRow, StoryNodeState } from '../types/plan-spec';

const TABLE = TABLE_NAMES.planSpecGraph;
const PLAN_STATE_INDEX = 'planId-state-index';
const PLAN_BATCH_INDEX = 'planId-cohortBatch-index';

/** Idempotent batch put, chunked to DynamoDB's 25-item BatchWrite limit. */
export async function batchPutStoryNodes(rows: StoryNodeRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: { [TABLE]: chunk.map((Item) => ({ PutRequest: { Item } })) },
      }),
    );
  }
}

export async function getStoryNode(storyId: string): Promise<StoryNodeRow | null> {
  const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: { storyId } }));
  return (res.Item as StoryNodeRow) || null;
}

/** All StoryNodes for a plan (paginated). Used to build the live graph snapshot. */
export async function getPlanStoryNodes(planId: string): Promise<StoryNodeRow[]> {
  const out: StoryNodeRow[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: PLAN_BATCH_INDEX,
        KeyConditionExpression: 'planId = :p',
        ExpressionAttributeValues: { ':p': planId },
        ExclusiveStartKey,
      }),
    );
    out.push(...((res.Items as StoryNodeRow[]) || []));
    ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/** StoryNodes for a plan in a given lifecycle state (e.g. 'ready' for the frontier). */
export async function getPlanStoryNodesByState(
  planId: string,
  state: StoryNodeState,
): Promise<StoryNodeRow[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: PLAN_STATE_INDEX,
      KeyConditionExpression: 'planId = :p AND #s = :st',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':p': planId, ':st': state },
    }),
  );
  return (res.Items as StoryNodeRow[]) || [];
}
