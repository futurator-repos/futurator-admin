import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { App, AppExecutionMode } from '../types/app';
import type { AgentJob } from '../types/agent-orchestrator';
import { AppError } from '../errors';
import { RESERVED_APP_IDS, APP_SLUG_REGEX } from '../schemas/app-schema';

/**
 * App repository (App/Plan v1).
 *
 * Storage: DynamoDB table `futurator-apps`, partition key `appId` (slug).
 * No GSIs — listApps does a Scan (table size is small).
 */

export interface CreateAppArgs {
  appId: string;
  displayName: string;
  icon?: string;
  executionMode?: AppExecutionMode;
  /** 2026-05-30 — brownfield: the App's real GitHub repo (any org) + branch. */
  githubRepoUrl?: string;
  githubBranch?: string;
}

/**
 * Create a new App. Validates slug format + reserved-list, sets `workingDir`
 * derived from `appId`, initializes `workingTreeStatus='clean'` and
 * `currentlyDeployedPlanId=null`. Rejects with 409 `APP_ID_TAKEN` on duplicate.
 */
export async function createApp(args: CreateAppArgs): Promise<App> {
  if (!APP_SLUG_REGEX.test(args.appId)) {
    throw new AppError(
      'APP_ID_INVALID',
      `App slug "${args.appId}" must be kebab-case (lowercase letters/digits/hyphens, no leading/trailing/double hyphens).`,
      400,
    );
  }
  if (RESERVED_APP_IDS.has(args.appId)) {
    throw new AppError(
      'APP_ID_RESERVED',
      `App slug "${args.appId}" is reserved (collides with homepage S3 paths).`,
      400,
    );
  }

  const existing = await getApp(args.appId);
  if (existing) {
    throw new AppError('APP_ID_TAKEN', `App "${args.appId}" already exists.`, 409);
  }

  const now = new Date().toISOString();
  const app: App = {
    appId: args.appId,
    displayName: args.displayName,
    icon: args.icon,
    workingDir: `/home/ubuntu/projects/${args.appId}`,
    // Pipeline v2 Phase 2-A Story 2-A-misc-pr43 — default flipped from
    // 'orchestrator' to 'pipeline' on 2026-05-06. brick-breaker forensic
    // (`docs/concepts/logs/plan_brick-breaker_mou3l51l-forensic-review.md`
    // §F-1) showed Apps inherited 'orchestrator' silently because of this
    // default, which then routed every Plan via the legacy orchestrator
    // path — bypassing every Phase 2-A improvement (PR-32 → PR-42).
    //
    // Plans inherit App.executionMode (functions/api/index.ts:6475:
    // `executionMode: parsed.data.executionMode ?? appRow.executionMode`)
    // so flipping here cascades to all new Plans automatically.
    //
    // Existing Apps retain their persisted executionMode unchanged — no
    // migration. Operators can override via the New App form.
    executionMode: args.executionMode ?? 'pipeline',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    workingTreeStatus: 'clean',
    ...(args.githubRepoUrl ? { githubRepoUrl: args.githubRepoUrl } : {}),
    ...(args.githubBranch ? { githubBranch: args.githubBranch } : {}),
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.apps, Item: app }));
  return app;
}

/** Fetch a single App by slug. Returns null when missing. */
export async function getApp(appId: string): Promise<App | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.apps, Key: { appId } }),
  );
  return (result.Item as App) || null;
}

/**
 * List all Apps. v1 uses ScanCommand — table is small (admin single-tenant).
 * Add a GSI + paginated query if N ever exceeds ~500.
 */
export async function listApps(): Promise<App[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.apps }));
  return (result.Items || []) as App[];
}

/**
 * Update mutable App fields. `appId`, `workingDir`, `createdAt`, `deployJobIds`
 * are NOT mutable through this path (use `appendDeployJobId` for the latter).
 */
