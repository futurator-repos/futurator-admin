// agentic-vqa-runner.test.mjs — hermetic unit tests for the agentic VQA lane.
//
// Run with the project-standard command:
//   node --test lib/__tests__/agentic-vqa-runner.test.mjs
//
// NO network, NO real Anthropic API, NO Playwright: the embedded loop is driven
// with an INJECTED fake executor + fake SDK client, `fetch` is injected, and the
// `s3` uploader is a recording stub. (Neighbouring daemon tests use vitest; this
// slice's run contract is `node --test`, so it uses node:test/node:assert.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runAgenticVqa,
  parseAgenticVerdict,
  buildInstruction,
  ensureUrl,
} from '../agentic-vqa-runner.mjs';

// ── Fakes ────────────────────────────────────────────────────────────────────

const FAKE_PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

/** Fake Anthropic-compatible client: returns `script[i]` per create() call. */
function makeFakeClient(script) {
  let call = 0;
  const createCalls = [];
  return {
    createCalls,
    beta: {
      messages: {
        create: async (params) => {
          createCalls.push(params);
          const r = script[Math.min(call, script.length - 1)];
          call += 1;
          return r;
        },
      },
    },
  };
}

/** Fake executor implementing the vendored executor interface. */
function makeFakeExecutor() {
  const calls = { start: 0, execute: 0, screenshot: 0, stop: 0 };
  return {
    calls,
    start: async () => {
      calls.start += 1;
      return { ok: true };
    },
    getViewport: async () => ({ width: 1280, height: 800 }),
    screenshot: async () => {
      calls.screenshot += 1;
      return FAKE_PNG_B64;
    },
    execute: async () => {
      calls.execute += 1;
      return { ok: true, base64Png: FAKE_PNG_B64 };
    },
    stop: async () => {
      calls.stop += 1;
    },
  };
}

/** Recording fake for the p3-qa-runner-shaped `s3(cmd, cwd, timeoutMs)` primitive. */
function makeFakeS3() {
  const cmds = [];
  const s3 = async (cmd) => {
    cmds.push(cmd);
    return { code: 0, stderr: '' };
  };
  s3.cmds = cmds;
  return s3;
}

// ── parseAgenticVerdict ──────────────────────────────────────────────────────

test('parseAgenticVerdict: pass with an attention finding', () => {
  const text = [
    'I opened the app and moved the player around; everything worked.',
    'QA_VERDICT: pass',
    'QA_FINDINGS:',
    '- [attention] The score label flickered briefly on load.',
  ].join('\n');
  const { verdict, findings } = parseAgenticVerdict(text);
  assert.equal(verdict, 'pass');
  assert.deepEqual(findings, [
    { severity: 'attention', note: 'The score label flickered briefly on load.' },
  ]);
});

test('parseAgenticVerdict: fail with a blocking finding', () => {
  const text = [
    'The Start button did nothing.',
    'QA_VERDICT: fail',
    'QA_FINDINGS:',
    '- [blocking] Clicking Start never begins the game — the canvas stays blank.',
    '- [attention] Footer text is misaligned.',
  ].join('\n');
  const { verdict, findings } = parseAgenticVerdict(text);
  assert.equal(verdict, 'fail');
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'blocking');
  assert.equal(findings[1].severity, 'attention');
});

test('parseAgenticVerdict: empty findings block on a clean pass', () => {
  const text = 'All good.\nQA_VERDICT: pass\nQA_FINDINGS:\n';
  const { verdict, findings } = parseAgenticVerdict(text);
  assert.equal(verdict, 'pass');
  assert.deepEqual(findings, []);
});

test('parseAgenticVerdict: unparseable verdict → uncertain + attention finding', () => {
  const { verdict, findings } = parseAgenticVerdict('I ran out of steps and never wrote a verdict.');
  assert.equal(verdict, 'uncertain');
  assert.deepEqual(findings, [{ severity: 'attention', note: 'unparseable verdict' }]);
});

test('parseAgenticVerdict: tolerant of case and asterisk bullets', () => {
  const text = 'qa_verdict:  FAIL\nqa_findings:\n* [BLOCKING] dead end reached';
  const { verdict, findings } = parseAgenticVerdict(text);
  assert.equal(verdict, 'fail');
  assert.deepEqual(findings, [{ severity: 'blocking', note: 'dead end reached' }]);
});

test('parseAgenticVerdict: null/empty text → uncertain', () => {
  assert.equal(parseAgenticVerdict('').verdict, 'uncertain');
  assert.equal(parseAgenticVerdict(undefined).verdict, 'uncertain');
});

// ── buildInstruction / ensureUrl ─────────────────────────────────────────────

