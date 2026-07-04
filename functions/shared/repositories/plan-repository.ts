import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { Plan, PlanStatus, PlanSummary } from '../types/plan';
import { AppError } from '../errors';
import { PLAN_LEGAL_TRANSITIONS } from '../schemas/plan-schema';

/**
 * Create a new Plan.
 *
 * Rejects with 409 `NAME_TAKEN` if another non-archived plan already uses the
 * same `name`. Archived plans holding the name are NOT counted — a user can
 * reuse a name once an old plan is archived.
 */
export async function createPlan(plan: Plan): Promise<Plan> {
  // Enforce uniqueness of `name` across non-archived plans via scan-then-put.
  // This is a small table (≤ hundreds of rows) so the scan is cheap; if we
  // ever need to scale, add a GSI on (`name`, `status`).
  const existing = await getPlanByName(plan.name);
  if (existing && existing.status !== 'archived') {
    throw new AppError(
      'NAME_TAKEN',
      `Plan name "${plan.name}" is already in use by plan ${existing.planId}`,
      409,
    );
  }

  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.plans, Item: plan }));
  return plan;
}

export async function getAllPlans(): Promise<Plan[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.plans }));
  return (result.Items || []) as Plan[];
}

export async function getPlanById(planId: string): Promise<Plan | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.plans, Key: { planId } }),
  );
  return (result.Item as Plan) || null;
}

/**
 * Find a plan by its canonical `name`.
 *
 * Scans the table with a filter expression. Returns the first match or null.
 * If multiple plans share a name (shouldn't happen due to createPlan's check,
 * but archived plans can share names with active ones), prefers non-archived.
 */
export async function getPlanByName(name: string): Promise<Plan | null> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAMES.plans,
      FilterExpression: '#n = :n',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: { ':n': name },
    }),
  );
  const items = (result.Items || []) as Plan[];
  if (items.length === 0) return null;
  // Prefer a non-archived match if any.
  return items.find((p) => p.status !== 'archived') || items[0];
}

