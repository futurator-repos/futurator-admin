/**
 * remediation-policies-repository.ts — 2026-05-27 PR D.a.
 *
 * Per-AttentionCategory mapping to a remediation policy. The daemon's
 * attention-poller (PR D.b) consults this when deciding whether to spawn
 * a free-agent session for a newly-opened attention item.
 *
 * Schema:
 *   PK: category (AttentionCategory string)
 *   value: { policy: RemediationPolicy, updatedBy: string, updatedAt: ISO }
 *
 * Default behavior: an absent row resolves to 'manual'. This means PR D
 * ships with EVERY category at 'manual' — the operator must graduate
 * individual categories as confidence builds. There is no auto-rollout.
 */

import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AttentionCategory, RemediationPolicy } from '../types/attention';

export interface RemediationPolicyRow {
  category: AttentionCategory;
  policy: RemediationPolicy;
  updatedBy: string;
  updatedAt: string;
}

/**
 * Look up the policy for a category. Returns 'manual' when no row exists
 * (safe default — the daemon's poller never spawns without an explicit
 * operator opt-in).
 */
export async function getPolicy(category: AttentionCategory): Promise<RemediationPolicy> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.remediationPolicies,
      Key: { category },
    }),
  );
  const row = result.Item as RemediationPolicyRow | undefined;
  return row?.policy ?? 'manual';
}

/**
 * Upsert a category's policy. Operator-initiated via the Settings panel.
 */
export async function setPolicy(
  category: AttentionCategory,
  policy: RemediationPolicy,
  updatedBy: string,
): Promise<RemediationPolicyRow> {
  const row: RemediationPolicyRow = {
    category,
    policy,
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.remediationPolicies, Item: row }));
  return row;
}

/**
 * List every row. The panel UI renders this as a table of category →
 * policy with a dropdown per row. Sparse rows (missing categories) are
 * rendered as 'manual' (the default).
 */
export async function listAllPolicies(): Promise<RemediationPolicyRow[]> {
  const result = await docClient.send(
    new ScanCommand({ TableName: TABLE_NAMES.remediationPolicies }),
  );
  return (result.Items as RemediationPolicyRow[] | undefined) ?? [];
}
