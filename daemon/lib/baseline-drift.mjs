/**
 * baseline-drift.mjs — Pipeline v2 Phase 2-A / Story 2-A-4-4 (PR-92).
 *
 * Implements the `acceptBaselineDrift` mechanism v2.5 §14 + Phase 2-A
 * baseline-diff design doc references. Two flavors:
 *
 *   Production rigor:   PR label `futurator:accept-baseline-drift` on the
 *                       wave PR converts the regression block to a warn.
 *                       Operator-applied label → daemon detects → wave
 *                       proceeds.
 *
 *   mvp / prototype:    Decision card in the plan dashboard — operator
 *                       confirms / declines the drift inline. Decision
 *                       recorded in `Plan.driftDecisions[]` for the
 *                       forensic JSON.
 *
 * Baseline roll-forward: after a green wave, the wave's `.pipeline/
 * after-passing.txt` overwrites `.pipeline/baseline-passing.txt` so the
 * accepted drift becomes the new floor for subsequent waves.
 */

import { existsSync, readFileSync, renameSync, copyFileSync } from 'fs';
import { join } from 'path';

export const ACCEPT_LABEL = 'futurator:accept-baseline-drift';

/**
 * Has the operator applied the accept-drift label to the wave PR?
 * Daemon supplies the PR-labels array (from `gh pr view --json labels`).
 *
 * @param {Array<{ name?: string } | string>} labels
 * @returns {boolean}
 */
export function isLabelAccepted(labels) {
  if (!Array.isArray(labels)) return false;
  return labels.some((l) => {
    if (typeof l === 'string') return l === ACCEPT_LABEL;
    return l?.name === ACCEPT_LABEL;
  });
}

/**
 * Decide how the daemon should handle a baseline regression given the
 * current rigor + label state. v2.5 §14 matrix:
 *
 *   prototype  → warn (always)
 *   mvp        → block until operator confirms drift card
 *   production → block until label applied (PR-label path)
 *
 * @param {{
 *   rigor: 'prototype' | 'mvp' | 'production',
 *   labels?: Array<{ name?: string } | string>,
 *   operatorConfirmed?: boolean,
 * }} args
 * @returns {{ disposition: 'warn' | 'block' | 'proceed-accepted', reason: string }}
 */
export function decideBaselineRegression({ rigor, labels = [], operatorConfirmed = false }) {
  if (rigor === 'prototype') {
    return { disposition: 'warn', reason: 'prototype rigor — warn-only' };
  }
  if (rigor === 'production') {
    if (isLabelAccepted(labels)) {
      return {
        disposition: 'proceed-accepted',
        reason: `PR label '${ACCEPT_LABEL}' applied — drift accepted`,
      };
    }
    return { disposition: 'block', reason: 'production rigor — PR label required to accept drift' };
  }
  // mvp
  if (operatorConfirmed) {
    return {
      disposition: 'proceed-accepted',
      reason: 'mvp rigor — operator confirmed drift via decision card',
    };
  }
  return { disposition: 'block', reason: 'mvp rigor — operator confirms via decision card' };
}

/**
 * Roll forward the baseline after a green wave with accepted drift.
 * Overwrites `<workingDir>/.pipeline/baseline-passing.txt` with the
 * wave's `after-passing.txt`. Idempotent (no-op when after file missing).
 *
 * @param {string} workingDir
 * @returns {{ rolled: boolean, baseline: string, after: string }}
 */
export function rollBaselineForward(workingDir) {
  const pipelineDir = join(workingDir, '.pipeline');
  const baseline = join(pipelineDir, 'baseline-passing.txt');
  const after = join(pipelineDir, 'after-passing.txt');
  if (!existsSync(after)) {
    return { rolled: false, baseline, after };
  }
  // Use renameSync; falls back to copy+remove if rename fails (e.g.
  // cross-device). On macOS / Linux this is normally same-device.
  try {
    renameSync(after, baseline);
  } catch {
    copyFileSync(after, baseline);
  }
  return { rolled: true, baseline, after };
}

/**
 * Read the current baseline (passing-test list) — used by the decision
 * card UI to show the operator what's changing.
 *
 * @returns {string[]}
 */
export function readBaselinePassing(workingDir) {
  const path = join(workingDir, '.pipeline', 'baseline-passing.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Read the wave's post-DEV passing list — what would become the new
 * baseline if the operator accepts drift.
 */
export function readAfterPassing(workingDir) {
  const path = join(workingDir, '.pipeline', 'after-passing.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Compute the diff between baseline and after — used by the decision
 * card to show the operator what would be added/removed.
 *
 * @returns {{ added: string[], removed: string[] }}
 */
export function diffBaseline(workingDir) {
  const baseline = new Set(readBaselinePassing(workingDir));
  const after = new Set(readAfterPassing(workingDir));
  const added = [...after].filter((t) => !baseline.has(t)).sort();
  const removed = [...baseline].filter((t) => !after.has(t)).sort();
  return { added, removed };
}
