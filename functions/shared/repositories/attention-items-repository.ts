import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type {
  AttentionAction,
  AttentionCategory,
  AttentionContext,
  AttentionItem,
  AttentionSeverity,
  AttentionStatus,
} from '../types/attention';

export async function listAttentionItems(planId: string): Promise<AttentionItem[]> {
  const out: AttentionItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.attentionItems,
        KeyConditionExpression: 'planId = :planId',
        ExpressionAttributeValues: { ':planId': planId },
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as AttentionItem[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

export async function getAttentionItem(
  planId: string,
  itemId: string,
): Promise<AttentionItem | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.attentionItems, Key: { planId, itemId } }),
  );
  return (result.Item as AttentionItem) || null;
}

export async function createAttentionItem(item: AttentionItem): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.attentionItems, Item: item }));
}

/**
 * 2026-05-27 PR D.b — claim an attention item for an agent session.
 *
 * Conditional update: succeeds only when `agentSessionId` is absent.
 * Returns ALL_OLD on success so the caller knows the prior state; returns
 * null when the conditional fails (another tick or claim raced us).
 *
 * Idempotent under concurrent ticks of the daemon's attention-poller.
 */
export async function claimForAgent(
  planId: string,
  itemId: string,
  sessionId: string,
): Promise<AttentionItem | null> {
  const nowIso = new Date().toISOString();
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.attentionItems,
        Key: { planId, itemId },
        UpdateExpression: 'SET agentSessionId = :sid, agentClaimedAt = :now',
        ConditionExpression: 'attribute_exists(itemId) AND attribute_not_exists(agentSessionId)',
        ExpressionAttributeValues: { ':sid': sessionId, ':now': nowIso },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (result.Attributes as AttentionItem) ?? null;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return null;
    }
    throw err;
  }
}

export async function updateAttentionStatus(
  planId: string,
  itemId: string,
  status: AttentionStatus,
): Promise<AttentionItem | null> {
  const now = new Date().toISOString();
  const resolvedAt = status === 'resolved' ? now : null;
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.attentionItems,
      Key: { planId, itemId },
      UpdateExpression: 'SET #status = :status, resolvedAt = :resolvedAt',
      ConditionExpression: 'attribute_exists(itemId)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':resolvedAt': resolvedAt },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return (result.Attributes as AttentionItem) || null;
}

// ── Pipeline v2.0 PR-7 (G+H+I) — idempotent upsert + auto-resolve ─────────

/**
 * Build a deterministic itemId from (planId, dedupKey). Hashing isn't
 * required — DDB string keys handle arbitrary characters — but we sanitize
 * separators so the resulting key is stable + greppable in the console.
 *
 * Format: `dk:<dedupKey>`. The 'dk:' prefix tags the row as upsert-managed
 * so older non-deduped rows (pre-PR-7) coexist without collision.
 */
function dedupItemId(dedupKey: string): string {
  // Limit to DDB's 2KB key size; collapse whitespace + control chars.
  const safe = dedupKey.replace(/\s+/g, '_').slice(0, 1500);
  return `dk:${safe}`;
}

/**
 * Pipeline v2.0 PR-7 (G) — write or bump an open attention item identified
 * by `dedupKey`. If a row with the same (planId, dedupKey) already exists
 * AND is `status === 'open'`: increments `recurrenceCount` + updates
 * `lastSeenAt`, leaves all other fields alone (the FIRST observation's
 * title/body/context are preserved as the canonical record). Otherwise:
 * creates a fresh row.
 *
 * Resolved rows are NOT reopened by upsert — once the operator clicks
 * Resolve, the same logical failure recurring creates a new row (operator
 * sees recurrence as a real signal, not duplicate noise).
 *
 * @param input.dedupKey — stable identifier for the logical failure
 *                         (e.g., "wave-reducer:test-gate-failed:<storyId>")
 * @returns the canonical row's itemId + whether this was a fresh insert
 */
