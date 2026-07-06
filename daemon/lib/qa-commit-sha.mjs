// qa-commit-sha — the ONE decision postDeployWriteback got wrong for two full
// rounds (2026-07-04 → 2026-07-06): whether to stamp plan.qaCommitSha from a
// completed DEV deploy job.
//
// Extracted into its own PURE, tested module because `agent-daemon.mjs` has NO
// test coverage at all (9800+ lines, no export boundary, starts a real poll
// loop on import) — the exact reason a one-line bug (`job.variables?.COMMIT_SHA`
// instead of the `variables` parameter that actually holds the extracted SHA)
// shipped silently: qaCommitSha was NEVER stamped, so the cron's p3-qa
// auto-enqueue (which requires it) never fired, so the REAL deployed-app QA
// (journeys+VQA+wiring) never ran for ANY plan. Every "QA" the operator saw was
// the per-story unit-test bound-AC table — never a check that the assembled
// app actually works. This module's only job is to make that decision
// unit-testable so it can never silently regress again.

const SHA40_RE = /^[a-f0-9]{40}$/;

/**
 * Decide whether to stamp `plan.qaCommitSha` from a completed dev-deploy job's
 * extracted variables.
 *
 * @param {{ deployEnv: string, variables: Record<string, unknown> }} args
 * @returns {string|null} the 40-hex SHA to stamp, or null (don't stamp —
 *   fail-open; devUrl still records regardless).
 */
export function resolveStampableCommitSha({ deployEnv, variables }) {
  if (deployEnv !== 'dev') return null;
  const sha = variables?.COMMIT_SHA;
  return typeof sha === 'string' && SHA40_RE.test(sha) ? sha : null;
}
