import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { buildIntegratorPrompt, runIntegratorJob, DANGER_PATHS } from '../integrator-pipeline.mjs';

// A minimal fake child process: a stdout/stderr stream pair that emits a single
// close with the given exit code on the next tick.
function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from('{"type":"assistant"}\n'));
    child.emit('close', exitCode);
  });
  return child;
}

// A fake git that lets integrateStory commit cleanly: it is ALREADY on the plan
// branch (so ensurePlanBranch short-circuits), has staged files, and reports a
// deterministic HEAD sha after commit.
function fakeGit(sha = 'f'.repeat(40)) {
  const calls = [];
  const git = async (args) => {
    calls.push(args.join(' '));
    const a = args.join(' ');
    if (a === 'rev-parse --abbrev-ref HEAD') return { code: 0, stdout: 'plan/testapp\n', stderr: '' };
    if (a === 'diff --cached --name-only') return { code: 0, stdout: 'src/integrated.ts\n', stderr: '' };
    if (a === 'rev-parse HEAD') return { code: 0, stdout: `${sha}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  git.calls = calls;
  return git;
}

const GREEN = () => ({ passed: true, detail: 'pass' });
const RED = (d) => () => ({ passed: false, detail: d });

function baseDeps(overrides = {}) {
  const spawnCalls = [];
  const jobUpdates = [];
  return {
    spawnCalls,
    jobUpdates,
    deps: {
      spawn: (bin, args) => {
        spawnCalls.push(args);
        return fakeChild(0);
      },
      claudeBin: 'claude',
      git: fakeGit(),
      headSha: 'a'.repeat(40),
      runTreeTypecheck: GREEN,
      runTreeBuild: GREEN,
      runLint: GREEN,
      runTests: GREEN,
      bootLiveness: () => ({ passed: true, detail: 'delta', seamMounted: true }),
      updateJobFields: async (jobId, fields) => { jobUpdates.push({ jobId, fields }); },
      now: () => 0,
      logger: { info() {}, warn() {}, error() {} },
      ...overrides,
    },
  };
}

const JOB = () => ({ jobId: 'int-1', jobType: 'integrator', planId: 'p1', workingDir: `${tmpdir()}/testapp`, appId: 'testapp', planSlug: 'testapp', failureSummary: 'QA blocking: start button inert' });

describe('buildIntegratorPrompt', () => {
  it('is PURE and embeds the dispatch failure summary + whole-tree authority', () => {
    const p = buildIntegratorPrompt({ appId: 'pac', failureSummary: 'boot-liveness: no state delta' });
    expect(p).toContain('pac');
    expect(p).toContain('boot-liveness: no state delta');
    expect(p).toContain('WHOLE-TREE write authority');
    expect(p).toContain('npm run build');
  });
  it('surfaces prior-attempt red detail on a re-spawn', () => {
    const p = buildIntegratorPrompt({ appId: 'pac', priorFailure: '- test: exit 1' });
    expect(p).toContain('PREVIOUS attempt');
    expect(p).toContain('- test: exit 1');
  });
  it('omits the dispatch/prior blocks when absent (no dangling headers)', () => {
    const p = buildIntegratorPrompt({ appId: 'pac' });
    expect(p).not.toContain('Why you were dispatched');
    expect(p).not.toContain('PREVIOUS attempt');
  });
});

describe('DANGER_PATHS', () => {
  it('forbids git plumbing, deps, infra config, and secrets', () => {
    expect(DANGER_PATHS).toContain('.git/**');
    expect(DANGER_PATHS).toContain('node_modules/**');
    expect(DANGER_PATHS).toContain('sst.config.ts');
    expect(DANGER_PATHS.some((p) => p.includes('.env'))).toBe(true);
  });
});

describe('runIntegratorJob', () => {
  it('commits + stamps SHA when the whole tree is green on the first pass', async () => {
    const { deps, spawnCalls, jobUpdates } = baseDeps();
    const res = await runIntegratorJob({ job: JOB(), eventLogDir: tmpdir(), deps });
    expect(res.green).toBe(true);
    expect(res.attemptsUsed).toBe(1);
    expect(spawnCalls.length).toBe(1);
    // Committed via integrateStory → stamped the fresh commit sha, GREEN true.
    const completed = jobUpdates.find((u) => u.fields.status === 'COMPLETED');
    expect(completed.fields.variables.INTEGRATE_GREEN).toBe('true');
    expect(completed.fields.variables.INTEGRATE_SHA).toBe('f'.repeat(40));
    expect(deps.git.calls.some((c) => c.startsWith('commit'))).toBe(true);
  });

  it('re-spawns on red, then commits once the tree turns green (one-red-then-green)', async () => {
    let testCall = 0;
    const testRunner = () => {
      testCall += 1;
      return testCall === 1 ? { passed: false, detail: 'exit 1: 2 failing' } : { passed: true, detail: 'pass' };
    };
    const { deps, spawnCalls, jobUpdates } = baseDeps({ runTests: testRunner });
    const res = await runIntegratorJob({ job: JOB(), eventLogDir: tmpdir(), deps });
    expect(res.green).toBe(true);
    expect(res.attemptsUsed).toBe(2);
    // Re-spawned exactly once after the red battery.
    expect(spawnCalls.length).toBe(2);
    const completed = jobUpdates.find((u) => u.fields.status === 'COMPLETED');
    expect(completed.fields.variables.INTEGRATE_GREEN).toBe('true');
    expect(completed.fields.variables.INTEGRATE_SHA).toBe('f'.repeat(40));
  });

  it('exhausts maxAttempts staying RED → INTEGRATE_GREEN false, no SHA stamp, no commit', async () => {
    const gitFake = fakeGit();
    const { deps, spawnCalls, jobUpdates } = baseDeps({
      git: gitFake,
      runTests: RED('exit 1: persistent'),
      maxAttempts: 3,
    });
    const res = await runIntegratorJob({ job: JOB(), eventLogDir: tmpdir(), deps });
    expect(res.green).toBe(false);
    expect(res.attemptsUsed).toBe(3);
    expect(spawnCalls.length).toBe(3);
    expect(res.failing).toContain('test');
    const completed = jobUpdates.find((u) => u.fields.status === 'COMPLETED');
    expect(completed.fields.variables.INTEGRATE_GREEN).toBe('false');
    expect(completed.fields.variables.INTEGRATE_SHA).toBeUndefined();
    // Fail-closed: never committed a red tree.
    expect(gitFake.calls.some((c) => c.startsWith('commit'))).toBe(false);
  });

  it('fails closed when a green runner is missing (reality gate never passes unobserved)', async () => {
    const { deps } = baseDeps({ bootLiveness: undefined, maxAttempts: 1 });
    const res = await runIntegratorJob({ job: JOB(), eventLogDir: tmpdir(), deps });
    expect(res.green).toBe(false);
    expect(res.failing).toContain('boot');
  });
});
