// judge-panel.test.mjs — blind-paired judge panel (design §7), driven by a deterministic stub judge
// so no live model is needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runJudgePanel, parseJudgeOutput, JUDGE_AXES } from '../lib/judge-panel.mjs';
import { makeDecisionPlan } from '../lib/decision-schema.mjs';

const case1 = makeDecisionPlan({ pattern: 'plan-synthesis-critique', source: 'case1-script', phases: [{ name: 'P', mode: 'sequential', fanOut: null, agents: [] }] });
const case2 = makeDecisionPlan({ pattern: 'greenfield-build', source: 'case2-planspec', phases: [{ name: 'wave-1', mode: 'parallel-barrier', fanOut: { axis: 'stories', width: 2 }, agents: [] }] });

// Stub judge that always scores A=8, B=5 (so we can verify A/B is correctly un-blinded to case1/case2).
const stubAhi = () => Promise.resolve(
  '---JUDGE---\n' + JSON.stringify(JUDGE_AXES.map((axis) => ({ axis, A: 8, B: 5, justification: 'because' }))) + '\n---END_JUDGE---',
);

test('parseJudgeOutput — drops a score with no justification (honesty rule)', () => {
  const raw = '---JUDGE---' + JSON.stringify([
    { axis: 'detail', A: 9, B: 4, justification: 'clear' },
    { axis: 'completeness', A: 7, B: 6, justification: '' }, // no justification → dropped
  ]) + '---END_JUDGE---';
  const out = parseJudgeOutput(raw);
  assert.equal(out.detail.A, 9);
  assert.equal(out.completeness.A, null);
  assert.equal(out.completeness.B, null);
});

test('blind un-mapping — even seed ⇒ case1=A; A-favoring judge lifts case1', async () => {
  const r = await runJudgePanel({ case1, case2, seed: 0, runJudge: stubAhi });
  assert.equal(r.blind.case1, 'A');
  assert.equal(r.perAxis.detail.case1, 8); // A score → case1
  assert.equal(r.perAxis.detail.case2, 5); // B score → case2
});

test('blind un-mapping — odd seed ⇒ case1=B; same judge now lifts case2', async () => {
  const r = await runJudgePanel({ case1, case2, seed: 1, runJudge: stubAhi });
  assert.equal(r.blind.case1, 'B');
  assert.equal(r.perAxis.detail.case1, 5); // B score → case1
  assert.equal(r.perAxis.detail.case2, 8); // A score → case2
});

test('outlier rejection — one wild judge among three is dropped', async () => {
  const scores = [8, 8, 1]; // third judge is an outlier on A
  let i = 0;
  const runJudge = () => {
    const A = scores[i++];
    return Promise.resolve('---JUDGE---' + JSON.stringify([{ axis: 'detail', A, B: 5, justification: 'x' }]) + '---END_JUDGE---');
  };
  const r = await runJudgePanel({ case1, case2, seed: 0, judges: 3, runJudge, axes: ['detail'] });
  assert.equal(r.perAxis.detail.case1, 8); // outlier (1) dropped → mean(8,8)=8, not mean(8,8,1)=5.67
});

test('panel collects justifications for the distillation corpus', async () => {
  const r = await runJudgePanel({ case1, case2, seed: 0, runJudge: stubAhi });
  assert.ok(r.notes.length > 0);
  assert.ok(r.notes.every((n) => /^\[\w+\]/.test(n)));
});
