/**
 * agent-spend-log-repository.ts — 2026-05-27 PR B.c.
 *
 * One row per completed agent job. Spend = wall-clock seconds × per-second
 * cost (see daemon `runJobAsync` finally block). Read by:
 *
 *   - `getDailySpend(date)` → today's cumulative spend (UI pill + PR C cap
 *     enforcement).
 *   - Forensic queries by jobId / sessionId for audit.
 *
 * Schema:
 *   PK: logId (uuid)
 *   GSI1: { GSI1PK = 'YYYY-MM-DD', GSI1SK = createdAt }
 *
 * 90-day TTL on `expiresAt` (epoch seconds). At v1 scale (~100 jobs/day)
 * the table stays well under 10k rows.
 *
 * Cost-per-sec is configurable via env (AGENT_COST_PER_SEC, default 0.02).
 * Per §9.5 RESOLVED, true token-level tracking is a deferred Phase 2
 * refinement; this gives us a daily soft cap NOW without a tracking layer.
 */

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import { randomUUID } from 'node:crypto';

export type AgentClass = 'party' | 'free-agent' | 'pipeline-v2' | 'app-bootstrap' | 'other';

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

export interface AgentSpendRow {
  logId: string;
  jobId?: string;
  sessionId?: string;
  projectId?: string;
  agentClass: AgentClass;
  walltimeSec: number;
  costUsd: number;
  createdAt: string;
  GSI1PK: string; // YYYY-MM-DD (UTC)
  GSI1SK: string; // createdAt ISO
  expiresAt: number;
}

export interface WriteSpendRowInput {
  jobId?: string;
  sessionId?: string;
  projectId?: string;
  agentClass: AgentClass;
  walltimeSec: number;
  costUsd: number;
  /** ISO timestamp; defaults to now. Tests inject for determinism. */
  createdAt?: string;
}

function dateKey(iso: string): string {
  // UTC day boundary so the "today" pill is consistent across operator
  // timezones. Operator's local clock is for display only.
  return iso.slice(0, 10);
}

export async function writeSpendRow(input: WriteSpendRowInput): Promise<AgentSpendRow> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const row: AgentSpendRow = {
    logId: randomUUID(),
    jobId: input.jobId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    agentClass: input.agentClass,
    walltimeSec: Number.isFinite(input.walltimeSec) ? Math.max(0, input.walltimeSec) : 0,
    costUsd: Number.isFinite(input.costUsd) ? Math.max(0, input.costUsd) : 0,
    createdAt,
    GSI1PK: dateKey(createdAt),
    GSI1SK: createdAt,
    expiresAt: Math.floor(Date.parse(createdAt) / 1000) + NINETY_DAYS_SECONDS,
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.agentSpendLog, Item: row }));
  return row;
}

/**
 * Sum walltime + cost across all rows for the given UTC date.
 * Returns 0/0 when the day has no rows.
 */
export interface DailySpend {
  date: string;
  totalCostUsd: number;
  totalWalltimeSec: number;
  rowCount: number;
}

export async function getDailySpend(date: string): Promise<DailySpend> {
  let totalCostUsd = 0;
  let totalWalltimeSec = 0;
  let rowCount = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.agentSpendLog,
        IndexName: 'date-createdAt-index',
        KeyConditionExpression: 'GSI1PK = :d',
        ExpressionAttributeValues: { ':d': date },
        ExclusiveStartKey,
      }),
    );
    for (const item of (result.Items as AgentSpendRow[] | undefined) ?? []) {
      totalCostUsd += Number(item.costUsd) || 0;
      totalWalltimeSec += Number(item.walltimeSec) || 0;
      rowCount += 1;
    }
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return { date, totalCostUsd, totalWalltimeSec, rowCount };
}

/** Resolve today's UTC date. Exposed so callers can mock for tests. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
