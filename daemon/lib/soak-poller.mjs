/**
 * soak-poller.mjs — Pipeline v2 Phase 3-S / Story 3-S-2-1 (PR-98).
 *
 * 24h staging soak gate per v2.5 §36. Soak success isn't "no alarms went
 * off for 24 hours" — it's "the staging environment processed N real
 * synthetic requests, dependency calls stayed within their P99 latency
 * envelope, and the dependency-error rate stayed below threshold."
 *
 * This module is the **pure decision logic** + the per-iteration metric-
 * polling shape. The daemon's existing cron / setInterval wires it to a
 * real CloudWatch query on a 5-min cadence.
 *
 * Soak conditions (v2.5 §36):
 *   1. 5xx rate < 0.5% over 24h on staging
 *   2. Dependency error rate < 1% (per-vendor for declared integrations)
 *   3. Smoke-test pass rate = 100% (from soak-script declared in
 *      aws.manifest.yaml deploy-gate.requires)
 *
 * Failure handling: on any condition trip, emit `production-soak-failed`
 * (high severity) + pause the soak clock. Operator re-runs after fix
 * (starts over at 0 — partial credit is theatre per v2.5 §36 commentary).
 */

const SOAK_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIVE_XX_THRESHOLD_PCT = 0.5;
const DEPENDENCY_ERR_THRESHOLD_PCT = 1.0;
const SMOKE_PASS_REQUIRED_PCT = 100.0;

/**
 * Evaluate a single soak sample against the three conditions.
 *
 * @param {{
 *   fiveXxRatePct: number,
 *   dependencyErrorRatePct: number,
 *   smokeTestPassPct: number,
 * }} sample
 * @returns {{
 *   ok: boolean,
 *   failures: string[],
 *   details: {
 *     fiveXxOk: boolean,
 *     dependencyOk: boolean,
 *     smokeOk: boolean,
 *   },
 * }}
 */
export function evaluateSoakSample(sample) {
  const failures = [];
  const fiveXxOk = sample.fiveXxRatePct < FIVE_XX_THRESHOLD_PCT;
  const dependencyOk = sample.dependencyErrorRatePct < DEPENDENCY_ERR_THRESHOLD_PCT;
  const smokeOk = sample.smokeTestPassPct >= SMOKE_PASS_REQUIRED_PCT;

  if (!fiveXxOk) {
    failures.push(
      `5xx rate ${sample.fiveXxRatePct.toFixed(2)}% ≥ threshold ${FIVE_XX_THRESHOLD_PCT}%`,
    );
  }
  if (!dependencyOk) {
    failures.push(
      `dependency error rate ${sample.dependencyErrorRatePct.toFixed(2)}% ≥ threshold ${DEPENDENCY_ERR_THRESHOLD_PCT}%`,
    );
  }
  if (!smokeOk) {
    failures.push(`smoke-test pass rate ${sample.smokeTestPassPct.toFixed(1)}% < 100%`);
  }

  return {
    ok: failures.length === 0,
    failures,
    details: { fiveXxOk, dependencyOk, smokeOk },
  };
}

/**
 * Soak progress checker. Given the soak window's start time + the
 * accumulated sample stream, decide whether the soak passed, is still
 * running, or failed.
 *
 * @param {{
 *   soakStartedAt: number,           // epoch ms when production plan tag landed
 *   samples: Array<{ takenAt: number, fiveXxRatePct: number, dependencyErrorRatePct: number, smokeTestPassPct: number }>,
 *   now?: () => number,
 * }} args
 * @returns {{
 *   status: 'pending' | 'failed' | 'passed',
 *   elapsedMs: number,
 *   remainingMs: number,
 *   latestSample?: ReturnType<typeof evaluateSoakSample>,
 *   failedAt?: number,
 * }}
 */
export function checkSoakProgress({ soakStartedAt, samples, now = () => Date.now() }) {
  const t = now();
  const elapsedMs = t - soakStartedAt;
  const remainingMs = Math.max(0, SOAK_WINDOW_MS - elapsedMs);

  // Walk samples in chronological order. First failing sample → failed.
  const sorted = [...samples].sort((a, b) => a.takenAt - b.takenAt);
  let latestEval;
  for (const sample of sorted) {
    const evaluated = evaluateSoakSample(sample);
    latestEval = evaluated;
    if (!evaluated.ok) {
      return {
        status: 'failed',
        elapsedMs,
        remainingMs,
        latestSample: evaluated,
        failedAt: sample.takenAt,
      };
    }
  }

  if (elapsedMs >= SOAK_WINDOW_MS) {
    return { status: 'passed', elapsedMs, remainingMs: 0, latestSample: latestEval };
  }

  return { status: 'pending', elapsedMs, remainingMs, latestSample: latestEval };
}

/**
 * Build the failure attention item per v2.5 §36 (high severity).
 */
export function buildSoakFailedAttention({ planId, projectSlug, sample, elapsedMs }) {
  return {
    severity: 'high',
    category: 'production-soak-failed',
    title: `Production soak failed for ${projectSlug}`,
    body:
      `Plan ${planId} failed soak after ${Math.floor(elapsedMs / 3600000)}h elapsed.\n\n` +
      `Failed conditions:\n` +
      sample.failures.map((f) => `  • ${f}`).join('\n') +
      `\n\nOperator: investigate, apply fix, restart soak (soak clock resets to 0).`,
    actions: ['restart-soak', 'rollback', 'inspect-logs'],
    context: { planId, projectSlug, sampleEvaluation: sample, elapsedMs },
  };
}

/**
 * Whether the operator-approval condition is in the deploy-gate.
 * Helper for the daemon — surfaces the final operator-confirm card
 * only after all the auto-checked conditions pass.
 */
export function requiresOperatorApproval(deployGateRequires) {
  return Array.isArray(deployGateRequires) && deployGateRequires.includes('operator-approval');
}

export const SOAK_CONSTANTS = Object.freeze({
  windowMs: SOAK_WINDOW_MS,
  fiveXxThresholdPct: FIVE_XX_THRESHOLD_PCT,
  dependencyErrorThresholdPct: DEPENDENCY_ERR_THRESHOLD_PCT,
  smokeTestPassRequiredPct: SMOKE_PASS_REQUIRED_PCT,
});
