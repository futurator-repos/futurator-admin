import { describe, it, expect } from 'vitest';
import { runStoryBindings } from '../test-binding-runner.mjs';
import { evaluateCompletion } from '../completion-gate.mjs';

const bound = (id, kind = 'unit', over = {}) => ({
  id, text: `${id}`, acClass: 'deterministic',
  testBinding: { status: 'bound', testRef: `ref-${id}`, testKind: kind }, ...over,
});

describe('runStoryBindings', () => {
  it('flips bound→passing/failing and stamps headSha', async () => {
    const { acceptanceCriteria, summary } = await runStoryBindings({
      acceptanceCriteria: [bound('a'), bound('b')],
      headSha: 'SHA1',
      executors: { unit: async (ac) => ({ passed: ac.id === 'a' }) },
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('passing');
    expect(acceptanceCriteria[0].testBinding.lastRunSha).toBe('SHA1');
    expect(acceptanceCriteria[1].testBinding.status).toBe('failing');
    expect(summary).toEqual({ ran: 2, passed: 1, failed: 1, skipped: 0 });
  });

  it('skips unbound and manual ACs (left for the gate / human)', async () => {
    const { summary } = await runStoryBindings({
      acceptanceCriteria: [
        { id: 'u', testBinding: { status: 'unbound' } },
        { id: 'm', verify: 'manual', testBinding: { status: 'bound', testRef: 'r', testKind: 'manual' } },
      ],
      headSha: 'SHA1',
    });
    expect(summary.skipped).toBe(2);
    expect(summary.ran).toBe(0);
  });

  it('a throwing executor is a fail, not a crash', async () => {
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [bound('a')],
      headSha: 'SHA1',
      executors: { unit: async () => { throw new Error('boom'); } },
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('failing');
    expect(acceptanceCriteria[0].testBinding.detail).toMatch(/boom/);
  });

  it('end-to-end: run → evaluateCompletion reports done when all pass at headSha', async () => {
    const headSha = 'SHA9';
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [bound('a'), bound('b')],
      headSha,
      executors: { unit: async () => ({ passed: true }) },
    });
    const verdict = evaluateCompletion({ acceptanceCriteria, currentHeadSha: headSha });
    expect(verdict.status).toBe('done');
  });
});
