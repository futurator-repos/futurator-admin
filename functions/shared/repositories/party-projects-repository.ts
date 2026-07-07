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

/**
 * Lazy-migrate legacy rows missing the `kind` discriminator (Story 15.4 AC #1).
 * Pre-15.4 rows existed before the field; they are greenfield by definition.
 * No DDB write — the migration is read-side only.
 */
function applyLazyKind(item: Record<string, unknown> | undefined): PartyProject | null {
  if (!item) return null;
  const row = item as unknown as PartyProject;
  if (row.kind === undefined) {
    return { ...row, kind: 'greenfield' };
  }
  return row;
}

export async function getProject(projectId: string): Promise<PartyProject | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.partyProjects, Key: { projectId } }),
  );
  return applyLazyKind(result.Item);
}

export async function listProjects(): Promise<PartyProject[]> {
  const out: PartyProject[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAMES.partyProjects, ExclusiveStartKey }),
    );
    if (result.Items) {
      for (const raw of result.Items) {
        const row = applyLazyKind(raw);
        if (row) out.push(row);
      }
    }
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
          kind: 'greenfield',
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

/**
 * Create a brownfield project row from API input (Story 15.4 AC #2). Mirrors
 * `upsertProjectFromFilesystem` but carries `kind='brownfield'` and the git
 * fields. Returns true if a new row was written; false if the row already
 * existed (so callers can return a 409 if they need creation semantics).
 */
export async function createBrownfieldProjectRow(
  projectId: string,
  path: string,
  opts: {
    gitRepoUrl: string;
    gitBranch: string;
    patSecretName?: string;
    envVars?: Record<string, string>;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const item: Record<string, unknown> = {
    projectId,
    path,
    kind: 'brownfield',
    bmadStatus: 'MISSING' as BmadStatus,
    expectedAgentCount: EXPECTED_AGENT_COUNT,
    gitRepoUrl: opts.gitRepoUrl,
    gitBranch: opts.gitBranch,
    lastPulledAt: null,
    lastCommitSha: null,
    createdAt: now,
    updatedAt: now,
  };
  if (opts.patSecretName) item.patSecretName = opts.patSecretName;
  if (opts.envVars && Object.keys(opts.envVars).length > 0) item.envVars = opts.envVars;

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAMES.partyProjects,
        Item: item,
        ConditionExpression: 'attribute_not_exists(projectId)',
      }),
    );
    return true;
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Migrate-module — update the env-var map on a brownfield project row.
 * Encrypted at rest by DDB's default KMS. Operator-initiated via
 * `PATCH /api/migrations/:id` body `envVars` field.
 */
export async function updateBrownfieldEnvVars(
  projectId: string,
  envVars: Record<string, string>,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partyProjects,
      Key: { projectId },
      UpdateExpression: 'SET envVars = :ev, updatedAt = :now',
      ConditionExpression: 'attribute_exists(projectId) AND #k = :brownfield',
      ExpressionAttributeNames: { '#k': 'kind' },
      ExpressionAttributeValues: {
        ':ev': envVars,
        ':now': new Date().toISOString(),
        ':brownfield': 'brownfield',
      },
    }),
  );
}

/**
 * Story 21.1 (party-push Epic 21) — flip a brownfield project's pushEnabled
 * flag. Daemon-side `party-checkpoint.sh` reads `project.pushEnabled` before
 * running the push step. Greenfield projects can also opt in but the UI only
 * surfaces the toggle for brownfield (greenfield projects already auto-push
 * via the existing deploy-agent pipeline).
 */
