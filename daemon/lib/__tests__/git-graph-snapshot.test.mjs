/**
 * Unit tests for git-graph-snapshot.mjs (2026-05-30).
 *
 * Verifies the bare-repo → GitGraphResponse mapping with a mock git runner,
 * including the US-delimited log parse, multi-parent (merge) commits, and the
 * branch parse. The real git commands were validated against a live bare repo.
 */

import { describe, it, expect } from 'vitest';
import { buildGitGraphSnapshot } from '../git-graph-snapshot.mjs';

const US = String.fromCharCode(31);

// A fake bare repo: main + plan/<slug>, with a 2-parent merge commit.
function fakeGit() {
  const logLines = [
    ['bdd', 'fed', 'fix(skills): remediate', 'Futurator Daemon', 'd@f.ai', '2026-05-30T13:00:00Z'].join(
      US,
    ),
    // merge commit — two parents (the "merge story X into wave" shape)
    ['0cc', '8cd 633', 'merge story 0b1be858 into wave', 'Futurator Daemon', 'd@f.ai', '2026-05-29T21:00:00Z'].join(
      US,
    ),
    ['8cd', '', 'init', 'Futurator Daemon', 'd@f.ai', '2026-05-29T20:00:00Z'].join(US),
  ].join('\n');
  const refLines = ['bdd main', '8cd plan/dino1-initial'].join('\n');
  return (args) => {
    if (args.includes('log')) return Promise.resolve({ code: 0, stdout: logLines, stderr: '' });
    if (args.includes('for-each-ref'))
      return Promise.resolve({ code: 0, stdout: refLines, stderr: '' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
}

describe('buildGitGraphSnapshot', () => {
  it('maps bare-repo log + refs to the GitGraphResponse shape', async () => {
    const snap = await buildGitGraphSnapshot({
      appId: 'dino1',
      bare: '/home/ubuntu/repos/dino1.git',
      git: fakeGit(),
      bareOpCwd: '/home/ubuntu/projects',
    });
    expect(snap).toBeTruthy();
    expect(snap.repo.name).toBe('dino1');
    expect(snap.repo.default_branch).toBe('main');
    expect(snap.source).toBe('bare-repo');
    expect(snap.pullRequests).toEqual([]);

    // 3 commits parsed
    expect(snap.commits).toHaveLength(3);
    const first = snap.commits[0];
    expect(first.sha).toBe('bdd');
    expect(first.commit.message).toBe('fix(skills): remediate');
    expect(first.commit.author.name).toBe('Futurator Daemon');
    expect(first.author).toBeNull();

    // The merge commit has TWO parents (the branching/merge the user wants).
    const merge = snap.commits.find((c) => c.sha === '0cc');
    expect(merge.parents.map((p) => p.sha)).toEqual(['8cd', '633']);

    // The root commit has zero parents.
    expect(snap.commits.find((c) => c.sha === '8cd').parents).toEqual([]);

    // Branches parsed (sha-first, name after).
    expect(snap.branches).toEqual([
      { name: 'main', commit: { sha: 'bdd' }, protected: true },
      { name: 'plan/dino1-initial', commit: { sha: '8cd' }, protected: false },
    ]);
  });

  it('returns null when git log fails', async () => {
    const git = () => Promise.resolve({ code: 1, stdout: '', stderr: 'boom' });
    const snap = await buildGitGraphSnapshot({ appId: 'x', bare: '/b', git, bareOpCwd: '/' });
    expect(snap).toBeNull();
  });

  it('returns null on missing inputs', async () => {
    expect(await buildGitGraphSnapshot({ appId: '', bare: '/b', git: fakeGit(), bareOpCwd: '/' })).toBeNull();
  });
});
