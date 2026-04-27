import { PutCommand, ScanCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { DirectoryUser } from '../types';

/**
 * Pipeline v1 — Story 6.5. User profile fields persisted on the existing
 * users row. Optional / nullable so existing rows aren't broken.
 */
export interface UserProfileExtensions {
  emailDigestEnabled?: boolean;
  timezone?: string;
}

export async function updateUserProfile(
  userId: string,
  patch: UserProfileExtensions,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const expressions: string[] = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    expressions.push(`#${k} = :${k}`);
  }
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.users,
      Key: { userId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

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
