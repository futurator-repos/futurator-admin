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

  /**
   * Flip a single story's `status` on the epic. Two-step because DynamoDB
   * cannot filter list items by predicate: fetch to find the index, then
   * update `stories[<idx>].status` in-place.
   */
  async function updateStoryStatus(epicId, storyId, status) {
    const epic = await getEpicById(epicId);
    if (!epic || !Array.isArray(epic.stories)) {
      return { updated: false, reason: 'epic-or-stories-not-found' };
    }
    const idx = epic.stories.findIndex((s) => s.storyId === storyId);
    if (idx === -1) {
      return { updated: false, reason: 'story-not-found', storyId };
    }
    const now = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { epicId },
        UpdateExpression:
          `SET #stories[${idx}].#status = :s, #stories[${idx}].#updatedAt = :now, #updatedAt = :now`,
        ExpressionAttributeNames: {
          '#stories': 'stories',
          '#status': 'status',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':s': status,
          ':now': now,
        },
      }),
    );
    return { updated: true, storyId, status, index: idx };
  }

  /**
   * Persist a story's `workSummary` (Story B.6) — the verbatim
   * `---WORK_SUMMARY--- … ---END_WORK_SUMMARY---` block extracted from the
   * DEV / retry agent. Sibling stories in the same wave read this via the
   * Story Context Pack so they don't have to re-discover what the prior
   * stories shipped. Last-write-wins per story (later retries replace
   * earlier ones).
   */
  async function persistStoryWorkSummary(epicId, storyId, workSummary) {
    const epic = await getEpicById(epicId);
    if (!epic || !Array.isArray(epic.stories)) {
      return { updated: false, reason: 'epic-or-stories-not-found' };
    }
    const idx = epic.stories.findIndex((s) => s.storyId === storyId);
    if (idx === -1) {
      return { updated: false, reason: 'story-not-found', storyId };
    }
    const now = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { epicId },
        UpdateExpression:
          `SET #stories[${idx}].#workSummary = :ws, #stories[${idx}].#workSummaryAt = :now, #updatedAt = :now`,
        ExpressionAttributeNames: {
          '#stories': 'stories',
          '#workSummary': 'workSummary',
          '#workSummaryAt': 'workSummaryAt',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':ws': workSummary,
          ':now': now,
        },
      }),
    );
    return { updated: true, storyId, index: idx };
  }

  /**
   * Pipeline v2.0 PR-4 — backfill a story's `touchPoints[]` after the daemon
   * inferred them at dispatch time. Same fetch-then-update pattern as
   * `updateStoryStatus`. Idempotent: re-running with the same value is a
   * cheap no-op.
   *
   * @param {string} epicId
   * @param {string} storyId
   * @param {string[]} touchPoints
   * @param {object} [meta] - optional inference metadata to persist alongside
   * @param {'heuristic'|'llm'|'none'} [meta.source]
   * @returns {Promise<{updated:boolean, reason?:string, storyId?:string}>}
   */
  async function updateStoryTouchPoints(epicId, storyId, touchPoints, meta = {}) {
    if (!Array.isArray(touchPoints)) {
      return { updated: false, reason: 'touchPoints must be an array' };
    }
    const epic = await getEpicById(epicId);
    if (!epic || !Array.isArray(epic.stories)) {
      return { updated: false, reason: 'epic-or-stories-not-found' };
    }
    const idx = epic.stories.findIndex((s) => s.storyId === storyId);
    if (idx === -1) {
      return { updated: false, reason: 'story-not-found', storyId };
    }
    const now = new Date().toISOString();
    const updateExpr = [
      `#stories[${idx}].#touchPoints = :tp`,
      `#stories[${idx}].#touchPointsAt = :now`,
      `#updatedAt = :now`,
    ];
    const exprNames = {
      '#stories': 'stories',
      '#touchPoints': 'touchPoints',
      '#touchPointsAt': 'touchPointsAt',
      '#updatedAt': 'updatedAt',
    };
    const exprValues = {
      ':tp': touchPoints,
      ':now': now,
    };
    if (meta.source) {
      updateExpr.push(`#stories[${idx}].#touchPointsSource = :src`);
      exprNames['#touchPointsSource'] = 'touchPointsSource';
      exprValues[':src'] = meta.source;
    }
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { epicId },
        UpdateExpression: `SET ${updateExpr.join(', ')}`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
      }),
    );
    return { updated: true, storyId, index: idx };
  }

  return {
    getEpicById,
    persistInferenceResult,
    updateStoryStatus,
    persistStoryWorkSummary,
    updateStoryTouchPoints,
  };
}
