import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  isAdminAlreadyBootstrapped,
  bootstrapAdminSelfEdit,
  ADMIN_PROJECT_ID,
} from '../admin-self-edit-bootstrap';

/**
 * 2026-05-27 PR B.a — admin self-edit bootstrap.
 *
 * Covers:
 *   - idempotence: ALREADY_BARE_SHA → alreadyBare:true with headSha
 *   - idempotence: BARE_ABSENT / TREE_ABSENT → alreadyBare:false
 *   - bootstrap: BOOTSTRAP_OK → converted:true with headSha
 *   - bootstrap: missing OK marker → bootstrap-failed with detail
 *   - bootstrap: ssm throw → bootstrap-failed with err.message
 *   - bootstrap: PAT is interpolated into clone URL
 *   - bootstrap: custom repoUrl + branch flow through
 */

function fakeDeps(output: string) {
  return {
    sendSsmCommand: vi.fn(async (_cmd: string) => 'cmd-id-1'),
    waitForSsmOutput: vi.fn(async () => output),
  };
}

function throwDeps(err: string) {
  return {
    sendSsmCommand: vi.fn(async () => 'cmd-id-1'),
    waitForSsmOutput: vi.fn(async () => {
      throw new Error(err);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isAdminAlreadyBootstrapped', () => {
  it('returns alreadyBare:true with headSha when the SSM script confirms bare+worktree', async () => {
    const deps = fakeDeps('ALREADY_BARE_SHA=abc1234567890123456789012345678901234567\n');
    const result = await isAdminAlreadyBootstrapped(deps);
    expect(result.alreadyBare).toBe(true);
    expect(result.headSha).toBe('abc1234567890123456789012345678901234567');
  });

  it('returns alreadyBare:false when bare repo is absent', async () => {
    const deps = fakeDeps('BARE_ABSENT\n');
    expect(await isAdminAlreadyBootstrapped(deps)).toEqual({ alreadyBare: false });
  });

  it('returns alreadyBare:false when worktree is absent', async () => {
    const deps = fakeDeps('TREE_ABSENT\n');
    expect(await isAdminAlreadyBootstrapped(deps)).toEqual({ alreadyBare: false });
  });

  it('returns alreadyBare:false when the working dir is NOT a worktree', async () => {
    const deps = fakeDeps('NOT_WORKTREE\n');
    expect(await isAdminAlreadyBootstrapped(deps)).toEqual({ alreadyBare: false });
  });

  it('returns alreadyBare:false when the working dir points at a wrong bare', async () => {
    const deps = fakeDeps('WRONG_BARE: /home/ubuntu/repos/something-else.git\n');
    expect(await isAdminAlreadyBootstrapped(deps)).toEqual({ alreadyBare: false });
  });

  it('swallows ssm throws as alreadyBare:false (caller will retry via bootstrap)', async () => {
    const deps = throwDeps('SSM offline');
    expect(await isAdminAlreadyBootstrapped(deps)).toEqual({ alreadyBare: false });
  });

  it('queries the correct project id paths', async () => {
    const deps = fakeDeps('BARE_ABSENT\n');
    await isAdminAlreadyBootstrapped(deps);
    const cmd = deps.sendSsmCommand.mock.calls[0][0];
    expect(cmd).toContain(`/home/ubuntu/repos/${ADMIN_PROJECT_ID}.git`);
    expect(cmd).toContain(`/home/ubuntu/projects/${ADMIN_PROJECT_ID}`);
  });
});

describe('bootstrapAdminSelfEdit', () => {
  it('returns converted:true on BOOTSTRAP_OK marker with headSha', async () => {
    const deps = fakeDeps(
      'cloning into bare\nworktree adding\nBOOTSTRAP_OK post=abc1234567890123456789012345678901234567\n',
    );
    const result = await bootstrapAdminSelfEdit({ pat: 'ghp_TEST_PAT' }, deps);
    expect(result).toEqual({
      converted: true,
      bareRepoPath: '/home/ubuntu/repos/futurator-admin.git',
      worktreePath: '/home/ubuntu/projects/futurator-admin',
      headSha: 'abc1234567890123456789012345678901234567',
    });
  });

  it('interpolates the PAT into the clone URL (token-auth pattern)', async () => {
    const deps = fakeDeps('BOOTSTRAP_OK post=def0000000000000000000000000000000000001\n');
    await bootstrapAdminSelfEdit({ pat: 'ghp_TEST_PAT' }, deps);
    const cmd = deps.sendSsmCommand.mock.calls[0][0];
    expect(cmd).toContain('https://x-access-token:ghp_TEST_PAT@github.com/');
  });

  it('honors a custom repoUrl + branch', async () => {
    const deps = fakeDeps('BOOTSTRAP_OK post=def0000000000000000000000000000000000001\n');
    await bootstrapAdminSelfEdit(
      { pat: 'ghp_X', repoUrl: 'https://github.com/other-org/repo.git', branch: 'develop' },
      deps,
    );
    const cmd = deps.sendSsmCommand.mock.calls[0][0];
    expect(cmd).toContain('https://x-access-token:ghp_X@github.com/other-org/repo.git');
    expect(cmd).toContain('--branch develop');
    expect(cmd).toContain('worktree add "/home/ubuntu/projects/futurator-admin" develop');
  });

  it('returns bootstrap-failed when the OK marker is missing', async () => {
    const deps = fakeDeps('BARE_CLONE_FAILED: permission denied\n');
    const result = await bootstrapAdminSelfEdit({ pat: 'ghp_X' }, deps);
    expect(result.converted).toBe(false);
    if (!result.converted && result.reason === 'bootstrap-failed') {
      expect(result.detail).toContain('BARE_CLONE_FAILED');
    } else {
      throw new Error('expected bootstrap-failed branch');
    }
  });

  it('returns bootstrap-failed with err.message on ssm throw', async () => {
    const deps = throwDeps('command timed out');
    const result = await bootstrapAdminSelfEdit({ pat: 'ghp_X' }, deps);
    expect(result.converted).toBe(false);
    if (!result.converted && result.reason === 'bootstrap-failed') {
      expect(result.detail).toContain('command timed out');
    } else {
      throw new Error('expected bootstrap-failed branch');
    }
  });

  it('chowns the bare + worktree dirs to ubuntu', async () => {
    const deps = fakeDeps('BOOTSTRAP_OK post=abc1234567890123456789012345678901234567\n');
    await bootstrapAdminSelfEdit({ pat: 'ghp_X' }, deps);
    const cmd = deps.sendSsmCommand.mock.calls[0][0];
    expect(cmd).toContain('chown -R ubuntu:ubuntu');
  });
});
