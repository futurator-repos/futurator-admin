import { describe, it, expect } from 'vitest';
import { resolveAgentPolicy, cliModelArgs } from '../model-effort-policy.mjs';

const env = {}; // isolate from the host machine's env

describe('resolveAgentPolicy', () => {
  it('planner gets the strongest default thinking (Opus 4.8 — the plan is the leverage)', () => {
    expect(resolveAgentPolicy({ role: 'planner', env })).toEqual({ model: 'claude-opus-4-8', effort: 'high' });
  });

  it('dev scales with story complexity', () => {
    expect(resolveAgentPolicy({ role: 'dev', complexity: 'trivial', env })).toEqual({ model: 'haiku', effort: null });
    expect(resolveAgentPolicy({ role: 'dev', complexity: 'standard', env }).effort).toBe('medium');
    expect(resolveAgentPolicy({ role: 'dev', complexity: 'complex', env }).effort).toBe('high');
    expect(resolveAgentPolicy({ role: 'dev', complexity: 'architectural', env }).model).toBe('claude-opus-4-8');
  });

  it('reviewer is cheap by default, escalates to high on P0 ACs', () => {
    expect(resolveAgentPolicy({ role: 'reviewer', env }).effort).toBe('low');
    expect(resolveAgentPolicy({ role: 'reviewer', riskTags: ['P3', 'P0'], env }).effort).toBe('high');
  });

  it('plan-level overrides win over defaults AND risk escalation', () => {
    const p = resolveAgentPolicy({ role: 'reviewer', riskTags: ['P0'], overrides: { model: 'claude-opus-4-8', effort: 'medium' }, env });
    expect(p).toEqual({ model: 'claude-opus-4-8', effort: 'medium' });
  });

  it('env overrides sit between plan overrides and defaults', () => {
    const p = resolveAgentPolicy({ role: 'test-author', env: { P3_TEST_AUTHOR_MODEL: 'claude-opus-4-8', P3_TEST_AUTHOR_EFFORT: 'max' } });
    expect(p).toEqual({ model: 'claude-opus-4-8', effort: 'max' });
  });

  it('haiku NEVER carries an effort (adaptive thinking unsupported)', () => {
    expect(resolveAgentPolicy({ role: 'judge', env })).toEqual({ model: 'haiku', effort: null });
    expect(resolveAgentPolicy({ role: 'dev', complexity: 'standard', overrides: { model: 'haiku', effort: 'high' }, env }).effort).toBeNull();
  });

  it('invalid effort values are dropped, not passed to the CLI', () => {
    expect(resolveAgentPolicy({ role: 'planner', overrides: { effort: 'banana' }, env }).effort).toBeNull();
  });
});

describe('cliModelArgs', () => {
  it('emits --model and --effort when both present', () => {
    expect(cliModelArgs({ model: 'claude-sonnet-5', effort: 'high' })).toEqual(['--model', 'claude-sonnet-5', '--effort', 'high']);
  });
  it('drops --effort when null (haiku)', () => {
    expect(cliModelArgs({ model: 'haiku', effort: null })).toEqual(['--model', 'haiku']);
  });
  it('empty for a missing policy', () => {
    expect(cliModelArgs(null)).toEqual([]);
  });
});
