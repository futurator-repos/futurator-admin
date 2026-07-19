// p3-qa-agentic-only.test.mjs — SLICE A: the operator-triggered AGENTIC-ONLY
// path of runP3Qa (daemon/lib/p3-qa-runner.mjs).
//
// Run with the project-standard command (same contract as
// agentic-vqa-runner.test.mjs):
//   node --test lib/__tests__/p3-qa-agentic-only.test.mjs
//
// NO network, NO playwright, NO real agentic lane: `runAgentic` is INJECTED as a
// recording spy and `spawnJudge` is a spy that MUST NOT fire (the deterministic
// journeys + VQA judge are skipped on an agentic-only run). Assertions cover:
//   1. agenticOnly skips the deterministic lanes and runs ONLY the agentic lane.
//   2. merge-not-clobber: same SHA → merged:true, no note.
//   3. SHA mismatch (and no-verdict) → merged:false + a fresh-report note.
//   4. the backend-mode override reaches runAgenticVqa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runP3Qa } from '../p3-qa-runner.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** Recording spy for the injected agentic lane. Returns a canned report. */
function makeRunAgenticSpy(report) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return report ?? { mode: 'headless', model: 'claude-sonnet-5', runs: [] };
  };
  fn.calls = calls;
  return fn;
}

// ── 1. skips deterministic lanes, runs ONLY the agentic lane ──────────────────

test('agenticOnly skips the deterministic journeys + VQA judge, runs only the agentic lane', async () => {
  const runAgentic = makeRunAgenticSpy({
    mode: 'headless',
    model: 'claude-sonnet-5',
    runs: [
      { journeyId: 'j1', instruction: 'x', verdict: 'pass', findings: [], frameUrls: [], steps: 2, durationMs: 10 },
    ],
  });
  let judgeCalls = 0;
  const spawnJudge = async () => {
    judgeCalls += 1;
    return { ok: true, verdict: 'pass', rationale: '' };
  };

  const result = await runP3Qa({
    plan: { planId: 'p1', devUrl: 'https://dev.example/apps/x', qaCommitSha: SHA_A },
    stories: [],
    journeys: [{ id: 'j1', title: 'Smoke', narrative: 'Open the app.', acRefs: [] }],
    playwright: { chromium: {} }, // present but must NOT be used
    spawnJudge, // must NOT be called on an agentic-only run
    agenticOnly: true,
    agenticBackendMode: 'headless',
    runAgentic,
    env: {},
  });

  assert.equal(result.agenticOnly, true);
  assert.equal(judgeCalls, 0, 'the VQA judge must not run on an agentic-only pass');
  assert.equal(runAgentic.calls.length, 1, 'the agentic lane runs exactly once');
  // The agentic-only descriptor carries NO deterministic verdict fields.
  assert.equal(result.journeys, undefined);
  assert.equal(result.vqa, undefined);
  assert.equal(result.wiring, undefined);
  assert.equal(result.blocking, undefined);
  assert.equal(result.status, undefined);
  assert.ok(result.agentic && result.agentic.runs.length === 1);
});

// ── 2. merge-not-clobber on the same SHA ──────────────────────────────────────

test('same SHA → merged:true, no note (daemon merges into the existing verdict)', async () => {
  const runAgentic = makeRunAgenticSpy();
  const result = await runP3Qa({
    plan: {
      planId: 'p',
      devUrl: 'https://d',
      qaCommitSha: SHA_A,
      p3QaVerdict: {
        status: 'pass',
        blocking: false,
        ranAtSha: SHA_A,
        journeys: [],
        vqa: [],
        wiring: { orphanModules: [], blocking: false },
      },
    },
    journeys: [{ id: 'j' }],
    agenticOnly: true,
    agenticBackendMode: 'headless',
    runAgentic,
    env: {},
  });

  assert.equal(result.merged, true);
  assert.equal(result.ranAtSha, SHA_A);
  assert.equal(result.note, undefined);
});

