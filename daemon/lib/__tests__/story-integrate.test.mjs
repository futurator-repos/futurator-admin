import { describe, it, expect, beforeEach } from 'vitest';
import { withCommitLock, isLocked, _reset } from '../commit-lock.mjs';
import { integrateStory } from '../story-integrate.mjs';
import { planBranchName, ensurePlanBranch, mergePlanToMain } from '../plan-branch.mjs';

describe('commit-lock', () => {
  beforeEach(() => _reset());

  it('serializes work for the same repo key (no overlap)', async () => {
    let active = 0; let maxActive = 0;
    const work = () => withCommitLock('/repoA', async () => {
      active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return 'ok';
    });
    await Promise.all([work(), work(), work()]);
    expect(maxActive).toBe(1);
  });

  it('runs different repo keys concurrently', async () => {
    const order = [];
    const a = withCommitLock('/repoA', async () => { await new Promise((r) => setTimeout(r, 10)); order.push('A'); });
    const b = withCommitLock('/repoB', async () => { order.push('B'); });
    await Promise.all([a, b]);
    expect(order[0]).toBe('B'); // B didn't wait on A's timer
  });

  it('a failing holder still releases the lock', async () => {
    await withCommitLock('/repoA', async () => { throw new Error('boom'); }).catch(() => {});
    const after = await withCommitLock('/repoA', async () => 'recovered');
    expect(after).toBe('recovered');
  });
});

describe('integrateStory', () => {
  function fakeGit(script) {
    const calls = [];
    const git = async (args, cwd) => {
      calls.push(args.join(' '));
      const key = args[0] + (args[1] ? ` ${args[1]}` : '');
      const r = script[key] ?? script[args[0]] ?? { code: 0, stdout: '', stderr: '' };
      return typeof r === 'function' ? r(args, cwd) : r;
    };
    return { git, calls };
  }

  it('stages touches, commits, returns the new SHA', async () => {
    const { git, calls } = fakeGit({
      add: { code: 0, stdout: '', stderr: '' },
      'diff --cached': { code: 0, stdout: 'src/game/dino.ts\n', stderr: '' },
      commit: { code: 0, stdout: '', stderr: '' },
      'rev-parse': { code: 0, stdout: 'abc123sha\n', stderr: '' },
    });
    const r = await integrateStory({ repoDir: '/r', touches: ['src/game/dino.ts'], storyId: 's1', title: 'Dino', git });
    expect(r).toEqual({ committed: true, sha: 'abc123sha' });
    expect(calls.some((c) => c.startsWith('add src/game/dino.ts'))).toBe(true);
    expect(calls.some((c) => c.startsWith('commit'))).toBe(true);
  });

  it('no staged changes → no commit', async () => {
    const { git } = fakeGit({
      add: { code: 0, stdout: '' },
      'diff --cached': { code: 0, stdout: '   \n' },
    });
    const r = await integrateStory({ repoDir: '/r', touches: ['x.ts'], storyId: 's', git });
    expect(r.committed).toBe(false);
    expect(r.reason).toMatch(/nothing to commit/);
  });

  it('EPIC_WIDE / empty touches → stages all (-A)', async () => {
    const { git, calls } = fakeGit({
      add: { code: 0 }, 'diff --cached': { code: 0, stdout: 'a\n' }, commit: { code: 0 }, 'rev-parse': { code: 0, stdout: 's\n' },
    });
    await integrateStory({ repoDir: '/r', touches: ['<EPIC_WIDE>'], storyId: 's', git });
    expect(calls.some((c) => c === 'add -A')).toBe(true);
  });

  it('git add failure → not committed, reason surfaced', async () => {
    const { git } = fakeGit({ add: { code: 1, stderr: 'fatal: pathspec' } });
    const r = await integrateStory({ repoDir: '/r', touches: ['x.ts'], storyId: 's', git });
    expect(r.committed).toBe(false);
    expect(r.reason).toMatch(/git add failed/);
  });

  it('planBranch → ensures the branch before committing', async () => {
    const { git, calls } = fakeGit({
      'rev-parse --abbrev-ref': { code: 0, stdout: 'main\n' },
      'rev-parse --verify': { code: 1, stdout: '' }, // branch doesn't exist
      checkout: { code: 0 },
      add: { code: 0 }, 'diff --cached': { code: 0, stdout: 'x.ts\n' }, commit: { code: 0 },
      'rev-parse': { code: 0, stdout: 'sha9\n' },
    });
    const r = await integrateStory({ repoDir: '/r', touches: ['x.ts'], storyId: 's', planBranch: 'plan/p1', git });
    expect(r.committed).toBe(true);
    expect(r.branch).toBe('plan/p1');
    expect(calls.some((c) => c.startsWith('checkout -b plan/p1'))).toBe(true);
  });
});

describe('plan-branch', () => {
  function fakeGit(script) {
    const calls = [];
    const git = async (args) => {
      calls.push(args.join(' '));
      const key = args.slice(0, 2).join(' ');
      const r = script[key] ?? script[args[0]] ?? { code: 0, stdout: '', stderr: '' };
      return r;
    };
    return { git, calls };
  }

  it('planBranchName sanitizes ids into a valid ref', () => {
    expect(planBranchName('plan_dino1_mr0')).toBe('plan/plan_dino1_mr0');
    expect(planBranchName('weird/slug name')).toBe('plan/weird-slug-name');
  });

  it('ensurePlanBranch: no-op when already on the branch', async () => {
    const { git, calls } = fakeGit({ 'rev-parse --abbrev-ref': { code: 0, stdout: 'plan/p1\n' } });
    const r = await ensurePlanBranch({ repoDir: '/r', branch: 'plan/p1', git });
    expect(r).toEqual({ branch: 'plan/p1', created: false, switched: false });
    expect(calls.length).toBe(1); // only the HEAD check
  });

  it('ensurePlanBranch: checks out an existing branch', async () => {
    const { git, calls } = fakeGit({
      'rev-parse --abbrev-ref': { code: 0, stdout: 'main\n' },
      'rev-parse --verify': { code: 0, stdout: 'sha\n' }, // exists
      checkout: { code: 0 },
    });
    const r = await ensurePlanBranch({ repoDir: '/r', branch: 'plan/p1', git });
    expect(r.switched).toBe(true);
    expect(r.created).toBe(false);
    expect(calls.some((c) => c === 'checkout plan/p1')).toBe(true);
  });

  it('mergePlanToMain: checks out main and merges --no-ff', async () => {
    const { git, calls } = fakeGit({
      checkout: { code: 0 }, merge: { code: 0 }, 'rev-parse': { code: 0, stdout: 'mainsha\n' },
    });
    const r = await mergePlanToMain({ repoDir: '/r', branch: 'plan/p1', git });
    expect(r.merged).toBe(true);
    expect(r.sha).toBe('mainsha');
    expect(calls.some((c) => c === 'checkout main')).toBe(true);
    expect(calls.some((c) => c.startsWith('merge --no-ff plan/p1'))).toBe(true);
  });

  it('mergePlanToMain: conflict → abort, not merged', async () => {
    const { git, calls } = fakeGit({
      checkout: { code: 0 }, merge: { code: 1, stdout: 'CONFLICT' },
    });
    const r = await mergePlanToMain({ repoDir: '/r', branch: 'plan/p1', git });
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/conflict/i);
    expect(calls.some((c) => c === 'merge --abort')).toBe(true);
  });
});
