import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AgentJob } from '../types/agent-orchestrator';

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
