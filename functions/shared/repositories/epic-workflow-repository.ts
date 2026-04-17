import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type { EpicWorkflow } from '../types/epic-workflow';

export async function createEpic(epic: EpicWorkflow): Promise<EpicWorkflow> {
  // EO-7.2: new epics default to the orchestrator path. Epics created before
  // the flip keep their existing value (no backfill) because this default
  // only applies when the caller omits the field.
  const item: EpicWorkflow = { ...epic, useEpicOrchestrator: epic.useEpicOrchestrator ?? true };
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.epicWorkflows, Item: item }));
  return item;
}

export async function getAllEpics(): Promise<EpicWorkflow[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.epicWorkflows }));
  return (result.Items || []) as EpicWorkflow[];
}

export async function getEpicById(epicId: string): Promise<EpicWorkflow | null> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAMES.epicWorkflows, Key: { epicId } }),
  );
  return (result.Item as EpicWorkflow) || null;
}

export async function deleteEpic(epicId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE_NAMES.epicWorkflows, Key: { epicId } }),
  );
}

export async function updateEpicFields(
  epicId: string,
  fields: Partial<Omit<EpicWorkflow, 'epicId'>>,
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
      TableName: TABLE_NAMES.epicWorkflows,
      Key: { epicId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
