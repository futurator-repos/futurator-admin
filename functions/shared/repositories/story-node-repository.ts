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

/**
 * Delete every StoryNode row for a plan (plan-spec-graph). Called by the plan-
 * delete + app-delete cascades so a deleted plan/app leaves no orphaned rows for
 * Labs3 to render (or for the ready-frontier to re-dispatch). Best-effort per
 * chunk; returns the number of rows deleted. No-op (0) when the plan was never
 * ingested as Pipeline-3.
 */
export async function deletePlanStoryNodes(planId: string): Promise<number> {
  const rows = await getPlanStoryNodes(planId);
  let deleted = 0;
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE]: chunk.map((r) => ({ DeleteRequest: { Key: { storyId: r.storyId } } })),
        },
      }),
    );
    deleted += chunk.length;
  }
  return deleted;
}

export async function getStoryNode(storyId: string): Promise<StoryNodeRow | null> {
  const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: { storyId } }));
  return (res.Item as StoryNodeRow) || null;
}

/**
 * Operator retry (2026-07-05): reset a wedged story to 'ready' + clear its
 * claim/job so the frontier re-mints. Race-safe: conditioned on a retryable
 * state — a story that just flipped 'done'/'ready' in parallel is untouched
 * (the conditional check throws; caller surfaces it). Mirrors the daemon
 * reaper's buildOrphanReleaseParams semantics, on demand.
 */
export async function resetStoryForRetry(storyId: string): Promise<void> {
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { storyId },
      UpdateExpression:
        'SET #state = :ready, updatedAt = :now REMOVE claimOwner, claimToken, claimExpiresAt, jobId',
      ConditionExpression: '#state IN (:failed, :claimed, :developing, :merging, :verifying)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':ready': 'ready',
        ':now': new Date().toISOString(),
        ':failed': 'failed',
        ':claimed': 'claimed',
        ':developing': 'developing',
        ':merging': 'merging',
        ':verifying': 'verifying',
      },
    }),
  );
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
  // Paginate: DynamoDB returns ≤1MB/query, and 'done'/'blocked' slices can grow
  // past that on a large plan — without the loop the Labs3 read silently truncates.
  const out: StoryNodeRow[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: PLAN_STATE_INDEX,
        KeyConditionExpression: 'planId = :p AND #s = :st',
        ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':p': planId, ':st': state },
        ExclusiveStartKey,
      }),
    );
    out.push(...((res.Items as StoryNodeRow[]) || []));
    ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}
