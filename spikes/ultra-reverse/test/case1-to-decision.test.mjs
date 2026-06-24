// Round-trip tests (design doc §3.2): run case1ToDecision on the REAL spikes/v3-hybrid workflow
// scripts and assert the known structure. Zero test framework — node's built-in runner.
//
//   Run:  npm i   (once, to get `typescript` into node_modules)
//         node --test spikes/ultra-reverse/test/
//
// These are the parser's acceptance fixtures. If a future CLI version changes the script surface,
// re-confirm here (preview drift — design doc §10.6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { case1ToDecision } from '../lib/case1-to-decision.mjs';
import { validateDecisionPlan } from '../lib/decision-schema.mjs';
import { computeStructuralDiff, sliceScore } from '../lib/structural-diff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WF = resolve(here, '../../v3-hybrid'); // spikes/v3-hybrid
const load = (rel) => case1ToDecision(readFileSync(resolve(WF, rel), 'utf8'));

const phaseNames = (p) => p.phases.map((x) => x.name);
const phase = (p, name) => p.phases.find((x) => x.name === name);

test('every fixture produces a schema-valid DecisionPlan', () => {
  for (const rel of [
    'workflows/plan.workflow.js',
    'workflows/dev.workflow.js',
    'workflows/review.workflow.js',
    'probes/E1-plan-swarm/epic-elicitation.workflow.js',
    'probes/C1-fixswarm/fixswarm.workflow.js',
  ]) {
    const plan = load(rel);
    const v = validateDecisionPlan(plan);
    assert.ok(v.ok, `${rel} invalid: ${v.errors.join('; ')}`);
    assert.equal(plan.source, 'case1-script');
  }
});

test('plan.workflow.js — Scout→Plan, scout-first ⇒ brownfield-harden', () => {
  const p = load('workflows/plan.workflow.js');
  assert.deepEqual(phaseNames(p), ['Scout', 'Plan']);
  assert.equal(p.pattern, 'brownfield-harden'); // scout/grounding phase at position 0
  assert.equal(phase(p, 'Scout').agents[0].hasSchema, false); // scout has no schema
  assert.equal(phase(p, 'Plan').agents[0].hasSchema, true); // PLAN_SCHEMA
  assert.equal(phase(p, 'Plan').agents[0].model, 'sonnet');
  assert.deepEqual(p.edges, [['Scout', 'Plan']]);
});

test('dev.workflow.js — parallel-barrier fan-out over stories, schema-typed, 1 reduce', () => {
  const p = load('workflows/dev.workflow.js');
  assert.deepEqual(phaseNames(p), ['Dev']);
  const dev = phase(p, 'Dev');
  assert.equal(dev.mode, 'parallel-barrier');
  assert.equal(dev.fanOut.axis, 'stories');
  assert.equal(dev.fanOut.width, 'dynamic'); // runtime array → excluded from fanout_width_delta
  assert.equal(dev.agents[0].hasSchema, true);
  assert.equal(dev.agents[0].model, 'sonnet');
  assert.equal(dev.agents[0].isolation, 'none');
  assert.equal(p.reduceSteps, 1); // results.filter(Boolean)
  // dynamic width must be recorded as a lossy field, not silently zeroed
  assert.ok(p.extraction.lossy.some((s) => /dynamic-fanout-width/.test(s)));
});

test('review.workflow.js — single sequential gate ⇒ verify present, kind none', () => {
  const p = load('workflows/review.workflow.js');
  assert.deepEqual(phaseNames(p), ['Review']);
  assert.equal(phase(p, 'Review').mode, 'sequential');
  assert.equal(phase(p, 'Review').agents[0].hasSchema, true);
  assert.equal(p.verify.present, true);
  assert.equal(p.verify.kind, 'none'); // not a named multi-agent verify pattern
});

test('epic-elicitation.workflow.js — Breakdown→Decompose ⇒ plan-synthesis-critique', () => {
  const p = load('probes/E1-plan-swarm/epic-elicitation.workflow.js');
  assert.deepEqual(phaseNames(p), ['Breakdown', 'Decompose']);
  assert.equal(p.pattern, 'plan-synthesis-critique');
  const dec = phase(p, 'Decompose');
  assert.equal(dec.mode, 'parallel-barrier');
  assert.equal(dec.fanOut.axis, 'epics'); // breakdown.epics.map(...)
  assert.equal(dec.agents[0].hasSchema, true);
  assert.equal(p.reduceSteps, 1); // subtrees.filter(Boolean)
});

test('fixswarm.workflow.js — Fix→Refute, worktree isolation, adversarial verify', () => {
  const p = load('probes/C1-fixswarm/fixswarm.workflow.js');
  assert.deepEqual(phaseNames(p), ['Fix', 'Refute']);
  const fix = phase(p, 'Fix');
  const refute = phase(p, 'Refute');
  assert.equal(fix.mode, 'parallel-barrier');
  assert.equal(fix.agents[0].isolation, 'worktree');
  assert.equal(fix.agents[0].model, 'sonnet');
  assert.equal(refute.agents[0].model, 'opus'); // model escalation on the verify pass
  assert.equal(refute.agents[0].isolation, 'worktree');
  assert.equal(p.verify.kind, 'adversarial'); // refuters + ACCEPT/REJECT verdict + fan-out
  assert.ok(p.qualityPatterns.includes('adversarial-verification'));
  assert.ok(p.qualityPatterns.includes('fan-out-and-synthesize'));
});

test('structural diff — identical plans score 1.0; the slice scorer uses 2 metrics', () => {
  const a = load('probes/E1-plan-swarm/epic-elicitation.workflow.js');
  const full = computeStructuralDiff(a, a);
  assert.equal(full.score, 1);
  assert.equal(full.perMetric.pattern_match, 1);

  const s = sliceScore(a, a);
  assert.deepEqual(Object.keys(s.perMetric).sort(), ['dag_shape', 'pattern_match']);
  assert.equal(s.score, 1);

  // a plan-synthesis plan vs a brownfield plan must NOT pattern-match
  const b = load('workflows/plan.workflow.js');
  assert.equal(computeStructuralDiff(a, b).perMetric.pattern_match, 0);
});
