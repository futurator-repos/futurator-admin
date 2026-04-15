import { PutCommand, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { DirectoryUser } from '../types';

export async function getAllUsers(): Promise<DirectoryUser[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.users }));
  return (result.Items || []) as DirectoryUser[];
}

export async function getUsersByProject(projectId: string): Promise<DirectoryUser[]> {
  const all = await getAllUsers();
  return all.filter((u) => projectId in (u.projects || {}));
}

export async function getUserById(userId: string): Promise<DirectoryUser | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.users, Key: { userId } }),
  );
  return (result.Item as DirectoryUser) || null;
}

export async function putUser(user: DirectoryUser): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.users, Item: user }));
}
