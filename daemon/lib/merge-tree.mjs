// merge-tree — predictive conflict detection BEFORE a real merge (development-plan §5.2).
//
// ecc2's move: `git merge-tree --write-tree` performs a merge in memory against
// the object store without touching the working tree or creating a commit. We run
// it at the integrate gate to predict whether a story's branch will conflict with
// the current integration head — so a dirty merge is queued/serialized instead of
// blowing up mid-merge (a major source of the index.md write race + compile thrash).
//
// Pure parser (`parseMergeTreeOutput`) + async runner (`predictConflicts`) with an
// injectable exec for tests. Fail-safe: if the prediction itself errors, report
// `unknown` (caller falls back to attempting the merge, never silently skips).

import { spawnSync as nodeSpawnSync } from 'node:child_process';

/**
 * Parse `git merge-tree --write-tree --name-only` output.
 *   • exit 0           → clean merge; line 0 is the resulting tree OID.
 *   • exit 1           → conflicts; line 0 = tree OID, remaining lines = paths.
 *   • other / no output→ unknown (treat as "attempt the merge").
 *
 * @returns {{ clean: boolean|null, conflicts: string[], treeOid?: string }}
 */
export function parseMergeTreeOutput(stdout, exitCode) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (exitCode === 0) {
    return { clean: true, conflicts: [], treeOid: lines[0] };
  }
  if (exitCode === 1) {
    // Modern git: first line is the (partial) tree oid, the rest are conflicted
    // file names. Some git versions emit an "Auto-merging"/"CONFLICT" section
    // after a blank line; --name-only keeps it to bare paths.
    const [treeOid, ...rest] = lines;
    return { clean: false, conflicts: rest, treeOid };
  }
  return { clean: null, conflicts: [] }; // unknown
}

/**
 * Predict whether merging `theirs` into `ours` conflicts.
 *
 * @param {{ repoDir: string, ours: string, theirs: string, exec?: Function }} args
 * @returns {{ clean: boolean|null, conflicts: string[], treeOid?: string, reason?: string }}
 */
export function predictConflicts({ repoDir, ours, theirs, exec = nodeSpawnSync }) {
  try {
    const res = exec('git', ['merge-tree', '--write-tree', '--name-only', ours, theirs], {
      cwd: repoDir, encoding: 'utf8', timeout: 30_000,
    });
    if (res.error) return { clean: null, conflicts: [], reason: `merge-tree error: ${res.error.message}` };
    // git merge-tree exits 0 (clean) or 1 (conflict); >1 is a real failure.
    if (typeof res.status === 'number' && res.status > 1) {
      return { clean: null, conflicts: [], reason: `git exited ${res.status}: ${(res.stderr || '').slice(0, 200)}` };
    }
    return parseMergeTreeOutput(res.stdout, res.status);
  } catch (err) {
    return { clean: null, conflicts: [], reason: `predictConflicts threw: ${err?.message || err}` };
  }
}
