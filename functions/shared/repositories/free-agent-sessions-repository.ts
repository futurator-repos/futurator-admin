/**
 * free-agent-sessions-repository.ts — Story 18.2 (Epic 18: Free Claude Code Agent)
 *
 * One table per concern: `futurator-free-agent-sessions` stores the lifecycle
 * row for every operator-initiated free-agent chat session. Conversation
 * messages live in a separate table introduced by Story 18.6.
 *
 * Lock pattern (acquireProcessingLock / releaseProcessingLock) mirrors
 * `party-sessions-repository.ts:tryAcquireSessionLock` — conditional
 * UpdateCommand with re-fetch disambiguation on
 * `ConditionalCheckFailedException`.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import {
  buildScopeIdComposite,
  type CreateFreeAgentSessionInput,
  type FreeAgentLockResult,
  type FreeAgentPrState,
  type FreeAgentReleaseStatus,
  type FreeAgentRiskClass,
  type FreeAgentSession,
  type FreeAgentSessionStatus,
} from '../types/free-agent';

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

// ─── Reads ──────────────────────────────────────────────────────────

export async function getSession(sessionId: string): Promise<FreeAgentSession | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
    }),
  );
  return (result.Item as FreeAgentSession | undefined) ?? null;
}

/**
 * Full table scan. Used by the GC sweep (Story 18.1's runFreeAgentGc).
 * Acceptable while the table is bounded by the 90-day TTL; switch to a
 * status-index GSI query if the table grows past ~10k rows.
 */
export async function listAllSessions(): Promise<FreeAgentSession[]> {
  const out: FreeAgentSession[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.freeAgentSessions,
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as FreeAgentSession[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/** Operator's recent sessions, newest first (GSI1: operator-recent-index). */
export async function listSessionsByOperator(
  operatorId: string,
  limit = 20,
): Promise<FreeAgentSession[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      IndexName: 'operator-recent-index',
      KeyConditionExpression: 'operatorId = :op',
      ExpressionAttributeValues: { ':op': operatorId },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );
  return (result.Items as FreeAgentSession[] | undefined) ?? [];
}

/**
 * 2026-05-27 (unification) — lookup by first 8 chars of sessionId.
 *
 * The worktree reaper has only the short form (from the filesystem path
 * `/home/ubuntu/worktrees/<app>/_assist/<sidShort>/`) and needs to resolve
 * it back to the full session row to decide whether to reap.
 *
 * Implementation mirrors party's `findBySessionIdShort` (party-sessions-
 * repository.ts §349) — DDB `Scan` with `begins_with(sessionId, :prefix)`,
 * paginated to avoid the `Limit: 5` bug. Collision probability across 4.3B
 * UUID prefixes is ~10⁻¹⁰; first match wins, warn-log on >1.
 *
 * Input validation: only lowercase hex 8-char prefixes are accepted.
 */
const SESSION_ID_SHORT_REGEX = /^[a-f0-9]{8}$/;

export async function findBySessionIdShort(
  sessionIdShort: string,
): Promise<FreeAgentSession | null> {
  if (typeof sessionIdShort !== 'string' || !SESSION_ID_SHORT_REGEX.test(sessionIdShort)) {
    return null;
  }
  // 2026-05-27 — paginate. DDB `Limit` caps items EVALUATED before the
  // FilterExpression runs, NOT matches returned. Party's incident on the
  // same day had `Limit: 5` returning 0 matches for sessions outside the
  // first 5 scanned rows; the reaper interpreted that as `session-row-
  // missing → reap` and deleted active worktrees mid-flight.
  const items: FreeAgentSession[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.freeAgentSessions,
        FilterExpression: 'begins_with(sessionId, :p)',
        ExpressionAttributeValues: { ':p': sessionIdShort },
        ExclusiveStartKey,
      }),
    );
    if (result.Items?.length) items.push(...(result.Items as FreeAgentSession[]));
    if (items.length >= 3) break;
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  if (items.length === 0) return null;
  if (items.length > 1) {
    console.warn(
      `[free-agent-sessions-repository] findBySessionIdShort('${sessionIdShort}'): ${items.length} matches — collision or rolled-back row? Returning first.`,
    );
  }
  return items[0];
}

/** Sessions about a specific scope (GSI2: scope-recent-index). */
export async function listSessionsByScope(
  scope: { kind: string; id?: string },
  limit = 20,
): Promise<FreeAgentSession[]> {
  const composite = `${scope.kind}#${scope.id ?? '_'}`;
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      IndexName: 'scope-recent-index',
      KeyConditionExpression: 'scopeIdComposite = :s',
      ExpressionAttributeValues: { ':s': composite },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items as FreeAgentSession[] | undefined) ?? [];
}

// ─── Writes ─────────────────────────────────────────────────────────