test('buildInstruction: includes narrative, real-user framing, and verdict reminder', () => {
  const instr = buildInstruction({
    title: 'Play a round',
    narrative: 'Open the maze game and move the player to eat a pellet.',
    expectedOutcomes: ['The player sprite moves', 'The score increases'],
  });
  assert.match(instr, /Play a round/);
  assert.match(instr, /move the player to eat a pellet/);
  assert.match(instr, /The score increases/);
  assert.match(instr, /Interact as a real user/);
  assert.match(instr, /QA_VERDICT: pass/);
  assert.match(instr, /QA_FINDINGS:/);
});

test('ensureUrl: prepends a scheme only when missing', () => {
  // Origin rewrite is ENV-CONFIGURED only (no baked deployment defaults in
  // code): without AGENTIC_VQA_URL_REWRITE the URL passes through untouched.
  assert.equal(
    ensureUrl('https://dev.futurator.ai/apps/x', {}),
    'https://dev.futurator.ai/apps/x',
  );
  assert.equal(
    ensureUrl('https://dev.futurator.ai/apps/x', {
      AGENTIC_VQA_URL_REWRITE: 'dev.futurator.ai=d222fvxm0fq0g3.cloudfront.net',
    }),
    'https://d222fvxm0fq0g3.cloudfront.net/apps/x',
  );
  assert.equal(
    ensureUrl('dev.futurator.ai/apps/x', {
      AGENTIC_VQA_URL_REWRITE: 'dev.futurator.ai=d222fvxm0fq0g3.cloudfront.net',
    }),
    'https://d222fvxm0fq0g3.cloudfront.net/apps/x',
  );
  assert.equal(
    ensureUrl('https://dev.futurator.ai/apps/x', { AGENTIC_VQA_URL_REWRITE: 'nope=never' }),
    'https://dev.futurator.ai/apps/x',
  );
  assert.equal(ensureUrl('localhost:3000'), 'http://localhost:3000');
});

// ── no-api-key skip ──────────────────────────────────────────────────────────

test('runAgenticVqa: missing BROWSER_AGENT_API_KEY → skipped, no runs, no throw', async () => {
  const report = await runAgenticVqa({
    plan: { planId: 'p1' },
    journeys: [{ id: 'j1', narrative: 'do a thing' }],
    devUrl: 'https://dev.futurator.ai/apps/x',
    sha: 'abc',
    env: {}, // no BROWSER_AGENT_API_KEY
  });
  assert.equal(report.skippedReason, 'no-api-key');
  assert.deepEqual(report.runs, []);
  assert.equal(report.model, 'claude-sonnet-5');
});

test('runAgenticVqa: never reads ANTHROPIC_API_KEY (isolation rule)', async () => {
  const report = await runAgenticVqa({
    journeys: [{ id: 'j1' }],
    devUrl: 'https://x',
    sha: 'abc',
    // ANTHROPIC_API_KEY present but BROWSER_AGENT_API_KEY absent → still skipped.
    env: { ANTHROPIC_API_KEY: 'sk-should-be-ignored' },
  });
  assert.equal(report.skippedReason, 'no-api-key');
});

// ── auto-mode probe → fallback / extension ───────────────────────────────────

test('runAgenticVqa: auto mode falls back to headless when the status probe fails', async () => {
  let probed = false;
  const fetchImpl = async (u) => {
    probed = true;
    assert.match(String(u), /\/api\/status$/);
    throw new Error('connection refused');
  };
  const report = await runAgenticVqa({
    journeys: [], // no journeys → resolves mode then returns
    devUrl: 'https://dev.futurator.ai/apps/x',
    sha: 'abc',
    mode: 'auto',
    env: { BROWSER_AGENT_API_KEY: 'k' },
    fetchImpl,
  });
  assert.equal(probed, true);
  assert.equal(report.mode, 'headless');
  assert.deepEqual(report.runs, []);
});

