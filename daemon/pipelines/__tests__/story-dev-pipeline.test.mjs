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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

  // ── A2 — honest lifecycle states ──────────────────────────────────────────
  it('(A2) a NON-final failing attempt persists "developing" with the verdict — terminal "failed" never hits the row mid-loop', async () => {
    const payload = makePayload();
    // Bound test stays RED on implementer attempt 1, goes GREEN on attempt 2.
    let implCount = 0;
    const { spawn, calls } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implCount += 1; },
    });
    const deps = makeDeps({
      spawn,
      git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts'], ['src/login.ts']] }),
      maxAttempts: 2,
    });
    deps.executors = { unit: async () => ({ passed: implCount >= 2, detail: implCount >= 2 ? 'pass' : 'fail: still red' }) };

    const r = await runStoryDevJob({ job: makeJob(workingDir, payload), eventLogDir, deps });

    expect(calls.filter((c) => /IMPLEMENTER/.test(c.prompt))).toHaveLength(2);
    expect(r.newState).toBe('done');
    // Attempt 1 failed but retries → 'developing' (WITH progress), never 'failed'.
    const midLoop = updates.find((u) => u.state === 'developing' && u.verdict);
    expect(midLoop).toBeTruthy();
    expect(midLoop.verdict.status).toBe('failing');
    expect(updates.filter((u) => u.state === 'failed')).toHaveLength(0);
    expect(updates.at(-1).state).toBe('done');
  });

  // ── A1+A6 — invariant persistence + gate-data fail-fast ───────────────────
  it('(A1/A6) an unauthored invariant is persisted WITH validator state, fails FAST (no second implementer spawn), and the reason names the data gap', async () => {
    // Story declares an invariant; the test-author emits NO <INVARIANTS> manifest
    // and no conventional `<id>.invariant.test.*` file exists in the worktree —
    // the exact pacman1 dead-end. Respawning the implementer can never fix it.
    const payload = makePayload({ invariants: [{ id: 'inv-1', description: 'seed data satisfies the schema' }] });
    const { spawn, calls } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implemented = true; },
    });
    const r = await runStoryDevJob({
      job: makeJob(workingDir, payload),
      eventLogDir,
      deps: makeDeps({
        spawn,
        git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts']] }),
        maxAttempts: 2, // attempts REMAIN — fail-fast is the taxonomy, not exhaustion
      }),
    });

    expect(r.newState).toBe('failed');
    expect(r.verdict.failing).toContain('inv-1');
    // No fix-forward waste: exactly ONE implementer spawn despite maxAttempts=2.
    expect(calls.filter((c) => /IMPLEMENTER/.test(c.prompt))).toHaveLength(1);
    // Terminal failed (not 'developing') because the failure is not agent-fixable.
    const persisted = updates.find((u) => u.state === 'failed' && u.verdict);
    expect(persisted).toBeTruthy();
    // The reason names the data gap (dossier A6).
    expect(persisted.verdict.reasons.join('\n')).toMatch(/gate-data failure/);
    expect(persisted.verdict.reasons.join('\n')).toMatch(/inv-1/);
    // A1: invariants land on the row WITH their run state (fail-closed here).
    expect(persisted.invariants).toBeTruthy();
    expect(persisted.invariants[0].id).toBe('inv-1');
    expect(persisted.invariants[0].validator.status).toBe('failing');
  });

  // ── B1+A5 — reviewer once per COMMIT, only on green bindings, after dev closes ──
  // A once-per-JOB memo replayed attempt-1 verdicts verbatim against a retried
  // attempt's NEW commit — an advisory AC could pass (or permanently fail) on
  // code the reviewer never saw. The memo keys on headSha: identical code is
  // never re-reviewed; fresh code always is.
  const reviewerFlags = { ...FLAGS, P3_QUALITY_GATE: 'on', P3_GREEN_TRUNK: 'on' };
  const p0Payload = () => makePayload({
    acceptanceCriteria: [{ id: 'AC-1', text: 'issues a token', riskTag: 'P0' }],
  });

  it('(B1/A5) reviewer RE-REVIEWS a retried attempt that integrated a NEW commit, and its step opens after the dev step_complete', async () => {
    const payload = p0Payload();
    let implCount = 0;
    let reviewerCalls = 0;
    const reviewedShas = [];
    let gtCalls = 0;
    const { spawn, calls } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implCount += 1; },
    });
    const deps = makeDeps({
      spawn,
      git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts'], ['src/login.ts']] }),
      maxAttempts: 2,
    });
    deps.executors = { unit: async () => ({ passed: implCount >= 1 }) };
    // Attempt 1: bindings GREEN @sha2 → reviewer runs → green-trunk FAILS
    // (agent-fixable → retry). Attempt 2 integrates a NEW commit (sha3) → the
    // reviewer MUST respawn: its attempt-1 verdicts describe code that no
    // longer ships (the once-per-job replay was the LENS-c hole).
    deps.greenTrunk = async () => {
      gtCalls += 1;
      return gtCalls === 1 ? { passed: false, reasons: ['green-trunk: tsc broke'] } : { passed: true, reasons: [] };
    };
    deps.spawnReviewer = async ({ headSha }) => {
      reviewerCalls += 1;
      reviewedShas.push(headSha);
      events.push({ stepId: 'reviewer', type: 'step_start', text: 'reviewer spawn' });
      return { verdicts: { 'AC-1': 'pass' }, needsHuman: [] };
    };
    const job = { ...makeJob(workingDir, payload), p3Flags: { ...reviewerFlags } };

    const r = await runStoryDevJob({ job, eventLogDir, deps });

    expect(r.newState).toBe('done');
    expect(calls.filter((c) => /IMPLEMENTER/.test(c.prompt))).toHaveLength(2);
    expect(reviewerCalls).toBe(2); // one review PER DISTINCT COMMIT
    expect(reviewedShas).toEqual(['sha2', 'sha3']); // never a stale replay against new code
    // green-trunk failure stayed retryable (A6) and persisted honestly (A2).
    expect(updates.some((u) => u.state === 'developing' && u.verdict)).toBe(true);
    // Event order (B1): the dev step closes BEFORE the reviewer step opens.
    const devComplete = events.findIndex((e) => e.stepId === 'story-dev' && e.type === 'step_complete');
    const reviewerStart = events.findIndex((e) => e.stepId === 'reviewer' && e.type === 'step_start');
    expect(devComplete).toBeGreaterThanOrEqual(0);
    expect(reviewerStart).toBeGreaterThan(devComplete);
    // Reviewer verdicts land in the stage summaries (B2).
    const done = updates.find((u) => u.state === 'done');
    expect(done.stageSummaries.reviewer.verdicts).toEqual({ 'AC-1': 'pass' });
    expect(done.stageSummaries.reviewer.ranAt).toBeTruthy();
  });

  it('(B1/A5) reviewer is MEMOIZED when the retry integrates NO new commit (same headSha → same code)', async () => {
    const payload = p0Payload();
    let implCount = 0;
    let reviewerCalls = 0;
    let gtCalls = 0;
    const { spawn, calls } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implCount += 1; },
    });
    // Git fake where attempt 2 stages NOTHING: integrate returns committed:false,
    // headSha stays sha2 — the only case a verdict replay is safe (identical code).
    const git = (() => {
      const ok = (stdout = '') => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
      let commits = 0;
      return async (args) => {
        const a = args.join(' ');
        if (a === 'rev-parse --abbrev-ref HEAD') return ok('plan/plan-1');
        if (a === 'status --porcelain') return ok('?? src/login.test.ts');
        if (args[0] === 'add') return ok('');
        // Clean tree after the implementer's first commit → 'nothing to commit'.
        if (a === 'diff --cached --name-only') return ok(commits >= 2 ? '' : 'src/login.test.ts\nsrc/login.ts');
        if (args[0] === 'commit') { commits += 1; return ok(''); }
        if (a === 'rev-parse HEAD') return ok(`sha${commits}`);
        if (args[0] === 'diff' && args[1] === '--name-only') return ok(commits === 2 ? 'src/login.ts' : 'src/login.test.ts');
        return ok('');
      };
    })();
    const deps = makeDeps({ spawn, git, maxAttempts: 2 });
    deps.executors = { unit: async () => ({ passed: implCount >= 1 }) };
    deps.greenTrunk = async () => {
      gtCalls += 1;
      return gtCalls === 1 ? { passed: false, reasons: ['green-trunk: tsc broke'] } : { passed: true, reasons: [] };
    };
    deps.spawnReviewer = async () => {
      reviewerCalls += 1;
      return { verdicts: { 'AC-1': 'pass' }, needsHuman: [] };
    };
    const job = { ...makeJob(workingDir, payload), p3Flags: { ...reviewerFlags } };

    const r = await runStoryDevJob({ job, eventLogDir, deps });

    expect(r.newState).toBe('done');
    expect(r.commitSha).toBe('sha2'); // attempt 2 integrated nothing new
    expect(calls.filter((c) => /IMPLEMENTER/.test(c.prompt))).toHaveLength(2);
    expect(reviewerCalls).toBe(1); // same SHA → memo replay, no wasted respawn
  });

  it('(B1/A5) reviewer is NOT spawned when the deterministic bindings are failing', async () => {
    const payload = p0Payload();
    let reviewerCalls = 0;
    const { spawn } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { /* never goes green */ },
    });
    const deps = makeDeps({
      spawn,
      git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts']] }),
      maxAttempts: 1,
    });
    deps.executors = { unit: async () => ({ passed: false, detail: 'red' }) };
    deps.spawnReviewer = async () => { reviewerCalls += 1; return { verdicts: {}, needsHuman: [] }; };
    const job = { ...makeJob(workingDir, payload), p3Flags: { ...FLAGS, P3_QUALITY_GATE: 'on' } };

    const r = await runStoryDevJob({ job, eventLogDir, deps });

    expect(r.newState).toBe('failed');
    expect(reviewerCalls).toBe(0); // a reviewer over a failing attempt is waste
  });

  // ── B2 — stage summaries on the row ───────────────────────────────────────
  it('(B2) persists structured stageSummaries: test-author files+preview+bindings, per-attempt implementer artifacts', async () => {
    const payload = makePayload();
    // Real file in the worktree so the summary captures lines + preview.
    mkdirSync(join(workingDir, 'src'), { recursive: true });
    writeFileSync(join(workingDir, 'src', 'login.test.ts'), 'line one\nline two\nline three');
    const { spawn } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implemented = true; },
    });
    const r = await runStoryDevJob({
      job: makeJob(workingDir, payload),
      eventLogDir,
      deps: makeDeps({ spawn, git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts']] }) }),
    });

    expect(r.newState).toBe('done');
    const done = updates.find((u) => u.state === 'done');
    const ss = done.stageSummaries;
    expect(ss).toBeTruthy();
    // test-author stage: authored files with content stats + the parsed bindings.
    expect(ss.testAuthor.files).toHaveLength(1);
    expect(ss.testAuthor.files[0].path).toBe('src/login.test.ts');
    expect(ss.testAuthor.files[0].lines).toBe(3);
    expect(ss.testAuthor.files[0].preview).toContain('line one');
    expect(ss.testAuthor.redSha).toBe('sha1');
    expect(ss.testAuthor.resumed).toBe(false);
    expect(ss.testAuthor.bindings['AC-1'].testRef).toMatch(/login\.test\.ts/);
    expect(typeof ss.testAuthor.durationMs).toBe('number');
    // implementer stage: one attempt with its commit + diff + duration.
    expect(ss.implementer.attempts).toHaveLength(1);
    expect(ss.implementer.attempts[0]).toMatchObject({ attempt: 1, commitSha: 'sha2', filesChanged: ['src/login.ts'] });
    expect(typeof ss.implementer.attempts[0].durationMs).toBe('number');
    // compile is NOT ours to write — left absent for the compile pipeline.
    expect(ss.compile).toBeUndefined();
  });

  it('(B2) caps oversized previews at 2000 chars in the persisted summary', async () => {
    const payload = makePayload();
    mkdirSync(join(workingDir, 'src'), { recursive: true });
    writeFileSync(join(workingDir, 'src', 'login.test.ts'), 'x'.repeat(6000));
    const { spawn } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implemented = true; },
    });
    await runStoryDevJob({
      job: makeJob(workingDir, payload),
      eventLogDir,
      deps: makeDeps({ spawn, git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts']] }) }),
    });
    const done = updates.find((u) => u.state === 'done');
    expect(done.stageSummaries.testAuthor.files[0].preview.length).toBeLessThanOrEqual(2000);
  });

  // ── B3 (call-site half) — per-agent skills injection ──────────────────────
  it('(B3) computes the skills loadout PER agent role: test-author gets its own prompt/role, implementer keeps story-dev', async () => {
    const payload = makePayload();
    const injectionCalls = [];
    const { spawn } = makeSpawn({
      testAuthorResults: [{ stdout: BINDING_TEXT, code: 0 }],
      onImplement: () => { implemented = true; },
    });
    const deps = makeDeps({ spawn, git: makeGit({ commitDiffs: [['src/login.test.ts'], ['src/login.ts']] }) });
    deps.buildSkillsInjection = async ({ role, storyText }) => {
      injectionCalls.push({ role, storyText });
      return [];
    };

    const r = await runStoryDevJob({ job: makeJob(workingDir, payload), eventLogDir, deps });

    expect(r.newState).toBe('done');
    const devCall = injectionCalls.find((c) => c.role === 'story-dev');
    const taCalls = injectionCalls.filter((c) => c.role === 'test-author');
    expect(devCall).toBeTruthy();
    expect(devCall.storyText).toMatch(/implementing ONE story/);
    expect(taCalls.length).toBeGreaterThanOrEqual(1);
    expect(taCalls[0].storyText).toMatch(/TEST AUTHOR/);
    // Never one loadout across roles: the two roles saw DIFFERENT prompt text.
    expect(taCalls[0].storyText).not.toBe(devCall.storyText);
  });
});
