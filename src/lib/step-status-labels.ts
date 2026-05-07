/**
 * Pipeline v2 Phase 2-A — PR-50 (2026-05-07).
 *
 * Maps pipeline step IDs to user-friendly status labels for per-story
 * status badges in the Plan dashboard, agentic-workflow story cards,
 * and live output panel.
 *
 * The daemon writes `job.currentStepId` on every step transition
 * (agent-daemon.mjs ~L2193 — bash-event-driven, no scanning). The UI
 * reads that field and runs it through `formatStepStatus()` to render
 * the badge. When `job.currentStepId` is absent (older jobs pre-PR-50),
 * the UI falls back to `pipeline.steps[currentStepIndex].id` for the
 * same lookup.
 *
 * Deliberate choices:
 *   - Status labels are short (1-2 words) so they fit in the chip slot.
 *   - Compile-phase steps collapse into a single "Compiling…" — the
 *     operator doesn't need per-substep visibility (compile-diff,
 *     compile-knowledge, compile-sync, compile-push are all "compile").
 *   - Quality gates (tamper-check, baseline-regression) get distinct
 *     labels so when they fail, the operator immediately knows why.
 *   - Retry / fix steps collapse into "Retrying…" — distinct from
 *     "Developing" because retries are a meaningful failure-recovery
 *     phase.
 */

export type StepStatusLabel =
  | 'Testing' // test-author
  | 'Verifying' // test-verify, test-gate-red
  | 'Tamper check' // tamper-check
  | 'Baseline check' // baseline-regression
  | 'Developing' // dev
  | 'Reviewing' // review
  | 'Retrying' // retry
  | 'Compiling' // compile-*
  | 'Building' // build-check, plan-build-check
  | 'Smoke test' // server-check
  | 'Fixing' // dev-build-fix, dev-server-fix, plan-build-fix
  | 'Bootstrap'; // inject-app-values, npm-install, bmad-bootstrap, commit-and-push

const STEP_TO_LABEL: Readonly<Record<string, StepStatusLabel>> = Object.freeze({
  // Agent steps
  'test-author': 'Testing',
  dev: 'Developing',
  review: 'Reviewing',
  retry: 'Retrying',
  'compile-knowledge': 'Compiling',

  // Test execution gates
  'test-gate-red': 'Verifying',
  'test-verify': 'Verifying',

  // Quality gates
  'tamper-check': 'Tamper check',
  'baseline-regression': 'Baseline check',

  // Compile-phase shell steps
  'compile-commit-on-pass': 'Compiling',
  'compile-diff': 'Compiling',
  'compile-sync': 'Compiling',
  'compile-push': 'Compiling',

  // Build / smoke gates
  'build-check': 'Building',
  'plan-build-check': 'Building',
  'server-check': 'Smoke test',
  'dev-build-fix': 'Fixing',
  'dev-server-fix': 'Fixing',
  'plan-build-fix': 'Fixing',

  // App bootstrap
  'inject-app-values': 'Bootstrap',
  'npm-install': 'Bootstrap',
  'bmad-bootstrap': 'Bootstrap',
  'commit-and-push': 'Bootstrap',
});

/**
 * Resolve the label for a step ID. Returns null when the step ID is
 * unknown (caller can fall back to the plan-level status).
 */
export function formatStepStatus(stepId: string | undefined | null): StepStatusLabel | null {
  if (!stepId || typeof stepId !== 'string') return null;
  return STEP_TO_LABEL[stepId] ?? null;
}

/**
 * Tone class for the status badge. Used by the UI to color the chip
 * consistent with the existing semantic theme tokens
 * (success / warning / accent-blue / accent-orange / muted).
 *
 * Tone mapping aligns with operator intuition:
 *   - Testing / Verifying / Baseline / Tamper → accent-blue (gates / quality)
 *   - Reviewing → accent-purple (consistent with story.status === 'in_review')
 *   - Retrying / Fixing → warning (something went wrong, recovering)
 *   - Developing → primary (active work)
 *   - Compiling / Building / Smoke / Bootstrap → muted (machine work)
 */
export function stepStatusTone(label: StepStatusLabel | null): string {
  switch (label) {
    case 'Testing':
    case 'Verifying':
    case 'Tamper check':
    case 'Baseline check':
      return 'text-accent-blue';
    case 'Reviewing':
      return 'text-purple-500';
    case 'Retrying':
    case 'Fixing':
      return 'text-warning';
    case 'Developing':
      return 'text-foreground';
    case 'Compiling':
    case 'Building':
    case 'Smoke test':
    case 'Bootstrap':
    case null:
    default:
      return 'text-muted-foreground';
  }
}
