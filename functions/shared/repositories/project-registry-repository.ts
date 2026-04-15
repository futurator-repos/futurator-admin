import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { ProjectRegistry, SessionMeta, FileManifestEntry } from '../types/project-registry';

export async function getProject(projectId: string): Promise<ProjectRegistry | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.projectRegistry, Key: { projectId } }),
  );
  return (result.Item as ProjectRegistry) || null;
}

export async function getAllProjects(): Promise<ProjectRegistry[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.projectRegistry }));
  return (result.Items || []) as ProjectRegistry[];
}

export async function createProject(project: ProjectRegistry): Promise<ProjectRegistry> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.projectRegistry, Item: project }));
  return project;
}

export async function deleteProject(projectId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE_NAMES.projectRegistry, Key: { projectId } }),
  );
}

export async function updateProjectFields(
  projectId: string,
  fields: Partial<Omit<ProjectRegistry, 'projectId'>>,
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const expressions: string[] = [];

  for (const [key, value] of entries) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    expressions.push(`#${key} = :${key}`);
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.projectRegistry,
      Key: { projectId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function upsertSession(
  projectId: string,
  storyId: string,
  session: SessionMeta,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.projectRegistry,
      Key: { projectId },
      UpdateExpression: 'SET #sessions.#storyId = :session, #updatedAt = :now',
      ExpressionAttributeNames: {
        '#sessions': 'sessions',
        '#storyId': storyId,
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':session': session,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

export async function updateFileManifest(
  projectId: string,
  files: Record<string, FileManifestEntry>,
): Promise<void> {
  // Merge file entries into the existing manifest
  const names: Record<string, string> = { '#fm': 'fileManifest', '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };
  const expressions: string[] = ['#updatedAt = :now'];

  let i = 0;
  for (const [filePath, entry] of Object.entries(files)) {
    const key = `#fk${i}`;
    const val = `:fv${i}`;
    names[key] = filePath;
    values[val] = entry;
    expressions.push(`#fm.${key} = ${val}`);
    i++;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.projectRegistry,
      Key: { projectId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function addEpicToProject(projectId: string, epicId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.projectRegistry,
      Key: { projectId },
      UpdateExpression:
        'SET #epics = list_append(if_not_exists(#epics, :empty), :newEpic), #updatedAt = :now',
      ExpressionAttributeNames: { '#epics': 'epics', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: {
        ':newEpic': [epicId],
        ':empty': [],
        ':now': new Date().toISOString(),
      },
    }),
  );
}
