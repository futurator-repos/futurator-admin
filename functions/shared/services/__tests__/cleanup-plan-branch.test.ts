/**
 * Unit tests for cleanupPlanBranch + assertWorktreeClean (2026-05-19).
 *
 * Both helpers ship SSM shell scripts. The tests stub sendSsmCommand/
 * waitForSsmOutput and assert two things per case:
 *
 *   1. The shell script the daemon would receive is shaped correctly
 *      (right git command, right branch name, sudo -u ubuntu prefix).
 *   2. The parsed result reflects the simulated SSM stdout sensibly.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  cleanupPlanBranch,
  assertWorktreeClean,
  countResidualPlanCommits,
  reapPlanStoryWorktrees,
  resetAppWorktreeToMain,
} from '../plan-folder-service';

describe('cleanupPlanBranch (2026-05-19)', () => {
  function makeDeps(stdout: string) {
    const sendSsmCommand = vi.fn(async (cmd: string) => {
      // Stash the script so the test can inspect it.
      (sendSsmCommand as unknown as { script?: string }).script = cmd;
      return 'cmd-id-mock';
    });
    const waitForSsmOutput = vi.fn(async () => stdout);
    return { sendSsmCommand, waitForSsmOutput };
  }

  it('refuses unsafe folder names', async () => {
    const deps = makeDeps('');
    await expect(
      cleanupPlanBranch({ workingDirSlug: '../etc', planName: 'foo' }, deps),
    ).rejects.toThrow(/folder name/);
    expect(deps.sendSsmCommand).not.toHaveBeenCalled();
  });

  it('refuses unsafe plan names', async () => {
    const deps = makeDeps('');
    await expect(
      cleanupPlanBranch({ workingDirSlug: 'snake-4', planName: '/etc/passwd' }, deps),
    ).rejects.toThrow(/plan name/);
  });

  it('emits sudo -u ubuntu prefixed git ops for the right branch', async () => {
    const deps = makeDeps('CLEANUP_PLAN_BRANCH_DONE');
    await cleanupPlanBranch({ workingDirSlug: 'snake-4', planName: 'snake-4-change-x' }, deps);
    const script = (deps.sendSsmCommand as unknown as { script: string }).script;
    expect(script).toContain('cd "/home/ubuntu/projects/snake-4"');
    expect(script).toContain('sudo -u ubuntu git fetch origin --prune');
    expect(script).toContain('sudo -u ubuntu git push origin --delete "plan/snake-4-change-x"');
    expect(script).toContain('sudo -u ubuntu git branch -D "plan/snake-4-change-x"');
    expect(script).toContain('sudo -u ubuntu git checkout main');
    expect(script).toContain('CLEANUP_PLAN_BRANCH_DONE');
  });

  it('reports remote=deleted local=deleted on a happy path', async () => {
    const deps = makeDeps(
      [
        'From github',
        'To origin',
        ' - [deleted]         plan/snake-4-change-x',
        "Switched to branch 'main'",
        'Deleted branch plan/snake-4-change-x',
        'CLEANUP_PLAN_BRANCH_DONE',
      ].join('\n'),
    );
    const result = await cleanupPlanBranch(
      { workingDirSlug: 'snake-4', planName: 'snake-4-change-x' },
      deps,
    );
    expect(result.status).toBe('done');
    expect(result.detail).toContain('remote=deleted');
    expect(result.detail).toContain('local=deleted');
  });

  it('reports remote=absent when ls-remote shows no branch', async () => {
    const deps = makeDeps(
      [
        'From github',
        'REMOTE_BRANCH_ABSENT: plan/snake-4-change-x',
        "Switched to branch 'main'",
        'Deleted branch plan/snake-4-change-x',
        'CLEANUP_PLAN_BRANCH_DONE',
      ].join('\n'),
    );
    const result = await cleanupPlanBranch(
      { workingDirSlug: 'snake-4', planName: 'snake-4-change-x' },
      deps,
    );
    expect(result.status).toBe('done');
    expect(result.detail).toContain('remote=absent');
    expect(result.detail).toContain('local=deleted');
  });

  it('reports skipped when the project folder is missing', async () => {
    const deps = makeDeps('FOLDER_MISSING');
    const result = await cleanupPlanBranch(
      { workingDirSlug: 'snake-4', planName: 'snake-4-change-x' },
      deps,
    );
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('absent');
  });

  it('surfaces error when SSM stdout never reaches the completion marker', async () => {
    const deps = makeDeps('fatal: random failure');
    const result = await cleanupPlanBranch(
      { workingDirSlug: 'snake-4', planName: 'snake-4-change-x' },
      deps,
    );
    expect(result.status).toBe('error');
    expect(result.detail).toMatch(/did not reach completion marker/);
  });
});

describe('assertWorktreeClean (2026-05-19)', () => {
  function makeDeps(stdout: string) {
    const sendSsmCommand = vi.fn(async () => 'cmd-id');
    const waitForSsmOutput = vi.fn(async () => stdout);
    return { sendSsmCommand, waitForSsmOutput };
  }

  it('returns clean=true when HEAD is main, working tree empty, sha matches origin', async () => {
    const sha = 'abcd1234abcd1234abcd1234abcd1234abcd1234';
    const stdout = [
      `HEAD_BRANCH:main`,
      `HEAD_SHA:${sha}`,
      `ORIGIN_MAIN_SHA:${sha}`,
      `STATUS_PORCELAIN_BEGIN`,
      `STATUS_PORCELAIN_END`,
      `PLAN_BRANCHES_BEGIN`,
      `PLAN_BRANCHES_END`,
      `CLEANLINESS_DONE`,
    ].join('\n');
    const result = await assertWorktreeClean('snake-4', makeDeps(stdout));
    expect(result.clean).toBe(true);
    if (result.clean) expect(result.commitSha).toBe(sha);
  });

  it('flags wrong-branch when HEAD is not main', async () => {
    const stdout = [
      `HEAD_BRANCH:plan/snake-4-change-x`,
      `HEAD_SHA:deadbeef`,
      `ORIGIN_MAIN_SHA:abcd1234`,
      `STATUS_PORCELAIN_BEGIN`,
      `STATUS_PORCELAIN_END`,
      `PLAN_BRANCHES_BEGIN`,
      `PLAN_BRANCHES_END`,
      `CLEANLINESS_DONE`,
    ].join('\n');
    const result = await assertWorktreeClean('snake-4', makeDeps(stdout));
    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.reason).toBe('wrong-branch');
      expect(result.headBranch).toBe('plan/snake-4-change-x');
    }
  });

  it('flags lingering plan/* branches', async () => {
    const stdout = [
      `HEAD_BRANCH:main`,
      `HEAD_SHA:abc`,
      `ORIGIN_MAIN_SHA:abc`,
      `STATUS_PORCELAIN_BEGIN`,
      `STATUS_PORCELAIN_END`,
      `PLAN_BRANCHES_BEGIN`,
      `plan/foo`,
      `plan/bar`,
      `PLAN_BRANCHES_END`,
      `CLEANLINESS_DONE`,
    ].join('\n');
    const result = await assertWorktreeClean('snake-4', makeDeps(stdout));
    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.reason).toBe('plan-branches-linger');
      expect(result.planBranches).toEqual(['plan/foo', 'plan/bar']);
    }
  });

  it('flags dirty working tree with porcelain output', async () => {
    const stdout = [
      `HEAD_BRANCH:main`,
      `HEAD_SHA:abc`,
      `ORIGIN_MAIN_SHA:abc`,
      `STATUS_PORCELAIN_BEGIN`,
      ` M src/page.tsx`,
      `?? scratch.ts`,
      `STATUS_PORCELAIN_END`,
      `PLAN_BRANCHES_BEGIN`,
      `PLAN_BRANCHES_END`,
      `CLEANLINESS_DONE`,
    ].join('\n');
    const result = await assertWorktreeClean('snake-4', makeDeps(stdout));
    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.reason).toBe('dirty');
      expect(result.dirtyFiles).toEqual([' M src/page.tsx', '?? scratch.ts']);
    }
  });

  it('flags ahead-or-behind when HEAD sha differs from origin/main', async () => {
    const stdout = [
      `HEAD_BRANCH:main`,
      `HEAD_SHA:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      `ORIGIN_MAIN_SHA:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      `STATUS_PORCELAIN_BEGIN`,
      `STATUS_PORCELAIN_END`,
      `PLAN_BRANCHES_BEGIN`,
      `PLAN_BRANCHES_END`,
      `CLEANLINESS_DONE`,
    ].join('\n');
    const result = await assertWorktreeClean('snake-4', makeDeps(stdout));
    expect(result.clean).toBe(false);
    if (!result.clean) expect(result.reason).toBe('ahead-or-behind');
  });

  it('flags folder-missing', async () => {
    const result = await assertWorktreeClean('snake-4', makeDeps('FOLDER_MISSING'));
    expect(result.clean).toBe(false);
    if (!result.clean) expect(result.reason).toBe('folder-missing');
  });

  it('flags not-a-repo when the folder exists but lacks a .git dir', async () => {
    const result = await assertWorktreeClean('snake-4', makeDeps('NOT_A_REPO'));
    expect(result.clean).toBe(false);
    if (!result.clean) expect(result.reason).toBe('not-a-repo');
  });
});

describe('countResidualPlanCommits (2026-05-19)', () => {
  function makeDeps(stdout: string) {
    const sendSsmCommand = vi.fn(async (cmd: string) => {
      (sendSsmCommand as unknown as { script?: string }).script = cmd;
      return 'cmd-id';
    });
    const waitForSsmOutput = vi.fn(async () => stdout);
    return { sendSsmCommand, waitForSsmOutput };
  }

  it('refuses planIds with shell-meta', async () => {
    const deps = makeDeps('');
    await expect(
      countResidualPlanCommits({ workingDirSlug: 'snake-4', planId: 'plan; rm -rf /' }, deps),
    ).rejects.toThrow(/shell-meta/);
  });

  it('greps main with the right --grep argument', async () => {
    const deps = makeDeps(
      [
        'RESIDUAL_COUNT_BEGIN',
        'abcdef0123456789abcdef0123456789abcdef01',
        'RESIDUAL_COUNT_END',
      ].join('\n'),
    );
    await countResidualPlanCommits({ workingDirSlug: 'snake-4', planId: 'plan_snake4_abc' }, deps);
    const script = (deps.sendSsmCommand as unknown as { script: string }).script;
    expect(script).toContain('--grep="Plan-Id: plan_snake4_abc"');
    expect(script).toContain('sudo -u ubuntu git log');
  });

  it('parses commit SHAs out of the BEGIN/END block', async () => {
    const stdout = [
      'RESIDUAL_COUNT_BEGIN',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cccccccccccccccccccccccccccccccccccccccc',
      'RESIDUAL_COUNT_END',
    ].join('\n');
    const result = await countResidualPlanCommits(
      { workingDirSlug: 'snake-4', planId: 'plan_x_y' },
      makeDeps(stdout),
    );
    expect(result.count).toBe(3);
    expect(result.sample).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cccccccccccccccccccccccccccccccccccccccc',
    ]);
  });

  it('returns count:0 when folder is missing', async () => {
    const result = await countResidualPlanCommits(
      { workingDirSlug: 'snake-4', planId: 'plan_x_y' },
      makeDeps('FOLDER_MISSING'),
    );
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
  });

  it('returns count:0 when no commits match (legacy plan, no trailer)', async () => {
    const result = await countResidualPlanCommits(
      { workingDirSlug: 'snake-4', planId: 'plan_x_y' },
      makeDeps('RESIDUAL_COUNT_BEGIN\nRESIDUAL_COUNT_END'),
    );
    expect(result.count).toBe(0);
  });

  it('caps sample at 5 even when count is higher', async () => {
    const shas = Array.from({ length: 10 }, () => 'a'.repeat(40));
    const stdout = ['RESIDUAL_COUNT_BEGIN', ...shas, 'RESIDUAL_COUNT_END'].join('\n');
    const result = await countResidualPlanCommits(
      { workingDirSlug: 'snake-4', planId: 'plan_x_y' },
      makeDeps(stdout),
    );
    expect(result.count).toBe(10);
    expect(result.sample).toHaveLength(5);
  });
});

describe('reapPlanStoryWorktrees (2026-05-21)', () => {
  function makeDeps(stdout: string) {
    const sendSsmCommand = vi.fn(async (cmd: string) => {
      (sendSsmCommand as unknown as { script?: string }).script = cmd;
      return 'cmd-id';
    });
    const waitForSsmOutput = vi.fn(async () => stdout);
    return { sendSsmCommand, waitForSsmOutput };
  }

  it('refuses unsafe folder names', async () => {
    const deps = makeDeps('');
    await expect(
      reapPlanStoryWorktrees({ workingDirSlug: '../etc', planName: 'foo' }, deps),
    ).rejects.toThrow(/folder name/);
  });

  it('refuses unsafe plan names', async () => {
    const deps = makeDeps('');
    await expect(
      reapPlanStoryWorktrees({ workingDirSlug: 'snake-4', planName: '/etc/passwd' }, deps),
    ).rejects.toThrow(/plan name/);
  });

  it('emits ssm script targeting /home/ubuntu/worktrees/<app>/<plan>', async () => {
    const deps = makeDeps('REAP_DONE worktrees=2 failed=0 local_branches=2 remote_branches=2');
    await reapPlanStoryWorktrees({ workingDirSlug: 'snake-4', planName: 'snake-4-x' }, deps);
    const script = (deps.sendSsmCommand as unknown as { script: string }).script;
    expect(script).toContain('/home/ubuntu/worktrees/snake-4/snake-4-x');
    expect(script).toContain('/home/ubuntu/repos/snake-4.git');
    expect(script).toContain('worktree remove --force');
    expect(script).toContain('branch -D');
    expect(script).toContain('push origin --delete');
  });

  it('reports REAP_NOTHING when neither worktree root nor bare repo exists', async () => {
    const deps = makeDeps('REAP_NOTHING');
    const result = await reapPlanStoryWorktrees(
      { workingDirSlug: 'snake-4', planName: 'snake-4-x' },
      deps,
    );
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('no worktrees or bare repo');
  });

  it('parses REAP_DONE counters into detail string', async () => {
    const deps = makeDeps('REAP_DONE worktrees=3 failed=0 local_branches=3 remote_branches=2');
    const result = await reapPlanStoryWorktrees(
      { workingDirSlug: 'snake-4', planName: 'snake-4-x' },
      deps,
    );
    expect(result.status).toBe('done');
    expect(result.detail).toContain('worktrees=3');
    expect(result.detail).toContain('local-wip=3');
    expect(result.detail).toContain('remote-wip=2');
  });

  it('reports error status when any per-story removal failed', async () => {
    const deps = makeDeps('REAP_DONE worktrees=2 failed=1 local_branches=2 remote_branches=2');
    const result = await reapPlanStoryWorktrees(
      { workingDirSlug: 'snake-4', planName: 'snake-4-x' },
      deps,
    );
    expect(result.status).toBe('error');
    expect(result.detail).toContain('failed=1');
  });
});

describe('resetAppWorktreeToMain (2026-05-21)', () => {
  function makeDeps(stdout: string) {
    const sendSsmCommand = vi.fn(async (cmd: string) => {
      (sendSsmCommand as unknown as { script?: string }).script = cmd;
      return 'cmd-id';
    });
    const waitForSsmOutput = vi.fn(async () => stdout);
    return { sendSsmCommand, waitForSsmOutput };
  }

  it('refuses unsafe slugs', async () => {
    const deps = makeDeps('');
    await expect(resetAppWorktreeToMain('../etc', deps)).rejects.toThrow(/folder name/);
  });

  it('skipped when folder is not a git repo', async () => {
    const deps = makeDeps('RESET_SKIPPED_NOT_A_REPO');
    const result = await resetAppWorktreeToMain('snake-4', deps);
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('not a git repo');
  });

  it('skipped when folder is missing', async () => {
    const deps = makeDeps('RESET_SKIPPED_FOLDER_MISSING');
    const result = await resetAppWorktreeToMain('snake-4', deps);
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('folder missing');
  });

  it('done when reset succeeds and tree is clean', async () => {
    const deps = makeDeps('RESET_DONE before=12 after=0 head=main');
    const result = await resetAppWorktreeToMain('snake-4', deps);
    expect(result.status).toBe('done');
    expect(result.detail).toContain('12→0');
    expect(result.detail).toContain('on main');
  });

  it('error when post-reset tree is still dirty', async () => {
    const deps = makeDeps('RESET_DONE before=12 after=5 head=main');
    const result = await resetAppWorktreeToMain('snake-4', deps);
    expect(result.status).toBe('error');
    expect(result.detail).toContain('5');
  });

  it('error when worktree ends up on wrong branch', async () => {
    const deps = makeDeps('RESET_DONE before=12 after=0 head=detached');
    const result = await resetAppWorktreeToMain('snake-4', deps);
    expect(result.status).toBe('error');
    expect(result.detail).toContain('detached');
  });

  it('script preserves node_modules + .next via git clean -e flags', async () => {
    const deps = makeDeps('RESET_DONE before=0 after=0 head=main');
    await resetAppWorktreeToMain('snake-4', deps);
    const script = (deps.sendSsmCommand as unknown as { script: string }).script;
    expect(script).toContain('git clean -fdx -e node_modules -e .next');
  });
});