export async function upsertOpenAttentionItem(input: {
  planId: string;
  dedupKey: string;
  severity: AttentionSeverity;
  category: AttentionCategory;
  title: string;
  body: string;
  context: AttentionContext;
  suggestedActions: AttentionAction[];
}): Promise<{ itemId: string; inserted: boolean; recurrenceCount: number }> {
  if (!input.planId || !input.dedupKey) {
    throw new Error('upsertOpenAttentionItem: planId + dedupKey required');
  }
  const now = new Date().toISOString();
  const itemId = dedupItemId(input.dedupKey);

  // ── Attempt insert with conditional "doesn't exist OR is resolved". ──
  // If a `resolved` row exists with the same itemId, we want to OVERWRITE it
  // (recurrence after operator-resolve produces a fresh open row).
  const item: AttentionItem = {
    planId: input.planId,
    itemId,
    createdAt: now,
    resolvedAt: null,
    severity: input.severity,
    category: input.category,
    title: input.title,
    body: input.body,
    context: input.context,
    suggestedActions: input.suggestedActions,
    status: 'open',
    dedupKey: input.dedupKey,
    lastSeenAt: now,
    recurrenceCount: 1,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAMES.attentionItems,
        Item: item,
        // Insert only if no row exists OR existing row is resolved
        // (recurrence-after-resolve → fresh row).
        ConditionExpression: 'attribute_not_exists(itemId) OR #status = :resolved',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':resolved': 'resolved' },
      }),
    );
    return { itemId, inserted: true, recurrenceCount: 1 };
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // Existing OPEN row — bump recurrence atomically.
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.attentionItems,
        Key: { planId: input.planId, itemId },
        UpdateExpression: 'SET lastSeenAt = :now ADD recurrenceCount :one',
        ExpressionAttributeValues: { ':now': now, ':one': 1 },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const row = result.Attributes as AttentionItem;
    return {
      itemId,
      inserted: false,
      recurrenceCount: row.recurrenceCount ?? 1,
    };
  }
}

/**
 * Pipeline v2.0 PR-7 (I) — auto-resolve open attention items whose dedupKey
 * matches the supplied predicate. Called by wave-reducer when a previously-
 * failed story now has a SUCCESS status.
 *
 * The dedupKey scheme is callsite-controlled (e.g., dev-retry-exhausted
 * uses "dev-retry-exhausted:<storyId>") so callers must pass the exact
 * dedupKey they expect to resolve. To avoid an O(N) scan of the items
 * table on every status flip, this function takes a single dedupKey and
 * resolves the (planId, dedupItemId(dedupKey)) row directly.
 *
 * Returns true if a row was resolved, false if nothing matched (already
 * resolved, never created, or wrong dedupKey).
 */
/**
 * 2026-05-19 — cascade-delete every attention item for a plan.
 *
 * Called from the plan-delete handler so attention items don't survive the
 * plan they reference (pre-fix they did — the cascade flushed jobs/events/
 * epics but never the operator surfaces, so a "deleted" plan would still
 * show resolved-but-undeleted items if the operator ever re-created a
 * planId by hand).
 *
 * Mechanics:
 *   1. Page through `QueryCommand` on `planId` PK.
 *   2. Batch DeleteRequests in groups of 25 (DDB hard cap).
 *   3. Retry UnprocessedItems on each round.
 *
 * Returns the total count deleted. Idempotent: calling twice on the same
 * plan returns 0 the second time.
 */
export async function deleteAttentionItemsByPlan(planId: string): Promise<number> {
  if (!planId) return 0;
  let deleted = 0;
  // Page through items with a small projection (just the SK).
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.attentionItems,
        KeyConditionExpression: 'planId = :pid',
        ExpressionAttributeValues: { ':pid': planId },
        ProjectionExpression: 'planId, itemId',
        ExclusiveStartKey,
      }),
    );
    const items = (page.Items || []) as Array<{ planId: string; itemId: string }>;
    // Batches of 25 (DDB BatchWriteItem cap).
    type DelBatch = Record<string, Array<{ DeleteRequest: { Key: Record<string, string> } }>>;
    for (let i = 0; i < items.length; i += 25) {
      const slice = items.slice(i, i + 25);
      let pending: DelBatch | undefined = {
        [TABLE_NAMES.attentionItems]: slice.map((it) => ({
          DeleteRequest: { Key: { planId: it.planId, itemId: it.itemId } },
        })),
      };
      // Retry UnprocessedItems up to 3 times (per DDB best practice).
      for (let attempt = 0; attempt < 3 && pending; attempt++) {
        const current: DelBatch = pending;
        const result = await docClient.send(new BatchWriteCommand({ RequestItems: current }));
        const unprocessed = result.UnprocessedItems?.[TABLE_NAMES.attentionItems] as
          | Array<{ DeleteRequest: { Key: Record<string, string> } }>
          | undefined;
        if (unprocessed && unprocessed.length > 0) {
          pending = { [TABLE_NAMES.attentionItems]: unprocessed };
        } else {
          pending = undefined;
        }
      }
      deleted += slice.length;
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return deleted;
}

export async function autoResolveByDedupKey(planId: string, dedupKey: string): Promise<boolean> {
  if (!planId || !dedupKey) return false;
  const itemId = dedupItemId(dedupKey);
  const now = new Date().toISOString();
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.attentionItems,
        Key: { planId, itemId },
        UpdateExpression: 'SET #status = :resolved, resolvedAt = :now',
        // Only flip if currently open; resolving an already-resolved row is
        // a no-op (and `attribute_exists` confirms the row hasn't been deleted).
        ConditionExpression: 'attribute_exists(itemId) AND #status = :open',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':resolved': 'resolved',
          ':open': 'open',
          ':now': now,
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
