import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { Project } from '../types';

export async function getAllProjects(): Promise<Project[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.projects }));
  return (result.Items || []) as Project[];
}

export async function getProjectById(projectId: string): Promise<Project | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.projects, Key: { projectId } }),
  );
  return (result.Item as Project) || null;
}

export async function updateProject(
  projectId: string,
  updates: Partial<Project>,
): Promise<Project> {
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined && key !== 'projectId') {
      const attrName = `#${key}`;
      const attrValue = `:${key}`;
      expressions.push(`${attrName} = ${attrValue}`);
      names[attrName] = key;
      values[attrValue] = value;
    }
  });

  expressions.push('#updatedAt = :updatedAt');
  names['#updatedAt'] = 'updatedAt';
  values[':updatedAt'] = new Date().toISOString();

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.projects,
      Key: { projectId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return result.Attributes as Project;
}

export async function createProject(project: Project): Promise<Project> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.projects, Item: project }));
  return project;
}
