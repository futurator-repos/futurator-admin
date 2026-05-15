import { describe, it, expect } from 'vitest';
import { buildQaExecutePipeline } from '../visual-qa-pipeline';
import type { Plan } from '../../types/plan';
import type { VisualTestDef } from '../../types/epic-workflow';

/**
 * PR-60 — qa-prepare hang hardening.
 *
 * Structural assertions on the bash text emitted for the qa-prepare step.
 * spyhunter-1 forensic 2026-05-13: Node IIFE captured 26/26 screenshots,
 * then bash waited 7 minutes on `node` until the daemon SIGKILLed the
 * step (exit null). Root causes:
 *
 *   (a) the per-test screenshot Node script only listened on child.stderr;
 *       child.stdout was never drained, which pins Node's event loop
 *       after the children close.
 *   (b) the IIFE had no `process.exit(0)` — same hang shape as (a).
 *   (c) unbounded `aws s3 cp ... &` parallelism — one hanging upload
 *       (IAM refresh, throttling) blocked the unbounded `wait`.
 *
 * These tests guard against each regression.
 */

// Minimal Plan shape — buildQaExecutePipeline only reads workingDir, name,
// rigor, and qaCostBudgetUsd. Using `as unknown as Plan` so we don't have
// to mirror the entire (and frequently-evolving) Plan type just for a test.
const PLAN = {
  planId: 'plan-test',
  appId: 'spyhunter-1',
  name: 'spyhunter-1',
  workingDir: '/home/ubuntu/projects/spyhunter-1',
  intent: 'test plan',
  rigor: 'mvp',
  status: 'review',
  epicIds: [],
  createdAt: '2026-05-13T00:00:00Z',
  updatedAt: '2026-05-13T00:00:00Z',
} as unknown as Plan;

const TESTS: Array<VisualTestDef & { storyId: string; storyTitle: string }> = [
  {
    id: 't1',
    criteriaRef: 'ac-1',
    description: 'overview renders',
    setup: 'visit /',
    expect: 'h1 visible',
    level: 'L0',
    storyId: 's1',
    storyTitle: 'Story 1',
  },
];

function findQaPrepareCommand(): string {
  const pipeline = buildQaExecutePipeline({
    plan: PLAN,
    allVisualTests: TESTS,
    snapshotPrefix: 'qa-snapshots/spyhunter-1/job/',
    jobId: 'job-123',
  });
  const step = pipeline.steps.find((s) => s.id === 'qa-prepare');
  if (!step || step.stepType !== 'shell' || !('command' in step)) {
    throw new Error('qa-prepare step not found or not a shell step');
  }
  return String(step.command);
}

describe('PR-60 — qa-prepare hardening', () => {
  it('per-test screenshot script drains child.stdout (prevents Node event-loop pin)', () => {
    const cmd = findQaPrepareCommand();
    // The drain handler is what stops un-consumed stdout pipes from pinning
    // the loop. Without it, Node hangs after the Playwright children close.
    expect(cmd).toContain("child.stdout.on('data', () => {})");
  });

  it('per-test screenshot script calls process.exit(0) when done', () => {
    const cmd = findQaPrepareCommand();
    // Belt-and-braces: explicit exit guarantees Node terminates even if a
    // stdio handle remains ref'd. Without this, spyhunter-1 hung 7 min
    // waiting on `node` until the daemon SIGKILLed.
    expect(cmd).toContain('process.exit(0)');
  });

  it('per-test screenshot script has error handler on the outer IIFE', () => {
    const cmd = findQaPrepareCommand();
    // An unhandled rejection in the IIFE used to disappear silently; the
    // step would just hang. .catch() + process.exit(1) makes failure loud.
    // (avoiding /s flag for ts target compatibility — `[\s\S]` instead).
    expect(cmd).toMatch(/\.catch\([\s\S]*process\.exit\(1\)/);
  });

  it('per-test spawn uses stdio array (ignore stdin) — guards against `stdio: "pipe"` regression', () => {
    const cmd = findQaPrepareCommand();
    // Previous shape `stdio: 'pipe'` opens stdin too (we never write to it).
    // Closing stdin via 'ignore' avoids one more pipe that could leak.
    expect(cmd).toContain("stdio: ['ignore', 'pipe', 'pipe']");
  });

  it('S3 upload loop bounds each cp with `timeout 30`', () => {
    const cmd = findQaPrepareCommand();
    // Unbounded `aws s3 cp ... &` parallelism + a single hang blocks
    // the trailing `wait` until the step's 5-min daemon timeout fires.
    expect(cmd).toMatch(/timeout 30 aws s3 cp/);
  });

  it('emits dated checkpoint logs around the slow blocks', () => {
    const cmd = findQaPrepareCommand();
    // When the step DOES hang in production, we need to know WHICH block
    // it hung in. Cheap echo lines around the slow sections.
    expect(cmd).toContain('[qa-prepare]');
    expect(cmd).toContain('capturing per-test screenshots');
    expect(cmd).toContain('uploading screenshots to S3');
  });
});
