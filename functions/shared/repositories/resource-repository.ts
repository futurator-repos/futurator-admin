import { QueryCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { AWSResource } from '../types';

export async function getResourcesByProject(projectId: string): Promise<AWSResource[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.resources,
      KeyConditionExpression: 'projectId = :pk',
      ExpressionAttributeValues: { ':pk': projectId },
    }),
  );
  return (result.Items || []) as AWSResource[];
}

export async function getAllResources(): Promise<AWSResource[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.resources }));
  return (result.Items || []) as AWSResource[];
}

export async function putResource(resource: AWSResource): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.resources, Item: resource }));
}
