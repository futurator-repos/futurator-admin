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
  // EO-7.2 (2026-04-17, now superseded): new epics defaulted to the orchestrator
  // path. CLAUDE.md "Recent changes" notes this was deprecated by Epic 17
  // (Plan.executionMode) and that all legacy pre-Epic-17 epics were wiped on
  // 2026-04-21. As of 2026-05-17 the default flipped to `false` — the
  // orchestrator path (daemon/pipelines/epic-dev-pipeline.mjs) has no live
  // production callers, and `?? true` was a footgun for any hand-crafted
  // epic-create payload that omitted the field. Plans created via the
  // standard launcher still pick the correct mode via
  // `plan-generation-service.ts` (`useEpicOrchestrator: plan.executionMode ===
  // 'orchestrator'`).
  const item: EpicWorkflow = { ...epic, useEpicOrchestrator: epic.useEpicOrchestrator ?? false };
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
