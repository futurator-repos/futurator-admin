// reps-store.test.mjs — N-rep aggregation (design §9) + the FileStore corpus backend (§8.3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarize } from '../lib/stats.mjs';
import { runReps, aggregateRuns } from '../lib/reps.mjs';
import { FileStore, createStore, DynamoStore } from '../lib/store.mjs';

test('summarize — mean/stdev/min/max', () => {
  assert.deepEqual(summarize([2, 4, 6]), { n: 3, mean: 4, stdev: 1.633, min: 2, max: 6 });
  assert.equal(summarize([]), null);
  assert.equal(summarize([5]).stdev, 0);
});

test('aggregateRuns — distributions across reps (structural + guardrail + judge)', () => {
  const runs = [
    { structural: { score: 0.8, perMetric: { pattern_match: 1, dag_shape: 0.6 } }, guardrail: { uplift: 1, sub: { agentType_routing: 1 } }, judge: { perAxis: { detail: { case1: 6, case2: 8 } } } },
    { structural: { score: 0.6, perMetric: { pattern_match: 0, dag_shape: 0.8 } }, guardrail: { uplift: 1, sub: { agentType_routing: 1 } }, judge: { perAxis: { detail: { case1: 8, case2: 6 } } } },
  ];
  const agg = aggregateRuns(runs);
  assert.equal(agg.structural.score.mean, 0.7);
  assert.equal(agg.structural.perMetric.pattern_match.mean, 0.5);
  assert.equal(agg.guardrail.uplift.mean, 1);
  assert.equal(agg.guardrail.uplift.stdev, 0);
  assert.equal(agg.judge.detail.case1.mean, 7);
  assert.equal(agg.judge.detail.case2.mean, 7);
});

test('runReps — calls runOnce n times and aggregates', async () => {
  let calls = 0;
  const out = await runReps({ n: 5, runOnce: () => { calls++; return Promise.resolve({ structural: { score: 0.5, perMetric: {} } }); } });
  assert.equal(calls, 5);
  assert.equal(out.n, 5);
  assert.equal(out.structural.score.mean, 0.5);
});

test('FileStore — round-trips a run record + lists the corpus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ur-store-'));
  const store = new FileStore(dir);
  await store.put({ runId: 'r1', structural: { score: 0.9 } });
  await store.put({ runId: 'r2', structural: { score: 0.4 } });
  assert.equal((await store.get('r1')).structural.score, 0.9);
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.get('missing'), null);
});

test('createStore — defaults to FileStore; DynamoStore refuses without config', () => {
  assert.ok(createStore({ dir: mkdtempSync(join(tmpdir(), 'ur-')) }) instanceof FileStore);
  assert.throws(() => new DynamoStore({}), /UR_RUNS_TABLE/);
});