export async function createSession(input: CreateFreeAgentSessionInput): Promise<FreeAgentSession> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + NINETY_DAYS_SECONDS;

  const session: FreeAgentSession = {
    sessionId: input.sessionId,
    operatorId: input.operatorId,
    projectId: input.projectId,
    scope: input.scope,
    scopeIdComposite: buildScopeIdComposite(input.scope),
    status: 'ACTIVE',
    model: input.model,
    costCapUsd: input.costCapUsd,
    costUsdAccumulated: 0,
    turnCount: 0,
    createdAt: nowIso,
    lastActivityAt: nowIso,
    expiresAt,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Item: session,
      // Prevent accidental overwrite of an existing sessionId.
      ConditionExpression: 'attribute_not_exists(sessionId)',
    }),
  );

  return session;
}

/**
 * Atomically transition session from ACTIVE → PROCESSING. On
 * ConditionalCheckFailedException, re-fetch the row to disambiguate
 * (SESSION_BUSY vs NOT_FOUND vs INVALID_STATE).
 */
export async function acquireProcessingLock(sessionId: string): Promise<FreeAgentLockResult> {
  const nowIso = new Date().toISOString();
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.freeAgentSessions,
        Key: { sessionId },
        UpdateExpression: 'SET #status = :processing, lastActivityAt = :now',
        ConditionExpression: 'attribute_exists(sessionId) AND #status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'PROCESSING' satisfies FreeAgentSessionStatus,
          ':active': 'ACTIVE' satisfies FreeAgentSessionStatus,
          ':now': nowIso,
        },
      }),
    );
    return { ok: true };
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'ConditionalCheckFailedException') {
      const row = await getSession(sessionId);
      if (!row) return { ok: false, reason: 'NOT_FOUND' };
      if (row.status === 'PROCESSING') return { ok: false, reason: 'SESSION_BUSY' };
      return { ok: false, reason: 'INVALID_STATE' };
    }
    throw err;
  }
}

/** Release the processing lock by transitioning to a terminal/idle state. */
export async function releaseProcessingLock(
  sessionId: string,
  newStatus: FreeAgentReleaseStatus,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, lastActivityAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':s': newStatus, ':now': nowIso },
    }),
  );
}

/**
 * Capture the Claude session id on first-turn `system.init`. Idempotent on
 * same value via a permissive condition (allows re-setting when absent).
 */
export async function setClaudeSessionId(
  sessionId: string,
  claudeSessionId: string,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET claudeSessionId = :cid',
      ConditionExpression:
        'attribute_exists(sessionId) AND (attribute_not_exists(claudeSessionId) OR claudeSessionId = :cid)',
      ExpressionAttributeValues: { ':cid': claudeSessionId },
    }),
  );
}

/** GC: ACTIVE → IDLE after 30 minutes idle. */
export async function markIdle(sessionId: string): Promise<void> {
  await transitionStatus(sessionId, 'IDLE', ['ACTIVE']);
}

/** GC: IDLE → EXPIRED after 2 additional hours. */
export async function markExpired(sessionId: string): Promise<void> {
  await transitionStatus(sessionId, 'EXPIRED', ['IDLE']);
}

/** Daemon: PROCESSING → BUDGET_EXHAUSTED on cost-cap exit. */
export async function markBudgetExhausted(sessionId: string): Promise<void> {
  await transitionStatus(sessionId, 'BUDGET_EXHAUSTED', ['PROCESSING', 'ACTIVE']);
}

/** Daemon: any non-terminal status → ERROR with a captured reason. */
export async function markError(sessionId: string, reason: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, errorReason = :r, lastActivityAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':s': 'ERROR', ':r': reason, ':now': nowIso },
    }),
  );
}

/** Atomic turnCount++ + lastTurnAt + lastActivityAt update. */
export async function incrementTurn(sessionId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET lastTurnAt = :now, lastActivityAt = :now ADD turnCount :one',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':now': nowIso, ':one': 1 },
    }),
  );
}

/** Atomic add to costUsdAccumulated. */
export async function updateCostUsd(sessionId: string, costUsdDelta: number): Promise<void> {
  if (!Number.isFinite(costUsdDelta) || costUsdDelta <= 0) return;
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'ADD costUsdAccumulated :d',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':d': costUsdDelta },
    }),
  );
}

/**
 * Story 18.3 — atomic add to tokensInAccumulated + tokensOutAccumulated.
 * No-op when both deltas are <= 0 or non-finite (defensive).
 */
export async function updateTokens(
  sessionId: string,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const safeIn = Number.isFinite(tokensIn) && tokensIn > 0 ? tokensIn : 0;
  const safeOut = Number.isFinite(tokensOut) && tokensOut > 0 ? tokensOut : 0;
  if (safeIn === 0 && safeOut === 0) return;
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'ADD tokensInAccumulated :i, tokensOutAccumulated :o',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':i': safeIn, ':o': safeOut },
    }),
  );
}

