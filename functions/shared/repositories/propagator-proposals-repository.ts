/**
 * propagator-proposals-repository.ts — Epic 6, Story 6.5.
 *
 * DDB layer for consent-gated PROPAGATOR proposals. One table per concern
 * (multi-table convention). PK = proposalId. Proposal volume is low (a handful
 * per wave gate), so the cross-status list uses a Scan + client-side filter —
 * same trade-off as the reflections inbox. A `(status, createdAt)` GSI is the
 * upgrade path if the queue ever grows large.
 */

import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { PropagatorProposal, PropagatorProposalStatus } from '../types/propagator';

export async function createProposal(row: PropagatorProposal): Promise<PropagatorProposal> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.propagatorProposals, Item: row }));
  return row;
}

export async function getProposal(proposalId: string): Promise<PropagatorProposal | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.propagatorProposals, Key: { proposalId } }),
  );
  return (result.Item as PropagatorProposal) || null;
}

export async function listProposals(
  args: { status?: PropagatorProposalStatus; sibling?: string; sourceProject?: string } = {},
): Promise<PropagatorProposal[]> {
  const out: PropagatorProposal[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({ TableName: TABLE_NAMES.propagatorProposals, ExclusiveStartKey }),
    );
    if (result.Items) out.push(...(result.Items as PropagatorProposal[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);

  let filtered = out;
  if (args.status) filtered = filtered.filter((p) => p.status === args.status);
  if (args.sibling) filtered = filtered.filter((p) => p.sibling === args.sibling);
  if (args.sourceProject) filtered = filtered.filter((p) => p.sourceProject === args.sourceProject);
  // Newest first.
  filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return filtered;
}

/**
 * Apply an operator/marker decision. Returns the updated row, or null if the
 * proposal doesn't exist. The consent gate lives in the route (it checks the
 * proposal is still `proposed` before approving/rejecting).
 */
export async function updateProposalStatus(
  proposalId: string,
  patch: {
    status: PropagatorProposalStatus;
    decidedBy?: string;
    decidedAt?: string;
    rejectionReason?: string;
    siblingJobId?: string;
  },
): Promise<PropagatorProposal | null> {
  const sets: string[] = ['#status = :status'];
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = { ':status': patch.status };

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'status' || v === undefined) continue;
    sets.push(`${k} = :${k}`);
    values[`:${k}`] = v;
  }

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.propagatorProposals,
      Key: { proposalId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(proposalId)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return (result.Attributes as PropagatorProposal) || null;
}
