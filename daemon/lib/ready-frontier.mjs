// ready-frontier — continuous Kahn dispatch (development-plan §5.2, lever 3).
//
// Replaces the fixed wave barrier (a cron/WaveCompletionCheck tick that idles
// 2–5 min between waves) with eager dispatch: the instant a story's deps are all
// `done`, it's claimable. This module is the decision layer that sits between the
// daemon's PENDING query and its spawn loop, gated by P3_READY_FRONTIER:
//   • shadow → compute what it WOULD dispatch, log the diff vs legacy waves,
//     change nothing (the A/B safety net before going live)
//   • on     → atomically claim each ready story and enqueue a dev job
//
// Pure where it can be: `computeReadyFrontier` is a thin pass to story-graph;
// the dispatch wrapper injects ddb + an enqueue fn + a token maker so it unit-
// tests without real infrastructure.

import { readyFrontier, isStoryDispatchable } from './story-graph.mjs';
import { claimStory } from './atomic-claim.mjs';

export { readyFrontier as computeReadyFrontier, isStoryDispatchable };

/** Default claim-token maker. Daemon code may use time+random freely. */
function defaultMakeToken(owner) {
  return `${owner}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Dispatch (or shadow-dispatch) the ready frontier of a plan.
 *
 * @param {{
 *   nodes: Array<{storyId,depends_on,state}>,  // the plan's live StoryNodes
 *   mode: 'shadow'|'on'|'off',
 *   ddb?, table?,                               // required when mode==='on'
 *   owner?: string,                             // claim owner (this daemon)
 *   enqueue?: (story) => Promise<void>,         // mint an AgentJob for a claimed story
 *   capacity?: number,                          // max to claim this tick (slot budget)
 *   now?: number, makeToken?: (owner)=>string,
 *   log?: (level, msg) => void,
 * }} args
 * @returns {Promise<{ frontier: string[], dispatched: string[], lost: string[], shadow: boolean }>}
 */
export async function dispatchReadyFrontier(args) {
  const {
    nodes = [], mode = 'off', ddb, table, owner = 'daemon',
    enqueue, capacity = Infinity, now = Date.now(),
    makeToken = defaultMakeToken, log = () => {},
  } = args;

  const frontier = readyFrontier(nodes);
  if (mode === 'off') return { frontier, dispatched: [], lost: [], shadow: false };

  if (mode === 'shadow') {
    log('info', `[ready-frontier] shadow: would dispatch ${frontier.length} ready stories [${frontier.join(', ')}]`);
    return { frontier, dispatched: [], lost: [], shadow: true };
  }

  // mode === 'on'
  const byId = new Map(nodes.map((n) => [n.storyId, n]));
  const dispatched = [];
  const lost = [];
  let claimedCount = 0;
  for (const storyId of frontier) {
    if (claimedCount >= capacity) break; // respect the caller's slot budget (parallelism preserved, just paced)
    const token = makeToken(owner);
    const res = await claimStory({ ddb, table, storyId, owner, token, now });
    if (!res.claimed) { lost.push(storyId); continue; }
    claimedCount += 1;
    try {
      if (enqueue) await enqueue({ ...byId.get(storyId), claimToken: token, claimOwner: owner });
      dispatched.push(storyId);
    } catch (err) {
      log('warn', `[ready-frontier] enqueue failed for ${storyId}: ${err?.message || err}`);
      // claimed but not enqueued — the lease will expire and another tick reclaims.
      lost.push(storyId);
    }
  }
  return { frontier, dispatched, lost, shadow: false };
}
