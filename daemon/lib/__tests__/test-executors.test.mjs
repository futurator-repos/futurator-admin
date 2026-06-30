import { describe, it, expect } from 'vitest';
import { defaultExecutors } from '../test-executors.mjs';
import { runStoryBindings } from '../test-binding-runner.mjs';

const ac = (kind, testRef) => ({ id: 'a1', testBinding: { status: 'bound', testRef, testKind: kind } });

describe('defaultExecutors', () => {
  it('unit executor runs `vitest run <testRef>` and maps exit 0 → passed', async () => {
    const calls = [];
    const spawnSync = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: 'ok', stderr: '' }; };
    const ex = defaultExecutors({ cwd: '/w', spawnSync });
    const r = await ex.unit(ac('unit', 'foo.test.ts -t bar'));
    expect(r.passed).toBe(true);
    expect(calls[0]).toEqual(['npx', 'vitest', 'run', 'foo.test.ts -t bar']);
  });

  it('non-zero exit → failed with tail detail', async () => {
    const spawnSync = () => ({ status: 1, stdout: '', stderr: 'AssertionError: nope' });
    const r = await defaultExecutors({ cwd: '/w', spawnSync }).unit(ac('unit', 'x'));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/AssertionError/);
  });

  it('no testRef → failed (cannot run an unbound test)', async () => {
    const r = await defaultExecutors({ cwd: '/w', spawnSync: () => ({ status: 0 }) }).unit({ id: 'a', testBinding: { status: 'bound' } });
    expect(r.passed).toBe(false);
  });

  it('spawn error → failed, not a throw', async () => {
    const spawnSync = () => ({ error: new Error('ENOENT npx') });
    const r = await defaultExecutors({ cwd: '/w', spawnSync }).typecheck({});
    expect(r.passed).toBe(false);
  });

  it('end-to-end: bound story flips passing via the real-shaped executor', async () => {
    const spawnSync = () => ({ status: 0, stdout: 'pass', stderr: '' });
    const ex = defaultExecutors({ cwd: '/w', spawnSync });
    const { acceptanceCriteria } = await runStoryBindings({
      acceptanceCriteria: [ac('unit', 't.test.ts')], headSha: 'SHA', executors: ex,
    });
    expect(acceptanceCriteria[0].testBinding.status).toBe('passing');
  });
});