/**
 * Story 18.5 — update the session's per-session cost cap. The daemon reads
 * `costCapUsd` from the session payload when constructing the next turn's
 * `--max-budget-usd` CLI flag, so the new cap takes effect on the next
 * message-enqueue (not retroactively to an in-flight turn).
 *
 * No-op when capUsd is non-finite, ≤0, or > FREE_AGENT_MAX_COST_CAP_USD (1000).
 */
export async function setCostCapUsd(sessionId: string, capUsd: number): Promise<void> {
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 1000) return;
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET costCapUsd = :cap',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':cap': capUsd },
    }),
  );
}

/**
 * Operator clicked Stop while the daemon is mid-turn. Sets a soft signal that
 * the daemon's runFreeAgentSession polls every few seconds; on detection the
 * daemon SIGTERMs the spawned `claude` subprocess and releases the lock back
 * to ACTIVE so the operator can continue the session.
 *
 * Only valid while the session is actually PROCESSING — otherwise the cancel
 * would just sit on a row with no daemon to consume it. The
 * ConditionalCheckFailedException becomes a 409 INVALID_STATE at the API layer.
 */
export async function requestCancel(sessionId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET cancelRequested = :t, cancelRequestedAt = :now',
      ConditionExpression: 'attribute_exists(sessionId) AND #status = :processing',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':t': true,
        ':now': new Date().toISOString(),
        ':processing': 'PROCESSING' satisfies FreeAgentSessionStatus,
      },
    }),
  );
}

/**
 * 2026-05-27 PR B.d — set the PR state on a session after `/open-pr`
 * succeeds. Upserts every PR-related field atomically. Subsequent calls
 * overwrite (we model "open a NEW PR" as supersession; the prior PR's
 * audit events stay in the event stream).
 */
export interface SetPrStateInput {
  prNumber: number;
  prUrl: string;
  prHeadSha: string;
  prState: FreeAgentPrState;
  prRiskClass: FreeAgentRiskClass;
  prRiskReasons: string[];
  prTitle: string;
}

export async function setPrState(sessionId: string, input: SetPrStateInput): Promise<void> {
  const nowIso = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression:
        'SET prNumber = :n, prUrl = :u, prHeadSha = :sha, prState = :s, ' +
        'prRiskClass = :rc, prRiskReasons = :rr, prTitle = :t, prUpdatedAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: {
        ':n': input.prNumber,
        ':u': input.prUrl,
        ':sha': input.prHeadSha,
        ':s': input.prState,
        ':rc': input.prRiskClass,
        ':rr': input.prRiskReasons,
        ':t': input.prTitle,
        ':now': nowIso,
      },
    }),
  );
}

/**
 * Transition just the PR state (not the rest of the PR fields). Used by
 * `/approve-merge` (OPEN → MERGED) and `/reject-merge` (OPEN → CLOSED).
 */
export async function transitionPrState(
  sessionId: string,
  newState: FreeAgentPrState,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET prState = :s, prUpdatedAt = :now',
      ConditionExpression: 'attribute_exists(sessionId) AND prState = :open',
      ExpressionAttributeValues: { ':s': newState, ':now': nowIso, ':open': 'OPEN' },
    }),
  );
}

/**
 * Daemon-side: clear the cancel flag (called on every turn start AND after
 * a successful cancel handoff) so a stale flag from a prior turn never bleeds
 * into the next one.
 */
export async function clearCancelFlag(sessionId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'REMOVE cancelRequested, cancelRequestedAt',
      ConditionExpression: 'attribute_exists(sessionId)',
    }),
  );
}

/** Record the moment an external caller re-AssumeRole'd credentials for this session. */
export async function setLastRefreshedAt(sessionId: string, isoTimestamp?: string): Promise<void> {
  const at = isoTimestamp ?? new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET lastRefreshedAt = :t',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':t': at },
    }),
  );
}

// ─── Internal ───────────────────────────────────────────────────────

async function transitionStatus(
  sessionId: string,
  next: FreeAgentSessionStatus,
  validPrevious: FreeAgentSessionStatus[],
): Promise<void> {
  const nowIso = new Date().toISOString();
  const previousNames: Record<string, string> = {};
  const previousValues: Record<string, FreeAgentSessionStatus> = {};
  const previousPlaceholders = validPrevious.map((status, i) => {
    const key = `:p${i}`;
    previousValues[key] = status;
    return key;
  });

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, lastActivityAt = :now',
      ConditionExpression: `attribute_exists(sessionId) AND #status IN (${previousPlaceholders.join(', ')})`,
      ExpressionAttributeNames: { '#status': 'status', ...previousNames },
      ExpressionAttributeValues: { ':s': next, ':now': nowIso, ...previousValues },
    }),
  );
}
