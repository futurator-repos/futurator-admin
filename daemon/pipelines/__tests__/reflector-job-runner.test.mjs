/**
 * reflector-job-runner.test.mjs — Pipeline v2 Phase 3-C Epic 6
 * (2026-05-20).
 *
 * Tests the job-row lifecycle wrapper for REFLECTOR. All deps injected.
 */

import { describe, it, expect, vi } from 'vitest';
import { validateReflectorJob, runReflectorJob } from '../reflector-job-runner.mjs';

function makeJob(over = {}) {
  return {
    jobId: 'refl-job-1',
    jobType: 'reflector',
    reflectorPayload: {
      scope: 'plan',
      planId: 'plan-1',
      planSlug: 'snake-5',
      projectSlug: 'snake-5',
      rigor: 'mvp',
      epicId: null,
      waveNumber: null,
    },
    ...over,
  };
}

describe('validateReflectorJob', () => {
  it('accepts a well-formed job', () => {
    expect(validateReflectorJob(makeJob())).toEqual({ ok: true });
  });

  it.each([
    ['no job', null, 'job-missing'],
    ['wrong jobType', { jobType: 'other' }, 'jobType-mismatch'],
    ['no jobId', { jobType: 'reflector', reflectorPayload: {} }, 'jobId-missing'],
  ])('rejects %s', (_l, j, reason) => {
    expect(validateReflectorJob(j)).toEqual({ ok: false, reason });
  });

  it('rejects invalid scope', () => {
    const j = makeJob();
    j.reflectorPayload.scope = 'rogue';
    expect(validateReflectorJob(j).reason).toBe('scope-invalid');
  });

  it('rejects missing planId', () => {
    const j = makeJob();
    j.reflectorPayload.planId = '';
    expect(validateReflectorJob(j).reason).toBe('planId-missing');
  });

  it('rejects invalid rigor', () => {
    const j = makeJob();
    j.reflectorPayload.rigor = 'XXL';
    expect(validateReflectorJob(j).reason).toBe('rigor-invalid');
  });
});

describe('runReflectorJob — happy path', () => {
  it('runs agent step + writes one row per proposal', async () => {
    const writeSpy = vi.fn(async () => {});
    const pushSpy = vi.fn(async () => {});
    const r = await runReflectorJob(makeJob(), {
      runAgentStep: async () => ({
        proposals: [
          { id: 'p1', target: 'project-claude-md', rationale: 'r1' },
          { id: 'p2', target: 'project-skill', rationale: 'r2' },
        ],
        tokensConsumed: 1234,
      }),
      writeReflectionRow: writeSpy,
      pushEvent: pushSpy,
      writeAttentionItem: vi.fn(),
    });
    expect(r.ok).toBe(true);
    expect(r.proposalCount).toBe(2);
    expect(r.writtenCount).toBe(2);
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy.mock.calls[0][0].planId).toBe('plan-1');
    expect(writeSpy.mock.calls[0][0].scope).toBe('plan');
    expect(writeSpy.mock.calls[0][0].status).toBe('pending');
    // Forensic event emitted.
    const skillEvent = pushSpy.mock.calls.find(
      (call) => typeof call[3] === 'string' && call[3].startsWith('step.reflector.'),
    );
    expect(skillEvent).toBeDefined();
  });

  it('returns ok+gated when rigor matrix says no', async () => {
    const j = makeJob();
    j.reflectorPayload.scope = 'story';
    j.reflectorPayload.rigor = 'mvp'; // story-scope requires production
    const r = await runReflectorJob(j, {
      runAgentStep: vi.fn(),
      writeReflectionRow: vi.fn(),
      writeAttentionItem: vi.fn(),
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('gated');
    expect(r.reason).toMatch(/production-rigor only/);
  });

  it('emits attention + returns failed on agent throw', async () => {
    const attentionSpy = vi.fn();
    const r = await runReflectorJob(makeJob(), {
      runAgentStep: async () => {
        throw new Error('OAuth expired');
      },
      writeReflectionRow: vi.fn(),
      writeAttentionItem: attentionSpy,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('agent-step-failed');
    expect(attentionSpy).toHaveBeenCalledTimes(1);
    expect(attentionSpy.mock.calls[0][0].title).toContain('REFLECTOR plan agent step failed');
  });

  it('handles empty proposals (agent returned no signal)', async () => {
    const writeSpy = vi.fn();
    const r = await runReflectorJob(makeJob(), {
      runAgentStep: async () => ({ proposals: [], tokensConsumed: 100 }),
      writeReflectionRow: writeSpy,
    });
    expect(r.ok).toBe(true);
    expect(r.proposalCount).toBe(0);
    expect(r.writtenCount).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('does not abort when individual writeReflectionRow throws', async () => {
    let call = 0;
    const writeSpy = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('DDB hiccup');
    });
    const r = await runReflectorJob(makeJob(), {
      runAgentStep: async () => ({
        proposals: [
          { id: 'p1', target: 'claude-md' },
          { id: 'p2', target: 'project-skill' },
        ],
        tokensConsumed: 0,
      }),
      writeReflectionRow: writeSpy,
      pushEvent: async () => {},
    });
    expect(r.ok).toBe(true);
    expect(r.proposalCount).toBe(2);
    expect(r.writtenCount).toBe(1); // 1 succeeded, 1 threw
  });

  it('rejects malformed jobs via validation', async () => {
    const r = await runReflectorJob({ jobType: 'reflector' }, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('jobId-missing');
  });
});
