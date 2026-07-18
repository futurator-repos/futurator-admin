// p3-qa-agentic-integration.test.mjs — SLICE B2 (design Q2) — the agentic VQA
// lane wired into runP3Qa: shadow-vs-on blocking policy + no-api-key skip.
//
// Run with the slice's contract command:
//   node --test lib/__tests__/p3-qa-agentic-integration.test.mjs
//
// Hermetic: a fake Playwright drives a PASSING deterministic journey (so the
// deterministic lanes never block — isolating the agentic contribution), and
// the agentic runner is INJECTED (`runAgentic`) so no SDK/browser/network is
// touched. The no-api-key case uses the REAL agentic runner with an empty env
// to prove the genuine skip path (it returns before any I/O).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runP3Qa } from '../p3-qa-runner.mjs';

// ── Fake Playwright: a deterministic journey that PASSES ──────────────────────

function makePassingPlaywright() {
  return {
    chromium: {
      launch: async () => {
        let snapCalls = 0;
        const page = {
          goto: async () => {},
          waitForFunction: async () => {},
          keyboard: { press: async () => {}, down: async () => {}, up: async () => {} },
          waitForTimeout: async () => {},
          screenshot: async () => Buffer.from(`frame-${++snapCalls}`),
          locator: () => ({ first: () => ({ click: async () => {} }), count: async () => 0 }),
          getByRole: () => ({ first: () => ({ click: async () => {} }), count: async () => 0 }),
          getByText: () => ({ first: () => ({ click: async () => {} }) }),
          evaluate: async (_fn, arg) => {
            if (arg && (arg.__settle || arg.k || arg.m)) return undefined;
            return { status: 'running' };
          },
        };
        return { newPage: async () => page, close: async () => {} };
      },
    },
  };
}

const passJudge = async () => ({ ok: true, output: 'VERDICT: PASS [conf=high]\nOBSERVATION: ok' });
const okS3 = async () => ({ code: 0, stdout: '', stderr: '' });
const fastWait = async () => {};

/** A single passing deterministic journey (status → running on Space). */
function passingFixture() {
  const stories = [
    {
      storyId: 's1',
      title: 'Start',
      touches: ['src/a.ts'],
      acceptanceCriteria: [{ id: 's1-ac1', text: 'space starts', when: 'The user presses Space', thenObservable: "snapshot.status equals 'running'" }],
    },
  ];
  const journeys = [
    { id: 'j1', title: 'Start journey', acRefs: ['s1-ac1'], steps: [{ acId: 's1-ac1', label: 'press space', when: 'The user presses Space', thenObservable: "snapshot.status equals 'running'" }] },
  ];
  return { stories, journeys };
}

const plan = { planId: 'plan-ag', qaCommitSha: 'shaAG', devUrl: 'https://dev.futurator.ai/p-ag' };

