// Pipeline v1 — Epic 4 (Cost & time discipline). Story 4.1.
//
// Per-job / per-plan / daily cost meter. Reads the cost field that the
// Claude CLI emits on its `result` event and persists rolling totals on
// the AgentJob row. Plan-level cost is a derived sum over all the plan's
// jobs; daily cost is a 24-hour rolling sum.
//
// Designed as a pure-ish module: it accepts a DDB client + the table name
// at construction. Daemon ownership of the singleton lives in agent-daemon.mjs.

import { GetCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const JOBS_TABLE = process.env.AGENT_JOBS_TABLE || 'futurator-agent-jobs';
const SESSIONS_TABLE = process.env.AGENT_SESSIONS_TABLE || 'futurator-agent-sessions';

export class CostMeter {
  constructor(ddb, opts = {}) {
    this.ddb = ddb;
    this.jobsTable = opts.jobsTable || JOBS_TABLE;
    this.sessionsTable = opts.sessionsTable || SESSIONS_TABLE;
  }

  /**
   * Record one turn's cost against a job (and its session if known).
   * Atomic ADD on `costSoFarUsd`. Returns the new total.
   */
  async recordTurn(jobId, sessionId, costUsd) {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
    const result = await this.ddb.send(
      new UpdateCommand({
        TableName: this.jobsTable,
        Key: { jobId },
        UpdateExpression: 'ADD costSoFarUsd :c SET updatedAt = :n',
        ExpressionAttributeValues: {
          ':c': costUsd,
          ':n': new Date().toISOString(),
        },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    if (sessionId) {
      try {
        await this.ddb.send(
          new UpdateCommand({
            TableName: this.sessionsTable,
            Key: { sessionId },
            UpdateExpression: 'ADD costUsd :c',
            ExpressionAttributeValues: { ':c': costUsd },
          }),
        );
      } catch {
        // session row may not exist yet (first turn); fine.
      }
    }
    return Number(result.Attributes?.costSoFarUsd) || 0;
  }

  async getJobCost(jobId) {
    const r = await this.ddb.send(
      new GetCommand({
        TableName: this.jobsTable,
        Key: { jobId },
        ProjectionExpression: 'costSoFarUsd, costCeilingUsd',
      }),
    );
    return {
      cost: Number(r.Item?.costSoFarUsd) || 0,
      ceiling: Number(r.Item?.costCeilingUsd) || 0,
    };
  }

  /**
   * Sum every job's costSoFarUsd matching `filterFn`. Used by the daily
   * rollup and per-plan rollup. O(N jobs) — for v1 the table is small.
   */
  async aggregateBy(filterFn) {
    let total = 0;
    let ExclusiveStartKey;
    do {
      const result = await this.ddb.send(
        new ScanCommand({
          TableName: this.jobsTable,
          ProjectionExpression: 'jobId, planId, epicId, createdAt, costSoFarUsd',
          ExclusiveStartKey,
        }),
      );
      for (const item of result.Items || []) {
        if (!filterFn(item)) continue;
        total += Number(item.costSoFarUsd) || 0;
      }
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return total;
  }

  /**
   * Daily total = sum of every job's costSoFarUsd whose `createdAt` falls
   * inside the rolling 24h window ending at `now`.
   */
  getDailyCost(nowMs = Date.now()) {
    const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    return this.aggregateBy((item) => (item.createdAt || '') >= cutoff);
  }

  getPlanCost(planId) {
    return this.aggregateBy((item) => item.planId === planId);
  }

  /**
   * Decision helper: given a current cost, ceiling, and warn-threshold (0..1),
   * decide whether the daemon should warn or terminate the active step.
   */
  decideAction(cost, ceiling, warnAt = 0.8) {
    if (!Number.isFinite(ceiling) || ceiling <= 0) return { action: 'continue' };
    if (cost >= ceiling) return { action: 'terminate', reason: 'COST_CEILING' };
    if (cost >= ceiling * warnAt) return { action: 'warn' };
    return { action: 'continue' };
  }
}
