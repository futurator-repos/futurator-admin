// story-job-minter — mint an AgentJob from a claimed StoryNode (development-plan §5.2).
//
// The bridge from the schedule unit (StoryNode) to the execution unit (AgentJob):
// when ready-frontier claims a story, this builds the per-story dev contract
// (scope) and a PENDING `story-dev` job row the poll loop picks up. One AgentJob
// per ready StoryNode.
//
// Pure builders (`buildStoryDevContract`, `buildStoryDevJob`) + a thin
// `mintStoryDevJob` insert, so the scope/shape logic unit-tests without DynamoDB.

import { PutCommand as RealPutCommand } from '@aws-sdk/lib-dynamodb';

// Universally-forbidden globs for ANY user-app dev spawn — independent of story.
// (Per-story precision comes from the union with sibling touches + authored
// forbiddenAreas below; the risk-tier gate catches the rest.)
export const DANGER_PATHS = Object.freeze([
  '**/.git/**', '.env', '.env.*', '**/.env', '**/.env.*',
  '**/.ssh/**', '**/.aws/**', '**/node_modules/**', '**/*.pem',
]);

/**
 * Build a story's dev-scope contract. forbiddenAreas is the union of the story's
 * authored forbidden globs, the universal DANGER_PATHS, and the touches of its
 * concurrently-claimed SIBLINGS (mutual exclusion → ~0 merge collisions).
 *
 * @param {{ storyNode: object, siblingTouches?: string[] }} args
 * @returns {{ allowedPaths: string[], forbiddenAreas: string[] }}
 */
export function buildStoryDevContract({ storyNode, siblingTouches = [] }) {
  const allowedPaths = Array.isArray(storyNode.touches) ? [...storyNode.touches] : [];
  const allowedSet = new Set(allowedPaths);
  const authored = Array.isArray(storyNode.forbiddenAreas) ? storyNode.forbiddenAreas : [];
  // A sibling's touch is forbidden UNLESS it's also ours (overlap stays allowed;
  // the gate's risk + post-diff backstop still cover genuine overlap).
  const siblings = (siblingTouches || []).filter((t) => !allowedSet.has(t));
  const forbiddenAreas = [...new Set([...authored, ...DANGER_PATHS, ...siblings])];
  return { allowedPaths, forbiddenAreas };
}

/**
 * Build a PENDING `story-dev` AgentJob row from a claimed StoryNode. PURE.
 *
 * @param {{
 *   storyNode: object, planId: string, appId: string, workingDir: string,
 *   contract?: { allowedPaths:string[], forbiddenAreas:string[] },
 *   p3Flags?: object, claimToken?: string, jobId: string, now?: string,
 * }} args
 */
export function buildStoryDevJob({ storyNode, planId, appId, workingDir, contract, p3Flags, claimToken, jobId, now }) {
  const ts = now || new Date().toISOString();
  const dev = contract || buildStoryDevContract({ storyNode });
  return {
    jobId,
    status: 'PENDING',
    createdAt: ts,
    updatedAt: ts,
    createdBy: 'ready-frontier',
    jobType: 'story-dev',
    workingDir,
    projectId: appId,
    storyNodeRef: { storyId: storyNode.storyId, planId },
    devContractRef: dev,
    claimToken,
    dependsOn: storyNode.depends_on || [],
    storyState: 'developing',
    p3Flags: p3Flags || undefined,
    storyDevPayload: {
      storyId: storyNode.storyId,
      planId,
      appId,
      title: storyNode.title,
      intent: storyNode.intent || '',
      complexity: storyNode.complexity || 'standard',
      acceptanceCriteria: storyNode.acceptanceCriteria || [],
      touches: dev.allowedPaths,
      forbiddenAreas: dev.forbiddenAreas,
      specShardRef: storyNode.specShardRef,
    },
  };
}

/** Insert the minted job row. Returns the row. */
export async function mintStoryDevJob({ ddb, table, row, PutCommand = RealPutCommand }) {
  await ddb.send(new PutCommand({ TableName: table, Item: row }));
  return row;
}
