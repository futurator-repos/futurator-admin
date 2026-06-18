/**
 * propagator-ingest.mjs — Seam A (Epic 6.5 activation).
 *
 * The PROPAGATOR pass writes consent-gated proposals to
 * `knowledge/_graph/propagator-proposals.json`. This files them into the
 * `PROPAGATOR_PROPOSALS_TABLE` DynamoDB queue (PK `proposalId`) where the API +
 * UI surface them for approve/reject. Idempotent: a proposal that has already
 * been decided (status ≠ `proposed`) is never resurrected — only genuinely-new
 * or still-`proposed` rows are written.
 *
 * Pure transform (`buildProposalItems`) + idempotent ingest (`ingestProposals`,
 * dependency-injected `get`/`put`) unit-test without AWS; `ingestToDynamo` wires
 * the real DynamoDB client (the daemon already ships `@aws-sdk/lib-dynamodb`).
 */

/** Map a proposals doc to DDB items (status `proposed`, requiresApproval). Pure. */
export function buildProposalItems(doc, { now } = {}) {
  const ts = now ?? new Date().toISOString();
  return (doc?.proposals ?? [])
    .filter((p) => p && p.proposalId)
    .map((p) => ({
      proposalId: p.proposalId,
      sourceProject: p.sourceProject ?? doc.sourceProject ?? null,
      sibling: p.sibling,
      trigger: p.trigger ?? doc.trigger ?? 'wave-gate',
      status: 'proposed',
      requiresApproval: true,
      brief: p.brief ?? '',
      contractChanges: p.contractChanges ?? [],
      proposedStory: p.proposedStory ?? null,
      atCommit: p.atCommit ?? null,
      createdAt: p.createdAt ?? ts,
    }));
}

/**
 * Idempotently file proposal items. For each, read the existing row; skip if it
 * exists and is already decided (status ≠ `proposed`). Returns a summary.
 *
 * @param {Array} items - from buildProposalItems
 * @param {{ get:(id:string)=>Promise<object|null>, put:(item:object)=>Promise<void> }} deps
 */
export async function ingestProposals(items, { get, put }) {
  let filed = 0;
  let skipped = 0;
  for (const item of items ?? []) {
    const existing = await get(item.proposalId);
    if (existing && existing.status && existing.status !== 'proposed') {
      skipped += 1;
      continue;
    }
    // Preserve the original createdAt on a re-file of a still-proposed row.
    await put(existing?.createdAt ? { ...item, createdAt: existing.createdAt } : item);
    filed += 1;
  }
  return { filed, skipped, total: (items ?? []).length };
}

/**
 * Wire ingestProposals to a real DynamoDB document client. Best-effort: any AWS
 * error is thrown to the caller, which logs + continues (non-blocking).
 *
 * @param {object} doc - parsed propagator-proposals.json
 * @param {{ tableName:string, docClient:object }} opts
 */
export async function ingestToDynamo(doc, { tableName, docClient }) {
  const { GetCommand, PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const items = buildProposalItems(doc);
  return ingestProposals(items, {
    get: async (proposalId) => {
      const r = await docClient.send(new GetCommand({ TableName: tableName, Key: { proposalId } }));
      return r.Item ?? null;
    },
    put: async (item) => {
      await docClient.send(new PutCommand({ TableName: tableName, Item: item }));
    },
  });
}

// ── Seam C — marker-on-Done reads ────────────────────────────────────────────

/**
 * Read proposals whose sibling port-story reached Done but whose source-contract
 * marker hasn't been advanced yet (`status === 'done' && !markerApplied`). These
 * are the ones the daemon marker pass stamps `lastPropagatedTo` for.
 */
export async function readDoneProposals({ tableName, docClient }) {
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await docClient.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    if (r.Items) out.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out.filter((p) => p.status === 'done' && !p.markerApplied);
}

/** Mark a proposal's marker as applied so it isn't re-stamped on the next run. */
export async function markProposalApplied(proposalId, { tableName, docClient, ts }) {
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { proposalId },
      UpdateExpression: 'SET markerApplied = :t, markerAppliedAt = :at',
      ExpressionAttributeValues: { ':t': true, ':at': ts ?? new Date().toISOString() },
    }),
  );
}

/** Build the default DynamoDB document client (daemon AWS creds). */
export async function defaultDocClient() {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}
