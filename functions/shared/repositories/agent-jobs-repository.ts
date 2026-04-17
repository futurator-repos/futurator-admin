import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AgentJob, WaveResult } from '../types/agent-orchestrator';

export async function createJob(job: AgentJob): Promise<AgentJob> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.agentJobs, Item: job }));
  return job;
}

export async function getJobById(jobId: string): Promise<AgentJob | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.agentJobs, Key: { jobId } }),
  );
  return (result.Item as AgentJob) || null;
}

export async function getOldestPendingJob(): Promise<AgentJob | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.agentJobs,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':pending': 'PENDING' },
      Limit: 1,
      ScanIndexForward: true,
    }),
  );
  return (result.Items?.[0] as AgentJob) || null;
}

/**
 * Paginated scan of the agent-jobs table. Used by offline operator tooling
 * (e.g. migration scripts) — never on the request path.
 */
export async function scanAllJobs(): Promise<AgentJob[]> {
  const out: AgentJob[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.agentJobs,
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as AgentJob[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

export async function deleteJob(jobId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAMES.agentJobs, Key: { jobId } }));
}

export async function updateJobFields(
  jobId: string,
  fields: Partial<Omit<AgentJob, 'jobId'>>,
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  // Always bump updatedAt
  entries.push(['updatedAt', new Date().toISOString()]);

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const expressions: string[] = [];

  for (const [key, value] of entries) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    expressions.push(`#${key} = :${key}`);
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.agentJobs,
      Key: { jobId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Append a wave checkpoint to the job's `waveResults` map (EO-4.1, §11).
 *
 * Uses two UpdateCommands:
 *   1. Seed `waveResults` as an empty map via `if_not_exists` — idempotent.
 *   2. Set `waveResults[<wave>] = result` and bump `updatedAt` / `lastHeartbeatAt`.
 *
 * Later writes to the same wave number overwrite; the daemon receiver relies
 * on this to tolerate retries from the orchestrator.
 */
export async function appendWaveResult(
  jobId: string,
  wave: number | string,
  result: WaveResult,
): Promise<void> {
  const waveKey = String(wave);
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.agentJobs,
      Key: { jobId },
      UpdateExpression: 'SET #wr = if_not_exists(#wr, :empty)',
      ExpressionAttributeNames: { '#wr': 'waveResults' },
      ExpressionAttributeValues: { ':empty': {} },
    }),
  );

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.agentJobs,
      Key: { jobId },
      UpdateExpression: 'SET #wr.#w = :r, #ua = :now, #hb = :now',
      ExpressionAttributeNames: {
        '#wr': 'waveResults',
        '#w': waveKey,
        '#ua': 'updatedAt',
        '#hb': 'lastHeartbeatAt',
      },
      ExpressionAttributeValues: {
        ':r': { ...result, persistedAt: result.persistedAt ?? now },
        ':now': now,
      },
    }),
  );
}
