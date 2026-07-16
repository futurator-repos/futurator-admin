// atomic-claim — DynamoDB conditional-write story claiming (development-plan §5.2).
//
// The multi-host / restart-safe replacement for the daemon's unconditional
// RUNNING write. A StoryNode is claimed with a conditional UpdateExpression that
// only succeeds when the row is `ready` (or its lease has expired), so two
// daemons racing the same frontier resolve to exactly one winner — no in-process
// lock, no lost work on restart. This BEATS ecc's non-atomic GitHub-issue-body
// claim, which documents its own race.
//
// Builders are pure (return the DDB params) and unit-tested without the SDK;
// the async wrappers construct the command + interpret ConditionalCheckFailed
// as "lost the race", not an error.

import crypto from 'node:crypto';
import { UpdateCommand as RealUpdateCommand } from '@aws-sdk/lib-dynamodb';

const DEFAULT_LEASE_MS = 15 * 60 * 1000; // 15-min lease; renew well before expiry

/** Build the conditional-claim UpdateCommand params. PURE. */
export function buildClaimParams({ table, storyId, owner, token, leaseMs = DEFAULT_LEASE_MS, now = Date.now() }) {
  const expiresAt = new Date(now + leaseMs).toISOString();
  const nowIso = new Date(now).toISOString();
  return {
    TableName: table,
    Key: { storyId },
    // Claim only a ready story whose lease is absent or already expired.
    // `state` is a DynamoDB reserved word + the GSI key the ingest writes, so it
    // MUST be aliased (#state) and match the ingest's field name exactly.
    UpdateExpression:
      'SET #state = :claimed, claimOwner = :owner, claimToken = :token, claimExpiresAt = :exp, updatedAt = :now',
    ConditionExpression:
      '#state = :ready AND (attribute_not_exists(claimExpiresAt) OR claimExpiresAt < :now)',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':claimed': 'claimed',
      ':ready': 'ready',
      ':owner': owner,
      ':token': token,
      ':exp': expiresAt,
      ':now': nowIso,
    },
    ReturnValues: 'ALL_NEW',
  };
}

/** Build the lease-renewal params (extend expiry, only while WE hold it). PURE. */
export function buildRenewParams({ table, storyId, token, leaseMs = DEFAULT_LEASE_MS, now = Date.now() }) {
  return {
    TableName: table,
    Key: { storyId },
    UpdateExpression: 'SET claimExpiresAt = :exp, updatedAt = :now',
    ConditionExpression: 'claimToken = :token',
    ExpressionAttributeValues: {
      ':exp': new Date(now + leaseMs).toISOString(),
      ':now': new Date(now).toISOString(),
      ':token': token,
    },
    ReturnValues: 'ALL_NEW',
  };
}

/**
 * Build the ORPHAN release params (back to ready, clear claim) — used by the
 * stale-heartbeat reaper when the claiming JOB is dead (daemon restart/OOM
 * killed the spawn mid-run; pacman4 f594a817, 2026-07-05). We don't have the
 * claim token (it lived in the dead process), so the safety condition is
 * ownership by the DEAD JOB: `state = claimed AND jobId = <deadJobId>` — a
 * story re-claimed by a live job carries a different jobId and is never
 * touched. Re-running a partially-done story is safe: the test-author is
 * retry-idempotent and the completion gate re-verifies every binding. PURE.
 */
export function buildOrphanReleaseParams({ table, storyId, deadJobId, now = Date.now() }) {
  return {
    TableName: table,
    Key: { storyId },
    UpdateExpression:
      'SET #state = :ready, updatedAt = :now REMOVE claimOwner, claimToken, claimExpiresAt, jobId',
    ConditionExpression: '#state = :claimed AND jobId = :deadJobId',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':ready': 'ready',
      ':claimed': 'claimed',
      ':now': new Date(now).toISOString(),
      ':deadJobId': deadJobId,
    },
    ReturnValues: 'ALL_NEW',
  };
}

