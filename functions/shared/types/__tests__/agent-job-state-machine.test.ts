import { describe, it, expect } from 'vitest';
import type { AgentJobStatus } from '../agent-orchestrator';
import {
  isTerminal,
  isSuccess,
  isFailureTerminal,
  isPaused,
  isActive,
  canTransition,
} from '../agent-job-state-machine';

const ALL_STATUSES: AgentJobStatus[] = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'COMPLETE_WITH_BLOCKED_STORIES',
  'STALE',
  'NEEDS_ATTENTION',
  'COMPLETED_VIA_SALVAGE',
  'COMPLETED_VIA_TALK',
  'MANUALLY_SKIPPED',
];

describe('agent-job-state-machine — classification', () => {
  it('treats COMPLETED, COMPLETED_VIA_SALVAGE, COMPLETED_VIA_TALK, and MANUALLY_SKIPPED as success', () => {
    expect(isSuccess('COMPLETED')).toBe(true);
    expect(isSuccess('COMPLETE_WITH_BLOCKED_STORIES')).toBe(true);
    expect(isSuccess('COMPLETED_VIA_SALVAGE')).toBe(true);
    expect(isSuccess('COMPLETED_VIA_TALK')).toBe(true);
    expect(isSuccess('MANUALLY_SKIPPED')).toBe(true);
  });

  it('does not treat FAILED, STALE, NEEDS_ATTENTION as success', () => {
    expect(isSuccess('FAILED')).toBe(false);
    expect(isSuccess('STALE')).toBe(false);
    expect(isSuccess('NEEDS_ATTENTION')).toBe(false);
    expect(isSuccess('PENDING')).toBe(false);
    expect(isSuccess('RUNNING')).toBe(false);
  });

  it('classifies NEEDS_ATTENTION as paused, not terminal', () => {
    expect(isPaused('NEEDS_ATTENTION')).toBe(true);
    expect(isTerminal('NEEDS_ATTENTION')).toBe(false);
  });

  it('classifies all terminal states correctly', () => {
    const terminal = ALL_STATUSES.filter(isTerminal);
    expect(terminal.sort()).toEqual(
      [
        'COMPLETED',
        'COMPLETE_WITH_BLOCKED_STORIES',
        'FAILED',
        'STALE',
        'COMPLETED_VIA_SALVAGE',
        'COMPLETED_VIA_TALK',
        'MANUALLY_SKIPPED',
      ].sort(),
    );
  });

  it('classifies failure-terminal as terminal-but-not-success', () => {
    expect(isFailureTerminal('FAILED')).toBe(true);
    expect(isFailureTerminal('STALE')).toBe(true);
    expect(isFailureTerminal('COMPLETED')).toBe(false);
    expect(isFailureTerminal('COMPLETED_VIA_SALVAGE')).toBe(false);
    expect(isFailureTerminal('MANUALLY_SKIPPED')).toBe(false);
    expect(isFailureTerminal('NEEDS_ATTENTION')).toBe(false);
  });

  it('classifies PENDING and RUNNING as active', () => {
    expect(isActive('PENDING')).toBe(true);
    expect(isActive('RUNNING')).toBe(true);
    expect(isActive('NEEDS_ATTENTION')).toBe(false);
    expect(isActive('COMPLETED')).toBe(false);
  });
});

describe('agent-job-state-machine — transitions (Story 1.1 AC #2)', () => {
  it('RUNNING can transition to NEEDS_ATTENTION (recoverable failure)', () => {
    expect(canTransition('RUNNING', 'NEEDS_ATTENTION')).toBe(true);
  });

  it('RUNNING can still transition to FAILED (Abort / unrecoverable infra)', () => {
    expect(canTransition('RUNNING', 'FAILED')).toBe(true);
  });

  it('NEEDS_ATTENTION can transition to COMPLETED_VIA_SALVAGE (Salvage)', () => {
    expect(canTransition('NEEDS_ATTENTION', 'COMPLETED_VIA_SALVAGE')).toBe(true);
  });

  it('NEEDS_ATTENTION can transition to COMPLETED_VIA_TALK (Talk apply-output)', () => {
    expect(canTransition('NEEDS_ATTENTION', 'COMPLETED_VIA_TALK')).toBe(true);
  });

  it('NEEDS_ATTENTION can transition to MANUALLY_SKIPPED (Skip)', () => {
    expect(canTransition('NEEDS_ATTENTION', 'MANUALLY_SKIPPED')).toBe(true);
  });

  it('NEEDS_ATTENTION can transition to FAILED (Abort)', () => {
    expect(canTransition('NEEDS_ATTENTION', 'FAILED')).toBe(true);
  });

  it('NEEDS_ATTENTION cannot directly transition to RUNNING (Retry creates a NEW job)', () => {
    expect(canTransition('NEEDS_ATTENTION', 'RUNNING')).toBe(false);
  });

  it('terminal success states cannot transition out', () => {
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransition('COMPLETED_VIA_SALVAGE', 'NEEDS_ATTENTION')).toBe(false);
    expect(canTransition('MANUALLY_SKIPPED', 'COMPLETED')).toBe(false);
  });

  it('FAILED is terminal — no outbound transitions', () => {
    for (const to of ALL_STATUSES) {
      expect(canTransition('FAILED', to)).toBe(false);
    }
  });

  it('STALE may re-enter PENDING (resume respawn) — backward compat', () => {
    expect(canTransition('STALE', 'PENDING')).toBe(true);
    expect(canTransition('STALE', 'RUNNING')).toBe(false);
  });

  it('PENDING transitions to RUNNING or FAILED only', () => {
    expect(canTransition('PENDING', 'RUNNING')).toBe(true);
    expect(canTransition('PENDING', 'FAILED')).toBe(true);
    expect(canTransition('PENDING', 'NEEDS_ATTENTION')).toBe(false);
    expect(canTransition('PENDING', 'COMPLETED')).toBe(false);
  });
});
