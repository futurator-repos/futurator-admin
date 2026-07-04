/**
 * seam-mount-check.mjs — pacman4 early seam-mount gate (QA-owned, dev-pipeline).
 *
 * THE BUG THIS CLOSES: the dev pipeline kept shipping apps where the game was
 * never wired — the verifiability seam hook (e.g. `useGameStateMachine`) ships in
 * the scaffold but no feature ever IMPORTS/CALLS it, so `window.__harness` never
 * publishes (a "static preview, not the live app"). Today QA only catches this at
 * FINAL QA (my DV-2 `SEAM_NEVER_PUBLISHED`) — 5+ hours and a full pipeline later.
 * This runs the SAME static check EARLY (at the wave/plan-ready gate) so an unwired
 * app is blocked the moment it's assembled, not at the end.
 *
 * CRITICAL CORRECTNESS — the two-stage grep (mirrors `visual-qa-pipeline.ts:545`):
 * a naive `grep -rl <hook> src` FALSE-PASSES, because the scaffold itself DEFINES
 * the hook (that file always matches). We must:
 *   1. find files that REFERENCE the hook, then
 *   2. DROP the file that EXPORTS/DEFINES it (`export function|const <hook>`),
 * leaving only files that genuinely IMPORT/USE it. Empty ⇒ seam not mounted.
 *
 * Pure logic + a thin fs/exec wrapper (injectable for tests).
 */

import { execSync } from 'node:child_process';

/**
 * Decide, from the two grep result lists, whether the seam is mounted.
 *  - `referencing`: files under src/ that mention the hook (stage 1).
 *  - `definitionOnly`: of those, the file(s) that EXPORT/DEFINE the hook (stage 2).
 * The seam is mounted iff some referencing file is NOT a definition file.
 * Pure — unit-tested without a filesystem.
 */
export function isSeamMounted(referencing, definitionOnly) {
  const refs = (referencing || []).map((s) => s.trim()).filter(Boolean);
  const defs = new Set((definitionOnly || []).map((s) => s.trim()).filter(Boolean));
  const importers = refs.filter((f) => !defs.has(f));
  return { mounted: importers.length > 0, importers };
}

/**
 * Run the seam-mount check against an app's `src/` on disk.
 *
 * @param {object} args
 * @param {string} args.projectDir   absolute path whose `src/` is grepped
 * @param {string} args.seamHook     hook symbol to require (from the gate-registry
 *                                    snapshot: `testHarness.seamHook`, per boilerplate)
 * @param {(cmd: string) => string} [args.exec]  exec impl (injected in tests)
 * @returns {{ checked: boolean, mounted: boolean, importers: string[], reason: string }}
 *   `checked:false` when there's no seam hook to require (non-seam boilerplate) —
 *   the caller must treat that as "not applicable", never as a block.
 */
export function checkSeamMounted({ projectDir, seamHook, exec }) {
  if (!seamHook) {
    return { checked: false, mounted: true, importers: [], reason: 'boilerplate declares no seam hook — N/A' };
  }
  const run = exec || ((cmd) => execSync(cmd, { cwd: projectDir, encoding: 'utf8' }));
  // `|| true` so a no-match (grep exit 1) doesn't throw; word-boundary match.
  const refOut = safe(() => run(`grep -rlE "\\b${seamHook}\\b" src 2>/dev/null || true`));
  const referencing = splitLines(refOut);
  if (referencing.length === 0) {
    return {
      checked: true,
      mounted: false,
      // `defined:false` — the hook is not in this tree AT ALL (non-scaffold app,
      // synthetic fixture). W2's QA runner treats this as N/A rather than a
      // wiring block: the runtime probe already covers "no seam" honestly.
      defined: false,
      importers: [],
      reason: `no source file references ${seamHook} — the verifiability seam ships in the scaffold but no feature mounts it (static preview, not the live app). Build the feature that imports and calls ${seamHook}.`,
    };
  }
  // Of the referencing files, which only DEFINE/EXPORT the hook (the scaffold).
  const defOut = safe(() =>
    run(`grep -rlE "export (function|const) ${seamHook}" src 2>/dev/null || true`),
  );
  const definitionOnly = splitLines(defOut);
  const { mounted, importers } = isSeamMounted(referencing, definitionOnly);
  return {
    checked: true,
    mounted,
    defined: true,
    importers,
    reason: mounted
      ? `${seamHook} is imported/used by ${importers.length} feature file(s): ${importers.join(', ')}`
      : `${seamHook} is only DEFINED in the scaffold, never imported by a feature — the game is not wired (static preview). Build the feature that calls ${seamHook}.`,
  };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return '';
  }
}
function splitLines(out) {
  return String(out || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