export async function updatePlanFields(
  planId: string,
  fields: Partial<Omit<Plan, 'planId' | 'name'>>,
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

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
      TableName: TABLE_NAMES.plans,
      Key: { planId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * QA-Review W2 — clear the p3QaJobId FK (REMOVE, not SET-null) so the cron's
 * `!plan.p3QaJobId` guard re-enqueues a fresh QA run after a send-back. The
 * generic updatePlanFields skips `undefined`, so a dedicated REMOVE is needed.
 */
export async function clearP3QaJob(planId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.plans,
      Key: { planId },
      UpdateExpression: 'REMOVE p3QaJobId SET updatedAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
}

/**
 * QA-Review W2 — reset QA state for a re-run (send-back / autopilot fix round).
 * REMOVES p3QaJobId, p3QaVerdict, devDeployJobId AND qaCommitSha:
 *  - p3QaVerdict: a sent-back verdict carries decidedAt, and the daemon's
 *    next-run write guards on `attribute_not_exists(p3QaVerdict.decidedAt)` —
 *    leaving it would permanently block the re-review verdict from persisting.
 *  - devDeployJobId + qaCommitSha: the cron's dev-deploy fires on
 *    `!devDeployJobId`; without clearing them the FIXED commit would never be
 *    re-deployed and re-QA would (with a stale pin) run against the OLD build.
 * After the fix stories land and the plan re-enters `review`, the full chain
 * re-fires fresh: dev-deploy → new qaCommitSha stamp → p3-qa → new verdict.
 */
export async function clearP3QaForRerun(planId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.plans,
      Key: { planId },
      UpdateExpression:
        'REMOVE p3QaJobId, p3QaVerdict, devDeployJobId, qaCommitSha SET updatedAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
}

/**
 * QA-Review W2 — persist a fresh P3 QA verdict, shadow-safe. Two guards:
 *  1. STALE guard — only write if verdict.ranAtSha matches the plan's current
 *     qaCommitSha (the runner ran against the deployed artifact; if the artifact
 *     moved on since, this verdict is stale and dropped).
 *  2. DECISION guard — never clobber an operator decision: if the stored verdict
 *     already carries decidedAt, a re-run leaves it untouched.
 * Returns whether it wrote. Reuses updatePlanFields for the write itself.
 */
export async function writeP3QaVerdict(
  planId: string,
  verdict: NonNullable<Plan['p3QaVerdict']>,
): Promise<{ written: boolean; reason?: string }> {
  const plan = await getPlanById(planId);
  if (!plan) return { written: false, reason: 'plan-not-found' };
  if (plan.qaCommitSha && verdict.ranAtSha && plan.qaCommitSha !== verdict.ranAtSha) {
    return { written: false, reason: 'stale-sha' };
  }
  if (plan.p3QaVerdict?.decidedAt) {
    return { written: false, reason: 'human-decided' };
  }
  await updatePlanFields(planId, { p3QaVerdict: verdict });
  return { written: true };
}

/**
 * Event-driven advancement (2026-05-30) — a short-lived per-plan reduce lock.
 *
 * Both the WaveCompletionCheck cron AND the reactive
 * `POST /api/plans/:id/check-wave-completion` (the daemon hits it the instant a
 * job finishes) run `reducePlan`. Running both concurrently for the same plan
 * could double-create a wave-merge/next-wave job (the reducer's
 * read-`waveBuildJobs`-then-write isn't atomic). This lock serializes reduce
 * passes per plan at the source, without touching the delicate reducer order.
 *
 * Conditional acquire: succeeds iff no live lock (`attribute_not_exists`) OR the
 * existing lock is stale (older than `ttlMs` — a crashed holder can't wedge
 * advancement forever). The cron is the backstop, so a missed acquire is
 * harmless: advancement just happens on the next tick.
 *
 * @returns the lock token if acquired, else null.
 */
export async function acquirePlanReduceLock(
  planId: string,
  nowMs: number,
  ttlMs = 60_000,
): Promise<string | null> {
  const token = `${nowMs}-${Math.round((nowMs * 7919) % 1_000_000)}`;
  const staleBefore = nowMs - ttlMs;
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.plans,
        Key: { planId },
        UpdateExpression: 'SET reduceLockToken = :tok, reduceLockAt = :now',
        ConditionExpression:
          'attribute_not_exists(reduceLockToken) OR attribute_not_exists(reduceLockAt) OR reduceLockAt < :stale',
        ExpressionAttributeValues: { ':tok': token, ':now': nowMs, ':stale': staleBefore },
      }),
    );
    return token;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

/**
 * Release the reduce lock iff we still hold it (token match). Best-effort —
 * a failed release just lets the TTL reclaim it.
 */
export async function releasePlanReduceLock(planId: string, token: string): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.plans,
        Key: { planId },
        UpdateExpression: 'REMOVE reduceLockToken, reduceLockAt',
        ConditionExpression: 'reduceLockToken = :tok',
        ExpressionAttributeValues: { ':tok': token },
      }),
    );
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

export async function deletePlan(planId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAMES.plans, Key: { planId } }));
}

// ─────────────────────────────────────────────────────────────────────
// App/Plan v1 — App-aware queries + lifecycle helpers
// ─────────────────────────────────────────────────────────────────────

const APP_ID_GSI = 'appId-createdAt-index';

/** Statuses considered "non-terminal" — exactly one such Plan per App at a time. */
const NON_TERMINAL_STATUSES: ReadonlySet<PlanStatus> = new Set([
  'concept',
  'developing',
  'review',
  'fixing', // legacy non-terminal
]);

/**
 * App/Plan v1 — list all Plans for an App, sorted ascending by `createdAt`.
 *
 * Uses the `appId-createdAt-index` GSI when available; falls back to a Scan
 * with FilterExpression while the GSI is being provisioned (Story 1.4).
 */
