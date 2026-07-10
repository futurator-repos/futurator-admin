import { describe, it, expect, vi } from 'vitest';
import { validateUltracodeBenchJob, runUltracodeBenchJob } from '../ultracode-bench-job-runner.mjs';

function makeJob(overrides = {}) {
  return {
    jobId: 'run-1',
    jobType: 'ultracode-bench',
    workingDir: '/home/ubuntu/ultracode-bench/run-1',
    ultracodeBenchPayload: {
      runId: 'run-1',
      intent: 'build me a pacman game',
      reps: 1,
      ...overrides,
    },
  };
}

// DI deps that simulate a clean run without spawning claude or touching DDB.
function makeDeps(over = {}) {
  return {
    paused: false,
    captureCase1: vi.fn(async () => ({
      scriptJs: 'export const meta = {}',
      agentCount: 0,
      tainted: false,
    })),
    runCase2: vi.fn(async () => ({ scriptJs: 'export const meta = {}', planText: 'my plan' })),
    parseScript: vi.fn((js) => ({
      pattern: js.includes('case2') ? 'greenfield-build' : 'build-verify-fix',
      phases: [],
      edges: [],
    })),
    scorePlans: vi.fn(() => ({ score: 0.8, perMetric: { pattern_match: 1, dag_shape: 0.6 } })),
    pushEvent: vi.fn(async () => {}),
    updateRun: vi.fn(async () => {}),
    ...over,
  };
}

describe('validateUltracodeBenchJob', () => {
  it('accepts a well-formed job', () => {
    expect(validateUltracodeBenchJob(makeJob())).toEqual({ ok: true });
  });
  it('rejects wrong jobType / missing fields', () => {
    expect(validateUltracodeBenchJob({ jobType: 'other' }).ok).toBe(false);
    expect(validateUltracodeBenchJob(makeJob({ intent: '' })).reason).toBe('intent-missing');
    expect(validateUltracodeBenchJob(makeJob({ reps: 0 })).reason).toBe('reps-invalid');
  });
});

describe('runUltracodeBenchJob', () => {
  it('happy path → CAPTURING → SCORING → COMPLETE with a structural score', async () => {
    const deps = makeDeps();
    const out = await runUltracodeBenchJob(makeJob(), deps);
    expect(out).toMatchObject({ ok: true, reps: 1, tainted: 0 });

    // both engines spawned, both scripts parsed, scored once
    expect(deps.captureCase1).toHaveBeenCalledTimes(1);
    expect(deps.runCase2).toHaveBeenCalledTimes(1);
    expect(deps.scorePlans).toHaveBeenCalledTimes(1);

    // final updateRun writes COMPLETE + the score + a scorecard
    const final = deps.updateRun.mock.calls.at(-1)[1];
    expect(final.status).toBe('COMPLETE');
    expect(final.case1Status).toBe('HALTED');
    expect(final.structuralScore).toBe(0.8);
    expect(final.scorecard.slices.some((s) => s.criterionId === 'STRUCT-aggregate')).toBe(true);
    expect(final.case2PlanText).toBe('my plan');

    // the per-rep case2 update (before scoring) also carries the plan text
    const case2Update = deps.updateRun.mock.calls.find((c) => c[1].case2Status === 'COMPLETE')[1];
    expect(case2Update.case2PlanText).toBe('my plan');

    // live-stream events for both sides + completion
    const types = deps.pushEvent.mock.calls.map((c) => c[3]);
    expect(types).toContain('ultracode-bench.case1.halted');
    expect(types).toContain('ultracode-bench.case2.ready');
    expect(types).toContain('ultracode-bench.complete');
  });

  it('truncates an oversized case2 planText to 4000 chars before it lands on the row', async () => {
    const longPlan = 'x'.repeat(5000);
    const deps = makeDeps({
      runCase2: vi.fn(async () => ({ scriptJs: 'export const meta = {}', planText: longPlan })),
    });
    await runUltracodeBenchJob(makeJob(), deps);
    const final = deps.updateRun.mock.calls.at(-1)[1];
    expect(final.case2PlanText).toHaveLength(4000);
  });

  it('paused → no work', async () => {
    const deps = makeDeps({ paused: true });
    expect(await runUltracodeBenchJob(makeJob(), deps)).toEqual({
      ok: false,
      reason: 'agent-paused',
    });
    expect(deps.captureCase1).not.toHaveBeenCalled();
  });

  it('a tainted capture excludes the rep; all tainted → ERROR (never a fake zero)', async () => {
    const deps = makeDeps({
      captureCase1: vi.fn(async () => ({
        scriptJs: '',
        agentCount: null,
        tainted: true,
        taintReason: 'timeout',
      })),
    });
    const out = await runUltracodeBenchJob(makeJob({ reps: 2 }), deps);
    expect(out).toMatchObject({ ok: false, reason: 'all-reps-tainted', tainted: 2 });
    // Case 2 runs in PARALLEL so it IS invoked, but a tainted rep is never SCORED.
    expect(deps.scorePlans).not.toHaveBeenCalled();
    const final = deps.updateRun.mock.calls.at(-1)[1];
    expect(final.status).toBe('ERROR');
    expect(final.taintedReps).toBe(2);
  });

  it('aggregates across reps (mean of structural scores)', async () => {
    let n = 0;
    const deps = makeDeps({
      scorePlans: vi.fn(() => ({
        score: n++ === 0 ? 0.6 : 1.0,
        perMetric: { pattern_match: n === 1 ? 0 : 1 },
      })),
    });
    const out = await runUltracodeBenchJob(makeJob({ reps: 2 }), deps);
    expect(out.reps).toBe(2);
    const final = deps.updateRun.mock.calls.at(-1)[1];
    expect(final.structuralScore).toBeCloseTo(0.8, 6); // mean(0.6, 1.0)
  });

  it('one tainted + one clean → completes on the clean rep, taintedReps=1', async () => {
    let call = 0;
    const deps = makeDeps({
      captureCase1: vi.fn(async () => {
        call++;
        return call === 1
          ? { scriptJs: '', agentCount: null, tainted: true, taintReason: 'agentCount=3' }
          : { scriptJs: 'export const meta = {}', agentCount: 0, tainted: false };
      }),
    });
    const out = await runUltracodeBenchJob(makeJob({ reps: 2 }), deps);
    expect(out).toMatchObject({ ok: true, reps: 1, tainted: 1 });
    expect(deps.updateRun.mock.calls.at(-1)[1].taintedReps).toBe(1);
  });
});