/** Build the release params (back to ready, clear claim) — only our claim. PURE. */
export function buildReleaseParams({ table, storyId, token, now = Date.now() }) {
  return {
    TableName: table,
    Key: { storyId },
    UpdateExpression:
      'SET #state = :ready, updatedAt = :now REMOVE claimOwner, claimToken, claimExpiresAt',
    ConditionExpression: 'claimToken = :token',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':ready': 'ready',
      ':now': new Date(now).toISOString(),
      ':token': token,
    },
    ReturnValues: 'ALL_NEW',
  };
}

/**
 * Build the atomic dependency-done decrement (event-driven Kahn, plan §5.1). Each
 * dependent of a just-`done` story is decremented; when its counter hits 0 the
 * row flips blocked→ready. Two writes keep it atomic + idempotent:
 *   (a) ADD unblockedDepsCount :neg1  (conditional: still > 0, so re-delivery
 *       of the same completion can't drive it negative)
 * The caller flips to ready when ALL_NEW reports 0. PURE.
 */
export function buildDecrementDepParams({ table, storyId, now = Date.now() }) {
  return {
    TableName: table,
    Key: { storyId },
    UpdateExpression: 'ADD unblockedDepsCount :neg1 SET updatedAt = :now',
    ConditionExpression: 'unblockedDepsCount > :zero',
    ExpressionAttributeValues: { ':neg1': -1, ':zero': 0, ':now': new Date(now).toISOString() },
    ReturnValues: 'ALL_NEW',
  };
}

/** Build the blocked→ready flip once a counter reaches 0. PURE. */
export function buildUnblockParams({ table, storyId, now = Date.now() }) {
  return {
    TableName: table,
    Key: { storyId },
    UpdateExpression: 'SET #state = :ready, updatedAt = :now',
    ConditionExpression: '#state = :blocked AND unblockedDepsCount = :zero',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':ready': 'ready',
      ':blocked': 'blocked',
      ':zero': 0,
      ':now': new Date(now).toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  };
}

// ---------------------------------------------------------------------------
// Agent-job CAS claim (Servers-module Task 17, development-plan Phase C).
//
// Same lease pattern as the story claim above, generalized to
// `futurator-agent-jobs`: a server-aware daemon polls its own PENDING jobs
// via `assignedServerId-status-index`, then must win a conditional claim
// before running one — two daemons racing the same assigned job (a restart
// re-polling mid-lease, or an operator re-pointing `assignedServerId`)
// resolve to exactly one winner. Key is `jobId` (not `storyId`), and the
// claim also pins the row to the caller's `assignedServerId` so a daemon can
// never claim a job the dispatcher assigned to someone else. PURE builders,
// unit-tested without the SDK.
// ---------------------------------------------------------------------------

/**
 * Build the conditional-claim UpdateCommand params for an agent job. Mints a
 * fresh claimToken (crypto random UUID) and returns it alongside the params
 * — callers need it to renew/release the lease they just won. PURE.
 */
export function buildJobClaimParams({ tableName, jobId, serverId, nowIso, leaseMs = DEFAULT_LEASE_MS }) {
  const nowMs = new Date(nowIso).getTime();
  const expiresAt = new Date(nowMs + leaseMs).toISOString();
  const claimToken = crypto.randomUUID();
  const params = {
    TableName: tableName,
    Key: { jobId },
    UpdateExpression:
      'SET #status = :running, claimOwner = :sid, claimToken = :tok, claimExpiresAt = :exp, startedAt = :now',
    ConditionExpression:
      '#status = :pending AND assignedServerId = :sid AND (attribute_not_exists(claimExpiresAt) OR claimExpiresAt < :now)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pending': 'PENDING',
      ':running': 'RUNNING',
      ':sid': serverId,
      ':tok': claimToken,
      ':exp': expiresAt,
      ':now': nowIso,
    },
    ReturnValues: 'ALL_NEW',
  };
  return { params, claimToken };
}