test('runAgenticVqa: auto mode selects extension when status reports extensionConnected', async () => {
  const fetchImpl = async (u) => {
    if (String(u).endsWith('/api/status')) {
      return { ok: true, json: async () => ({ extensionConnected: true }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const report = await runAgenticVqa({
    journeys: [],
    devUrl: 'https://dev.futurator.ai/apps/x',
    sha: 'abc',
    mode: 'auto',
    env: { BROWSER_AGENT_URL: 'http://127.0.0.1:3010', BROWSER_AGENT_API_KEY: 'k' },
    fetchImpl,
  });
  assert.equal(report.mode, 'extension');
});

// ── embedded loop with injected fake executor + fake SDK client ───────────────

test('runAgenticVqa: embedded headless drives the vendored loop, saves frames, parses verdict', async () => {
  const fakeExecutor = makeFakeExecutor();
  const fakeClient = makeFakeClient([
    // Step 1: model requests a screenshot tool call.
    { content: [{ type: 'tool_use', id: 't1', input: { action: 'screenshot' } }], stop_reason: 'tool_use' },
    // Step 2: model finishes with a parseable verdict.
    {
      content: [
        {
          type: 'text',
          text: 'Opened the app and it rendered.\nQA_VERDICT: pass\nQA_FINDINGS:\n- [attention] slow first paint',
        },
      ],
      stop_reason: 'end_turn',
    },
  ]);
  const s3 = makeFakeS3();

  const report = await runAgenticVqa({
    plan: { planId: 'plan-1' },
    journeys: [{ id: 'j1', title: 'Smoke test', narrative: 'Open the app.' }],
    devUrl: 'https://dev.futurator.ai/apps/x',
    sha: 'sha123',
    mode: 'headless',
    s3,
    env: { BROWSER_AGENT_API_KEY: 'test-key', QA_SCREENSHOT_BUCKET: 'test-dev-bucket' },
    createExecutor: () => fakeExecutor,
    client: fakeClient,
  });

  assert.equal(report.mode, 'headless');
  assert.equal(report.model, 'claude-sonnet-5');
  assert.equal(report.runs.length, 1);

  const run = report.runs[0];
  assert.equal(run.journeyId, 'j1');
  assert.equal(run.verdict, 'pass');
  assert.deepEqual(run.findings, [{ severity: 'attention', note: 'slow first paint' }]);
  assert.match(run.instruction, /Interact as a real user/);
  assert.equal(typeof run.durationMs, 'number');

  // The loop captured the initial frame + the tool-result frame → ≥ 2 uploads.
  assert.ok(run.frameUrls.length >= 2, `expected ≥2 frames, got ${run.frameUrls.length}`);
  assert.equal(
    run.frameUrls[0],
    'https://dev.futurator.ai/_qa/plan-1/sha123/agentic/j1/step-001.png',
  );
  assert.ok(s3.cmds.length >= 2, 's3 upload should have been invoked per frame');
  assert.match(s3.cmds[0], /aws s3 cp .* "s3:\/\/test-dev-bucket\/_qa\/plan-1\/sha123\/agentic\/j1\/step-001\.png"/);

  // The executor + client were actually exercised.
  assert.equal(fakeExecutor.calls.start, 1);
  assert.ok(fakeExecutor.calls.execute >= 1);
  assert.equal(fakeExecutor.calls.stop, 1); // loop's finally always stops it
  assert.ok(fakeClient.createCalls.length >= 2);
  // Computer-use tool spec preserved by the vendored loop.
  assert.equal(fakeClient.createCalls[0].tools[0].type, 'computer_20251124');
  assert.deepEqual(fakeClient.createCalls[0].betas, ['computer-use-2025-11-24']);
});

test('runAgenticVqa: a journey whose executor.start throws degrades to uncertain (never throws out)', async () => {
  const s3 = makeFakeS3();
  const report = await runAgenticVqa({
    plan: { planId: 'plan-2' },
    journeys: [{ id: 'jbad', narrative: 'x' }],
    devUrl: 'https://x',
    sha: 'sha',
    mode: 'headless',
    s3,
    env: { BROWSER_AGENT_API_KEY: 'k', QA_SCREENSHOT_BUCKET: 'b' },
    createExecutor: () => ({
      start: async () => {
        throw new Error('chromium launch failed');
      },
    }),
    client: makeFakeClient([{ content: [], stop_reason: 'end_turn' }]),
  });
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].verdict, 'uncertain');
  assert.match(report.runs[0].error, /chromium launch failed/);
});

test('runAgenticVqa: caps journeys at AGENTIC_VQA_MAX_JOURNEYS', async () => {
  const s3 = makeFakeS3();
  const journeys = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
  ];
  const report = await runAgenticVqa({
    plan: { planId: 'p' },
    journeys,
    devUrl: 'https://x',
    sha: 's',
    mode: 'headless',
    s3,
    env: { BROWSER_AGENT_API_KEY: 'k', AGENTIC_VQA_MAX_JOURNEYS: '2', QA_SCREENSHOT_BUCKET: 'b' },
    createExecutor: () => makeFakeExecutor(),
    client: makeFakeClient([{ content: [{ type: 'text', text: 'QA_VERDICT: pass\nQA_FINDINGS:' }], stop_reason: 'end_turn' }]),
  });
  assert.equal(report.runs.length, 2);
  assert.deepEqual(report.runs.map((r) => r.journeyId), ['a', 'b']);
});