/** An injected agentic runner returning a report with a BLOCKING finding. */
function agenticWithBlocking() {
  return async () => ({
    mode: 'headless',
    model: 'claude-sonnet-5',
    runs: [
      {
        journeyId: 'j1',
        instruction: 'play the game',
        verdict: 'fail',
        findings: [{ severity: 'blocking', note: 'the Start button does nothing — journey cannot begin' }],
        frameUrls: ['https://dev.futurator.ai/_qa/plan-ag/shaAG/agentic/j1/step-001.png'],
        steps: 4,
        durationMs: 1234,
      },
    ],
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('agenticMode=off → lane never runs, no report attached', async () => {
  const { stories, journeys } = passingFixture();
  let called = false;
  const result = await runP3Qa({
    plan, stories, journeys,
    playwright: makePassingPlaywright(), spawnJudge: passJudge, s3: okS3, qaContext: {},
    agenticMode: 'off',
    runAgentic: async () => { called = true; return { mode: 'headless', model: 'm', runs: [] }; },
    log: () => {}, wait: fastWait,
  });
  assert.equal(called, false);
  assert.equal(result.agentic, undefined);
  assert.equal(result.blocking, false);
  assert.equal(result.status, 'pass');
});

test("agenticMode=shadow → report attached, a [blocking] finding does NOT gate", async () => {
  const { stories, journeys } = passingFixture();
  const result = await runP3Qa({
    plan, stories, journeys,
    playwright: makePassingPlaywright(), spawnJudge: passJudge, s3: okS3, qaContext: {},
    agenticMode: 'shadow',
    runAgentic: agenticWithBlocking(),
    log: () => {}, wait: fastWait,
  });
  // Report recorded…
  assert.ok(result.agentic, 'agentic report attached');
  assert.equal(result.agentic.runs.length, 1);
  assert.equal(result.agentic.runs[0].findings[0].severity, 'blocking');
  // …but shadow NEVER gates: the deterministic journey passed, so blocking stays false.
  assert.equal(result.blocking, false);
  assert.equal(result.status, 'pass');
});

test("agenticMode=on → a [blocking] finding contributes to verdict.blocking → status fail", async () => {
  const { stories, journeys } = passingFixture();
  const result = await runP3Qa({
    plan, stories, journeys,
    playwright: makePassingPlaywright(), spawnJudge: passJudge, s3: okS3, qaContext: {},
    agenticMode: 'on',
    runAgentic: agenticWithBlocking(),
    log: () => {}, wait: fastWait,
  });
  assert.ok(result.agentic);
  assert.equal(result.blocking, true); // the blocking agentic finding gates
  assert.equal(result.status, 'fail');
});

test("agenticMode=on with only ATTENTION findings → does NOT gate", async () => {
  const { stories, journeys } = passingFixture();
  const result = await runP3Qa({
    plan, stories, journeys,
    playwright: makePassingPlaywright(), spawnJudge: passJudge, s3: okS3, qaContext: {},
    agenticMode: 'on',
    runAgentic: async () => ({
      mode: 'headless', model: 'm',
      runs: [{ journeyId: 'j1', instruction: 'x', verdict: 'pass', findings: [{ severity: 'attention', note: 'minor visual nit' }], frameUrls: [], steps: 2, durationMs: 10 }],
    }),
    log: () => {}, wait: fastWait,
  });
  assert.equal(result.blocking, false);
  assert.equal(result.status, 'pass');
});

test("missing BROWSER_AGENT_API_KEY surfaces skippedReason and NEVER fails QA (real runner, empty env)", async () => {
  const { stories, journeys } = passingFixture();
  const result = await runP3Qa({
    plan, stories, journeys,
    playwright: makePassingPlaywright(), spawnJudge: passJudge, s3: okS3, qaContext: {},
    agenticMode: 'on', // even at 'on'
    env: {}, // no BROWSER_AGENT_API_KEY
    // default runAgentic = real agentic-vqa-runner import; it returns before any I/O
    log: () => {}, wait: fastWait,
  });
  assert.ok(result.agentic, 'agentic report present even when skipped');
  assert.equal(result.agentic.skippedReason, 'no-api-key');
  assert.deepEqual(result.agentic.runs, []);
  // A skipped lane can never gate — QA is not failed.
  assert.equal(result.blocking, false);
  assert.equal(result.status, 'pass');
});

test('agentic runner that THROWS is caught → non-blocking skippedReason, QA not failed', async () => {
  const { stories, journeys } = passingFixture();
  const result = await runP3Qa({
    plan, stories, journeys,
    playwright: makePassingPlaywright(), spawnJudge: passJudge, s3: okS3, qaContext: {},
    agenticMode: 'on',
    runAgentic: async () => { throw new Error('boom'); },
    log: () => {}, wait: fastWait,
  });
  assert.ok(result.agentic);
  assert.match(result.agentic.skippedReason, /boom/);
  assert.equal(result.blocking, false);
});
