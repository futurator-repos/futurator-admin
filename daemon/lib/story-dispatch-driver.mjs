// story-dispatch-driver — the one call site the daemon needs for ready-frontier
// dispatch (development-plan §5.2). Keeps the agent-daemon.mjs edit to a single
// function call, gated by P3_READY_FRONTIER, so it composes with the concurrent
// workstreams on that hot file instead of threading logic through it.
//
// Responsibilities:
//   • load a plan's StoryNode rows (GSI planId-cohortBatch-index)
//   • run one dispatch tick (shadow logs would-dispatch; on claims+enqueues)
//   • on a story finishing, decrement+unblock its dependents (event-driven Kahn)
//
// All DDB access is injected (loadNodes / ddb), so this unit-tests without infra.

import { QueryCommand as RealQueryCommand } from '@aws-sdk/lib-dynamodb';
import { flagMode } from './pipeline-flags.mjs';
import { dispatchReadyFrontier } from './ready-frontier.mjs';
import { recordDependencyDone } from './atomic-claim.mjs';

const PLAN_BATCH_INDEX = 'planId-cohortBatch-index';

/** Default loader: page the plan's StoryNodes off the cohortBatch GSI. */
async function defaultLoadNodes({ ddb, table, planId, QueryCommand = RealQueryCommand }) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: PLAN_BATCH_INDEX,
      KeyConditionExpression: 'planId = :p',
      ExpressionAttributeValues: { ':p': planId },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * Run one frontier dispatch tick for a plan. Reads P3_READY_FRONTIER off the
 * resolved flags (off → no-op returning the frontier; shadow → log only; on →
 * claim+enqueue). Maps StoryNode rows (which carry `storyState`) into the
 * `{state}` shape story-graph expects.
 *
 * @returns {Promise<{ mode:string, frontier:string[], dispatched:string[], lost:string[] }>}
 */
export async function runFrontierTick({
  ddb, table, planId, p3Flags, owner = 'daemon', capacity = Infinity,
  enqueue, loadNodes = defaultLoadNodes, log = () => {}, now,
}) {
  const mode = flagMode(p3Flags, 'P3_READY_FRONTIER'); // off | shadow | on
  if (mode === 'off') return { mode, frontier: [], dispatched: [], lost: [] };

  const rows = await loadNodes({ ddb, table, planId });
  const nodes = rows.map((r) => ({ storyId: r.storyId, depends_on: r.depends_on || [], state: r.state || r.storyState }));

  const res = await dispatchReadyFrontier({ nodes, mode, ddb, table, owner, capacity, enqueue, now, log });
  return { mode, frontier: res.frontier, dispatched: res.dispatched, lost: res.lost };
}

/**
 * Propagate a story's completion: decrement each dependent's unblockedDepsCount
 * and flip it to ready at zero. The dependents are every StoryNode listing
 * `completedStoryId` in its depends_on. Returns the storyIds newly unblocked.
 */
export async function propagateCompletion({ ddb, table, completedStoryId, dependents, now }) {
  const unblocked = [];
  for (const dep of dependents || []) {
    const res = await recordDependencyDone({ ddb, table, storyId: dep, now });
    if (res.unblocked) unblocked.push(dep);
  }
  return { unblocked };
}

/** Find the dependents of a story within a loaded node set (pure helper). */
export function dependentsOf(nodes, completedStoryId) {
  return nodes.filter((n) => (n.depends_on || []).includes(completedStoryId)).map((n) => n.storyId);
}
