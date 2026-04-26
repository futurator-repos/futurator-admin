/**
 * Context-pack resolver — Epic B.2 glue.
 *
 * Bridges the daemon (which has DDB + disk access) to the pure
 * `buildStoryContextPack` assembler. Reads the epic + plan from DDB, picks
 * the current story out of the epic's stories array, and assembles
 * `prevStoriesInWave` from sibling DONE stories in the same wave.
 *
 * Pure-ish: all I/O is parameterised — pass an injectable `ddb` for tests.
 *
 * Contract: never throws. On any failure the caller gets back a stub pack
 * with `meta.failure` populated and a comment-only serialized body — the
 * pipeline still runs, the dev prompt just doesn't get the rich context
 * block this one time.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  buildStoryContextPack,
  serializeStoryContextPack,
  DEFAULT_RUN_COMMAND,
} from './story-context-pack.mjs';

const EPIC_WORKFLOWS_TABLE_DEFAULT = 'futurator-epic-workflows';
const PLANS_TABLE_DEFAULT = 'futurator-plans';

/**
 * Resolve the inputs for a context pack and return its serialized
 * markdown body, ready to drop into `<project_context>` in any prompt.
 *
 * @param {{
 *   ddb: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
 *   job: { jobId: string, workingDir?: string },
 *   variables: Record<string, string>,
 *   epicsTable?: string,
 *   plansTable?: string,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} input
 * @returns {Promise<{ body: string, pack: object | null, failure?: string }>}
 */
export async function resolveAndSerializeContextPack(input) {
  const {
    ddb,
    job,
    variables,
    epicsTable = process.env.EPIC_WORKFLOWS_TABLE || EPIC_WORKFLOWS_TABLE_DEFAULT,
    plansTable = process.env.PLANS_TABLE || PLANS_TABLE_DEFAULT,
    logger,
  } = input;
  const log = logger || { info() {}, warn() {}, error() {} };

  const projectDir = job?.workingDir;
  const storyId = variables?.STORY_ID;
  const epicId = variables?.EPIC_ID;
  if (!projectDir || !storyId) {
    return stubFailure('missing projectDir or STORY_ID variable');
  }
  if (!epicId || epicId === '(not provided)') {
    // Legacy / orchestrator jobs without epic context — fall back to a
    // disk-only pack (no plan, no prev summaries). Still useful for cache
    // stability.
    return runAssembler({
      plan: {},
      story: { storyId, title: '', description: '' },
      prevStoriesInWave: [],
      projectDir,
      waveStartTime: null,
      log,
    });
  }

  let epic = null;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: epicsTable, Key: { epicId } }),
    );
    epic = result?.Item || null;
  } catch (err) {
    log.warn(`context-pack-resolver: failed to read epic ${epicId}: ${err.message}`);
    return stubFailure(`epic read failed: ${err.message}`);
  }
  if (!epic) {
    return stubFailure(`epic ${epicId} not found in ${epicsTable}`);
  }

  const stories = Array.isArray(epic.stories) ? epic.stories : [];
  const story = stories.find((s) => s && s.storyId === storyId);
  if (!story) {
    return stubFailure(`story ${storyId} not in epic ${epicId} stories array`);
  }

  // Sibling DONE stories in the same wave with a captured workSummary —
  // B.6's `prevWorkSummaries` field. When B.6's persistence ships, this
  // populates naturally; until then it's empty (an empty array is fine).
  const wave = typeof story.wave === 'number' ? story.wave : 0;
  const prevStoriesInWave = stories
    .filter(
      (s) =>
        s &&
        s.storyId !== storyId &&
        (typeof s.wave === 'number' ? s.wave : 0) === wave &&
        s.status === 'done' &&
        typeof s.workSummary === 'string' &&
        s.workSummary.length > 0,
    )
    .map((s) => ({
      storyId: s.storyId,
      title: s.title || '',
      workSummary: s.workSummary,
    }));

  // Wave-start time: best signal we have is the wave's earliest story start.
  // Fall back to epic.createdAt so `git log --since=…` always has a bound.
  const waveStartTime =
    earliestWaveStoryStart(stories, wave) ||
    epic.startedAt ||
    epic.createdAt ||
    null;

  let plan = {};
  if (epic.planId && plansTable) {
    try {
      const planResult = await ddb.send(
        new GetCommand({ TableName: plansTable, Key: { planId: epic.planId } }),
      );
      plan = planResult?.Item || {};
    } catch (err) {
      log.warn(`context-pack-resolver: failed to read plan ${epic.planId}: ${err.message}`);
      // Continue with empty plan — the pack is still useful without it.
    }
  }

  return runAssembler({
    plan,
    story,
    prevStoriesInWave,
    projectDir,
    waveStartTime,
    log,
  });
}

async function runAssembler({ plan, story, prevStoriesInWave, projectDir, waveStartTime, log }) {
  try {
    const pack = await buildStoryContextPack({
      plan,
      story,
      prevStoriesInWave,
      projectDir,
      waveStartTime,
      onWarning: (e) => log.info?.(`context-pack: ${e.type}${e.detail ? ' — ' + e.detail : ''}`),
    });
    return { body: serializeStoryContextPack(pack), pack };
  } catch (err) {
    log.warn?.(`context-pack-resolver: assembler threw: ${err.message}`);
    return stubFailure(`assembler error: ${err.message}`);
  }
}

function stubFailure(reason) {
  // Prompt-cache friendly: a minimal placeholder block. Same input → same
  // output. Carries the reason in a comment so the operator can see why
  // the pack was empty when reading the prompt logs.
  const body = [
    '<!-- story-context-pack v1 -->',
    '<!-- assembly skipped: ' + reason + ' -->',
    '',
    '## Run command',
    '```',
    DEFAULT_RUN_COMMAND,
    '```',
    '',
  ].join('\n');
  return { body, pack: null, failure: reason };
}

function earliestWaveStoryStart(stories, wave) {
  let earliest = null;
  for (const s of stories) {
    if (!s) continue;
    const sw = typeof s.wave === 'number' ? s.wave : 0;
    if (sw !== wave) continue;
    const t = s.compilationStartedAt || null;
    if (!t) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest;
}
