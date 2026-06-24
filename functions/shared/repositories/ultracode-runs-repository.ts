/**
 * Ultracode-Reverse — DynamoDB repository (pure DDB I/O, mirrors agent-jobs-repository).
 *
 * Table `futurator-ultracode-runs` (additive; never reshapes a shared table):
 *   PK runId; GSI operator-createdAt-index (my runs, newest first);
 *   GSI status-createdAt-index (daemon/ops queries). 90-day TTL on `expiresAt`.
 */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { UltracodeRun, UltracodeRunSummary } from '../types/ultracode-run';
import { toRunSummary } from '../types/ultracode-run';

export async function createRun(run: UltracodeRun): Promise<UltracodeRun> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.ultracodeRuns, Item: run }));
  return run;
}

export async function getRun(runId: string): Promise<UltracodeRun | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.ultracodeRuns, Key: { runId } }),
  );
  return (result.Item as UltracodeRun) || null;
}

/** Owner-scoped corpus list, newest first. */
export async function listRunsByOperator(
  operatorId: string,
  limit = 50,
): Promise<UltracodeRunSummary[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.ultracodeRuns,
      IndexName: 'operator-createdAt-index',
      KeyConditionExpression: 'operatorId = :op',
      ExpressionAttributeValues: { ':op': operatorId },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );
  return ((result.Items as UltracodeRun[]) || []).map(toRunSummary);
}

/**
 * Partial update of a run row. Always bumps `updatedAt`. `status` is reserved so it
 * is written via an expression-attribute name. Undefined fields are skipped.
 */
export async function updateRun(
  runId: string,
  patch: Partial<Omit<UltracodeRun, 'runId' | 'createdAt'>>,
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
  if (sets.length === 0) return; // true no-op: nothing to update, don't even bump updatedAt
  put('updatedAt', new Date().toISOString());
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.ultracodeRuns,
      Key: { runId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
