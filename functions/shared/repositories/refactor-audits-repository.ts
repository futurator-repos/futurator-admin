/**
 * refactor-audits-repository.ts — Refactoring Assessment Module (Epic C).
 *
 * DDB layer for durable audit records (`futurator-refactor-audits`). PK =
 * auditId; GSI `projectId-createdAt-index` lists a project's audits
 * newest-first. The MVP recon report rides the job row (no-TTL); this table is
 * the durable home for L3-adjudicated audits whose verdicts + generated plan
 * seed dev stories and must outlive the 7-day events TTL.
 */

import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { RefactorAuditRecord } from '../types/refactor-audit';

const GSI_PROJECT = 'projectId-createdAt-index';

/** Upsert an audit record (the daemon writes one per completed audit). */
export async function putAudit(record: RefactorAuditRecord): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.refactorAudits,
      Item: record,
    }),
  );
}

/** Fetch one audit by id (the read endpoint). */
export async function getAudit(auditId: string): Promise<RefactorAuditRecord | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.refactorAudits,
      Key: { auditId },
    }),
  );
  return (res.Item as RefactorAuditRecord) ?? null;
}

/**
 * List a project's audits newest-first via the GSI. `limit` caps the page; the
 * GSI rangeKey is `createdAt`, so `ScanIndexForward: false` returns descending.
 */
export async function listAuditsByProject(
  projectId: string,
  limit = 20,
): Promise<RefactorAuditRecord[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.refactorAudits,
      IndexName: GSI_PROJECT,
      KeyConditionExpression: 'projectId = :pid',
      ExpressionAttributeValues: { ':pid': projectId },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items as RefactorAuditRecord[]) ?? [];
}

/**
 * Delete every audit for a project (app-delete cascade). Volume is low (a few
 * per app), so a GSI Query + per-item delete is fine. Returns the count deleted.
 */
export async function deleteAuditsForProject(projectId: string): Promise<number> {
  const rows = await listAuditsByProject(projectId, 1000);
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  for (const r of rows) {
    await docClient.send(
      new DeleteCommand({ TableName: TABLE_NAMES.refactorAudits, Key: { auditId: r.auditId } }),
    );
  }
  return rows.length;
}
