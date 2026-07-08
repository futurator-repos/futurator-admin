import { describe, it, expect } from 'vitest';
import { handleStoryCompletion } from '../story-completion-handler.mjs';

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
