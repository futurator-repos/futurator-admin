// story-dev-pipeline tests — the TDD fail-closed contract (pacman8 incident,
// 2026-07-11). The forbidden mechanism this suite pins down: the implementer
// must NEVER author or influence the tests that judge it. Concretely:
//   (a) test-author fails twice → the story FAILS CLOSED, no implementer spawn,
//       no legacy single-spawn fallback;
//   (b) test-author fails once then succeeds → the implementer spawns normally;
//   (c) the implementer's live gate forbids EVERY test file (owned + the
//       **/*.test.* / **/*.spec.* globs);
//   (d) a post-hoc tamper hit (implementer commit touched an owned test) fails
//       the attempt like a failing AC (was warn-only).
// Every primitive is injected (spawn, git, gate builder, executors, ddb-side
// callbacks) — no CLI, no repo, no network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { runStoryDevJob } from '../story-dev-pipeline.mjs';

const BINDING_TEXT =
  'tests authored\n<BINDING>{"AC-1":{"testRef":"src/login.test.ts > login > [AC-1] issues token","testKind":"unit"}}</BINDING>';

/** Frozen flag set: split ON, everything else pinned legacy/off so the run is
 * deterministic (freezeFlagsOntoJob returns job.p3Flags verbatim when present). */
const FLAGS = Object.freeze({
  P3_GATE_MODE: 'off',
  P3_COST_CEILING: 'off',
  P3_TEST_AUTHOR_SPLIT: 'on',
  P3_QUALITY_GATE: 'off',
  P3_FRONTIER_MODE: 'kahn',
  P3_SELECTIVE_REGRESSION: 'off',
  P3_FOUNDATION_GATE: 'off',
  P3_GREEN_TRUNK: 'off',
  P3_READY_FRONTIER: 'off',
  P3_LAZY_MODE: 'off',
});

function makePayload(overrides = {}) {
  return {
    storyId: 'S1',
    title: 'Login',
    planSlug: 'plan-1',
    touches: ['src/login.ts'],
    forbiddenAreas: ['src/secret/**'],
    acceptanceCriteria: [{ id: 'AC-1', text: 'issues a token' }],
    ...overrides,
  };
}

function makeJob(workingDir, payload) {
  return {
    jobId: 'job-1',
    workingDir,
    p3Flags: { ...FLAGS },
    storyDevPayload: payload,
  };
}