/** Build the lease-renewal params for an agent job (extend expiry, only while WE hold it). PURE. */
export function buildJobRenewParams({ tableName, jobId, serverId, claimToken, nowIso, leaseMs = DEFAULT_LEASE_MS }) {
  const nowMs = new Date(nowIso).getTime();
  const expiresAt = new Date(nowMs + leaseMs).toISOString();
  return {
    TableName: tableName,
    Key: { jobId },
    UpdateExpression: 'SET claimExpiresAt = :exp',
    ConditionExpression: 'claimOwner = :sid AND claimToken = :tok',
    ExpressionAttributeValues: {
      ':sid': serverId,
      ':tok': claimToken,
      ':exp': expiresAt,
    },
    ReturnValues: 'ALL_NEW',
  };
}

/**
 * Build the release params for an agent job: set the final status and clear
 * the claim fields, but only while we still hold the lease (owner + token
 * match). PURE.
 */
export function buildJobReleaseParams({ tableName, jobId, serverId, claimToken, status }) {
  return {
    TableName: tableName,
    Key: { jobId },
    UpdateExpression: 'SET #status = :status REMOVE claimOwner, claimToken, claimExpiresAt',
    ConditionExpression: 'claimOwner = :sid AND claimToken = :tok',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':sid': serverId,
      ':tok': claimToken,
    },
    ReturnValues: 'ALL_NEW',
  };
}

const isConditionFail = (err) => err?.name === 'ConditionalCheckFailedException';

/**
 * Attempt to claim a story. Returns { claimed:true, item } on success,
 * { claimed:false } when another worker won (ConditionalCheckFailed). Any other
 * error propagates (a real infra fault should surface, not look like a lost race).
 */
export async function claimStory({ ddb, table, storyId, owner, token, leaseMs, now, UpdateCommand = RealUpdateCommand }) {
  try {
    const res = await ddb.send(new UpdateCommand(buildClaimParams({ table, storyId, owner, token, leaseMs, now })));
    return { claimed: true, item: res?.Attributes };
  } catch (err) {
    if (isConditionFail(err)) return { claimed: false };
    throw err;
  }
}

export async function renewClaim({ ddb, table, storyId, token, leaseMs, now, UpdateCommand = RealUpdateCommand }) {
  try {
    const res = await ddb.send(new UpdateCommand(buildRenewParams({ table, storyId, token, leaseMs, now })));
    return { renewed: true, item: res?.Attributes };
  } catch (err) {
    if (isConditionFail(err)) return { renewed: false };
    throw err;
  }
}

export async function releaseClaim({ ddb, table, storyId, token, now, UpdateCommand = RealUpdateCommand }) {
  try {
    const res = await ddb.send(new UpdateCommand(buildReleaseParams({ table, storyId, token, now })));
    return { released: true, item: res?.Attributes };
  } catch (err) {
    if (isConditionFail(err)) return { released: false };
    throw err;
  }
}

/**
 * Record that one dependency finished: decrement the dependent's counter and,
 * if it hit 0, flip it to ready. Returns { unblocked:boolean }.
 */
export async function recordDependencyDone({ ddb, table, storyId, now, UpdateCommand = RealUpdateCommand }) {
  let remaining;
  try {
    const res = await ddb.send(new UpdateCommand(buildDecrementDepParams({ table, storyId, now })));
    remaining = Number(res?.Attributes?.unblockedDepsCount);
  } catch (err) {
    if (isConditionFail(err)) return { unblocked: false }; // already at 0 (idempotent re-delivery)
    throw err;
  }
  if (remaining !== 0) return { unblocked: false };
  try {
    await ddb.send(new UpdateCommand(buildUnblockParams({ table, storyId, now })));
    return { unblocked: true };
  } catch (err) {
    if (isConditionFail(err)) return { unblocked: false }; // someone else flipped it
    throw err;
  }
}
