import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import { EXPECTED_AGENT_COUNT } from '../types/party';
import type { BmadStatus, PartyProject } from '../types/party';

export async function getProject(projectId: string): Promise<PartyProject | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.partyProjects, Key: { projectId } }),
  );
  return (result.Item as PartyProject) || null;
}

export async function listProjects(): Promise<PartyProject[]> {
  const out: PartyProject[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAMES.partyProjects, ExclusiveStartKey }),
    );
    if (result.Items) out.push(...(result.Items as PartyProject[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * Upsert a project row discovered on the filesystem. Idempotent: if the row
 * already exists it is left untouched (existing status is authoritative).
 */
export async function upsertProjectFromFilesystem(projectId: string, path: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAMES.partyProjects,
        Item: {
          projectId,
          path,
          bmadStatus: 'MISSING' as BmadStatus,
          expectedAgentCount: EXPECTED_AGENT_COUNT,
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(projectId)',
      }),
    );
  } catch (err) {
    const error = err as { name?: string };
    if (error.name !== 'ConditionalCheckFailedException') throw err;
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE_NAMES.partyProjects, Key: { projectId } }),
  );
}

export async function updateProjectState(
  projectId: string,
  patch: Partial<Omit<PartyProject, 'projectId' | 'createdAt'>>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partyProjects,
      Key: { projectId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Remove `allowedTools` from a project so it falls back to defaults at
 * daemon time. Distinct from setting [] (which means "deny all extras").
 */
export async function clearProjectAllowedTools(projectId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partyProjects,
      Key: { projectId },
      UpdateExpression: 'REMOVE allowedTools SET updatedAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
}

export type BootstrapLockResult =
  | { ok: true }
  | { ok: false; reason: 'BOOTSTRAP_IN_PROGRESS' | 'NOT_FOUND' };

/**
 * Atomically transition a project to INSTALLING. Allowed from: MISSING, HEALTHY,
 * DRIFTED, FAILED, CORRUPTED. Fails with BOOTSTRAP_IN_PROGRESS if already INSTALLING.
 */
export async function tryAcquireBootstrapLock(
  projectId: string,
  jobId: string,
): Promise<BootstrapLockResult> {
  const now = new Date().toISOString();
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.partyProjects,
        Key: { projectId },
        UpdateExpression:
          'SET bmadStatus = :installing, lastBootstrapJobId = :jobId, updatedAt = :now',
        ConditionExpression:
          'attribute_exists(projectId) AND bmadStatus IN (:missing, :healthy, :drifted, :failed, :corrupted)',
        ExpressionAttributeValues: {
          ':installing': 'INSTALLING',
          ':jobId': jobId,
          ':now': now,
          ':missing': 'MISSING',
          ':healthy': 'HEALTHY',
          ':drifted': 'DRIFTED',
          ':failed': 'FAILED',
          ':corrupted': 'CORRUPTED',
        },
      }),
    );
    return { ok: true };
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'ConditionalCheckFailedException') {
      const row = await getProject(projectId);
      if (!row) return { ok: false, reason: 'NOT_FOUND' };
      return { ok: false, reason: 'BOOTSTRAP_IN_PROGRESS' };
    }
    throw err;
  }
}
