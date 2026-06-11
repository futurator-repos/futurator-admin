/**
 * wave-merge.mjs — Pipeline v2 Phase 2-B / Story 2-B-3-1 (PR-95).
 *
 * Helper module for the v2.5 §26 wave-merge flow. Stories collect on
 * `wip/<storyId>` branches; wave-merge is where they integrate into a
 * single new HEAD on the wave base.
 *
 *   1. Establish merge target — wave-base (first wave: main; later
 *      waves: prior wave's merge SHA).
 *   2. Per story: `git merge --no-ff wip/<storyId> -m '<commit-msg>'`.
 *      No-ff preserves story identity in the graph.
 *   3. Re-run full test suite against the merged state.
 *   4a. Green → push to origin, archive `wip/` branches.
 *   4b. Red → reset HEAD, emit `wave-build-failed` or `merge-conflict`
 *       attention item, mark wave `fixing`.
 *
 * The merge orchestration calls into the daemon's existing exec/spawn
 * surface — this module is the pure logic + the commit-message builder.
 */

import { buildCommitMetadataFlags, quoteFlagsForShell } from '../pipelines/lib/commit-metadata.mjs';

/**
 * Build the `git merge --no-ff` command for one story's wave merge.
 * Returns the shell command string + the metadata flags (for caller's
 * forensic log / dry-run).
 *
 * @param {{
 *   storyId: string,
 *   waveBaseRef: string,        // commit-ish to merge into
 *   storyBranch?: string,       // defaults to wip/<storyId>
 *   planId?: string,
 *   plan?: string,
 *   wave?: string | number,
 *   epicId?: string,
 * }} args
 * @returns {{ command: string, flagBodies: string[] }}
 */
export function buildWaveMergeCommand(args) {
  if (!args.storyId) throw new Error('wave-merge: storyId required');
  const storyBranch = args.storyBranch || `wip/${args.storyId}`;
  const subject = `merge story ${args.storyId} into wave`;

  const flagBodies = buildCommitMetadataFlags({
    agent: 'WAVE-MERGE',
    planId: args.planId,
    plan: args.plan,
    epicId: args.epicId,
    wave: args.wave,
    story: args.storyId,
  });

  const flags = ['-m', `'${subject}'`, ...quoteFlagsForShell(flagBodies).flatMap((b) => ['-m', b])];

  return {
    command: `git merge --no-ff ${storyBranch} ${flags.join(' ')}`,
    flagBodies: [subject, ...flagBodies],
  };
}

/**
 * Classify the outcome of a wave merge based on the merge exit code +
 * the post-merge test-run exit code.
 *
 * @param {{ mergeExit: number, testExit?: number }} args
 * @returns {{
 *   outcome: 'success' | 'merge-conflict' | 'wave-build-failed',
 *   attentionCategory?: string,
 *   reason: string,
 * }}
 */
export function classifyWaveMergeOutcome({ mergeExit, testExit }) {
  if (mergeExit !== 0) {
    return {
      outcome: 'merge-conflict',
      attentionCategory: 'merge-conflict',
      reason: `git merge exit ${mergeExit} — operator resolves conflicts manually`,
    };
  }
  if (typeof testExit === 'number' && testExit !== 0) {
    return {
      outcome: 'wave-build-failed',
      attentionCategory: 'wave-build-failed',
      reason: `tests failed against merged state (exit ${testExit})`,
    };
  }
  return { outcome: 'success', reason: 'merge clean + tests green' };
}

/**
 * Build the conflict-resolver attention item shape. The daemon writes
 * this when classify returns `merge-conflict`. v2.5 §26 — Tier 1 falls
 * through to operator (PR-40 confirmed).
 */
export function buildMergeConflictAttention({
  planId,
  storyIds,
  conflictedFiles,
}) {
  return {
    severity: 'high',
    category: 'merge-conflict',
    title: `Wave merge conflict in plan ${planId}`,
    body:
      `Conflicted files (${conflictedFiles.length}):\n` +
      conflictedFiles.map((f) => `  • ${f}`).join('\n') +
      `\n\nStories in wave (${storyIds.length}):\n` +
      storyIds.map((s) => `  • ${s}`).join('\n') +
      `\n\nResolve conflicts on the merge HEAD, then mark wave merged manually.`,
    actions: ['resolve-manually', 'reset-wave'],
    context: { planId, storyIds, conflictedFiles },
  };
}

/**
 * Build the wave-build-failed attention item shape (tests failed after
 * a clean merge).
 */
export function buildWaveBuildFailedAttention({
  planId,
  storyIds,
  testExit,
  failingTests = [],
  // pacman1 (2026-06-11) — tail of the validation command's output. When
  // the failure is a compile/typecheck error (no failing TESTS at all),
  // "No failing test list captured." told the operator nothing; the actual
  // error was only in the daemon log. Surface it in the card body.
  outputTail = '',
}) {
  const failHead = failingTests.slice(0, 5);
  const moreCount = Math.max(0, failingTests.length - 5);
  return {
    severity: 'high',
    category: 'wave-build-failed',
    title: `Wave build failed in plan ${planId} (test exit ${testExit})`,
    body:
      `Stories in wave: ${storyIds.join(', ')}\n` +
      (failingTests.length > 0
        ? `Top failing tests:\n${failHead.map((t) => `  • ${t}`).join('\n')}` +
          (moreCount > 0 ? `\n  …and ${moreCount} more` : '')
        : 'No failing tests — the BUILD itself failed (compile/typecheck).') +
      (outputTail ? `\n\nValidation output (tail):\n${outputTail}` : ''),
    actions: ['mark-wave-fixing', 'reset-wave', 'inspect-logs'],
    context: { planId, storyIds, testExit, failingTests },
  };
}

/**
 * Pure helper: derive the wave-base ref for a given wave index. First
 * wave merges into `main`; subsequent waves merge into the previous
 * wave's merge-commit SHA.
 */
export function waveBaseRef({ waveIndex, previousWaveSha }) {
  if (waveIndex === 0) return 'main';
  if (!previousWaveSha) {
    throw new Error(`wave-merge: wave ${waveIndex} needs previousWaveSha (only wave 0 merges into main)`);
  }
  return previousWaveSha;
}

/**
 * Branch names to delete after successful wave merge — the wip/<storyId>
 * branches don't need to survive past their merge commit.
 */
export function postMergeCleanupBranches(storyIds) {
  return storyIds.map((s) => `wip/${s}`);
}
