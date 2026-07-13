import { describe, it, expect } from 'vitest';
import { runStoryBindings, runStoryInvariants, makeInvariantExecutor } from '../test-binding-runner.mjs';
import { evaluateCompletion } from '../completion-gate.mjs';

const bound = (id, kind = 'unit', over = {}) => ({
  id, text: `${id}`, acClass: 'deterministic',
  testBinding: { status: 'bound', testRef: `ref-${id}`, testKind: kind }, ...over,
});

describe('runStoryBindings', () => {
  it('flips bound→passing/failing and stamps headSha', async () => {
    const { acceptanceCriteria, summary } = await runStoryBindings({
      acceptanceCriteria: [bound('a'), bound('b')],
      headSha: 'SHA1',
      executors: { unit: async (ac) => ({ passed: ac.id === 'a' }) },
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('passing');
    expect(acceptanceCriteria[0].testBinding.lastRunSha).toBe('SHA1');
    expect(acceptanceCriteria[1].testBinding.status).toBe('failing');
    expect(summary).toEqual({ ran: 2, passed: 1, failed: 1, skipped: 0 });
  });

  it('skips unbound and manual ACs (left for the gate / human)', async () => {
    const { summary } = await runStoryBindings({
      acceptanceCriteria: [
        { id: 'u', testBinding: { status: 'unbound' } },
        { id: 'm', verify: 'manual', testBinding: { status: 'bound', testRef: 'r', testKind: 'manual' } },
      ],
      headSha: 'SHA1',
    });
    expect(summary.skipped).toBe(2);
    expect(summary.ran).toBe(0);
  });

  it('a throwing executor is a fail, not a crash', async () => {
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [bound('a')],
      headSha: 'SHA1',
      executors: { unit: async () => { throw new Error('boom'); } },
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('failing');
    expect(acceptanceCriteria[0].testBinding.detail).toMatch(/boom/);
  });

  it('FAIL CLOSED: a behavior AC bound testKind:unit is not run as unit — recorded failing', async () => {
    let unitRan = false;
    const { acceptanceCriteria, summary } = await runStoryBindings({
      acceptanceCriteria: [{
        id: 'beh', verify: 'behavior', needsBrowser: true, acClass: 'deterministic',
        testBinding: { status: 'bound', testRef: 'x.test.ts', testKind: 'unit' },
      }],
      headSha: 'SHA1',
      executors: { unit: async () => { unitRan = true; return { passed: true }; } },
    });
    expect(unitRan).toBe(false); // never silently downgraded to the unit executor
    expect(acceptanceCriteria[0].testBinding.status).toBe('failing');
    expect(acceptanceCriteria[0].testBinding.detail).toMatch(/browser/);
    expect(summary).toEqual({ ran: 1, passed: 0, failed: 1, skipped: 0 });
  });

  it('a behavior AC bound testKind:browser runs under the browser executor', async () => {
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [{
        id: 'beh', verify: 'behavior', needsBrowser: true, acClass: 'deterministic',
        testBinding: { status: 'bound', testRef: 'probe:reach', testKind: 'browser' },
      }],
      headSha: 'SHA1',
      executors: { browser: async () => ({ passed: true }) },
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('passing');
  });

  it('end-to-end: run → evaluateCompletion reports done when all pass at headSha', async () => {
    const headSha = 'SHA9';
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [bound('a'), bound('b')],
      headSha,
      executors: { unit: async () => ({ passed: true }) },
    });
    const verdict = evaluateCompletion({ acceptanceCriteria, currentHeadSha: headSha });
    expect(verdict.status).toBe('done');
  });
});

