#!/usr/bin/env node
// run-slice.mjs — the §9.1 vertical slice driver: normalize BOTH engines → score → emit a scorecard.
// (Live Case-1 capture is the only piece not wired here; pass a captured script/.js to stand in.)
//
//   node spikes/ultra-reverse/bin/run-slice.mjs \
//     --case1 spikes/v3-hybrid/probes/E1-plan-swarm/epic-elicitation.workflow.js \
//     --case2 spikes/ultra-reverse/test/fixtures/sample-plan-output.json \
//     --target greenfield --rigor production --out /tmp/ultra-reverse-runs
//
// --case1 accepts a raw workflow `.js` OR a `*.case1.json` produced by capture/script-capture.mjs.

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { case1ToDecision } from '../lib/case1-to-decision.mjs';
import { case2ToDecisionReal } from '../lib/case2-to-decision-real.mjs';
import { sliceScore } from '../lib/structural-diff.mjs';
import { guardrailUplift } from '../lib/guardrail-uplift.mjs';
import { emitSlices } from '../lib/scorecard-emit.mjs';
import { validateDecisionPlan } from '../lib/decision-schema.mjs';
import { createStore } from '../lib/store.mjs';

const a = parseArgs(process.argv.slice(2));
if (!a.case1 || !a.case2) {
  console.error('usage: run-slice.mjs --case1 <script.js|*.case1.json> --case2 <planOutput.json> [--target] [--rigor] [--out dir]');
  process.exit(2);
}

// ── Case 1: load script (raw .js or captured json) → DecisionPlan ──────────────
const case1Raw = readFileSync(resolve(a.case1), 'utf8');
const scriptJs = a.case1.endsWith('.json') ? JSON.parse(case1Raw).scriptJs : case1Raw;
const c1 = case1ToDecision(scriptJs);

// ── Case 2: planOutput → DecisionPlan ──────────────────────────────────────────
const planOutput = JSON.parse(readFileSync(resolve(a.case2), 'utf8'));
const ctx = { target: a.target ?? 'greenfield', rigor: a.rigor ?? 'production' };
const c2 = await case2ToDecisionReal(planOutput, ctx); // deployed-fidelity layering (falls back to plain port)

for (const [label, plan] of [['case1', c1], ['case2', c2]]) {
  const v = validateDecisionPlan(plan);
  if (!v.ok) { console.error(`✗ ${label} produced an invalid DecisionPlan: ${v.errors.join('; ')}`); process.exit(1); }
}

// ── score: structural slice (pattern_match + dag_shape) + guardrail uplift ──────
const structural = sliceScore(c1, c2);
const guardrail = guardrailUplift(c2, planOutput, { validatorPassed: true });

const runId = `slice-${basename(a.case1).replace(/\.[^.]+$/, '')}-${Date.now()}`;
const slices = emitSlices({ structural, guardrail, runId });

// ── persist via the pluggable store (FileStore locally; DynamoDB+S3 when configured, §8.3) ──────
const outDir = a.out ?? join(process.cwd(), 'ultra-reverse-runs');
const store = createStore({ dir: outDir });
const record = { runId, ctx, structural, guardrail, slices, case1: c1, case2: c2, capturedAt: new Date().toISOString() };
const outPath = await store.put(record);

// ── report ──────────────────────────────────────────────────────────────────────
console.log(`\n▸ ultra-reverse slice — ${runId}`);
console.log(`  case1 pattern: ${c1.pattern}   case2 pattern: ${c2.pattern}`);
console.log(`  structural (pattern_match + dag_shape): ${structural.score.toFixed(3)}`);
for (const [m, v] of Object.entries(structural.perMetric)) console.log(`    ${m.padEnd(16)} ${v.toFixed(3)}`);
console.log(`  guardrail uplift (Case-2 axis): ${guardrail.uplift.toFixed(3)}`);
for (const [k, v] of Object.entries(guardrail.sub)) console.log(`    ${k.padEnd(22)} ${v.toFixed(3)}`);
console.log(`  scorecard slices: ${slices.length}  ${slices.map((s) => s.verdict).join('')}`);
console.log(`  saved → ${outPath}\n`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) out[k.slice(2)] = argv[++i];
  }
  return out;
}
