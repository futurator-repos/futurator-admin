// story-completion-handler — turn a story-dev run into a graph verdict
// (development-plan §5.5). Pure orchestration over the bound-AC machinery:
//   dev output → parse <BINDING> → bind ACs → run bound tests → completion-gate
//   → StoryNode state + which dependents to unblock.
//
// "Done" is a deterministic function of the graph; this is where it's computed.
// Executors are injected so it unit-tests without running real tests.

import { parseBindingManifest, applyBindings, evaluateCompletion } from './completion-gate.mjs';
import { runStoryBindings } from './test-binding-runner.mjs';

/**
 * @param {{
 *   storyNode: object,            // carries acceptanceCriteria (boundAC[])
 *   devOutput: string,            // the agent's transcript (for the <BINDING> manifest)
 *   headSha: string,              // current merge head (staleness guard)
 *   executors?: object,           // test-binding-runner executors by kind
 *   reviewerVerdicts?: Record<string,'pass'|'fail'>,
 *   needsHuman?: string[],
 *   now?: () => string,
 * }} args
 * @returns {Promise<{
 *   verdict: object,                       // evaluateCompletion result
 *   acceptanceCriteria: object[],          // updated ACs (bound + run)
 *   newState: 'done'|'failed'|'verifying'|'merging',
 *   propagate: boolean,                    // true when done → unblock dependents
 *   bindingSummary: object,
 * }}>}
 */
export async function handleStoryCompletion({
  storyNode, devOutput = '', headSha, executors = {}, reviewerVerdicts = {}, needsHuman = [], now,
}) {
  const authored = storyNode.acceptanceCriteria || [];

  // 1) bind ACs from the agent's <BINDING> manifest (unbound → bound).
  const manifest = parseBindingManifest(devOutput);
  const bound = applyBindings(authored, manifest);

  // 2) run the bound tests deterministically → passing/failing + lastRunSha.
  const { acceptanceCriteria, summary: bindingSummary } = await runStoryBindings({
    acceptanceCriteria: bound, headSha, executors, now,
  });

  // 3) the deterministic completion verdict.
  const verdict = evaluateCompletion({ acceptanceCriteria, currentHeadSha: headSha, reviewerVerdicts, needsHuman });

  // 4) map verdict → StoryNode lifecycle state.
  //    In the shared-tree model the per-story commit IS the integration (no
  //    merge step), so a passing+committed+test-verified story is DONE outright.
  //    failing/blocked/needs-human → failed (fix-forward/retry re-opens).
  const newState = verdict.status === 'done' ? 'done' : 'failed';

  return {
    verdict,
    acceptanceCriteria,
    newState,
    propagate: verdict.status === 'done',
    bindingSummary,
  };
}
