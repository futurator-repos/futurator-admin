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
