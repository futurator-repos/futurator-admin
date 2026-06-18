/**
 * skill-proposals-repository.ts — Skills Institution, Story 3.1.
 *
 * DDB layer for the curation Inbox. One table per concern (multi-table
 * convention). PK = proposalId (ULID). Unlike the propagator/reflections inboxes
 * (which Scan), this table carries a `status-createdAt-index` GSI so the inbox's
 * primary view — "all pending proposals, newest first" — is a Query, not a Scan;
 * the gate can fan a bulk-acquisition batch (Phase 3) into hundreds of rows
 * without making the inbox load O(table).
 *
 * Pure persistence: the gate decides securityStatus/labels before writing here,
 * and the ratify guard (status must be ratifiable) lives in the route.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { SkillProposal, ProposalStatus } from '../schemas/skill-proposal-schema';

const STATUS_INDEX = 'status-createdAt-index';

export async function putProposal(row: SkillProposal): Promise<SkillProposal> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.skillProposals, Item: row }));
  return row;
}

export async function getProposal(proposalId: string): Promise<SkillProposal | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.skillProposals, Key: { proposalId } }),
  );
  return (result.Item as SkillProposal) || null;
}

/**
 * List proposals for one status, newest first, via the GSI. Paginates fully —
 * the inbox wants every pending item, and the queue is bounded by curator pace.
 */
export async function listByStatus(status: ProposalStatus): Promise<SkillProposal[]> {
  const out: SkillProposal[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.skillProposals,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ScanIndexForward: false, // newest createdAt first
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as SkillProposal[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * List every proposal (cross-status), newest first. Used by the inbox "all"
 * filter and tests. Falls back to a Scan because the GSI is status-partitioned;
 * proposal volume is curator-bounded so this is acceptable (same trade-off the
 * reflections/propagator inboxes accept).
 */
export async function listAllProposals(): Promise<SkillProposal[]> {
  const out: SkillProposal[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAMES.skillProposals, ExclusiveStartKey }),
    );
    if (result.Items) out.push(...(result.Items as SkillProposal[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

/**
 * Patch a proposal's status (+ decision metadata). Returns the updated row, or
 * null if it doesn't exist. The route enforces the legal transition (e.g. only
 * `pending`/`quarantined`→`ratified`, override required for quarantined).
 */
export async function updateStatus(
  proposalId: string,
  patch: {
    status: ProposalStatus;
    ratifiedBy?: string;
    ratifiedAt?: string;
    rejectedReason?: string;
  },
): Promise<SkillProposal | null> {
  const sets: string[] = ['#status = :status'];
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = { ':status': patch.status };

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'status' || v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.skillProposals,
      Key: { proposalId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(proposalId)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return (result.Attributes as SkillProposal) || null;
}

/** Attach an advisory artifact (LLM review / dedup) without changing status. */
export async function patchProposalFields(
  proposalId: string,
  patch: Partial<Pick<SkillProposal, 'llmReview' | 'dedup' | 'qualityGrade' | 'clusterId'>>,
): Promise<SkillProposal | null> {
  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }
  if (sets.length === 0) return getProposal(proposalId);

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.skillProposals,
      Key: { proposalId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(proposalId)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return (result.Attributes as SkillProposal) || null;
}
