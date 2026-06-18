/**
 * scorecard-assess-job-runner.test.mjs — Plan Retrospect / The Assessor
 * (plan-retrospect-spec §4b).
 *
 * Tests the job-row lifecycle wrapper for the Assessor. All deps injected —
 * no Claude spawn, no DDB. Focus: validation, the honesty guard (verbatim-quote
 * requirement + ⚪ backfill), and the read → grade → persist routing.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validateScorecardAssessJob,
  parseAssessorOutput,
  buildAssessorPrompt,
  runScorecardAssessJob,
} from '../scorecard-assess-job-runner.mjs';

function makeJob(over = {}) {
  return {
    jobId: 'assess-job-1',
    jobType: 'scorecard-assess',
    scorecardAssessPayload: {
      planId: 'plan-1',
      stage: 'development',
      rubricVersion: 'v0',
      pipelineVersion: 'sha-abc',
      deterministicSliceRef: 'development#v0',
    },
    ...over,
  };
}

function makeDeps(over = {}) {
  return {
    loadDeterministicSlice: vi.fn().mockResolvedValue({
      rubricSlice: 'D-DV1: AC satisfaction (0-4). D-DV2: scope.',
      deterministicContext: 'D-CC1 🔴 (compile thrash 29%)',
      criterionIds: ['D-DV1', 'D-DV2'],
      planSummary: 'snake game, mvp',
    }),
    runAgentStep: vi.fn().mockResolvedValue({
      output:
        '---ASSESSOR---\n[' +
        '{"criterionId":"D-DV1","score":3,"evidence":"AC-2: paddle moves on key press — diff adds onKeyDown handler","note":"all ACs touched"},' +
        '{"criterionId":"D-DV2","score":4,"evidence":"diff touches only src/game/*","note":"scoped"}' +
        ']\n---END_ASSESSOR---',
      tokensConsumed: 1234,
    }),
    writeAssessorSlices: vi.fn().mockResolvedValue(undefined),
    pushEvent: vi.fn().mockResolvedValue(undefined),
    writeAttentionItem: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('validateScorecardAssessJob', () => {
  it('accepts a well-formed job', () => {
    expect(validateScorecardAssessJob(makeJob())).toEqual({ ok: true });
  });

  it.each([
    ['no job', null, 'job-missing'],
    ['wrong jobType', { jobType: 'reflector' }, 'jobType-mismatch'],
    ['no jobId', { jobType: 'scorecard-assess', scorecardAssessPayload: {} }, 'jobId-missing'],
  ])('rejects %s', (_l, j, reason) => {
    expect(validateScorecardAssessJob(j)).toEqual({ ok: false, reason });
  });

  it('rejects invalid stage', () => {
    const j = makeJob();
    j.scorecardAssessPayload.stage = 'rogue';
    expect(validateScorecardAssessJob(j).reason).toBe('stage-invalid');
  });

  it('rejects missing planId', () => {
    const j = makeJob();
    j.scorecardAssessPayload.planId = '';
    expect(validateScorecardAssessJob(j).reason).toBe('planId-missing');
  });

  it('rejects missing rubricVersion', () => {
    const j = makeJob();
    j.scorecardAssessPayload.rubricVersion = '';
    expect(validateScorecardAssessJob(j).reason).toBe('rubricVersion-missing');
  });
});

describe('parseAssessorOutput — honesty guard', () => {
  it('parses a well-formed block', () => {
    const out = parseAssessorOutput(
      '---ASSESSOR---\n[{"criterionId":"Q-C1","score":2,"evidence":"claim: button exists","note":"ok"}]\n---END_ASSESSOR---',
      ['Q-C1'],
    );
    expect(out).toEqual([
      { criterionId: 'Q-C1', score: 2, verdict: '🟡', evidence: 'claim: button exists', note: 'ok' },
    ]);
  });

  it('downgrades a numeric score with NO evidence quote to ⚪ needs-instrumentation (never trust an uncited score)', () => {
    const out = parseAssessorOutput(
      '[{"criterionId":"Q-C2","score":4,"evidence":"","note":"looks fine"}]',
      ['Q-C2'],
    );
    expect(out[0].score).toBeNull();
    expect(out[0].verdict).toBe('⚪');
    expect(out[0].note).toMatch(/needs-instrumentation/);
  });

  it('drops hallucinated criterion ids not in the expected set', () => {
    const out = parseAssessorOutput(
      '[{"criterionId":"NOT-A-REAL-ID","score":4,"evidence":"x"}]',
      ['Q-C1'],
    );
    expect(out).toEqual([]);
  });

  it('maps score bands to verdicts (4→🟢, 2-3→🟡, 0-1→🔴)', () => {
    const out = parseAssessorOutput(
      '[{"criterionId":"A","score":4,"evidence":"q"},{"criterionId":"B","score":2,"evidence":"q"},{"criterionId":"C","score":0,"evidence":"q"}]',
      ['A', 'B', 'C'],
    );
    expect(out.map((s) => s.verdict)).toEqual(['🟢', '🟡', '🔴']);
  });

  it('returns [] on non-JSON / missing block', () => {
    expect(parseAssessorOutput('no json here', ['A'])).toEqual([]);
    expect(parseAssessorOutput('', ['A'])).toEqual([]);
  });
});

describe('buildAssessorPrompt', () => {
  it('embeds the never-invent-metrics role + criterion ids + read-set', () => {
    const p = buildAssessorPrompt({
      stage: 'qa',
      rubricVersion: 'v0',
      criterionIds: ['Q-C1', 'Q-C2'],
      rubricSlice: 'Q-C1 ...',
      deterministicContext: 'Q-C6 🟢',
      planSummary: 'sum',
    });
    expect(p).toMatch(/You are The Assessor/);
    expect(p).toMatch(/never invent metrics|deterministic scores below are authoritative/i);
    expect(p).toMatch(/Q-C1, Q-C2/);
    expect(p).toMatch(/qa-report/);
    expect(p).toMatch(/---ASSESSOR---/);
  });
});

describe('runScorecardAssessJob', () => {
  it('happy path: load → grade → persist; emits an event; never fabricates', async () => {
    const deps = makeDeps();
    const res = await runScorecardAssessJob(makeJob(), deps);
    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(res.sliceCount).toBe(2);
    expect(res.gradedCount).toBe(2);

    expect(deps.loadDeterministicSlice).toHaveBeenCalledOnce();
    expect(deps.runAgentStep).toHaveBeenCalledOnce();
    expect(deps.pushEvent).toHaveBeenCalledOnce();
    expect(deps.writeAssessorSlices).toHaveBeenCalledOnce();

    const written = deps.writeAssessorSlices.mock.calls[0][0];
    expect(written.stage).toBe('development');
    expect(written.scoredBy).toBe('assessor:assess-job-1');
    expect(written.slices).toHaveLength(2);
    expect(written.slices[0].engine).toBe('assessor');
    expect(written.slices[0].evidence.kind).toBe('artifact');
  });

  it('backfills an omitted criterion as ⚪ needs-instrumentation (not a 0)', async () => {
    const deps = makeDeps({
      runAgentStep: vi.fn().mockResolvedValue({
        output:
          '---ASSESSOR---\n[{"criterionId":"D-DV1","score":3,"evidence":"AC-2 handler added"}]\n---END_ASSESSOR---',
      }),
    });
    const res = await runScorecardAssessJob(makeJob(), deps);
    expect(res.ok).toBe(true);
    expect(res.gradedCount).toBe(1);
    const slices = deps.writeAssessorSlices.mock.calls[0][0].slices;
    const dv2 = slices.find((s) => s.criterionId === 'D-DV2');
    expect(dv2.score).toBeNull();
    expect(dv2.verdict).toBe('⚪');
    expect(dv2.note).toMatch(/needs-instrumentation/);
  });

  it('gates behind agent.paused without spawning the agent', async () => {
    const deps = makeDeps({ paused: true });
    const res = await runScorecardAssessJob(makeJob(), { ...deps, paused: true });
    expect(res).toEqual({ ok: true, status: 'gated', reason: 'agent.paused' });
    expect(deps.runAgentStep).not.toHaveBeenCalled();
  });

  it('returns no-llm-criteria for a stage with no [LLM] rows (e.g. deployment)', async () => {
    const deps = makeDeps({
      loadDeterministicSlice: vi.fn().mockResolvedValue({
        rubricSlice: '',
        deterministicContext: 'DP-S1 🟢',
        criterionIds: [],
      }),
    });
    const job = makeJob({
      scorecardAssessPayload: {
        planId: 'plan-1',
        stage: 'deployment',
        rubricVersion: 'v0',
      },
    });
    const res = await runScorecardAssessJob(job, deps);
    expect(res).toMatchObject({ ok: true, status: 'no-llm-criteria', sliceCount: 0 });
    expect(deps.runAgentStep).not.toHaveBeenCalled();
  });

  it('fails with a clear reason when the deterministic slice is missing', async () => {
    const deps = makeDeps({ loadDeterministicSlice: vi.fn().mockResolvedValue(null) });
    const res = await runScorecardAssessJob(makeJob(), deps);
    expect(res).toMatchObject({ ok: false, reason: 'deterministic-slice-missing' });
  });

  it('surfaces an attention item + fails when the agent step throws', async () => {
    const deps = makeDeps({
      runAgentStep: vi.fn().mockRejectedValue(new Error('spawn boom')),
    });
    const res = await runScorecardAssessJob(makeJob(), deps);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('agent-step-failed');
    expect(deps.writeAttentionItem).toHaveBeenCalledOnce();
  });

  it('rejects a malformed job before doing any work', async () => {
    const deps = makeDeps();
    const res = await runScorecardAssessJob({ jobType: 'wrong' }, deps);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/validation/);
    expect(deps.loadDeterministicSlice).not.toHaveBeenCalled();
  });
});