export async function updateApp(
  appId: string,
  patch: Partial<
    Pick<
      App,
      'displayName' | 'icon' | 'executionMode' | 'currentlyDeployedPlanId' | 'workingTreeStatus'
    >
  >,
): Promise<App> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    const existing = await getApp(appId);
    if (!existing) {
      throw new AppError('APP_NOT_FOUND', `App "${appId}" not found.`, 404);
    }
    return existing;
  }

  entries.push(['updatedAt', new Date().toISOString()]);

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const expressions: string[] = [];

  for (const [key, value] of entries) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    expressions.push(`#${key} = :${key}`);
  }

  const result = await docClient
    .send(
      new UpdateCommand({
        TableName: TABLE_NAMES.apps,
        Key: { appId },
        UpdateExpression: `SET ${expressions.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(appId)',
        ReturnValues: 'ALL_NEW',
      }),
    )
    .catch((err: Error) => {
      if (err.name === 'ConditionalCheckFailedException') {
        throw new AppError('APP_NOT_FOUND', `App "${appId}" not found.`, 404);
      }
      throw err;
    });

  return result.Attributes as App;
}

/**
 * Atomically append a deploy job ID to an App's history.
 * Uses DDB `list_append` so two near-simultaneous deploys don't lose entries.
 */
export async function appendDeployJobId(appId: string, deployJobId: string): Promise<App> {
  const result = await docClient
    .send(
      new UpdateCommand({
        TableName: TABLE_NAMES.apps,
        Key: { appId },
        UpdateExpression:
          'SET deployJobIds = list_append(if_not_exists(deployJobIds, :empty), :new), updatedAt = :now',
        ExpressionAttributeValues: {
          ':empty': [],
          ':new': [deployJobId],
          ':now': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(appId)',
        ReturnValues: 'ALL_NEW',
      }),
    )
    .catch((err: Error) => {
      if (err.name === 'ConditionalCheckFailedException') {
        throw new AppError('APP_NOT_FOUND', `App "${appId}" not found.`, 404);
      }
      throw err;
    });

  return result.Attributes as App;
}

/**
 * Hard-delete an App. Caller MUST cascade-delete all of the App's Plans
 * (and their Epics) before calling this — there is no automatic cascade
 * here. See the API layer's DELETE /api/apps/:appId handler.
 */
export async function deleteApp(appId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAMES.apps, Key: { appId } }));
}

/**
 * Pipeline v2 / Story 1.4.4 — atomic App row + bootstrap job write.
 *
 * Writes BOTH the new App row AND the daemon-pickup `app-bootstrap` job in a
 * single DynamoDB `TransactWriteCommand`, guarded by `attribute_not_exists`
 * conditions so an in-flight retry never overwrites an existing row.
 *
 * Failure modes the caller must handle:
 *   - `TransactionCanceledException` — usually means one of the conditional
 *     checks failed (App slug taken, jobId collision). The route layer treats
 *     this as a 500 and triggers GitHub repo rollback (Gate G-7).
 *   - Any other DDB error — bubbles up; the route layer also rolls back.
 *
 * On rollback the partial repo is deleted; a duplicated transaction with the
 * same args after rollback succeeds because the conditional checks pass.
 *
 * @returns `{ app, job }` so the caller can return the App to the UI and the
 *          jobId in the 201 response.
 */
export async function createAppAndBootstrapJob(
  app: App,
  job: AgentJob,
): Promise<{ app: App; job: AgentJob }> {
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAMES.apps,
            Item: app,
            // Fail loudly if the slug is already taken — the caller's
            // pre-check is best-effort, this is the authoritative guard.
            ConditionExpression: 'attribute_not_exists(appId)',
          },
        },
        {
          Put: {
            TableName: TABLE_NAMES.agentJobs,
            Item: job,
            ConditionExpression: 'attribute_not_exists(jobId)',
          },
        },
      ],
    }),
  );
  return { app, job };
}
