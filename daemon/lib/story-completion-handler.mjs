// story-completion-handler — turn a story-dev run into a graph verdict
// (development-plan §5.5). Pure orchestration over the bound-AC machinery:
//   dev output → parse <BINDING> → bind ACs → run bound tests → completion-gate
//   → StoryNode state + which dependents to unblock.
//
// "Done" is a deterministic function of the graph; this is where it's computed.
// Executors are injected so it unit-tests without running real tests.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { parseBindingManifest, parseInvariantManifest, applyBindings, evaluateCompletion } from './completion-gate.mjs';
import { runStoryBindings, runStoryInvariants, makeInvariantExecutor } from './test-binding-runner.mjs';
import { computeQualityInput } from './quality-input.mjs';
import { evaluateQualityGate } from './quality-gate.mjs';
import { shouldReview, parseReviewerVerdict } from './story-reviewer.mjs';

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
  // Spine no-mock rule + invariant gate. `cwd` is the worktree root (bound files
  // read relative to it); `invariants` are the story's DECLARED invariants (the
  // planner's properties); `agentText` carries the <INVARIANTS> manifest (defaults
  // to devOutput). `readFile`/`invariantExecutor`/`spawnSync` are injectable for tests.
  cwd, invariants = [], agentText, readFile, invariantExecutor, spawnSync = nodeSpawnSync,
  // W2.1 — P3_QUALITY_GATE ('off'|'shadow'|'on'). When !== 'off', compute the
  // PASS/CONCERNS/FAIL/WAIVED verdict and attach it ADDITIVELY. It never changes
  // newState/propagate (the authoritative deterministic completion-gate rules);
  // it's an observability + future-reviewer signal.
  qualityMode = 'off',
  // W2.1b — risk-tiered reviewer spawn: async ({acceptanceCriteria, headSha}) =>
  // { verdicts:{acId:'pass'|'fail'}, needsHuman:[] } (or { text }). Absent → skip.
  spawnReviewer,
}) {
  const authored = storyNode.acceptanceCriteria || [];

  // 1) bind ACs from the agent's <BINDING> manifest (unbound → bound).
  const manifest = parseBindingManifest(devOutput);
  const bound = applyBindings(authored, manifest);

  // 2) run the bound tests deterministically → passing/failing + lastRunSha.
  //    Threads the no-mock rule (verify:'state' unit/integration ACs may not mock
  //    the in-repo module under test → status:'misbound').
  const { acceptanceCriteria, summary: bindingSummary } = await runStoryBindings({
    acceptanceCriteria: bound, headSha, executors, now, cwd, enforceNoMock: true,
    ...(readFile ? { readFile } : {}),
  });

  // 2b) invariant validators (redesign Part 4). Parse the <INVARIANTS> manifest to
  //     bind each declared invariant to its authored validator (declared→authored),
  //     then run them. Unauthored/mocked/failing invariants block completion.
  let ranInvariants = [];
  if (Array.isArray(invariants) && invariants.length) {
    const invManifest = parseInvariantManifest(agentText != null ? agentText : devOutput);
    const authoredInvariants = invariants.map((inv) => {
      const m = invManifest[inv.id];
      if (!m || !m.ref) return inv;
      return {
        ...inv,
        validator: { ...(inv.validator || {}), ref: m.ref, kind: m.kind || inv.validator?.kind, status: 'authored' },
      };
    });
    const invResult = await runStoryInvariants({
      invariants: authoredInvariants,
      headSha,
      // cwd threads through for the no-mock source read — a relative validator
      // ref read against the daemon's cwd is always ENOENT ("unreadable —
      // fail-closed"), which failed every invariant-carrying story on all
      // attempts (pacman1, 2026-07-13). The executor was already cwd-bound.
      cwd,
      executor: invariantExecutor || makeInvariantExecutor({ cwd, spawnSync }),
      now,
      ...(readFile ? { readFile } : {}),
    });
    ranInvariants = invResult.invariants;
  }

  // W2.1 — the quality verdict (also decides whether a reviewer is warranted).
  let qualityVerdict;
  if (qualityMode && qualityMode !== 'off') {
    try { qualityVerdict = evaluateQualityGate(computeQualityInput(acceptanceCriteria)); }
    catch { qualityVerdict = undefined; }
  }

  // W2.1b — risk-tiered reviewer. Runs in a FRESH context and is ADVISORY. We
  // only FEED its verdict into the deterministic gate when qualityMode==='on'
  // (in 'shadow' we may compute the quality verdict but the completion stays
  // byte-identical). Absent spawnReviewer / not-high-risk → no-op.
  let effReviewerVerdicts = reviewerVerdicts;
  let effNeedsHuman = needsHuman;
  if (qualityMode === 'on' && typeof spawnReviewer === 'function' && shouldReview(acceptanceCriteria, qualityVerdict)) {
    try {
      const rv = await spawnReviewer({ acceptanceCriteria, headSha });
      const parsed = rv && rv.verdicts ? rv : parseReviewerVerdict(rv?.text || '');
      if (parsed.verdicts) effReviewerVerdicts = { ...reviewerVerdicts, ...parsed.verdicts };
      if (Array.isArray(parsed.needsHuman)) effNeedsHuman = [...needsHuman, ...parsed.needsHuman];
    } catch { /* reviewer failure is non-blocking → keep the original (empty) verdicts */ }
  }

  // 3) the deterministic completion verdict.
  const verdict = evaluateCompletion({ acceptanceCriteria, currentHeadSha: headSha, reviewerVerdicts: effReviewerVerdicts, needsHuman: effNeedsHuman, invariants: ranInvariants });

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
    ...(ranInvariants.length ? { invariants: ranInvariants } : {}),
    ...(qualityVerdict ? { qualityVerdict } : {}),
  };
}
