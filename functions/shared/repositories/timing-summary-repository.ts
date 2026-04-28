// TimingSummary repository — Story 1.8.6
//
// One row per cohort. PK = cohortKey, SK = lastUpdated (ISO-8601).
// Written every 6 hours by functions/cron/timing-aggregator.ts.
// Read by:
//   • GET /api/timing/cohort  (fast single-row Get)
//   • forensic-builder.ts     (cohort field in the forensic export)
//   • escalator.ts            (3× outlier detector after plan delivery)

import { QueryCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { TimerCategory } from '../timer/types';
import type { CohortCategoryStats } from '../timer/cohort';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One cohort row in DynamoDB.
 *
 * PK: cohortKey  (format: `<templateType>#<planKind>#<epicCountBucket>`)
 * SK: lastUpdated (ISO-8601)
 */
export interface TimingSummary {
  cohortKey: string;
  lastUpdated: string;
  samples: number;
  medianMs: number;
  p90Ms: number;
  byCategory: Record<TimerCategory, CohortCategoryStats>;
  /** Last 20 planIds used in this cohort sample — for forensic traceability. */
  lastSampleIds: string[];
}

// ── Repository functions ─────────────────────────────────────────────────────

/**
 * Retrieve a single cohort row by cohortKey.
 * Uses a Query on PK + orders by SK descending so we always get the most-recent
 * row first, then return the first result.
 *
 * Returns null when no row exists for the given key.
 */
export async function getCohortByKey(cohortKey: string): Promise<TimingSummary | null> {
  // The table uses cohortKey (PK) + lastUpdated (SK). A GetCommand requires
  // both PK and SK. Since we want the latest row, we issue a QueryCommand
  // descending on SK and take the first item.
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.timingSummary,
      KeyConditionExpression: 'cohortKey = :pk',
      ExpressionAttributeValues: { ':pk': cohortKey },
      ScanIndexForward: false, // newest lastUpdated first
      Limit: 1,
    }),
  );
  if (!result.Items || result.Items.length === 0) return null;
  return result.Items[0] as TimingSummary;
}

/**
 * Upsert (Put) one cohort row.
 * PutCommand replaces any row with the same (cohortKey, lastUpdated) pair —
 * the cron always writes a fresh lastUpdated so old rows are retained for
 * point-in-time audit. Operators may prune old SK rows in a Phase-2 cleanup
 * cron if the table grows large.
 */
export async function upsertCohort(summary: TimingSummary): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.timingSummary,
      Item: summary,
    }),
  );
}

/**
 * List all cohort rows (latest SK per cohortKey is NOT guaranteed — this
 * returns ALL rows, including historical SK values).
 *
 * Used for forensic enrichment and admin dashboards. Phase-2 may restrict
 * this to "latest per PK" via a FilterExpression or a GSI on lastUpdated.
 *
 * NOTE: uses ScanCommand — acceptable for Phase 1 (cohort table is small).
 */
export async function listAllCohorts(): Promise<TimingSummary[]> {
  const items: TimingSummary[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.timingSummary,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    if (result.Items) items.push(...(result.Items as TimingSummary[]));
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
}
