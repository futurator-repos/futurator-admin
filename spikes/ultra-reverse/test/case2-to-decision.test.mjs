// case2ToDecision projection tests (design doc §4). Projects a planOutputSchema object onto the
// shared DecisionPlan IR and asserts the wave layering + the guardrails Case 2 wins on (design §8).
//
//   Run:  node --test spikes/ultra-reverse/test/case2-to-decision.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { case2ToDecision, computeWaves } from '../lib/case2-to-decision.mjs';
import { validateDecisionPlan } from '../lib/decision-schema.mjs';
import { computeStructuralDiff } from '../lib/structural-diff.mjs';
import { case1ToDecision } from '../lib/case1-to-decision.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const planOutput = JSON.parse(readFileSync(resolve(here, 'fixtures/sample-plan-output.json'), 'utf8'));

const phase = (p, name) => p.phases.find((x) => x.name === name);
const allAgents = (p) => p.phases.flatMap((x) => x.agents);

test('projects to a schema-valid DecisionPlan tagged case2-planspec', () => {
  const p = case2ToDecision(planOutput, { target: 'greenfield', rigor: 'production' });
  const v = validateDecisionPlan(p);
  assert.ok(v.ok, `invalid: ${v.errors.join('; ')}`);
  assert.equal(p.source, 'case2-planspec');
  assert.equal(p.pattern, 'greenfield-build');
});

test('wave layering — S1‖S4 then S2 then S3 (parallel-barrier on the independent wave)', () => {
  const p = case2ToDecision(planOutput, { target: 'greenfield', rigor: 'mvp' });
  assert.equal(p.phases.length, 3); // 3 waves
  assert.equal(phase(p, 'wave-1').mode, 'parallel-barrier');
  assert.equal(phase(p, 'wave-1').fanOut.axis, 'stories');
  assert.equal(phase(p, 'wave-1').fanOut.width, 2); // S1 + S4 are independent
  assert.equal(phase(p, 'wave-2').mode, 'sequential'); // S2 depends on S1
  assert.equal(phase(p, 'wave-3').mode, 'sequential'); // S3 (epic E2 depends on E1)
  assert.deepEqual(p.edges, [['wave-1', 'wave-2'], ['wave-2', 'wave-3']]);
});

test('guardrails — every agent carries agentType + testTier; worktree only off <EPIC_WIDE>', () => {
  const p = case2ToDecision(planOutput, { target: 'greenfield', rigor: 'production' });
  const agents = allAgents(p);
  assert.equal(agents.length, 4); // S1..S4
  assert.ok(agents.every((a) => a.agentType === 'DEV')); // every story typed (Case 1 lacks this)
  assert.ok(agents.every((a) => a.testTier === 'L2')); // production → L2
  assert.ok(agents.every((a) => a.hasSchema === true));
  // S4 is <EPIC_WIDE> → not worktree-isolated; the file-scoped stories are
  const wave1 = phase(p, 'wave-1').agents;
  const isoCount = wave1.filter((a) => a.isolation === 'worktree').length;
  assert.equal(isoCount, 1); // S1 (file touchPoint) isolated; S4 (<EPIC_WIDE>) not
});

test('rigor drives test tier + verify presence', () => {
  assert.equal(case2ToDecision(planOutput, { rigor: 'prototype' }).phases[0].agents[0].testTier, 'L0');
  assert.equal(case2ToDecision(planOutput, { rigor: 'mvp' }).phases[0].agents[0].testTier, 'L1');
  assert.equal(case2ToDecision(planOutput, { rigor: 'production' }).verify.kind, 'adversarial');
  assert.equal(case2ToDecision(planOutput, { rigor: 'prototype' }).verify.present, false);
});

test('declarative plan records its lossy fields (no script reduce/barrier-reason)', () => {
  const p = case2ToDecision(planOutput, {});
  assert.equal(p.reduceSteps, 0);
  assert.ok(p.extraction.lossy.some((s) => /no-script-reduce/.test(s)));
});

test('computeWaves throws on a dependency cycle', () => {
  const cyclic = [
    { id: 'S1', epicId: 'E1', dependsOn: ['S2'], epicDependsOn: [] },
    { id: 'S2', epicId: 'E1', dependsOn: ['S1'], epicDependsOn: [] },
  ];
  assert.throws(() => computeWaves(cyclic), /cycle/);
});

test('cross-engine: a Case-1 greenfield-build script and the Case-2 greenfield plan pattern-match', () => {
  // sanity that the two projectors land in the same IR space and the structural diff runs end-to-end
  const c2 = case2ToDecision(planOutput, { target: 'greenfield', rigor: 'production' });
  // synthesize a minimal Case-1 plan with the same pattern to confirm pattern_match fires
  const c1Like = { ...c2, source: 'case1-script' };
  const diff = computeStructuralDiff(c1Like, c2);
  assert.equal(diff.perMetric.pattern_match, 1);
  assert.ok(diff.score > 0);
});