export async function listPlansByApp(appId: string): Promise<Plan[]> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.plans,
        IndexName: APP_ID_GSI,
        KeyConditionExpression: 'appId = :appId',
        ExpressionAttributeValues: { ':appId': appId },
        ScanIndexForward: true, // ascending by createdAt
      }),
    );
    return (result.Items || []) as Plan[];
  } catch (err) {
    // GSI not yet provisioned — fall back to scan + sort. Logged but non-fatal.
    if ((err as Error).name === 'ValidationException') {
      const result = await docClient.send(
        new ScanCommand({
          TableName: TABLE_NAMES.plans,
          FilterExpression: 'appId = :appId',
          ExpressionAttributeValues: { ':appId': appId },
        }),
      );
      const items = (result.Items || []) as Plan[];
      return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    throw err;
  }
}

/**
 * App/Plan v1 — return the App's currently-active Plan (the one in `concept`,
 * `developing`, or `review`), or null. Used by the API layer's concurrency
 * check on `POST /api/apps/:appId/plans` and by the daemon's dispatch guard.
 */
export async function getActivePlanForApp(appId: string): Promise<Plan | null> {
  const plans = await listPlansByApp(appId);
  return plans.find((p) => NON_TERMINAL_STATUSES.has(p.status)) ?? null;
}

/**
 * App/Plan v1 — atomically append an epicId to a Plan's `epicIds[]`.
 * Used by the PM-augmentation apply step (Story 4.4).
 */
export async function addEpicToPlan(planId: string, epicId: string): Promise<Plan> {
  const result = await docClient
    .send(
      new UpdateCommand({
        TableName: TABLE_NAMES.plans,
        Key: { planId },
        UpdateExpression:
          'SET epicIds = list_append(if_not_exists(epicIds, :empty), :new), updatedAt = :now',
        ExpressionAttributeValues: {
          ':empty': [],
          ':new': [epicId],
          ':now': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(planId)',
        ReturnValues: 'ALL_NEW',
      }),
    )
    .catch((err: Error) => {
      if (err.name === 'ConditionalCheckFailedException') {
        throw new AppError('PLAN_NOT_FOUND', `Plan "${planId}" not found.`, 404);
      }
      throw err;
    });

  return result.Attributes as Plan;
}

/**
 * App/Plan v1 — transition a Plan to a new status, validating against
 * `PLAN_LEGAL_TRANSITIONS`. Throws `ILLEGAL_TRANSITION` (409) on illegal
 * moves and `PLAN_NOT_FOUND` (404) when the Plan doesn't exist.
 *
 * NOTE: Atomic abandon (writes Plan + App + jobs in one transactWrite) is
 * a separate concern handled by `plan-reducer.ts` in Story 3.3 — this
 * function only handles the Plan row write.
 */
export async function transitionPlanStatus(planId: string, toStatus: PlanStatus): Promise<Plan> {
  const plan = await getPlanById(planId);
  if (!plan) {
    throw new AppError('PLAN_NOT_FOUND', `Plan "${planId}" not found.`, 404);
  }

  const legal = PLAN_LEGAL_TRANSITIONS[plan.status] ?? [];
  if (!legal.includes(toStatus)) {
    throw new AppError(
      'ILLEGAL_TRANSITION',
      `Cannot transition Plan ${planId} from "${plan.status}" to "${toStatus}". Legal targets: ${legal.join(', ') || 'none (terminal state)'}.`,
      409,
    );
  }

  await updatePlanFields(planId, { status: toStatus });
  return { ...plan, status: toStatus, updatedAt: new Date().toISOString() };
}

/** Convert a Plan to the list-summary shape returned by `GET /api/plans`. */
export function toPlanSummary(plan: Plan): PlanSummary {
  return {
    planId: plan.planId,
    name: plan.name,
    displayName: plan.displayName,
    intent: plan.intent,
    status: plan.status,
    totalStories: plan.totalStories,
    doneStories: plan.doneStories,
    totalCostUsd: plan.totalCostUsd,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    archivedAt: plan.archivedAt,
    deployUrl: plan.deployUrl,
  };
}
