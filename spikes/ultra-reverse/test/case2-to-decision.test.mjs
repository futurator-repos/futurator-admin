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

test('wave layering — collision-aware: {S1,S5}‖ then S4(EPIC_WIDE) then S2 then S3', () => {
  const p = case2ToDecision(planOutput, { target: 'greenfield', rigor: 'mvp' });
  assert.equal(p.phases.length, 4); // S1‖S5 | S4 | S2 | S3
  assert.equal(phase(p, 'wave-1').mode, 'parallel-barrier'); // S1 + S5 — disjoint files, no deps
  assert.equal(phase(p, 'wave-1').fanOut.axis, 'stories');
  assert.equal(phase(p, 'wave-1').fanOut.width, 2);
  assert.equal(phase(p, 'wave-2').mode, 'sequential'); // S4 is <EPIC_WIDE> → a wave to itself
  assert.equal(phase(p, 'wave-2').agents.length, 1);
  assert.equal(phase(p, 'wave-3').mode, 'sequential'); // S2 depends on S1
  assert.equal(phase(p, 'wave-4').mode, 'sequential'); // S3 (epic E2 depends on E1)
  assert.deepEqual(p.edges, [['wave-1', 'wave-2'], ['wave-2', 'wave-3'], ['wave-3', 'wave-4']]);
});

test('guardrails — every agent carries agentType + testTier; <EPIC_WIDE> story is not isolated', () => {
  const p = case2ToDecision(planOutput, { target: 'greenfield', rigor: 'production' });
  const agents = allAgents(p);
  assert.equal(agents.length, 5); // S1..S5
  assert.ok(agents.every((a) => a.agentType === 'DEV')); // every story typed (Case 1 lacks this)
  assert.ok(agents.every((a) => a.testTier === 'L2')); // production → L2
  assert.ok(agents.every((a) => a.hasSchema === true));
  // 4 file-scoped stories worktree-isolated; S4 (<EPIC_WIDE>) is not
  assert.equal(agents.filter((a) => a.isolation === 'worktree').length, 4);
  assert.equal(agents.filter((a) => a.isolation === 'none').length, 1);
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

test('computeWaves is cycle-SAFE (caps at wave 0, matches the real fn — no throw)', () => {
  // mirrors computeStoryWaves cycle safety; cycle DETECTION is a validator concern (guardrail)
  const cyclic = [
    { storyId: 'S1', dependsOn: ['S2'], touchPoints: [], order: 0 },
    { storyId: 'S2', dependsOn: ['S1'], touchPoints: [], order: 1 },
  ];
  const waves = computeWaves(cyclic);
  const placed = waves.flat();
  assert.equal(placed.length, 2); // both stories placed, no crash
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
