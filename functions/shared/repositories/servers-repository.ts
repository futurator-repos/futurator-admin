/**
 * Servers module — DynamoDB repository (pure DDB I/O, mirrors the
 * queue-requests repository).
 *
 * Table `futurator-servers`: PK serverId. Small fleet — bounded scans are
 * acceptable for list/find operations (mirrors listAllRequests).
 */

import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { ComputeServer } from '../types/compute-server';

export async function createServer(server: ComputeServer): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.servers, Item: server }));
}

export async function getServerById(serverId: string): Promise<ComputeServer | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.servers, Key: { serverId } }),
  );
  return (result.Item as ComputeServer) || null;
}

/**
 * Full server list. The fleet is small (single-operator factory) so a bounded
 * scan is acceptable; DELETED rows are filtered out by default.
 */
export async function listServers(opts?: { includeDeleted?: boolean }): Promise<ComputeServer[]> {
  const out: ComputeServer[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAMES.servers, ExclusiveStartKey }),
    );
    if (result.Items) out.push(...(result.Items as ComputeServer[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return opts?.includeDeleted ? out : out.filter((s) => s.status !== 'DELETED');
}

/**
 * Partial update of a server row. Always bumps `updatedAt`. `status` is a
 * reserved word so it is written via an expression-attribute name. Undefined
 * fields are skipped.
 */
export async function updateServerFields(
  serverId: string,
  fields: Partial<ComputeServer>,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const put = (k: string, v: unknown) => {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  };
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'serverId' || k === 'createdAt') continue;
    if (v === undefined) continue;
    put(k, v);
  }
  if (sets.length === 0) return;
  put('updatedAt', new Date().toISOString());
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.servers,
      Key: { serverId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Find a server by its enroll-token hash (used during daemon self-register).
 * Fleet is small so a filtered scan is acceptable.
 */
export async function findServerByEnrollTokenHash(hash: string): Promise<ComputeServer | null> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAMES.servers,
      FilterExpression: 'enrollTokenHash = :h',
      ExpressionAttributeValues: { ':h': hash },
    }),
  );
  const items = (result.Items as ComputeServer[]) || [];
  return items[0] || null;
}
