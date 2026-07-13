import { describe, it, expect } from 'vitest';
import { handleStoryCompletion, findInvariantValidatorByConvention } from '../story-completion-handler.mjs';

const ac = (id, over = {}) => ({ id, text: `${id}`, acClass: 'deterministic', verify: 'state', ...over });

// A dev transcript that binds one state AC to a unit test.
const bindingText = (id, ref = `src/${id}.test.ts`) =>
  `work...\n<BINDING>\n{ "${id}": { "testRef": "${ref}", "testKind": "unit" } }\n</BINDING>\n`;

describe('handleStoryCompletion — no-mock + invariants threaded end-to-end', () => {
  it('a state AC bound to a mocking test → story fails (misbound), no propagate', async () => {
    const storyNode = { acceptanceCriteria: [ac('a')] };
    const r = await handleStoryCompletion({
      storyNode,
      devOutput: bindingText('a'),
      headSha: 'SHA1',
      cwd: '/wt',
      readFile: async () => `vi.mock('./levels')`,
      executors: { unit: async () => ({ passed: true }) },
    });
    expect(r.newState).toBe('failed');
    expect(r.propagate).toBe(false);
    expect(r.acceptanceCriteria[0].testBinding.status).toBe('misbound');
  });

  it('a state AC bound to a clean test → story done', async () => {
    const storyNode = { acceptanceCriteria: [ac('a')] };
    const r = await handleStoryCompletion({
      storyNode,
      devOutput: bindingText('a'),
      headSha: 'SHA1',
      cwd: '/wt',
      readFile: async () => `import { init } from './levels'`,
      executors: { unit: async () => ({ passed: true }) },
    });
    expect(r.newState).toBe('done');
    expect(r.propagate).toBe(true);
  });

  it('a declared invariant with no authored validator blocks completion (fail-closed)', async () => {
    const storyNode = { acceptanceCriteria: [ac('a')] };
    const r = await handleStoryCompletion({
      storyNode,
      devOutput: bindingText('a'), // no <INVARIANTS> manifest → invariant stays declared
      headSha: 'SHA1',
      cwd: '/wt',
      invariants: [{ id: 'inv-1', description: 'every pellet is reachable', validator: { status: 'declared' } }],
      readFile: async () => `import { init } from './levels'`,
      executors: { unit: async () => ({ passed: true }) },
      invariantExecutor: async () => ({ passed: true }),
    });
    expect(r.newState).toBe('failed');
    expect(r.verdict.failing).toContain('inv-1');
    expect(r.invariants[0].validator.status).toBe('failing');
  });

  it('an authored + passing invariant lets the story complete', async () => {
    const storyNode = { acceptanceCriteria: [ac('a')] };
    const agentText = `${bindingText('a')}\n<INVARIANTS>\n{ "inv-1": { "ref": "scripts/inv/flood.mjs", "kind": "script" } }\n</INVARIANTS>`;
    const r = await handleStoryCompletion({
      storyNode,
      devOutput: agentText,
      headSha: 'SHA1',
      cwd: '/wt',
      invariants: [{ id: 'inv-1', description: 'every pellet is reachable', validator: { status: 'declared' } }],
      readFile: async () => `import { init } from './levels'`, // clean for both AC test and validator source
      executors: { unit: async () => ({ passed: true }) },
      invariantExecutor: async () => ({ passed: true }),
    });
    expect(r.newState).toBe('done');
    expect(r.invariants[0].validator.status).toBe('passing');
    expect(r.invariants[0].validator.lastRunSha).toBe('SHA1');
  });

  it('an authored invariant whose validator FAILS blocks completion', async () => {
    const storyNode = { acceptanceCriteria: [ac('a')] };
    const agentText = `${bindingText('a')}\n<INVARIANTS>\n{ "inv-1": "v.invariant.test.ts" }\n</INVARIANTS>`;
    const r = await handleStoryCompletion({
      storyNode,
      devOutput: agentText,
      headSha: 'SHA1',
      cwd: '/wt',
      invariants: [{ id: 'inv-1', description: 'maze solvable', validator: { status: 'declared', kind: 'test' } }],
      readFile: async () => `import { solve } from './maze'`,
      executors: { unit: async () => ({ passed: true }) },
      invariantExecutor: async () => ({ passed: false, detail: 'unreachable region' }),
    });
    expect(r.newState).toBe('failed');
    expect(r.verdict.failing).toContain('inv-1');
  });
});

// ── Convention rebind (dossier A1) ────────────────────────────────────────────
// A resumed/retried job has bindingOutput='' → <INVARIANTS> manifest {} — the
// dead-end that failed every invariant-carrying retry (pacman1, job 677f9e70).
// When the row didn't persist a validator either, the gate deterministically
// rebinds to the committed `**/<id>.invariant.test.*` file the test-author
// prompt MANDATES. Not found → stays declared → fail-closed (unchanged).

/** Minimal fake fs: tree maps absolute dir → [name, 'f'|'d'] entries. */
const fakeFs = (tree) => ({
  readdirSync: (dir) => {
    const entries = tree[dir];
    if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
    return entries.map(([name, type]) => ({
      name,
      isFile: () => type === 'f',
      isDirectory: () => type === 'd',
    }));
  },
});

