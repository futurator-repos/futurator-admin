// Pipeline v2.0 efficiency fix T0.2 — daemon-side pre-DEV gate.
//
// Combines two deterministic bash/code signals to decide whether the DEV
// agent needs to run at all for a given story. When both are green, the
// daemon flips the job to COMPLETED_VIA_PREWORK without spawning the LLM.
// dino1 forensic projects this would have eliminated 7 of 9 DEV spawns
// (~$10–15 saved per Plan against pre-scaffolded boilerplates).
//
//   Signal 1 — recent commits in scope
//     `git log --since=<plan-start> -- <touchPoints>` returns ≥1 commit.
//     Reuses collectRecentTouchPointWork from prework-check.mjs (already
//     shipped per v1 dev-correction Epic D.5).
//
//   Signal 2 — project still type-checks clean
//     runCachedTypecheck (cached-tsc.mjs). Cached on git SHA so siblings
//     in the same wave don't re-run. This is the AUTHORITATIVE, AST-grounded
//     check: a clean whole-project typecheck already proves every declared
//     export resolves through the real import graph.
//
// Root-cause remediation D2-1 (2026-06-22): the former Signal 2 — an
// AC-prose export-name heuristic (extractCandidateExports / checkExportsPresent)
// — was deleted. It mined identifiers from prose with regex and string-matched
// them against raw file text, never against the resolved import graph, so it
// produced misleading "candidate export not found" noise (e.g. `drawOverlays`
// for a file that exports `drawTitleScreen…`). The typecheck below subsumes it
// correctly. See docs/concepts/pipeline-v3/root-cause-remediation-plan.md §D2.
//
// Pure orchestrator — no DDB, no spawn. Caller decides what to do with the
// verdict (the wiring lives in agent-daemon.mjs::executePipeline).

import { collectRecentTouchPointWork } from '../pipelines/lib/prework-check.mjs';
import { runCachedTypecheck } from './cached-tsc.mjs';

/**
 * Run the two signals and return a structured verdict.
 *
 * @param {object} input
 * @param {string} input.projectDir
 * @param {string|null|undefined} input.planStartTime - ISO; passed to git log --since
 * @param {string[]} input.touchPoints
 * @param {string} [input.acText] - DEPRECATED/unused since D2-1 (kept for caller
 *   compatibility; the export-name heuristic that consumed it was deleted).
 * @param {string} [input.runCommand] - typecheck command
 * @param {boolean} [input.skipTypecheck] - tests only; bypass tsc signal
 * @param {object} [input.deps] - injectable for tests
 * @returns {Promise<{
 *   shouldSpawnDev: boolean,
 *   reason: string,
 *   evidence: {
 *     recentCommits: { sha: string, subject: string, files: string[] }[],
 *     typecheck: { ok: boolean, cached: boolean, output: string },
 *   },
 * }>}
 */
export async function evaluatePreworkGate(input) {
  const {
    projectDir,
    planStartTime,
    touchPoints,
    runCommand,
    skipTypecheck = false,
    deps = {},
  } = input || {};

  if (!projectDir) {
    return verdict(true, 'gate-skipped: projectDir missing', emptyEvidence());
  }
  if (!Array.isArray(touchPoints) || touchPoints.length === 0) {
    return verdict(true, 'gate-skipped: no touchPoints declared', emptyEvidence());
  }

  // ── Signal 1: recent commits in scope ──
  const commitReport = (deps.collectRecentTouchPointWork || collectRecentTouchPointWork)({
    projectDir,
    sinceTime: planStartTime || null,
    touchPoints,
  });

  const recentCommits = commitReport?.skipped ? [] : commitReport.commits || [];
  const evidence = {
    recentCommits,
    typecheck: { ok: false, cached: false, output: '' },
  };

  if (recentCommits.length === 0) {
    return verdict(true, 'gate-failed: no recent commits touching touchPoints', evidence);
  }

  // ── Signal 2: project type-checks clean (authoritative AST check) ──
  if (skipTypecheck) {
    evidence.typecheck = { ok: true, cached: false, output: '(skipped per input)' };
  } else {
    const tc = await (deps.runCachedTypecheck || runCachedTypecheck)({
      projectDir,
      runCommand,
    });
    evidence.typecheck = { ok: tc.ok, cached: tc.cached, output: tc.output };
    if (!tc.ok) {
      return verdict(true, 'gate-failed: typecheck not clean', evidence);
    }
  }

  // Both signals green.
  return verdict(
    false,
    `gate-passed: ${recentCommits.length} commit(s), tsc clean${evidence.typecheck.cached ? ' (cached)' : ''}`,
    evidence,
  );
}

/**
 * Render the gate's evidence as a markdown block suitable for writing to
 * `<projectDir>/.context/wave-N-story-<id>.md` so a *running* DEV agent (when
 * the gate fails) can see what the daemon already established. The agent
 * gains context without paying for re-discovery.
 *
 * @param {ReturnType<typeof evaluatePreworkGate> extends Promise<infer V> ? V : never} verdictObj
 * @param {string} storyId
 */
export function renderGateEvidence(verdictObj, storyId) {
  if (!verdictObj?.evidence) return '';
  const ev = verdictObj.evidence;
  const lines = [];
  lines.push(`<!-- prework-gate evidence — story ${storyId || 'unknown'} -->`);
  lines.push(`Verdict: ${verdictObj.shouldSpawnDev ? 'spawn-dev' : 'skip-dev'}`);
  lines.push(`Reason: ${verdictObj.reason}`);
  lines.push('');

  if (ev.recentCommits.length > 0) {
    lines.push('## Recent commits in scope');
    for (const c of ev.recentCommits) {
      lines.push(`- ${c.sha} — ${c.subject}`);
      for (const f of c.files) lines.push(`  - ${f}`);
    }
    lines.push('');
  }

  if (ev.typecheck.output || typeof ev.typecheck.ok === 'boolean') {
    lines.push('## Typecheck');
    lines.push(`OK: ${ev.typecheck.ok}${ev.typecheck.cached ? ' (cached)' : ''}`);
    if (!ev.typecheck.ok && ev.typecheck.output) {
      lines.push('```');
      lines.push(ev.typecheck.output.slice(0, 2000));
      lines.push('```');
    }
  }

  return lines.join('\n').trimEnd();
}

// ── internals ────────────────────────────────────────────────────────────

function verdict(shouldSpawnDev, reason, evidence) {
  return { shouldSpawnDev, reason, evidence };
}

function emptyEvidence() {
  return {
    recentCommits: [],
    typecheck: { ok: false, cached: false, output: '' },
  };
}
