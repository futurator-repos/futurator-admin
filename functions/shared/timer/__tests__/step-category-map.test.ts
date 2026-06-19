import { describe, it, expect } from 'vitest';
import { resolveStepCategory, STEP_ID_TO_CATEGORY } from '../step-category-map';

describe('PR-49 — resolveStepCategory', () => {
  it('returns null for unknown stepIds (caller falls back to classifier)', () => {
    expect(resolveStepCategory('foo')).toBeNull();
    expect(resolveStepCategory('')).toBeNull();
    expect(resolveStepCategory(undefined)).toBeNull();
    expect(resolveStepCategory(null)).toBeNull();
  });

  it('test-execution gates → test-execute', () => {
    expect(resolveStepCategory('test-gate-red')).toBe('test-execute');
    expect(resolveStepCategory('test-verify')).toBe('test-execute');
  });

  it('quality gates map to their dedicated categories', () => {
    expect(resolveStepCategory('tamper-check')).toBe('tamper-check');
    expect(resolveStepCategory('baseline-regression')).toBe('baseline-check');
  });

  it('compile-* steps split into git vs compile correctly', () => {
    expect(resolveStepCategory('compile-commit-on-pass')).toBe('git');
    expect(resolveStepCategory('compile-push')).toBe('git');
    expect(resolveStepCategory('compile-diff')).toBe('compile');
    expect(resolveStepCategory('compile-sync')).toBe('compile');
  });

  it('build / smoke gates map to compile (or fix for the fixer agents)', () => {
    expect(resolveStepCategory('build-check')).toBe('compile');
    expect(resolveStepCategory('plan-build-check')).toBe('compile');
    expect(resolveStepCategory('server-check')).toBe('compile');
    expect(resolveStepCategory('dev-build-fix')).toBe('fix');
    expect(resolveStepCategory('dev-server-fix')).toBe('fix');
    expect(resolveStepCategory('plan-build-fix')).toBe('fix');
  });

  it('lint gate → compile, lint fixer → fix (v3 E3-S1)', () => {
    // The eslint gate is static-analysis work, bucketed with the build gates.
    expect(resolveStepCategory('lint-verify')).toBe('compile');
    // The bounded eslint fixer is an agent step but the map override wins over
    // its DEV role, so its repair time books as `fix` (not raw `dev`).
    expect(resolveStepCategory('lint-fix')).toBe('fix');
  });

  it('app-bootstrap saga steps map to bootstrap', () => {
    expect(resolveStepCategory('inject-app-values')).toBe('bootstrap');
    expect(resolveStepCategory('npm-install')).toBe('bootstrap');
    expect(resolveStepCategory('bmad-bootstrap')).toBe('bootstrap');
    expect(resolveStepCategory('commit-and-push')).toBe('bootstrap');
  });

  it('agent-only stepIds (test-author, dev, review, retry) are NOT in the map', () => {
    // These are agent steps; their classification flows through the
    // classifier's byRole overrides, not the stepId map. The map is only
    // for shell steps that lack a meaningful agentRole.
    expect(resolveStepCategory('test-author')).toBeNull();
    expect(resolveStepCategory('dev')).toBeNull();
    expect(resolveStepCategory('review')).toBeNull();
    expect(resolveStepCategory('retry')).toBeNull();
    expect(resolveStepCategory('compile-knowledge')).toBeNull();
  });

  it('STEP_ID_TO_CATEGORY is frozen (defense against runtime mutation)', () => {
    expect(Object.isFrozen(STEP_ID_TO_CATEGORY)).toBe(true);
  });
});
