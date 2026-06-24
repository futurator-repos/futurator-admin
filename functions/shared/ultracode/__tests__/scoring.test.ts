import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { case2Project } from '../case2-project';
import { computeStructuralDiff, sliceScore } from '../structural-diff';
import { guardrailUplift } from '../guardrail-uplift';
import { emitSlices } from '../scorecard-emit';
import { scoreRun } from '../score-run';

// Cross-check against the verified .mjs prototype (the plain port, which itself is drift-guarded
// against the real services in spikes/). If the TS port and the .mjs agree on wave structure +
// guardrail numbers, the TS port is faithful.
import { case2ToDecision } from '../../../../spikes/ultra-reverse/lib/case2-to-decision.mjs';
import { guardrailUplift as mjsGuardrail } from '../../../../spikes/ultra-reverse/lib/guardrail-uplift.mjs';

const planOutput = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'spikes/ultra-reverse/test/fixtures/sample-plan-output.json'),
    'utf8',
  ),
);

interface PhaseLike {
  mode: string;
  agents: unknown[];
  fanOut: { width: number | string } | null;
}
const waveShape = (p: { phases: PhaseLike[] }) =>
  p.phases.map((ph) => ({ mode: ph.mode, n: ph.agents.length, width: ph.fanOut?.width ?? null }));

describe('case2Project (TS) vs the .mjs prototype', () => {
  it('produces the SAME collision-aware wave structure', () => {
    const ts = case2Project(planOutput, { target: 'greenfield', rigor: 'production' }).plan;
    const mjs = case2ToDecision(planOutput, { target: 'greenfield', rigor: 'production' });
    expect(waveShape(ts)).toEqual(waveShape(mjs));
    expect(ts.pattern).toBe('greenfield-build');
  });

  it('resolves real capability scoping per story (buildAgentConfig)', () => {
    const { capability } = case2Project(planOutput, { rigor: 'production' });
    const cfgs = Object.values(capability);
    expect(cfgs.length).toBe(5); // S1..S5
    for (const c of cfgs) {
      expect(typeof c.allowedTools).toBe('string');
      expect(c.disallowedTools).toContain('WebFetch');
      expect(Number.isInteger(c.maxTurns)).toBe(true);
    }
  });
});

describe('guardrailUplift (TS) vs the .mjs prototype', () => {
  it('matches sub-scores and headline uplift', () => {
    const tsPlan = case2Project(planOutput, { rigor: 'production' }).plan;
    const mjsPlan = case2ToDecision(planOutput, { rigor: 'production' });
    const ts = guardrailUplift(tsPlan, planOutput, { validatorPassed: true });
    const mjs = mjsGuardrail(mjsPlan, planOutput, { validatorPassed: true });
    expect(ts.uplift).toBeCloseTo(mjs.uplift, 6);
    expect(ts.sub).toEqual(mjs.sub);
  });
});

describe('structural diff (TS)', () => {
  it('identical plans score 1.0', () => {
    const p = case2Project(planOutput, { rigor: 'production' }).plan;
    expect(computeStructuralDiff(p, p).score).toBe(1);
    expect(sliceScore(p, p).score).toBe(1);
  });
});

describe('emitSlices + scoreRun', () => {
  it('emits valid ScorecardSlices', () => {
    const p = case2Project(planOutput, { rigor: 'production' }).plan;
    const structural = sliceScore(p, p);
    const guardrail = guardrailUplift(p, planOutput, { validatorPassed: true });
    const slices = emitSlices({ structural, guardrail, runId: 'r1' });
    expect(slices.some((s) => s.criterionId === 'GUARD-uplift')).toBe(true);
    for (const s of slices) {
      expect(['🟢', '🟡', '🔴', '⚪']).toContain(s.verdict);
      expect(s.engine).toBe('deterministic');
    }
  });

  it('scoreRun (M2 path, no Case-1) returns a guardrail-bearing scorecard', () => {
    const out = scoreRun({
      runId: 'r2',
      planOutput,
      ctx: { target: 'greenfield', rigor: 'production' },
    });
    expect(out.case2Pattern).toBe('greenfield-build');
    expect(out.guardrailUplift).toBeGreaterThan(0.9);
    expect(out.scorecard.verdict).toBe('awaiting-case1'); // no Case-1 captured in M2
    expect(out.scorecard.slices.length).toBeGreaterThan(0);
  });
});
