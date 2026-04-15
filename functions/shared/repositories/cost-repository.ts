import { QueryCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { CostRecord } from '../types';
import { subDays, format } from 'date-fns';

export async function getCostsByProject(projectId: string, days: number): Promise<CostRecord[]> {
  const startDate = format(subDays(new Date(), days), 'yyyy-MM-dd');
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.costs,
      KeyConditionExpression: 'projectId = :pk AND #date >= :start',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':pk': projectId, ':start': startDate },
    }),
  );
  return (result.Items || []) as CostRecord[];
}

export async function getPortfolioCosts(days: number): Promise<CostRecord[]> {
  return getCostsByProject('PORTFOLIO', days);
}

export async function putCostRecord(record: CostRecord): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.costs, Item: record }));
}

export async function getLatestCostsByAllProjects(days: number): Promise<CostRecord[]> {
  const startDate = format(subDays(new Date(), days), 'yyyy-MM-dd');
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAMES.costs,
      FilterExpression: '#date >= :start AND projectId <> :portfolio',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':start': startDate, ':portfolio': 'PORTFOLIO' },
    }),
  );
  return (result.Items || []) as CostRecord[];
}

export async function putManualCost(record: CostRecord & { manualId: string }): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.costs, Item: record }));
}

export async function deleteManualCost(projectId: string, date: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE_NAMES.costs, Key: { projectId, date } }),
  );
}
