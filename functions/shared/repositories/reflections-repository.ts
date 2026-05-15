/**
 * reflections-repository.ts — Pipeline v2 Phase 3 / Story 3-E-3-1 (PR-76).
 *
 * DDB layer for REFLECTOR proposals. PK = projectSlug; SK = id (ULID-shape).
 * Cross-project chronological list at `/labs/reflections` uses a Scan with
 * client-side sort by `createdAt` — proposal volume is low (single-digit
 * per plan-close), so Query-everything-by-status is overkill. If/when the
 * inbox grows large, a GSI on (status, createdAt) is the upgrade path.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { ReflectionRow, ReflectionStatus, ReflectionDecision } from '../types/reflection';

export async function listReflections(
  args: {
    projectSlug?: string;
    status?: ReflectionStatus;
  } = {},
): Promise<ReflectionRow[]> {
  const out: ReflectionRow[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  if (args.projectSlug) {
    // Project-scoped Query.
    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAMES.reflections,
          KeyConditionExpression: 'projectSlug = :projectSlug',
          ExpressionAttributeValues: { ':projectSlug': args.projectSlug },
          ExclusiveStartKey,
        }),
      );
      if (result.Items) out.push(...(result.Items as ReflectionRow[]));
      ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
  } else {
    // Cross-project Scan. Proposal volume is low — see header comment.
    do {
      const result = await docClient.send(
        new ScanCommand({
          TableName: TABLE_NAMES.reflections,
          ExclusiveStartKey,
        }),
      );
      if (result.Items) out.push(...(result.Items as ReflectionRow[]));
      ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
  }

  const filtered = args.status ? out.filter((r) => r.status === args.status) : out;
  // Newest first.
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return filtered;
}

export async function getReflection(
  projectSlug: string,
  id: string,
): Promise<ReflectionRow | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.reflections, Key: { projectSlug, id } }),
  );
  return (result.Item as ReflectionRow) || null;
}

export async function createReflection(row: ReflectionRow): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.reflections, Item: row }));
}

/**
 * Apply an operator decision. Idempotent on `confirmed` (re-confirming a
 * confirmed proposal is a no-op); transitioning out of `confirmed` is
 * rejected (no un-confirming — the daemon's REFLECTOR-APPLY commit
 * already landed).
 */
export async function applyDecision(args: {
  projectSlug: string;
  id: string;
  decision: ReflectionDecision;
  decidedAt?: string;
}): Promise<ReflectionRow | null> {
  const now = args.decidedAt || new Date().toISOString();
  const nextStatus: ReflectionStatus =
    args.decision === 'confirm'
      ? 'confirmed'
      : args.decision === 'decline'
        ? 'declined'
        : 'deferred';

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.reflections,
        Key: { projectSlug: args.projectSlug, id: args.id },
        UpdateExpression: 'SET #status = :next, decidedAt = :now',
        ConditionExpression: '#status <> :confirmed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':next': nextStatus,
          ':now': now,
          ':confirmed': 'confirmed',
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (result.Attributes as ReflectionRow) || null;
  } catch (err) {
    // Already confirmed — return the current row instead of throwing.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return getReflection(args.projectSlug, args.id);
    }
    throw err;
  }
}
