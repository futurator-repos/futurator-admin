/**
 * Thin DynamoDB access layer for the epic-workflows table from Node ESM
 * pipeline scripts. Mirrors the subset of
 * `functions/shared/repositories/epic-workflow-repository.ts` used by the
 * touch-point-inference CLI (fetch + persist) without importing the
 * TypeScript frontend modules.
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const DEFAULT_TABLE = 'futurator-epic-workflows';

/**
 * @param {{ ddb: any, tableName?: string }} opts
 */
export function createEpicRepo({ ddb, tableName = DEFAULT_TABLE } = {}) {
  if (!ddb) throw new Error('createEpicRepo: ddb client is required');

  async function getEpicById(epicId) {
    const result = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { epicId } }),
    );
    return result.Item || null;
  }

  /**
   * Overwrite the full `stories` array on the epic row along with an
   * `inferenceSummary` field. Single UpdateCommand — the stories list
   * is rewritten wholesale since inference output restructures waves.
   */
  async function persistInferenceResult(epicId, { stories, inferenceSummary }) {
    const now = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { epicId },
        UpdateExpression:
          'SET #stories = :stories, #inferenceSummary = :summary, #updatedAt = :now',
        ExpressionAttributeNames: {
          '#stories': 'stories',
          '#inferenceSummary': 'inferenceSummary',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':stories': stories,
          ':summary': inferenceSummary,
          ':now': now,
        },
      }),
    );
  }

  return { getEpicById, persistInferenceResult };
}
