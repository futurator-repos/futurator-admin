/**
 * merge-lock-repository.ts — Pipeline v2 Phase 2-B / Story 2-B-4-1 (PR-87).
 *
 * Distributed merge lock per v2.5 §27. Two plans completing simultaneously
 * must serialize their pushes to `main`. Implementation:
 *
 *   PK = LOCK#<project-slug>
 *   SK = MERGE
 *   attributes: holder, acquiredAt, ttl
 *   condition: attribute_not_exists(holder) OR ttl < now
 *
 * 5-minute TTL handles daemon-crash recovery — if the holder dies
 * mid-merge, the lock auto-releases and the next contender retries.
 * Same DDB single-table that holds plans + attention items; no extra
 * infrastructure.
 *
 * Convention: project-merge locks live alongside other plan/project rows
 * in the existing attentionItems table to avoid provisioning yet another
 * DDB table for a single high-value row pattern. PK + SK shape keeps it
 * collision-free against any real attention row.
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';

const TTL_MS = 5 * 60 * 1000;

export interface MergeLockRow {
  planId: string; // partition key (reusing attentionItems' PK slot)
  itemId: string; // sort key
  holder: string;
  acquiredAt: string;
  ttl: number; // epoch seconds (DDB TTL semantics)
  kind: 'merge-lock';
}

export interface AcquireLockResult {
  acquired: boolean;
  row?: MergeLockRow;
  /** When `acquired: false`, the current holder. */
  currentHolder?: string;
  /** When `acquired: false`, seconds remaining on the existing lock. */
  ttlRemainingSec?: number;
}

function lockKey(projectSlug: string) {
  return { planId: `LOCK#${projectSlug}`, itemId: 'MERGE' };
}

/**
 * Acquire the merge lock. Conditional write: succeeds when the lock row
 * doesn't exist OR the existing row's TTL has expired.
 *
 * Caller supplies a `holder` string (typically `<daemon-id>:<planId>`).
 */
export async function acquireMergeLock(args: {
  projectSlug: string;
  holder: string;
  now?: () => number;
}): Promise<AcquireLockResult> {
  const now = args.now ?? (() => Date.now());
  const nowMs = now();
  const ttlSec = Math.floor((nowMs + TTL_MS) / 1000);
  const row: MergeLockRow = {
    ...lockKey(args.projectSlug),
    holder: args.holder,
    acquiredAt: new Date(nowMs).toISOString(),
    ttl: ttlSec,
    kind: 'merge-lock',
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAMES.attentionItems,
        Item: row,
        ConditionExpression: 'attribute_not_exists(holder) OR #ttl < :nowSec',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':nowSec': Math.floor(nowMs / 1000) },
      }),
    );
    return { acquired: true, row };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Lock held — fetch current holder for the caller.
      const current = await getMergeLock(args.projectSlug);
      return {
        acquired: false,
        currentHolder: current?.holder,
        ttlRemainingSec: current ? Math.max(0, current.ttl - Math.floor(nowMs / 1000)) : 0,
      };
    }
    throw err;
  }
}

/**
 * Read the current lock row. Returns null when no lock active OR the
 * lock has expired (caller can ignore expired locks; the next acquire
 * will reclaim).
 */
export async function getMergeLock(projectSlug: string): Promise<MergeLockRow | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.attentionItems,
      Key: lockKey(projectSlug),
    }),
  );
  return (result.Item as MergeLockRow) || null;
}

/**
 * Release the lock. Conditional on `holder` matching the supplied value
 * so a stale daemon doesn't release a lock held by its successor.
 *
 * @returns true when actually released; false when not held by the
 *          caller (either expired and reclaimed by another holder, or
 *          already released).
 */
export async function releaseMergeLock(args: {
  projectSlug: string;
  holder: string;
}): Promise<boolean> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAMES.attentionItems,
        Key: lockKey(args.projectSlug),
        ConditionExpression: 'holder = :holder',
        ExpressionAttributeValues: { ':holder': args.holder },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}

/**
 * Unconditionally drop a project's merge lock (the LOCK#<slug> row in the
 * attention-items table). Unlike `releaseMergeLock`, this is NOT holder-gated —
 * used by the nuclear app-delete cascade where the app (and any holder) is going
 * away regardless. `deleteAttentionItemsByPlan` keys on real planIds and won't
 * match the LOCK# pseudo-planId, so this must be called explicitly.
 */
export async function deleteMergeLock(projectSlug: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAMES.attentionItems,
      Key: lockKey(projectSlug),
    }),
  );
}

export const MERGE_LOCK_TTL_MS = TTL_MS;
