import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

const ATTENTION_TABLE =
  process.env.ATTENTION_ITEMS_TABLE || 'futurator-attention-items';
const EPICS_TABLE =
  process.env.EPIC_WORKFLOWS_TABLE || 'futurator-epic-workflows';
const PLANS_TABLE = process.env.PLANS_TABLE || 'futurator-plans';

// Cache epicId → planId lookups so attention bursts don't hammer DDB.
const planIdCache = new Map();

/**
 * Resolve a planId from an epicId by reading the epic row. Cached.
 * Returns null if the epic doesn't exist or has no planId.
 */
export async function resolvePlanIdFromEpicId(ddb, epicId) {
  if (!ddb || !epicId) return null;
  if (planIdCache.has(epicId)) return planIdCache.get(epicId);
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: EPICS_TABLE,
        Key: { epicId },
        ProjectionExpression: 'planId',
      }),
    );
    const planId = result.Item?.planId || null;
    planIdCache.set(epicId, planId);
    return planId;
  } catch {
    return null;
  }
}

/**
 * PR-14b — roll up a step's USD cost into the parent plan's `totalCostUsd`.
 *
 * Called fire-and-forget from `executeStep` after a step_complete with
 * non-zero cost. Looks up the plan via the job's epicId (cached) and issues
 * `UpdateItem ADD totalCostUsd :delta`. If the plan can't be resolved
 * (orchestrator-level jobs without epic context, party jobs, etc.) we
 * silently skip — cost still lives on the job's stepResults for forensic.
 *
 * 2026-05-04 dino-runner-1 forensic showed plan.totalCostUsd: 0 even
 * though stepResults summed to ~$3.34. Per-job cost was always there;
 * just never rolled up.
 *
 * Returns true on successful update, false otherwise. Errors are logged
 * via the optional logger but do not propagate.
 */
export async function addCostToPlan(ddb, epicId, costUsd, logger) {
  if (!ddb || !epicId || !costUsd || costUsd <= 0) return false;
  const planId = await resolvePlanIdFromEpicId(ddb, epicId);
  if (!planId) return false;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: PLANS_TABLE,
        Key: { planId },
        UpdateExpression: 'ADD totalCostUsd :delta SET updatedAt = :now',
        ExpressionAttributeValues: {
          ':delta': costUsd,
          ':now': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(planId)',
      }),
    );
    return true;
  } catch (err) {
    logger?.warn?.(`addCostToPlan: failed for plan ${planId}: ${err.message}`);
    return false;
  }
}

/**
 * Pipeline v2.0 PR-7 (G) — build a deterministic itemId from a dedupKey.
 * Same scheme as the TS repo's `dedupItemId`. Tagged with `dk:` so PR-7+
 * upserted rows coexist with legacy random-UUID rows from earlier writes.
 */
function dedupItemId(dedupKey) {
  const safe = String(dedupKey).replace(/\s+/g, '_').slice(0, 1500);
  return `dk:${safe}`;
}

/**
 * Write an attention item to DynamoDB. Fire-and-forget: errors are logged
 * but do not propagate, so a failed attention write never breaks the
 * shutdown / retry / guard code paths that create it.
 *
 * Pipeline v2.0 PR-7 (G): when `item.dedupKey` is supplied, the write goes
 * through the idempotent upsert path — multiple emitters of the same logical
 * failure produce ONE row whose `recurrenceCount` increments on each
 * subsequent observation. dino1 forensic: 224 duplicates → 1 row with
 * `recurrenceCount: 86`.
 *
 * Without a dedupKey, falls back to the legacy random-UUID create (one new
 * row per call) for backwards-compat with callers that haven't been
 * updated yet.
 *
 * @param {object} ddb - shared DynamoDBDocumentClient instance
 * @param {object} item
 * @param {string} item.planId
 * @param {string} [item.dedupKey] — PR-7: stable identifier for this logical failure
 * @param {('low'|'medium'|'high'|'critical')} item.severity
 * @param {string} item.category
 * @param {string} item.title
 * @param {string} [item.body]
 * @param {object} [item.context]
 * @param {Array<{label:string,kind:string}>} [item.suggestedActions]
 * @param {function} [log] - optional logger(level, msg, data)
 */
