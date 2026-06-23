// scoring.test.mjs — guardrail uplift (design §8) + ScorecardSlice emit (the persist mapping).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { case2ToDecision } from '../lib/case2-to-decision.mjs';
import { guardrailUplift } from '../lib/guardrail-uplift.mjs';
import { emitSlices, verdictForScore } from '../lib/scorecard-emit.mjs';
import { sliceScore } from '../lib/structural-diff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const planOutput = JSON.parse(readFileSync(resolve(here, 'fixtures/sample-plan-output.json'), 'utf8'));

test('guardrail uplift — a fully-typed production plan scores high', () => {
  const c2 = case2ToDecision(planOutput, { target: 'greenfield', rigor: 'production' });
  const g = guardrailUplift(c2, planOutput, { validatorPassed: true });
  assert.equal(g.sub.agentType_routing, 1); // every story typed
  assert.equal(g.sub.test_tier, 1); // every agent has L2
  assert.equal(g.sub.acceptance_criteria > 0.9, true); // all stories have AC + verify intent
  assert.equal(g.sub.validator_conformance, 1);
  assert.ok(g.uplift > 0.9 && g.uplift <= 1);
});

test('guardrail uplift — failed validator drags conformance to 0', () => {
  const c2 = case2ToDecision(planOutput, { rigor: 'mvp' });
  const g = guardrailUplift(c2, planOutput, { validatorPassed: false });
  assert.equal(g.sub.validator_conformance, 0);
  assert.ok(g.uplift < 1);
});

test('verdictForScore matches the daemon mapping', () => {
  assert.equal(verdictForScore(null), '⚪');
  assert.equal(verdictForScore(4), '🟢');
  assert.equal(verdictForScore(2), '🟡');
  assert.equal(verdictForScore(1), '🔴');
});

test('emitSlices — produces valid ScorecardSlice rows for structural + guardrail', () => {
  const c2 = case2ToDecision(planOutput, { rigor: 'production' });
  const structural = sliceScore(c2, c2); // identical → 1.0
  const guardrail = guardrailUplift(c2, planOutput, { validatorPassed: true });
  const slices = emitSlices({ structural, guardrail, runId: 'test-run' });

  // one slice per structural metric + aggregate, plus one per guardrail sub + uplift
  const ids = slices.map((s) => s.criterionId);
  assert.ok(ids.includes('STRUCT-pattern_match'));
  assert.ok(ids.includes('STRUCT-aggregate'));
  assert.ok(ids.includes('GUARD-uplift'));

  for (const s of slices) {
    assert.equal(s.stage, 'development');
    assert.ok(['🟢', '🟡', '🔴', '⚪'].includes(s.verdict));
    assert.ok(s.score === null || (s.score >= 0 && s.score <= 4));
    assert.equal(s.evidence.kind, 'report');
    assert.ok(Array.isArray(s.ieIds) && Array.isArray(s.fixIds));
    assert.ok(s.engine === 'deterministic');
  }
  // identical structural plan → aggregate is 🟢
  assert.equal(slices.find((s) => s.criterionId === 'STRUCT-aggregate').verdict, '🟢');
});
