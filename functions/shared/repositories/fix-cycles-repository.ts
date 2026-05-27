/**
 * fix-cycles-repository.ts — 2026-05-27 PR C.e.
 *
 * Per-(plan, wave) counter for free-agent fix-retry cycles. Per the
 * §9.5 RESOLVED hard cap, the agent will propose at most 3 fixes for
 * the same (plan, wave) before refusing. The 4th /open-pr against the
 * same wave gets 409 CYCLE_CAP_EXHAUSTED, the operator gets an attention
 * item, and the agent stops auto-proposing — the operator must look
 * manually.
 *
 * Schema:
 *   PK:  cycleKey = `${planId}#${waveNumber}`
 *   value: attempts (number), lastAttemptAt (ISO), sessionIds (string[]),
 *          status: 'open' | 'exhausted', expiresAt (epoch sec, 30d).
 *
 * Lifecycle:
 *   - First fix-PR against (plan, wave): writes row with attempts=1.
 *   - 2nd, 3rd: ADD attempts :one. attempts becomes 2 then 3.
 *   - 4th /open-pr: caller has already checked countAttempts() — if it's
 *     already 3, refuse and flip status to 'exhausted'.
 *
 * The cap applies ONLY to PRs that target a pipeline-v2 wave failure
 * (caller indicates via `targetWaveFailure: { planId, waveNumber }` in
 * the /open-pr body). Greenfield/brownfield development sessions don't
 * touch this table.
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/** v1 cap. Hard-coded per §9.5 RESOLVED — not configurable. */
export const FIX_CYCLE_HARD_CAP = 3;

export interface FixCycleRow {
  cycleKey: string;
  planId: string;
  waveNumber: number;
  attempts: number;
  lastAttemptAt: string;
  sessionIds: string[];
  status: 'open' | 'exhausted';
  expiresAt: number;
}

export function cycleKey(planId: string, waveNumber: number): string {
  return `${planId}#${waveNumber}`;
}

export async function getCycle(planId: string, waveNumber: number): Promise<FixCycleRow | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.fixCycles,
      Key: { cycleKey: cycleKey(planId, waveNumber) },
    }),
  );
  return (result.Item as FixCycleRow | undefined) ?? null;
}

/**
 * Record a fresh fix attempt. Idempotently increments `attempts` and
 * appends the sessionId. Returns the post-update row so the caller knows
 * the new attempt count.
 */
export async function recordAttempt(
  planId: string,
  waveNumber: number,
  sessionId: string,
): Promise<FixCycleRow> {
  const nowIso = new Date().toISOString();
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.fixCycles,
      Key: { cycleKey: cycleKey(planId, waveNumber) },
      UpdateExpression:
        'ADD attempts :one ' +
        'SET planId = if_not_exists(planId, :p), waveNumber = if_not_exists(waveNumber, :w), ' +
        'lastAttemptAt = :now, sessionIds = list_append(if_not_exists(sessionIds, :empty), :sid), ' +
        '#status = if_not_exists(#status, :open), ' +
        'expiresAt = :ttl',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':p': planId,
        ':w': waveNumber,
        ':now': nowIso,
        ':empty': [],
        ':sid': [sessionId],
        ':open': 'open',
        ':ttl': Math.floor(Date.now() / 1000) + THIRTY_DAYS_SECONDS,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return result.Attributes as FixCycleRow;
}

/**
 * Mark a cycle as exhausted. Called by the /open-pr endpoint when it
 * refuses the 4th attempt. Idempotent — subsequent calls are no-ops.
 */
export async function markExhausted(planId: string, waveNumber: number): Promise<void> {
  const nowIso = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.fixCycles,
      Key: { cycleKey: cycleKey(planId, waveNumber) },
      UpdateExpression: 'SET #status = :exhausted, lastAttemptAt = :now',
      ConditionExpression: 'attribute_exists(cycleKey)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':exhausted': 'exhausted',
        ':now': nowIso,
      },
    }),
  );
}
