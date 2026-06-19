import type { TimerCategory } from './types';

/**
 * Pipeline v2 Phase 2-A — PR-49 (2026-05-07).
 *
 * Maps shell-step `stepId` values to the appropriate `TimerCategory`. Used by
 * the slicer to override the default `compile` classification for shell-step
 * lifecycle events (step_start / step_complete / step_error) that happen to
 * carry meaningful work — e.g. `test-verify` is test-execution time, not
 * orchestrator overhead.
 *
 * Without this map, every shell step's events were classified as `compile`
 * regardless of what the step actually did. brick-breaker-3 forensic showed
 * `test-execute` reading 0ms across a full plan run because `test-verify`
 * (the only test-execution step) was bucketed into `compile`.
 *
 * Agent steps (test-author, dev, review, retry, compile-knowledge) are NOT
 * in this map — their classification comes from `byRole` overrides in
 * `categories.ts` (test → test-author, reviewer → review, compiler →
 * compile, etc.). Agent + shell steps are deliberately split: shell steps
 * have no agentRole, so they need stepId-based routing.
 *
 * Steps absent from this map fall through to the existing classification
 * (`compile` for lifecycle events). That's a safe default.
 */
export const STEP_ID_TO_CATEGORY: Readonly<Record<string, TimerCategory>> = Object.freeze({
  // ── Test execution gates ──────────────────────────────────────────────
  // PR-A.3 / Phase C.3
  'test-gate-red': 'test-execute',
  'test-verify': 'test-execute',

  // ── Quality gates (PR-36 + PR-41) ──────────────────────────────────────
  'tamper-check': 'tamper-check',
  'baseline-regression': 'baseline-check',

  // ── Compile phase shell steps (PR-44 + PR-A.3) ─────────────────────────
  // Per-story commit + push are git operations, not compile work. Diff +
  // sync are pre-knowledge orchestration → compile.
  'compile-commit-on-pass': 'git',
  'compile-diff': 'compile',
  'compile-sync': 'compile',
  'compile-push': 'git',

  // ── Build / smoke gates (Phase 1 + PR-30/31) ───────────────────────────
  'build-check': 'compile',
  'plan-build-check': 'compile',
  'server-check': 'compile',
  'dev-build-fix': 'fix',
  'dev-server-fix': 'fix',
  'plan-build-fix': 'fix',

  // ── Lint gate + fixer (pacman1 F1; v3 E3-S1, 2026-06-19) ───────────────
  // `lint-verify` (story-pipeline.ts) runs `eslint --fix` on the per-story
  // delta — static-analysis work, classified with the other build/static
  // gates as `compile`. Previously it had no entry and only "happened" to
  // land in `compile` via the shell-step default; the explicit entry pins it
  // so a default change can't silently re-bucket lint time.
  //
  // `lint-fix` is the bounded fixer agent (agentId:'DEV'). Without an entry it
  // was classified by role → `dev`, so eslint-repair time leaked into raw dev
  // time (the same misattribution PR-49 fixed for test-execute). The map
  // override wins over byRole (slicer `stepOverride ?? classify`), so this
  // books it as `fix` alongside dev-build-fix / dev-server-fix.
  'lint-verify': 'compile',
  'lint-fix': 'fix',

  // ── Wave gate (pong1 P2, 2026-06-12) ───────────────────────────────────
  // Every wave-merge runner log line is teed into the events table with
  // stepId 'wave-merge' (agent-daemon waveLog). Pre-fix these classified as
  // machine-wait ('status' events) / fix ('step_error'), hiding the v2.6
  // gate's real work — pong1 booked 41% of wall-clock as machine-wait.
  // The slicer further promotes 'merge-gate' → 'vqa-gate' when the event
  // text carries the '[wave-vqa]' prefix (see slicer.ts).
  'wave-merge': 'merge-gate',

  // ── App bootstrap (Phase 1) ────────────────────────────────────────────
  // App-bootstrap saga steps don't usually surface in story-pipeline
  // forensic, but listing here closes the gap if they ever do.
  'inject-app-values': 'bootstrap',
  'npm-install': 'bootstrap',
  'bmad-bootstrap': 'bootstrap',
  'commit-and-push': 'bootstrap',
});

/**
 * Resolve a step's category override. Returns null when the step isn't in
 * the map (caller falls back to the default classification).
 */
export function resolveStepCategory(stepId: string | undefined | null): TimerCategory | null {
  if (!stepId || typeof stepId !== 'string') return null;
  return STEP_ID_TO_CATEGORY[stepId] ?? null;
}
