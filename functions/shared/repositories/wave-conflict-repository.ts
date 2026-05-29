/**
 * wave-conflict-repository.ts — Story C (agentic-integration, 2026-05-29).
 *
 * Read side of the wave-merge conflict telemetry. The daemon writes rows
 * (daemon/lib/wave-conflict-recorder.mjs); this repository serves the
 * operator "conflicts / conflict-rate by plan or app" view that makes
 * Decision A (operator-resolve-only) durable — it IS the conflict-rate data
 * the 2026-05-19 decision named as the precondition for ever reconsidering
 * auto-resolution.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { WaveConflictEvent, WaveConflictMode, WaveConflictRate } from '../types/wave-conflict';

/**
 * All conflicts recorded for a plan, newest first (the conflictId SK is
 * epoch-ms-prefixed, so ScanIndexForward:false gives reverse-chronological).
 */
export async function listConflictsByPlan(planId: string): Promise<WaveConflictEvent[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.waveConflicts,
      KeyConditionExpression: 'planId = :p',
      ExpressionAttributeValues: { ':p': planId },
      ScanIndexForward: false,
    }),
  );
  return (result.Items || []) as WaveConflictEvent[];
}

/**
 * All conflicts recorded for an app across all its plans, newest first, via
 * the appId-createdAt GSI.
 */
export async function listConflictsByApp(appId: string): Promise<WaveConflictEvent[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.waveConflicts,
      IndexName: 'appId-createdAt-index',
      KeyConditionExpression: 'appId = :a',
      ExpressionAttributeValues: { ':a': appId },
      ScanIndexForward: false,
    }),
  );
  return (result.Items || []) as WaveConflictEvent[];
}

/**
 * Aggregate a list of conflict events into a rate summary: total, breakdown
 * by resolution mode, and a per-file ranking (which files conflict most —
 * the empirical input to "which hot files does the Story D registry refactor
 * need to make additive").
 */
export function summarizeConflicts(events: WaveConflictEvent[]): WaveConflictRate {
  const byMode: Record<WaveConflictMode, number> = {
    halted: 0,
    'operator-resolved': 0,
    'auto-resolved': 0,
  };
  const byFile: Record<string, number> = {};
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const e of events) {
    if (e.mode in byMode) byMode[e.mode] += 1;
    for (const f of e.files || []) {
      byFile[f] = (byFile[f] || 0) + 1;
    }
    if (e.createdAt) {
      if (!firstAt || e.createdAt < firstAt) firstAt = e.createdAt;
      if (!lastAt || e.createdAt > lastAt) lastAt = e.createdAt;
    }
  }

  return { total: events.length, byMode, byFile, firstAt, lastAt };
}
