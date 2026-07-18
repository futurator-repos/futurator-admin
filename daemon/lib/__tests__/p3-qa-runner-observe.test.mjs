// p3-qa-runner-observe.test.mjs — SLICE B2 (design Q1) — observe-step flow.
//
// Run with the slice's contract command:
//   node --test lib/__tests__/p3-qa-runner-observe.test.mjs
//
// Hermetic: a fake Playwright drives runObserveStep (navigate → settle →
// single frame), a fake spawnJudge stands in for the VLM, a recording s3 stub
// swallows uploads, and a recording persistAdvisory captures the per-AC
// advisoryVqa writeback. NO network, NO real browser. (Neighbouring vitest
// tests exist; this slice's run contract is `node --test`, so it uses
// node:test/node:assert like the agentic-vqa sibling.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runP3Qa } from '../p3-qa-runner.mjs';

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * Fake Playwright whose page supports the OBSERVE path (goto → waitForTimeout →
 * screenshot). One frame Buffer per screenshot() call. Records goto URLs.
 */
function makeObservePlaywright() {
  const calls = { gotos: [], settles: [], screenshots: 0, launches: 0 };
  return {
    calls,
    chromium: {
      launch: async () => {
        calls.launches += 1;
        const page = {
          goto: async (u) => {
            calls.gotos.push(u);
          },
          waitForTimeout: async (ms) => {
            calls.settles.push(ms);
          },
          screenshot: async () => {
            calls.screenshots += 1;
            return Buffer.from(`observe-frame-${calls.screenshots}`);
          },
          url: () => undefined,
        };
        return { newPage: async () => page, close: async () => {} };
      },
    },
  };
}

const passObserveJudge = async () => ({ ok: true, output: 'VERDICT: PASS [conf=high]\nOBSERVATION: maze walls render on the canvas' });
const failObserveJudge = async () => ({ ok: true, output: 'VERDICT: FAIL [conf=high]\nOBSERVATION: blank white page, no walls' });
const uncertainObserveJudge = async () => ({ ok: true, output: 'VERDICT: UNCERTAIN [conf=low]\nOBSERVATION: image too dark to read' });
const unavailableJudge = async () => ({ ok: false, reason: 'judge cli crashed' });

const okS3 = async () => ({ code: 0, stdout: '', stderr: '' });
const fastWait = async () => {};

/** One appearance-only AC + a journey with a single observe step referencing it. */
function observeFixture(acOverrides = {}) {
  const ac = {
    id: 's1-ac1',
    text: 'maze walls render on the canvas',
    verify: 'appearance',
    acClass: 'advisory-taste',
    then: 'the maze walls are visible',
    ...acOverrides,
  };
  const stories = [{ storyId: 's1', title: 'Maze render', intent: 'draw the maze', touches: ['src/a.ts'], acceptanceCriteria: [ac] }];
  const journeys = [
    {
      id: 'j-observe',
      title: 'Appearance journey',
      acRefs: ['s1-ac1'],
      steps: [{ kind: 'observe', acId: 's1-ac1', spec: 'maze walls render on the canvas', settleMs: 1200 }],
    },
  ];
  return { stories, journeys };
}

const plan = { planId: 'plan-obs', qaCommitSha: 'shaOBS', devUrl: 'https://dev.futurator.ai/p-obs' };