describe('findInvariantValidatorByConvention', () => {
  const tree = {
    '/wt': [['src', 'd'], ['node_modules', 'd'], ['.git', 'd'], ['README.md', 'f']],
    '/wt/src': [['game', 'd'], ['app.ts', 'f']],
    '/wt/src/game': [['inv-1.invariant.test.ts', 'f'], ['maze.ts', 'f']],
    // poisoned copies that must never be found (skipped dirs)
    '/wt/node_modules': [['inv-2.invariant.test.ts', 'f']],
    '/wt/.git': [['inv-2.invariant.test.ts', 'f']],
  };

  it('finds a nested committed validator and returns a cwd-relative path', () => {
    const ref = findInvariantValidatorByConvention({ cwd: '/wt', invariantId: 'inv-1', fs: fakeFs(tree) });
    expect(ref).toBe('src/game/inv-1.invariant.test.ts');
  });

  it('never descends into node_modules or dot-dirs', () => {
    const ref = findInvariantValidatorByConvention({ cwd: '/wt', invariantId: 'inv-2', fs: fakeFs(tree) });
    expect(ref).toBeNull();
  });

  it('returns null when no file matches (and for missing args)', () => {
    expect(findInvariantValidatorByConvention({ cwd: '/wt', invariantId: 'ghost', fs: fakeFs(tree) })).toBeNull();
    expect(findInvariantValidatorByConvention({ cwd: '', invariantId: 'inv-1', fs: fakeFs(tree) })).toBeNull();
    expect(findInvariantValidatorByConvention({ cwd: '/wt', invariantId: '', fs: fakeFs(tree) })).toBeNull();
  });

  it('fails CLOSED on an AMBIGUOUS id: two committed files match → null (never binds a wrong story\'s validator)', () => {
    // Legacy plans minted before id-namespacing (or hand-authored rows) can
    // carry the same invariant id on two stories, each with its own committed
    // validator. Binding either one would judge a story by a test asserting a
    // DIFFERENT story's property — ambiguous stays 'declared' → fail-closed.
    const dup = {
      '/wt': [['src', 'd'], ['tests', 'd']],
      '/wt/src': [['seed-valid.invariant.test.ts', 'f']],
      '/wt/tests': [['seed-valid.invariant.test.mjs', 'f']],
    };
    expect(findInvariantValidatorByConvention({ cwd: '/wt', invariantId: 'seed-valid', fs: fakeFs(dup) })).toBeNull();
  });
});

describe('handleStoryCompletion — convention rebind on resume (A1)', () => {
  const tree = {
    '/wt': [['src', 'd']],
    '/wt/src': [['inv-1.invariant.test.ts', 'f']],
  };
  const resumeArgs = (over = {}) => ({
    storyNode: { acceptanceCriteria: [ac('a', { testBinding: { status: 'bound', testRef: 'src/a.test.ts', testKind: 'unit' } })] },
    devOutput: '', // RESUME: bindingOutput is empty — no <BINDING>, no <INVARIANTS>
    headSha: 'SHA2',
    cwd: '/wt',
    readFile: async () => `import { init } from './levels'`,
    executors: { unit: async () => ({ passed: true }) },
    invariantExecutor: async () => ({ passed: true }),
    ...over,
  });

  it('manifest absent + no persisted ref + committed conventional file → rebound authored → runs → done', async () => {
    const r = await handleStoryCompletion(resumeArgs({
      invariants: [{ id: 'inv-1', description: 'd', validator: { status: 'declared' } }],
      fs: fakeFs(tree),
    }));
    expect(r.newState).toBe('done');
    expect(r.invariants[0].validator.ref).toBe('src/inv-1.invariant.test.ts');
    expect(r.invariants[0].validator.kind).toBe('test');
    expect(r.invariants[0].validator.status).toBe('passing');
  });

  it('manifest absent + no conventional file → stays declared → fail-closed (unchanged)', async () => {
    const r = await handleStoryCompletion(resumeArgs({
      invariants: [{ id: 'inv-9', description: 'd', validator: { status: 'declared' } }],
      fs: fakeFs(tree),
    }));
    expect(r.newState).toBe('failed');
    expect(r.verdict.failing).toContain('inv-9');
    expect(r.invariants[0].validator.status).toBe('failing');
    expect(r.invariants[0].validator.detail).toMatch(/no authored validator/);
  });

  it('a PERSISTED validator ref (row write-back) is honored without any manifest or rebind', async () => {
    const r = await handleStoryCompletion(resumeArgs({
      invariants: [{ id: 'inv-1', description: 'd', validator: { ref: 'scripts/inv/check.mjs', kind: 'script', status: 'authored' } }],
      fs: fakeFs({ '/wt': [] }), // rebind would find nothing — must not be needed
    }));
    expect(r.newState).toBe('done');
    expect(r.invariants[0].validator.ref).toBe('scripts/inv/check.mjs');
    expect(r.invariants[0].validator.status).toBe('passing');
  });

  it('a fresh <INVARIANTS> manifest wins over the convention search', async () => {
    const agentText = `<INVARIANTS>{ "inv-1": { "ref": "custom/path.invariant.test.ts", "kind": "test" } }</INVARIANTS>`;
    const r = await handleStoryCompletion(resumeArgs({
      devOutput: agentText,
      invariants: [{ id: 'inv-1', description: 'd', validator: { status: 'declared' } }],
      fs: fakeFs(tree),
    }));
    expect(r.invariants[0].validator.ref).toBe('custom/path.invariant.test.ts');
  });
});
