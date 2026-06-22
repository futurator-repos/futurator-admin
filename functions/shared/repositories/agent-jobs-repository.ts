import {
  BatchWriteCommand,
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

/** Subset of an AgentJob projected by the by-app scan (cuts read cost). */
type AppJobMatchRow = {
  jobId: string;
  workingDir?: string;
  appBootstrapPayload?: { appId?: string };
  skillScoutPayload?: { projectSlug?: string; appId?: string };
  skillInstallPayload?: { projectSlug?: string; appId?: string };
  reflectorPayload?: { projectSlug?: string };
  remediationMerge?: { appId?: string };
  refactorAuditPayload?: { projectId?: string };
};

/**
 * Does a workingDir belong to this app? Anchored to the segment AFTER a known
 * root (`projects/<appId>[/...]` or `free-agent-worktrees/<appId>/<session>`)
 * rather than a bare basename — so it matches the app dir AND its worktrees AND
 * free-agent sessions, while NOT over-matching a different tree that merely ends
 * in the same slug (e.g. admin-self-edit `projects/futurator-admin`, or a
 * sibling `pacman10`). Exact segment compare, never substring.
 */
function workingDirMatchesApp(workingDir: string | undefined, appId: string): boolean {
  if (!workingDir) return false;
  const segs = workingDir.split('/').filter(Boolean);
  for (const root of ['projects', 'free-agent-worktrees']) {
    const i = segs.indexOf(root);
    if (i >= 0 && segs[i + 1] === appId) return true;
  }
  return false;
}

function jobBelongsToApp(row: AppJobMatchRow, appId: string): boolean {
  // workingDir (anchored) is the job-type-agnostic linkage; payload fields are
  // belt-and-braces for standalone skill-scout / skill-install / reflector jobs.
  return (
    workingDirMatchesApp(row.workingDir, appId) ||
    row.appBootstrapPayload?.appId === appId ||
    row.skillScoutPayload?.projectSlug === appId ||
    row.skillScoutPayload?.appId === appId ||
    row.skillInstallPayload?.projectSlug === appId ||
    row.skillInstallPayload?.appId === appId ||
    row.reflectorPayload?.projectSlug === appId ||
    row.remediationMerge?.appId === appId ||
    row.refactorAuditPayload?.projectId === appId
  );
}

/**
 * Find every job belonging to an app — by anchored workingDir OR any payload
 * projectSlug/appId — so a delete cascade can purge ALL of them, including the
 * standalone skill-scout / skill-install / reflector / deploy / free-agent jobs
 * that no plan/epic row references (those were the orphans keeping a deleted app
 * alive in the Skills Usage page). There is NO appId GSI on this table, so a
 * full paginated Scan is the only access path. (A ProjectionExpression trims the
 * returned payload, NOT the items DynamoDB evaluates — it does not lower scan
 * RCU or latency. The jobs table has no TTL and grows unbounded, so at large
 * scale this should become an async cleanup job; for the current single-operator
 * factory the inline scan is acceptable.)
 */
export async function listAppJobIds(appId: string): Promise<string[]> {
  const ids: string[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.agentJobs,
        ProjectionExpression:
          'jobId, workingDir, appBootstrapPayload, skillScoutPayload, skillInstallPayload, reflectorPayload, remediationMerge, refactorAuditPayload',
        ExclusiveStartKey,
      }),
    );
    for (const row of (result.Items ?? []) as AppJobMatchRow[]) {
      if (jobBelongsToApp(row, appId)) ids.push(row.jobId);
    }
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return ids;
}

/**
 * BatchWrite-delete jobs by id (25/request), retrying UnprocessedItems with
 * linear backoff. Unlike agent-events (7-day TTL), the jobs table has NO TTL —
 * an unprocessed delete is a permanent leak — so we count ONLY rows that
 * actually landed. Returns the true deleted count; a caller seeing
 * `deleted < jobIds.length` knows some rows survived throttling and can report
 * a partial/error status instead of a false 'done'.
 */
export async function batchDeleteJobs(jobIds: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < jobIds.length; i += 25) {
    const chunk = jobIds.slice(i, i + 25);
    let pending = chunk.map((jobId) => ({ DeleteRequest: { Key: { jobId } } }));
    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * attempt));
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [TABLE_NAMES.agentJobs]: pending } }),
      );
      const unprocessed = res.UnprocessedItems?.[TABLE_NAMES.agentJobs];
      pending = (unprocessed as typeof pending | undefined) ?? [];
    }
    deleted += chunk.length - pending.length; // count only what actually landed
  }
  return deleted;
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
