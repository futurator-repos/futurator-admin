import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AuditResult } from '../types';

export async function getLatestAudits(): Promise<AuditResult[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.audits }));
  const items = (result.Items || []) as AuditResult[];
  const latest = new Map<string, AuditResult>();
  for (const item of items) {
    const existing = latest.get(item.projectId);
    if (!existing || item.auditDate > existing.auditDate) {
      latest.set(item.projectId, item);
    }
  }
  return Array.from(latest.values());
}

export async function putAuditResult(audit: AuditResult): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.audits, Item: audit }));
}
