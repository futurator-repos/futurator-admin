import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { Alert } from '../types';

export async function getAllAlerts(): Promise<Alert[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.alerts }));
  return ((result.Items || []) as Alert[]).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getAlertsByProject(projectId: string): Promise<Alert[]> {
  const all = await getAllAlerts();
  return all.filter((a) => a.projectId === projectId);
}

export async function putAlert(alert: Alert): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.alerts, Item: alert }));
}
