import { describe, it, expect } from 'vitest';
import { formatStepStatus, stepStatusTone } from '../step-status-labels';

describe('PR-50 — formatStepStatus', () => {
  it('returns null for unknown / empty input', () => {
    expect(formatStepStatus('')).toBeNull();
    expect(formatStepStatus(undefined)).toBeNull();
    expect(formatStepStatus(null)).toBeNull();
    expect(formatStepStatus('mystery-step')).toBeNull();
  });

  it.each([
    ['test-author', 'Testing'],
    ['dev', 'Developing'],
    ['review', 'Reviewing'],
    ['retry', 'Retrying'],
    ['compile-knowledge', 'Compiling'],
    ['test-gate-red', 'Verifying'],
    ['test-verify', 'Verifying'],
    ['tamper-check', 'Tamper check'],
    ['baseline-regression', 'Baseline check'],
    ['compile-commit-on-pass', 'Compiling'],
    ['compile-diff', 'Compiling'],
    ['compile-sync', 'Compiling'],
    ['compile-push', 'Compiling'],
    ['build-check', 'Building'],
    ['plan-build-check', 'Building'],
    ['server-check', 'Smoke test'],
    ['dev-build-fix', 'Fixing'],
    ['dev-server-fix', 'Fixing'],
    ['plan-build-fix', 'Fixing'],
    ['inject-app-values', 'Bootstrap'],
    ['npm-install', 'Bootstrap'],
    ['bmad-bootstrap', 'Bootstrap'],
    ['commit-and-push', 'Bootstrap'],
  ] as const)('"%s" → "%s"', (stepId, expected) => {
    expect(formatStepStatus(stepId)).toBe(expected);
  });
});

describe('PR-50 — stepStatusTone', () => {
  it('quality gates → accent-blue', () => {
    expect(stepStatusTone('Testing')).toBe('text-accent-blue');
    expect(stepStatusTone('Verifying')).toBe('text-accent-blue');
    expect(stepStatusTone('Tamper check')).toBe('text-accent-blue');
    expect(stepStatusTone('Baseline check')).toBe('text-accent-blue');
  });

  it('Reviewing → purple', () => {
    expect(stepStatusTone('Reviewing')).toBe('text-purple-500');
  });

  it('recovery → warning', () => {
    expect(stepStatusTone('Retrying')).toBe('text-warning');
    expect(stepStatusTone('Fixing')).toBe('text-warning');
  });

  it('Developing → primary foreground', () => {
    expect(stepStatusTone('Developing')).toBe('text-foreground');
  });

  it('machine work → muted', () => {
    expect(stepStatusTone('Compiling')).toBe('text-muted-foreground');
    expect(stepStatusTone('Building')).toBe('text-muted-foreground');
    expect(stepStatusTone('Smoke test')).toBe('text-muted-foreground');
    expect(stepStatusTone('Bootstrap')).toBe('text-muted-foreground');
  });

  it('null → muted (graceful default)', () => {
    expect(stepStatusTone(null)).toBe('text-muted-foreground');
  });
});