function fakeChild({ stdout = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

/**
 * Fake claude spawn. Routes on the prompt: TEST AUTHOR spawns consume
 * `testAuthorResults` in order; anything else is the implementer/legacy dev
 * spawn (succeeds, fires `onImplement` so the executor can flip to GREEN).
 */
function makeSpawn({ testAuthorResults = [], onImplement } = {}) {
  const calls = [];
  let taCalls = 0;
  const spawn = (bin, args, opts) => {
    const prompt = args[args.indexOf('-p') + 1] || '';
    calls.push({ prompt, args, env: opts?.env });
    if (/TEST AUTHOR/.test(prompt)) {
      const r = testAuthorResults[Math.min(taCalls, testAuthorResults.length - 1)] || { code: 1 };
      taCalls += 1;
      return fakeChild(r);
    }
    onImplement?.();
    return fakeChild({ stdout: 'implemented', code: 0 });
  };
  return { spawn, calls };
}

/**
 * Fake git. Commits mint sha1, sha2, … in order; `commitDiffs[n]` is the file
 * list `git diff --name-only shaN~1 shaN` reports for the (n+1)-th commit —
 * commit #1 is the test-author's RED commit, commit #2 the implementer's.
 */
function makeGit({ commitDiffs = [] } = {}) {
  const ok = (stdout = '') => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
  let commits = 0;
  const diffs = {};
  const git = async (args) => {
    const a = args.join(' ');
    if (a === 'rev-parse --abbrev-ref HEAD') return ok('plan/plan-1'); // already on the plan branch
    if (a === 'status --porcelain') return ok('?? src/login.test.ts');
    if (args[0] === 'add') return ok('');
    if (a === 'diff --cached --name-only') return ok('src/login.test.ts\nsrc/login.ts');
    if (args[0] === 'commit') {
      commits += 1;
      diffs[`sha${commits}`] = commitDiffs[commits - 1] || [];
      return ok('');
    }
    if (a === 'rev-parse HEAD') return ok(`sha${commits}`);
    if (args[0] === 'diff' && args[1] === '--name-only') return ok((diffs[args[3]] || []).join('\n'));
    return ok('');
  };
  return git;
}

describe('runStoryDevJob — TDD fail-closed (P3_TEST_AUTHOR_SPLIT=on)', () => {
  let workingDir;
  let eventLogDir;
  let gateCalls;
  let updates;
  let events;
  let implemented;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'story-dev-pipeline-test-'));
    eventLogDir = mkdtempSync(join(tmpdir(), 'story-dev-events-'));
    gateCalls = [];
    updates = [];
    events = [];
    implemented = false;
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(eventLogDir, { recursive: true, force: true });
  });

  const makeDeps = ({ spawn, git, maxAttempts = 1 }) => ({
    spawn,
    git,
    maxAttempts,
    headSha: 'sha0',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // Gate-builder seam: record every scope the pipeline builds; inert result
    // (no settings file, no env) keeps the spawn args clean for inspection.
    buildGateSpawn: (opts) => {
      gateCalls.push(opts);
      return { settingsPath: null, args: [], env: {} };
    },
    // Deterministic bound-AC executor: RED before the implementer ran, GREEN
    // after — exactly the real-world sequence the RED-first gate assumes.
    executors: { unit: async () => ({ passed: implemented, detail: implemented ? 'pass' : 'fail: not implemented' }) },
    updateStoryState: async (u) => { updates.push(u); },
    pushEvent: async (jobId, stepId, agentId, type, data) => { events.push({ stepId, type, text: data?.text }); },
  });

  it('(a) test-author throws twice → story fails CLOSED: no implementer, no legacy fallback', async () => {
    const payload = makePayload();
    // Both test-author attempts crash (spawn exit 1) → runTestAuthorPhase throws twice.
    const { spawn, calls } = makeSpawn({ testAuthorResults: [{ code: 1 }, { code: 1 }] });
    const r = await runStoryDevJob({
      job: makeJob(workingDir, payload),
      eventLogDir,
      deps: makeDeps({ spawn, git: makeGit() }),
    });

    expect(r.exitCode).toBe(0);
    expect(r.newState).toBe('failed');
    expect(r.attemptsUsed).toBe(0);
    expect(r.verdict.status).toBe('failing');
    expect(r.verdict.reasons.join('\n')).toMatch(/test-author-failed/);
    expect(r.lastFailureDetail).toMatch(/^test-author-failed:/);

    // The forbidden mechanism: NO spawn beyond the two test-author attempts —
    // neither the split implementer nor the legacy single-spawn dev prompt.
    expect(calls.filter((c) => /TEST AUTHOR/.test(c.prompt))).toHaveLength(2);
    expect(calls.filter((c) => /IMPLEMENTER/.test(c.prompt))).toHaveLength(0);
    expect(calls.some((c) => /implementing ONE story/.test(c.prompt))).toBe(false);
    expect(calls).toHaveLength(2);

    const failed = updates.find((u) => u.state === 'failed');
    expect(failed).toBeTruthy();
    expect(failed.storyId).toBe('S1');
    expect(failed.reason).toMatch(/^test-author-failed:/);
    expect(events.some((e) => e.stepId === 'test-author' && e.type === 'step_error'
      && /fails closed/.test(e.text) && /never authors its own tests/.test(e.text))).toBe(true);
  });

  it('(b) test-author throws once then succeeds → the implementer spawns and the story completes', async () => {
    const payload = makePayload();
    const { spawn, calls } = makeSpawn({
      testAuthorResults: [{ code: 1 }, { stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implemented = true; },
    });
    const r = await runStoryDevJob({
      job: makeJob(workingDir, payload),
      eventLogDir,
      // commit #1 = RED (test file), commit #2 = implementation (impl file only).
      deps: makeDeps({ spawn, git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts']] }) }),
    });

    expect(calls.filter((c) => /TEST AUTHOR/.test(c.prompt))).toHaveLength(2);
    const impl = calls.filter((c) => /IMPLEMENTER/.test(c.prompt));
    expect(impl).toHaveLength(1);
    expect(impl[0].prompt).toMatch(/src\/login\.test\.ts/); // owned tests listed as untouchable
    expect(r.newState).toBe('done');
    expect(r.verdict.status).toBe('done');
    expect(r.commitSha).toBe('sha2');
  });

  it('(c) the implementer gate forbids ALL test files: owned + **/*.test.* + **/*.spec.*', async () => {
    const payload = makePayload();
    const { spawn } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implemented = true; },
    });
    await runStoryDevJob({
      job: makeJob(workingDir, payload),
      eventLogDir,
      deps: makeDeps({ spawn, git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts']] }) }),
    });

    // Build order: base story-dev gate → test-author gate → implementer gate.
    const storyDevGates = gateCalls.filter((g) => g.agentRole === 'story-dev');
    expect(storyDevGates.length).toBe(2);
    const implGate = storyDevGates[1];
    expect(implGate.forbiddenAreas).toEqual(
      expect.arrayContaining(['src/secret/**', 'src/login.test.ts', '**/*.test.*', '**/*.spec.*']),
    );
    // The test-author's OWN gate stays permissive for test files (it must write them).
    const taGate = gateCalls.find((g) => g.agentRole === 'test-author');
    expect(taGate.touchPoints).toEqual(expect.arrayContaining(['**/*.test.*', '**/*.spec.*']));
    expect(taGate.forbiddenAreas).toEqual(['src/secret/**']);
  });

  it('(d) tamper: implementer commit touched an owned test → attempt FAILS with test-tampering', async () => {
    const payload = makePayload();
    const { spawn } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implemented = true; },
    });
    const r = await runStoryDevJob({
      job: makeJob(workingDir, payload),
      eventLogDir,
      // Commit #2's diff includes the OWNED test file → post-hoc tamper hit,
      // even though the bound AC executor reports GREEN.
      deps: makeDeps({ spawn, git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.test.ts', 'src/login.ts']] }) }),
    });

    expect(r.newState).toBe('failed');
    expect(r.verdict.status).toBe('failing');
    expect(r.verdict.failing).toContain('test-tampering');
    expect(r.verdict.reasons.join('\n')).toMatch(/implementer modified authored test\(s\): src\/login\.test\.ts/);
    // Consumes a fix-forward retry like a failing AC: persisted as failed, not propagated.
    const persisted = updates.find((u) => u.state === 'failed' && u.verdict);
    expect(persisted).toBeTruthy();
    expect(persisted.verdict.failing).toContain('test-tampering');
  });
});
