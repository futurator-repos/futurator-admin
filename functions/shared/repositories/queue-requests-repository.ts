/**
 * Queues module — DynamoDB repository (pure DDB I/O, mirrors agent-jobs /
 * ultracode-runs repositories).
 *
 * Table `futurator-queue-requests`:
 *   PK requestId; GSI status-createdAt-index (queue drain + ops queries);
 *   GSI source-createdAt-index (per-app history). 30-day TTL on `expiresAt`.
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { QueueRequest, QueueRequestStatus } from '../types/queue-request';

export async function createRequest(request: QueueRequest): Promise<QueueRequest> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.queueRequests, Item: request }));
  return request;
}

export async function getRequestById(requestId: string): Promise<QueueRequest | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.queueRequests, Key: { requestId } }),
  );
  return (result.Item as QueueRequest) || null;
}

/**
 * List rows for a given status via the GSI, newest first. Used by the Queues
 * tab (e.g. status='QUEUED' for the live queue, or omit to list everything).
 */
export async function listRequestsByStatus(
  status: QueueRequestStatus,
  limit = 100,
): Promise<QueueRequest[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.queueRequests,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );
  return (result.Items as QueueRequest[]) || [];
}

/**
 * Full recent list across all statuses (Queues tab default view). The table is
 * small (30-day TTL, single-operator factory) so a bounded scan is acceptable;
 * callers sort by createdAt. Mirrors the scanAll pattern in agent-jobs-repository.
 */
export async function listAllRequests(limit = 200): Promise<QueueRequest[]> {
  const out: QueueRequest[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAMES.queueRequests, ExclusiveStartKey }),
    );
    if (result.Items) out.push(...(result.Items as QueueRequest[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey && out.length < limit);
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  return out.slice(0, limit);
}

export async function deleteRequest(requestId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE_NAMES.queueRequests, Key: { requestId } }),
  );
}

/**
 * Partial update of a request row. Always bumps `updatedAt`. `status` is a
 * reserved word so it is written via an expression-attribute name. Undefined
 * fields are skipped.
 */
export async function updateRequestFields(
  requestId: string,
  patch: Partial<Omit<QueueRequest, 'requestId' | 'createdAt'>>,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const put = (k: string, v: unknown) => {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    put(k, v);
  }
  if (sets.length === 0) return;
  put('updatedAt', new Date().toISOString());
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.queueRequests,
      Key: { requestId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