export async function updateProjectPushEnabled(
  projectId: string,
  pushEnabled: boolean,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partyProjects,
      Key: { projectId },
      UpdateExpression: 'SET pushEnabled = :pe, updatedAt = :now',
      ConditionExpression: 'attribute_exists(projectId)',
      ExpressionAttributeValues: {
        ':pe': pushEnabled,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

/**
 * Flip a project's auto-open-PR opt-in. The daemon reads `project.autoOpenPr`
 * after a successful checkpoint push and, when true, opens/updates a draft PR.
 * Independent of pushEnabled (no PAT rotation needed) — but only has effect
 * when pushEnabled is also true, since there's no pushed branch otherwise.
 */
export async function updateProjectAutoOpenPr(
  projectId: string,
  autoOpenPr: boolean,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partyProjects,
      Key: { projectId },
      UpdateExpression: 'SET autoOpenPr = :ap, updatedAt = :now',
      ConditionExpression: 'attribute_exists(projectId)',
      ExpressionAttributeValues: {
        ':ap': autoOpenPr,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

/**
 * 2026-06-12 — flip the per-project auto-merge toggle. Independent write
 * (no PAT); only effective server-side when pushEnabled + autoOpenPr are
 * also on (the daemon checks all three before merging).
 */
export async function updateProjectAutoMerge(projectId: string, autoMerge: boolean): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partyProjects,
      Key: { projectId },
      UpdateExpression: 'SET autoMerge = :am, updatedAt = :now',
      ConditionExpression: 'attribute_exists(projectId)',
      ExpressionAttributeValues: {
        ':am': autoMerge,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

/**
 * Migrate-module — record the Secrets Manager secret name holding this
 * project's PAT. Called by the API after `CreateSecretCommand` succeeds.
 */
export async function updateBrownfieldPatSecretName(
  projectId: string,
  patSecretName: string,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partyProjects,
      Key: { projectId },
      UpdateExpression: 'SET patSecretName = :ps, updatedAt = :now',
      ConditionExpression: 'attribute_exists(projectId) AND #k = :brownfield',
      ExpressionAttributeNames: { '#k': 'kind' },
      ExpressionAttributeValues: {
        ':ps': patSecretName,
        ':now': new Date().toISOString(),
        ':brownfield': 'brownfield',
      },
    }),
  );
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

export type RefreshLockResult =
  | { ok: true }
  | { ok: false; reason: 'REFRESH_IN_PROGRESS' | 'NOT_FOUND' | 'INVALID_STATE' };

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

/**
 * Atomically transition a brownfield project into REFRESHING (Story 15.4 AC #7).
 * Allowed source states: HEALTHY | DRIFTED (steady-state re-sync) plus FAILED |
 * CORRUPTED (recovery) — a refresh is a hard `git reset --hard origin/<branch>`,
 * so it's the correct way to recover a clone whose prior refresh/bootstrap left
 * it broken. Mirrors tryAcquireBootstrapLock's recovery set; the sole blocked
 * source is REFRESHING itself (→ REFRESH_IN_PROGRESS). Returns INVALID_STATE for
 * any other source state.
 */
export async function tryAcquireRefreshLock(projectId: string): Promise<RefreshLockResult> {
  const now = new Date().toISOString();
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.partyProjects,
        Key: { projectId },
        UpdateExpression: 'SET bmadStatus = :refreshing, updatedAt = :now',
        ConditionExpression:
          'attribute_exists(projectId) AND bmadStatus IN (:healthy, :drifted, :failed, :corrupted)',
        ExpressionAttributeValues: {
          ':refreshing': 'REFRESHING',
          ':now': now,
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
      if (row.bmadStatus === 'REFRESHING') return { ok: false, reason: 'REFRESH_IN_PROGRESS' };
      return { ok: false, reason: 'INVALID_STATE' };
    }
    throw err;
  }
}

/**
 * Release the refresh lock by setting bmadStatus to `next` (typically HEALTHY
 * or FAILED). Unlike acquisition this is unconditional — callers own the
 * decision of which terminal state to enter.
 */
export async function releaseRefreshLock(
  projectId: string,
  next: 'HEALTHY' | 'FAILED',
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.partyProjects,
      Key: { projectId },
      UpdateExpression: 'SET bmadStatus = :next, updatedAt = :now',
      ExpressionAttributeValues: {
        ':next': next,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

/**
 * Typed wrapper over `updateProjectState` for the post-refresh write. Keeps
 * the daemon-side caller surface narrow: only the fields that change on a
 * successful refresh.
 */
export async function updateProjectAfterRefresh(
  projectId: string,
  patch: {
    lastPulledAt: string;
    lastCommitSha: string;
    customAgentsSHA: string;
    agentCount?: number;
    failureReason?: string;
  },
): Promise<void> {
  await updateProjectState(projectId, {
    ...patch,
    lastInspectedAt: patch.lastPulledAt,
  });
}