// ── 3. SHA mismatch / no-verdict → fresh report ───────────────────────────────

test('SHA mismatch → merged:false + explanatory note naming the stored verdict', async () => {
  const runAgentic = makeRunAgenticSpy();
  const result = await runP3Qa({
    plan: {
      planId: 'p',
      devUrl: 'https://d',
      qaCommitSha: SHA_A,
      p3QaVerdict: {
        status: 'pass',
        blocking: false,
        ranAtSha: SHA_B, // a DIFFERENT commit than qaCommitSha
        journeys: [],
        vqa: [],
        wiring: { orphanModules: [], blocking: false },
      },
    },
    journeys: [{ id: 'j' }],
    agenticOnly: true,
    runAgentic,
    env: {},
  });

  assert.equal(result.merged, false);
  assert.match(result.note, /only the agentic lane/i);
  assert.match(result.note, /bbbbbbb/); // stored verdict's short SHA (SHA_B)
});

test('no stored verdict → merged:false + a no-verdict note', async () => {
  const runAgentic = makeRunAgenticSpy();
  const result = await runP3Qa({
    plan: { planId: 'p', devUrl: 'https://d', qaCommitSha: SHA_A },
    journeys: [{ id: 'j' }],
    agenticOnly: true,
    runAgentic,
    env: {},
  });

  assert.equal(result.merged, false);
  assert.match(result.note, /no full QA verdict/i);
});

// ── 4. backend-mode override reaches runAgenticVqa ────────────────────────────

test('the backend-mode override reaches runAgenticVqa (overrides env.AGENTIC_VQA_MODE)', async () => {
  const runAgentic = makeRunAgenticSpy();
  await runP3Qa({
    plan: { planId: 'p', devUrl: 'https://d', qaCommitSha: SHA_A },
    journeys: [{ id: 'j' }],
    agenticOnly: true,
    agenticBackendMode: 'extension',
    runAgentic,
    env: { AGENTIC_VQA_MODE: 'headless' }, // must be overridden by the explicit mode
  });
  assert.equal(runAgentic.calls[0].mode, 'extension');
  // The plan + pin were forwarded to the lane.
  assert.equal(runAgentic.calls[0].sha, SHA_A);
  assert.equal(runAgentic.calls[0].devUrl, 'https://d');
});

test('mode falls back to env.AGENTIC_VQA_MODE, then auto', async () => {
  const spyEnv = makeRunAgenticSpy();
  await runP3Qa({
    plan: { planId: 'p', devUrl: 'https://d', qaCommitSha: SHA_A },
    journeys: [{ id: 'j' }],
    agenticOnly: true,
    runAgentic: spyEnv,
    env: { AGENTIC_VQA_MODE: 'extension' },
  });
  assert.equal(spyEnv.calls[0].mode, 'extension');

  const spyAuto = makeRunAgenticSpy();
  await runP3Qa({
    plan: { planId: 'p', devUrl: 'https://d', qaCommitSha: SHA_A },
    journeys: [{ id: 'j' }],
    agenticOnly: true,
    runAgentic: spyAuto,
    env: {},
  });
  assert.equal(spyAuto.calls[0].mode, 'auto');
});

// ── fail-open: the agentic lane throwing never throws out of runP3Qa ──────────

test('an agentic lane throw degrades to a skipped report — runP3Qa never throws out', async () => {
  const result = await runP3Qa({
    plan: { planId: 'p', devUrl: 'https://d', qaCommitSha: SHA_A },
    journeys: [{ id: 'j' }],
    agenticOnly: true,
    runAgentic: async () => {
      throw new Error('sdk boom');
    },
    env: {},
  });
  assert.equal(result.agenticOnly, true);
  assert.match(result.agentic.skippedReason, /sdk boom/);
  assert.deepEqual(result.agentic.runs, []);
});