describe('runStoryBindings — no-mock rule for verify:state ACs', () => {
  const stateAc = (id, over = {}) => ({
    id, verify: 'state', acClass: 'deterministic',
    testBinding: { status: 'bound', testRef: `src/${id}.test.ts`, testKind: 'unit' }, ...over,
  });

  it('a state/unit AC whose bound test mocks an in-repo module → misbound, not run', async () => {
    let ran = false;
    const readFile = async () => `vi.mock('./levels')\nimport { init } from './levels'`;
    const { acceptanceCriteria, summary } = await runStoryBindings({
      acceptanceCriteria: [stateAc('a')],
      headSha: 'SHA1', cwd: '/wt', readFile,
      executors: { unit: async () => { ran = true; return { passed: true }; } },
    });
    expect(ran).toBe(false);
    expect(acceptanceCriteria[0].testBinding.status).toBe('misbound');
    expect(acceptanceCriteria[0].testBinding.detail).toMatch(/no-mock rule/);
    expect(acceptanceCriteria[0].testBinding.detail).toMatch(/\.\/levels/);
    expect(summary).toEqual({ ran: 1, passed: 0, failed: 1, skipped: 0 });
  });

  it('an unreadable bound test file → misbound (fail-closed)', async () => {
    const readFile = async () => { throw new Error('ENOENT'); };
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [stateAc('a')],
      headSha: 'SHA1', cwd: '/wt', readFile,
      executors: { unit: async () => ({ passed: true }) },
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('misbound');
    expect(acceptanceCriteria[0].testBinding.detail).toMatch(/file unreadable/);
  });

  it('a state/unit AC with clean source runs normally', async () => {
    const readFile = async () => `import { init } from './levels'\nit('works', () => {})`;
    const { acceptanceCriteria, summary } = await runStoryBindings({
      acceptanceCriteria: [stateAc('a')],
      headSha: 'SHA1', cwd: '/wt', readFile,
      executors: { unit: async () => ({ passed: true }) },
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('passing');
    expect(summary).toEqual({ ran: 1, passed: 1, failed: 0, skipped: 0 });
  });

  it('RED phase: enforceNoMock:false skips the check even for a mocking test', async () => {
    const readFile = async () => `vi.mock('./levels')`;
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [stateAc('a')],
      headSha: 'SHA1', cwd: '/wt', readFile, enforceNoMock: false,
      executors: { unit: async () => ({ passed: true }) },
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('passing');
  });

  it('the no-mock rule does NOT apply to a non-state (verify undefined) unit AC', async () => {
    let ran = false;
    const readFile = async () => `vi.mock('./levels')`; // would violate IF checked
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [{ id: 'p', acClass: 'deterministic', testBinding: { status: 'bound', testRef: 'p.test.ts', testKind: 'unit' } }],
      headSha: 'SHA1', cwd: '/wt', readFile,
      executors: { unit: async () => { ran = true; return { passed: true }; } },
    });
    expect(ran).toBe(true);
    expect(acceptanceCriteria[0].testBinding.status).toBe('passing');
  });
});

