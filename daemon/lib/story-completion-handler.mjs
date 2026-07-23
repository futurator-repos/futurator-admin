// story-completion-handler — turn a story-dev run into a graph verdict
// (development-plan §5.5). Pure orchestration over the bound-AC machinery:
//   dev output → parse <BINDING> → bind ACs → run bound tests → completion-gate
//   → StoryNode state + which dependents to unblock.
//
// "Done" is a deterministic function of the graph; this is where it's computed.
// Executors are injected so it unit-tests without running real tests.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { parseBindingManifest, parseInvariantManifest, applyBindings, evaluateCompletion } from './completion-gate.mjs';
import { runStoryBindings, runStoryInvariants, makeInvariantExecutor } from './test-binding-runner.mjs';
import { computeQualityInput } from './quality-input.mjs';
import { evaluateQualityGate } from './quality-gate.mjs';
import { shouldReview, parseReviewerVerdict } from './story-reviewer.mjs';

// Directories the convention search never descends into (vendored/derived trees
// can be huge and can never legitimately hold a story-authored validator).
const REBIND_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

/**
 * Deterministic convention rebind (dossier A1): locate a COMMITTED validator
 * file for a declared invariant by the naming the test-author prompt MANDATES —
 * `<invariantId>.invariant.test.*` anywhere in the tree (the prompt's
 * double-star glob; spelled out here because `*` + `/` ends a block comment).
 * Used only when BOTH the parsed
 * <INVARIANTS> manifest AND the persisted validator lack a ref (a resumed job
 * has bindingOutput='' → manifest {}), so a green-coded story is not
 * deterministically dead-ended on retry. Existence in the worktree is enough —
 * the executor runs the file FROM the worktree, so a stale/uncommitted path
 * simply fails the run (fail-closed, never fail-open). PURE over the injected
 * fs (default node:fs); returns a cwd-relative posix path or null.
 *
 * UNIQUENESS GUARD: parseQuickPlanspec namespaces ids `<storyId>-<slug>` so two
 * stories can no longer share an id, but plans minted BEFORE that fix (and any
 * hand-authored rows) may still collide. A rebind must NEVER bind an id to the
 * wrong story's file, so when MORE THAN ONE file in the tree matches the id the
 * search returns null — ambiguous → stays 'declared' → the runner fails it
 * closed, exactly like "not found". This costs a full (depth/skip-bounded) walk
 * instead of a first-hit return; acceptable for the rare resume-only path.
 *
 * @param {{ cwd: string, invariantId: string, fs?: object, maxDepth?: number }} args
 * @returns {string|null}
 */
export function findInvariantValidatorByConvention({ cwd, invariantId, fs = nodeFs, maxDepth = 10 }) {
  if (!cwd || !invariantId) return null;
  const prefix = `${invariantId}.invariant.test.`;
  const matches = [];
  const walk = (relDir, depth) => {
    if (depth > maxDepth || matches.length > 1) return;
    let entries;
    try {
      entries = fs.readdirSync(relDir ? join(cwd, relDir) : cwd, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never throw into the gate
    }
    for (const e of entries) {
      if (e.isFile?.() && e.name.startsWith(prefix)) {
        matches.push(relDir ? `${relDir}/${e.name}` : e.name);
        if (matches.length > 1) return; // ambiguous — no need to keep walking
      }
    }
    for (const e of entries) {
      if (!e.isDirectory?.()) continue;
      if (e.name.startsWith('.') || REBIND_SKIP_DIRS.has(e.name)) continue;
      walk(relDir ? `${relDir}/${e.name}` : e.name, depth + 1);
      if (matches.length > 1) return;
    }
  };
  walk('', 0);
  return matches.length === 1 ? matches[0] : null;
}

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
 *   newState: 'done'|'needs-human'|'failed'|'verifying'|'merging',
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
  // Incident D — the story's `touches` (the module(s) UNDER TEST). Threaded into
  // runStoryBindings so the no-mock rule flags ONLY a mock of the module under
  // test (sibling impl or a `touches` path), not a legitimate dependency mock.
  // NOT passed to runStoryInvariants — the invariant gate stays strict (an
  // invariant asserting real foundation data must never mock any in-repo module).
  touches = [],
  // Injected fs for the deterministic convention rebind (default node:fs).
  fs = nodeFs,
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
    acceptanceCriteria: bound, headSha, executors, now, cwd, enforceNoMock: true, touches,
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
      if (m && m.ref) {
        return {
          ...inv,
          validator: { ...(inv.validator || {}), ref: m.ref, kind: m.kind || inv.validator?.kind, status: 'authored' },
        };
      }
      // CONVENTION FALLBACK (dossier A1): no manifest entry AND no persisted
      // validator ref — the exact state every resumed/retried job lands in
      // (bindingOutput='' → manifest {}). The test-author prompt MANDATES
      // `**/<id>.invariant.test.*` naming, so a committed file matching the id
      // is a deterministic rebind (no LLM). Not found → stays declared and the
      // runner fails it closed exactly as before.
      if (!inv.validator?.ref && cwd) {
        const ref = findInvariantValidatorByConvention({ cwd, invariantId: inv.id, fs });
        if (ref) {
          return {
            ...inv,
            validator: { ...(inv.validator || {}), ref, kind: 'test', status: 'authored' },
          };
        }
      }
      return inv;
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
  // B1+A5: only review an attempt whose deterministic binding summary is clean —
  // a reviewer over an already-failing attempt is pure waste (the verdict is
  // failing regardless, and the fix-forward retry re-reviews if it goes green).
  if (
    qualityMode === 'on'
    && typeof spawnReviewer === 'function'
    && bindingSummary.failed === 0
    && shouldReview(acceptanceCriteria, qualityVerdict)
  ) {
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
  //    D-fix-3 (quarantine, don't wedge): a 'needs-human' verdict — the story's
  //    ONLY outstanding failure is a browser/behavior AC that RAN and failed a
  //    snapshot assertion (D-fix-2; a candidate interaction-gated VQA false-
  //    negative) — is NOT a hard failure. It maps to a DISTINCT, non-terminal,
  //    operator-actionable 'needs-human' state (NOT 'failed'): the story must not
  //    cascade-block its dependents (they keep their unblockedDepsCount and wait)
  //    and the plan must not advance to review as if it failed — it surfaces for
  //    the operator's Accept lane. Everything else genuinely failing/blocked →
  //    'failed' (fix-forward/retry re-opens). Keys ONLY on verdict.status — no
  //    app/story/content literal. `propagate` stays gated on 'done' below, so a
  //    quarantined story never auto-unblocks a dependent.
  const newState = verdict.status === 'done'
    ? 'done'
    : verdict.status === 'needs-human'
      ? 'needs-human'
      : 'failed';

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
