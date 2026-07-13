import { describe, it, expect } from 'vitest';
import { defaultExecutors } from '../test-executors.mjs';
import { runStoryBindings } from '../test-binding-runner.mjs';

const ac = (kind, testRef) => ({ id: 'a1', testBinding: { status: 'bound', testRef, testKind: kind } });
// Every real ref must resolve to a committed test file; tests inject exists.
const yes = () => true;

describe('defaultExecutors', () => {
  it('unit executor runs `vitest run <file>` and maps exit 0 → passed', async () => {
    const calls = [];
    const spawnSync = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: 'ok', stderr: '' }; };
    const ex = defaultExecutors({ cwd: '/w', spawnSync, exists: yes });
    const r = await ex.unit(ac('unit', 'foo.test.ts'));
    expect(r.passed).toBe(true);
    expect(r.errored).toBe(false);
    expect(calls[0]).toEqual(['npx', 'vitest', 'run', '--passWithNoTests=false', 'foo.test.ts']);
  });

  it('extracts the FILE from vitest report-notation testRefs (file > describe > it)', async () => {
    const calls = [];
    const spawnSync = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; };
    const ex = defaultExecutors({ cwd: '/w', spawnSync, exists: yes });
    await ex.unit(ac('unit', 'src/x/__tests__/dino.test.ts > initiateJump — launches > makes vy negative (AC-S2-2)'));
    expect(calls[0]).toEqual(['npx', 'vitest', 'run', '--passWithNoTests=false', 'src/x/__tests__/dino.test.ts']);
  });

  it('non-zero exit → failed with tail detail', async () => {
    const spawnSync = () => ({ status: 1, stdout: '', stderr: 'AssertionError: nope' });
    const r = await defaultExecutors({ cwd: '/w', spawnSync, exists: yes }).unit(ac('unit', 'x.test.ts'));
    expect(r.passed).toBe(false);
    expect(r.errored).toBe(false); // ran-and-failed, NOT a binding fault
    expect(r.detail).toMatch(/AssertionError/);
  });

  it('no testRef → failed + errored (cannot run an unbound test)', async () => {
    const r = await defaultExecutors({ cwd: '/w', spawnSync: () => ({ status: 0 }), exists: yes }).unit({ id: 'a', testBinding: { status: 'bound' } });
    expect(r.passed).toBe(false);
    expect(r.errored).toBe(true);
  });

  it('spawn error → failed, not a throw', async () => {
    const spawnSync = () => ({ error: new Error('ENOENT npx') });
    const r = await defaultExecutors({ cwd: '/w', spawnSync, exists: yes }).typecheck({});
    expect(r.passed).toBe(false);
  });

  it('end-to-end: bound story flips passing via the real-shaped executor', async () => {
    const spawnSync = () => ({ status: 0, stdout: 'pass', stderr: '' });
    const ex = defaultExecutors({ cwd: '/w', spawnSync, exists: yes });
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [ac('unit', 't.test.ts')], headSha: 'SHA', executors: ex,
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('passing');
  });
});

describe('defaultExecutors — F1 multi-ref execution (Incident C)', () => {
  it('runs EACH ref of a JSON-array testRef and ANDs the results', async () => {
    const calls = [];
    const spawnSync = (cmd, args) => { calls.push(args[args.length - 1]); return { status: 0 }; };
    const ex = defaultExecutors({ cwd: '/w', spawnSync, exists: yes });
    const r = await ex.unit(ac('unit', ['a/one.test.ts', 'b/two.test.ts']));
    expect(r.passed).toBe(true);
    expect(r.errored).toBe(false);
    expect(calls).toEqual(['a/one.test.ts', 'b/two.test.ts']); // both files run
  });

  it('parses a legacy " + "-joined composite with parenthetical prose and runs each file', async () => {
    const calls = [];
    const spawnSync = (cmd, args) => { calls.push(args[args.length - 1]); return { status: 0 }; };
    const ex = defaultExecutors({ cwd: '/w', spawnSync, exists: yes });
    // the exact Incident-C shape: two files, prose in parens, one carrying a verify note
    await ex.unit(ac('unit',
      'src/game/maze.test.ts (buildInitialState contract) + src/game/reducer.test.ts (makePacmanReducer/System contract; typecheck enforced separately by the verify:build step)'));
    expect(calls).toEqual(['src/game/maze.test.ts', 'src/game/reducer.test.ts']);
  });

  it('ANY failing ref → AC fails (never turns a genuine failure green)', async () => {
    const spawnSync = (cmd, args) => ({ status: args[args.length - 1] === 'b.test.ts' ? 1 : 0, stderr: 'boom' });
    const ex = defaultExecutors({ cwd: '/w', spawnSync, exists: yes });
    const r = await ex.unit(ac('unit', ['a.test.ts', 'b.test.ts']));
    expect(r.passed).toBe(false);
    expect(r.errored).toBe(false); // one ran and failed — a real failure, not a fault
  });

  it('ANY unresolvable ref → errored (binding fault), distinct from ran-and-failed', async () => {
    const ran = [];
    const spawnSync = (cmd, args) => { ran.push(args[args.length - 1]); return { status: 0 }; };
    // only a.test.ts exists; b.test.ts does not
    const exists = (p) => /a\.test\.ts$/.test(p);
    const ex = defaultExecutors({ cwd: '/w', spawnSync, exists });
    const r = await ex.unit(ac('unit', ['a.test.ts', 'b.test.ts']));
    expect(r.passed).toBe(false);
    expect(r.errored).toBe(true);
    expect(r.detail).toMatch(/no such test file/);
    expect(ran).toEqual(['a.test.ts']); // the missing file is never spawned
  });

  it('a ref that is not a *.test.*/*.spec.* file at all → errored (unrunnable)', async () => {
    const ex = defaultExecutors({ cwd: '/w', spawnSync: () => ({ status: 0 }), exists: yes });
    const r = await ex.unit(ac('unit', 'src/game/reducer.ts')); // a source file, not a test
    expect(r.passed).toBe(false);
    expect(r.errored).toBe(true);
  });

  it('passes ONLY when every token is a real file AND every run is green (safety property)', async () => {
    const spawnSync = () => ({ status: 0 });
    const ex = defaultExecutors({ cwd: '/w', spawnSync, exists: yes });
    const r = await ex.unit(ac('unit', ['a.test.ts', 'b.spec.ts']));
    expect(r.passed).toBe(true);
    expect(r.errored).toBe(false);
  });
});