describe('runStoryInvariants', () => {

  // pacman1 (2026-07-13): the no-mock source read must resolve a RELATIVE
  // validator ref against the worktree cwd — reading it raw resolves against
  // the daemon's own cwd, every ref is ENOENT, and the story fails "unreadable
  // — fail-closed" on all attempts no matter how green the code.
  it('resolves relative validator refs against cwd for the no-mock read', async () => {
    const reads = [];
    const readFile = async (path) => { reads.push(path); return 'import { x } from "./real";'; };
    const { invariants } = await runStoryInvariants({
      invariants: [{ id: 'i1', validator: { status: 'authored', ref: 'src/a.invariant.test.ts', kind: 'test' } }],
      headSha: 'S', cwd: '/work/tree', readFile,
      executor: async () => ({ passed: true }),
    });
    expect(reads).toEqual(['/work/tree/src/a.invariant.test.ts']);
    expect(invariants[0].validator.status).toBe('passing');
  });

  it('leaves absolute validator refs untouched and stays fail-closed on a missing file', async () => {
    const reads = [];
    const readFile = async (path) => { reads.push(path); throw new Error('ENOENT'); };
    const { invariants } = await runStoryInvariants({
      invariants: [{ id: 'i1', validator: { status: 'authored', ref: '/abs/v.test.ts', kind: 'test' } }],
      headSha: 'S', cwd: '/work/tree', readFile,
      executor: async () => ({ passed: true }),
    });
    expect(reads).toEqual(['/abs/v.test.ts']);
    expect(invariants[0].validator.status).toBe('failing');
    expect(invariants[0].validator.detail).toMatch(/unreadable — fail-closed/);
  });
  const inv = (id, over = {}) => ({ id, description: `${id} holds`, validator: { status: 'declared', ...over } });

  it('a declared invariant with no authored validator → failing (fail-closed)', async () => {
    const { invariants, summary } = await runStoryInvariants({
      invariants: [inv('i1')], headSha: 'SHA1', executor: async () => ({ passed: true }),
      readFile: async () => '', now: () => 'T',
    });
    expect(invariants[0].validator.status).toBe('failing');
    expect(invariants[0].validator.detail).toMatch(/no authored validator/);
    expect(summary).toEqual({ ran: 0, passed: 0, failed: 1, skipped: 0 });
  });

  it('an authored validator that mocks an in-repo module → failing, not executed', async () => {
    let ran = false;
    const { invariants } = await runStoryInvariants({
      invariants: [inv('i1', { status: 'authored', ref: 'v.invariant.test.ts', kind: 'test' })],
      headSha: 'SHA1',
      readFile: async () => `vi.mock('@/game/state')`,
      executor: async () => { ran = true; return { passed: true }; },
      now: () => 'T',
    });
    expect(ran).toBe(false);
    expect(invariants[0].validator.status).toBe('failing');
    expect(invariants[0].validator.detail).toMatch(/no-mock rule/);
  });

  it('an authored+clean validator that passes → passing + lastRunSha stamped', async () => {
    const { invariants, summary } = await runStoryInvariants({
      invariants: [inv('i1', { status: 'authored', ref: 'v.mjs', kind: 'script' })],
      headSha: 'SHA9',
      readFile: async () => `// pure node script`,
      executor: async () => ({ passed: true, detail: 'flood-fill ok' }),
      now: () => 'T1',
    });
    expect(invariants[0].validator.status).toBe('passing');
    expect(invariants[0].validator.lastRunSha).toBe('SHA9');
    expect(invariants[0].validator.lastRunAt).toBe('T1');
    expect(invariants[0].validator.detail).toBe('flood-fill ok');
    expect(summary).toEqual({ ran: 1, passed: 1, failed: 0, skipped: 0 });
  });

  it('a failing executor → failing status', async () => {
    const { invariants } = await runStoryInvariants({
      invariants: [inv('i1', { status: 'authored', ref: 'v.mjs', kind: 'script' })],
      headSha: 'SHA1', readFile: async () => '// ok',
      executor: async () => ({ passed: false, detail: 'unreachable pellet' }), now: () => 'T',
    });
    expect(invariants[0].validator.status).toBe('failing');
    expect(invariants[0].validator.detail).toBe('unreachable pellet');
  });

  it('a throwing executor is a fail, not a crash', async () => {
    const { invariants } = await runStoryInvariants({
      invariants: [inv('i1', { status: 'authored', ref: 'v.mjs', kind: 'script' })],
      headSha: 'SHA1', readFile: async () => '// ok',
      executor: async () => { throw new Error('boom'); }, now: () => 'T',
    });
    expect(invariants[0].validator.status).toBe('failing');
    expect(invariants[0].validator.detail).toMatch(/boom/);
  });
});

describe('makeInvariantExecutor', () => {
  it('kind:script → node <ref>, exit 0 = pass', async () => {
    const calls = [];
    const spawnSync = (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: 'ok', stderr: '' }; };
    const exec = makeInvariantExecutor({ cwd: '/wt', spawnSync });
    const r = await exec({ validator: { ref: 'scripts/inv/flood.mjs', kind: 'script' } });
    expect(r.passed).toBe(true);
    expect(calls[0]).toEqual(['node', ['scripts/inv/flood.mjs']]);
  });

  it('kind:test → vitest on the file segment of the ref', async () => {
    const calls = [];
    const spawnSync = (cmd, args) => { calls.push([cmd, args]); return { status: 1, stdout: '', stderr: 'fail' }; };
    const exec = makeInvariantExecutor({ cwd: '/wt', spawnSync });
    const r = await exec({ validator: { ref: 'v.invariant.test.ts > prop > holds', kind: 'test' } });
    expect(r.passed).toBe(false);
    expect(calls[0]).toEqual(['npx', ['vitest', 'run', 'v.invariant.test.ts']]);
  });

  it('no ref → not passed', async () => {
    const exec = makeInvariantExecutor({ cwd: '/wt', spawnSync: () => ({ status: 0 }) });
    expect((await exec({ validator: {} })).passed).toBe(false);
  });
});