function recordingPersist() {
  const calls = [];
  return { calls, fn: async (args) => { calls.push(args); } };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('observe PASS → advisoryVqa status=pass persisted onto the story row, never blocks', async () => {
  const { stories, journeys } = observeFixture();
  const persist = recordingPersist();
  const result = await runP3Qa({
    plan,
    stories,
    journeys,
    playwright: makeObservePlaywright(),
    spawnJudge: passObserveJudge,
    s3: okS3,
    qaContext: { screenshotBucket: 'dev-env-bucket', screenshotBase: 'https://dev.futurator.ai' },
    persistAdvisory: persist.fn,
    log: () => {},
    wait: fastWait,
  });

  // NEVER blocks — advisory-taste contract.
  assert.equal(result.blocking, false);

  // Writeback happened exactly once, for story s1, carrying the mutated AC.
  assert.equal(persist.calls.length, 1);
  assert.equal(persist.calls[0].storyId, 's1');
  const writtenAc = persist.calls[0].acceptanceCriteria.find((a) => a.id === 's1-ac1');
  assert.ok(writtenAc.advisoryVqa, 'advisoryVqa written onto the AC');
  assert.equal(writtenAc.advisoryVqa.status, 'pass');
  assert.equal(writtenAc.advisoryVqa.sha, 'shaOBS');
  assert.match(writtenAc.advisoryVqa.frameUrl, /^https:\/\/dev\.futurator\.ai\/_qa\/plan-obs\/shaOBS\/j-observe\//);
  assert.ok(writtenAc.advisoryVqa.judgedAt, 'judgedAt stamped');
  assert.match(writtenAc.advisoryVqa.rationale, /maze walls/);
});

test('observe FAIL → advisoryVqa status=attention (mapped, NEVER blocking)', async () => {
  const { stories, journeys } = observeFixture();
  const persist = recordingPersist();
  const result = await runP3Qa({
    plan,
    stories,
    journeys,
    playwright: makeObservePlaywright(),
    spawnJudge: failObserveJudge,
    s3: okS3,
    qaContext: { screenshotBucket: 'dev-env-bucket' },
    persistAdvisory: persist.fn,
    log: () => {},
    wait: fastWait,
  });

  assert.equal(result.blocking, false);
  const writtenAc = persist.calls[0].acceptanceCriteria.find((a) => a.id === 's1-ac1');
  assert.equal(writtenAc.advisoryVqa.status, 'attention'); // fail → attention, not blocking
});

test('observe UNCERTAIN → advisoryVqa status=attention', async () => {
  const { stories, journeys } = observeFixture();
  const persist = recordingPersist();
  await runP3Qa({
    plan,
    stories,
    journeys,
    playwright: makeObservePlaywright(),
    spawnJudge: uncertainObserveJudge,
    s3: okS3,
    qaContext: {},
    persistAdvisory: persist.fn,
    log: () => {},
    wait: fastWait,
  });
  const writtenAc = persist.calls[0].acceptanceCriteria.find((a) => a.id === 's1-ac1');
  assert.equal(writtenAc.advisoryVqa.status, 'attention');
});

test('observe with an UNAVAILABLE judge → advisoryVqa status=error (distinct from attention)', async () => {
  const { stories, journeys } = observeFixture();
  const persist = recordingPersist();
  await runP3Qa({
    plan,
    stories,
    journeys,
    playwright: makeObservePlaywright(),
    spawnJudge: unavailableJudge,
    s3: okS3,
    qaContext: {},
    persistAdvisory: persist.fn,
    log: () => {},
    wait: fastWait,
  });
  const writtenAc = persist.calls[0].acceptanceCriteria.find((a) => a.id === 's1-ac1');
  assert.equal(writtenAc.advisoryVqa.status, 'error');
});

test('observe with NO playwright (engine misconfigured) → status=error, still non-blocking, marker surfaced', async () => {
  const { stories, journeys } = observeFixture();
  const persist = recordingPersist();
  const result = await runP3Qa({
    plan,
    stories,
    journeys,
    playwright: null, // lazy import failed on this box
    spawnJudge: passObserveJudge,
    s3: okS3,
    qaContext: {},
    persistAdvisory: persist.fn,
    qaEngine: { misconfigured: true, box: 'srv-mac-1' },
    log: () => {},
    wait: fastWait,
  });

  assert.equal(result.blocking, false);
  const writtenAc = persist.calls[0].acceptanceCriteria.find((a) => a.id === 's1-ac1');
  assert.equal(writtenAc.advisoryVqa.status, 'error'); // no browser → no frame → error, not a fake pass

  // Q3b — explicit qa-engine-misconfigured marker naming the box.
  assert.ok(result.qaEngineMisconfigured, 'misconfigured marker present');
  assert.equal(result.qaEngineMisconfigured.box, 'srv-mac-1');
  assert.match(result.qaEngineMisconfigured.note, /qa-engine-misconfigured/);
});

test('observe steps are excluded from the deterministic journey.steps (no fake Lane-1 fail)', async () => {
  const { stories, journeys } = observeFixture();
  const result = await runP3Qa({
    plan,
    stories,
    journeys,
    playwright: makeObservePlaywright(),
    spawnJudge: passObserveJudge,
    s3: okS3,
    qaContext: {},
    persistAdvisory: async () => {},
    log: () => {},
    wait: fastWait,
  });
  const journey = result.journeys[0];
  // No deterministic steps were produced from the observe-only journey — it is
  // NOT an uninterpretable Lane-1 fail; it verified nothing deterministically.
  assert.deepEqual(journey.steps, []);
  assert.equal(journey.verdict, 'uncertain'); // honest: nothing deterministic ran
  assert.equal(result.blocking, false);
});
