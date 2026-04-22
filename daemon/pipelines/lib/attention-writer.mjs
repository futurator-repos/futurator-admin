import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

const ATTENTION_TABLE =
  process.env.ATTENTION_ITEMS_TABLE || 'futurator-attention-items';
const EPICS_TABLE =
  process.env.EPIC_WORKFLOWS_TABLE || 'futurator-epic-workflows';

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
 * Write an attention item to DynamoDB. Fire-and-forget: errors are logged
 * but do not propagate, so a failed attention write never breaks the
 * shutdown / retry / guard code paths that create it.
 *
 * @param {object} ddb - shared DynamoDBDocumentClient instance
 * @param {object} item
 * @param {string} item.planId
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
      log('info', `attention-item written`, {
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
}