export async function writeAttentionItem(ddb, item, log) {
  if (!ddb) return;
  if (!item || !item.planId) return;
  const now = new Date().toISOString();

  // PR-7 (G) — idempotent upsert path.
  if (item.dedupKey) {
    const itemId = dedupItemId(item.dedupKey);
    const row = {
      planId: item.planId,
      itemId,
      createdAt: now,
      resolvedAt: null,
      severity: item.severity || 'medium',
      category: item.category || 'other',
      title: item.title || 'Untitled',
      body: item.body || '',
      context: item.context || {},
      suggestedActions: item.suggestedActions || [],
      status: 'open',
      dedupKey: item.dedupKey,
      lastSeenAt: now,
      recurrenceCount: 1,
    };

    try {
      await ddb.send(
        new PutCommand({
          TableName: ATTENTION_TABLE,
          Item: row,
          // Insert if no row exists OR existing row is resolved (recurrence
          // after operator-resolve → fresh open row, surfaces again).
          ConditionExpression:
            'attribute_not_exists(itemId) OR #status = :resolved',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':resolved': 'resolved' },
        }),
      );
      if (log) {
        log('info', `attention-item upserted (new)`, {
          planId: row.planId,
          itemId,
          dedupKey: item.dedupKey,
          recurrenceCount: 1,
        });
      }
      return { itemId, inserted: true, recurrenceCount: 1 };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') {
        if (log) {
          log('error', `failed to upsert attention-item: ${err.message}`, {
            planId: row.planId,
            dedupKey: item.dedupKey,
          });
        }
        return null;
      }
      // Open row already exists — bump recurrence count.
      try {
        const result = await ddb.send(
          new UpdateCommand({
            TableName: ATTENTION_TABLE,
            Key: { planId: item.planId, itemId },
            UpdateExpression:
              'SET lastSeenAt = :now ADD recurrenceCount :one',
            ExpressionAttributeValues: { ':now': now, ':one': 1 },
            ReturnValues: 'ALL_NEW',
          }),
        );
        const recurrenceCount = result.Attributes?.recurrenceCount ?? 1;
        if (log) {
          log('info', `attention-item upserted (recurrence)`, {
            planId: item.planId,
            itemId,
            dedupKey: item.dedupKey,
            recurrenceCount,
          });
        }
        return { itemId, inserted: false, recurrenceCount };
      } catch (bumpErr) {
        if (log) {
          log('error', `failed to bump attention-item recurrence: ${bumpErr.message}`, {
            planId: item.planId,
            dedupKey: item.dedupKey,
          });
        }
        return null;
      }
    }
  }

  // Legacy path — one new row per call (deprecated; PR-7 callers should
  // supply dedupKey).
  const itemId = randomUUID();
  const row = {
    planId: item.planId,
    itemId,
    createdAt: now,
    resolvedAt: null,
    severity: item.severity || 'medium',
    category: item.category || 'other',
    title: item.title || 'Untitled',
    body: item.body || '',
    context: item.context || {},
    suggestedActions: item.suggestedActions || [],
    status: 'open',
  };
  try {
    await ddb.send(
      new PutCommand({ TableName: ATTENTION_TABLE, Item: row }),
    );
    if (log) {
      log('info', `attention-item written (legacy / no dedupKey)`, {
        planId: row.planId,
        itemId,
        severity: row.severity,
        category: row.category,
      });
    }
  } catch (err) {
    if (log) {
      log('error', `failed to write attention-item: ${err.message}`, {
        planId: row.planId,
        category: row.category,
      });
    }
  }
  return null;
}

/**
 * Pipeline v2.0 PR-7 (I) — auto-resolve a single (planId, dedupKey) attention
 * row. Called by the daemon's success paths to clear failure items the
 * operator no longer needs to triage.
 *
 * Returns true if a row was flipped to 'resolved', false otherwise (no row,
 * already resolved, etc).
 */
export async function autoResolveAttentionByDedupKey(ddb, planId, dedupKey, log) {
  if (!ddb || !planId || !dedupKey) return false;
  const itemId = dedupItemId(dedupKey);
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ATTENTION_TABLE,
        Key: { planId, itemId },
        UpdateExpression: 'SET #status = :resolved, resolvedAt = :now',
        ConditionExpression: 'attribute_exists(itemId) AND #status = :open',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':resolved': 'resolved',
          ':open': 'open',
          ':now': now,
        },
      }),
    );
    if (log) {
      log('info', `attention-item auto-resolved`, { planId, itemId, dedupKey });
    }
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    if (log) {
      log('warn', `auto-resolve failed (non-critical): ${err.message}`, {
        planId,
        dedupKey,
      });
    }
    return false;
  }
}
