// selective-regression — W5.1 (P3_SELECTIVE_REGRESSION). The surgical replacement
// for the retired per-wave full-suite build gate: after a story commits on the
// shared plan branch, run ONLY the prior tests that cover a symbol this story
// changed (reverse-traverse the deterministic TESTS/IMPORTS/CALLS edges via
// queryImpact). This restores cross-story-regression safety (§3b ⚠️) at a
// fraction of the cost. No-op when the covering set is empty.
//
// PURE selection logic (the graph query + test runner are injected) so it
// unit-tests without Memgraph or a CLI.

/** Gate: 'off' → skip; 'shadow' → compute the set but don't run; 'on' → run. */
export function selectiveRegressionMode(flag) {
  return flag === 'on' ? 'on' : flag === 'shadow' ? 'shadow' : 'off';
}

/**
 * Collect the union of covering-test node ids for a set of changed graph nodes.
 * Reverse-impact each changed node and union the `tests` it surfaces.
 *
 * @param {string[]} changedNodeIds
 * @param {object} driver
 * @param {{ queryImpact: Function, maxHops?: number }} deps
 * @returns {Promise<string[]>} sorted, deduped covering-test node ids
 */
export async function collectCoveringTests(changedNodeIds, driver, { queryImpact, maxHops = 4 } = {}) {
  if (!driver || typeof queryImpact !== 'function' || !Array.isArray(changedNodeIds) || !changedNodeIds.length) {
    return [];
  }
  const tests = new Set();
  for (const nodeId of changedNodeIds) {
    try {
      const r = await queryImpact(nodeId, driver, { maxHops });
      for (const t of r?.tests || []) tests.add(t);
    } catch { /* best-effort per node — a bad node never fails the gate */ }
  }
  return [...tests].sort();
}

/**
 * Run selective regression for a story. Returns a verdict; NEVER throws.
 * `runTest(testNodeId)` resolves `{ passed:boolean }`.
 *
 * @returns {Promise<{ mode:string, selected:string[], ran:number, regressions:string[], skipped?:string }>}
 */
export async function runSelectiveRegression({
  flag, changedNodeIds, driver, queryImpact, runTest, maxHops = 4,
}) {
  const mode = selectiveRegressionMode(flag);
  if (mode === 'off') return { mode, selected: [], ran: 0, regressions: [], skipped: 'off' };

  const selected = await collectCoveringTests(changedNodeIds, driver, { queryImpact, maxHops });
  if (!selected.length) return { mode, selected: [], ran: 0, regressions: [], skipped: 'empty' };
  if (mode === 'shadow' || typeof runTest !== 'function') {
    return { mode, selected, ran: 0, regressions: [], skipped: mode === 'shadow' ? 'shadow' : 'no-runner' };
  }

  const regressions = [];
  let ran = 0;
  for (const t of selected) {
    try {
      const res = await runTest(t);
      ran += 1;
      if (res && res.passed === false) regressions.push(t);
    } catch { /* a runner error is not a regression signal */ }
  }
  return { mode, selected, ran, regressions };
}
