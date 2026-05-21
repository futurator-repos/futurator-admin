import { describe, it, expect, vi } from 'vitest';

import {
  cleanupPartyBranch,
  archivePartyBranch,
  reapPartyWorktree,
  countResidualPartyCommits,
} from '../plan-folder-service';

/**
 * Story 20.9 tests — party-* cleanup helpers in plan-folder-service.ts.
 *
 * Each helper exercises:
 *   - happy path (SSM returns the expected DONE marker + flags)
 *   - "nothing-to-do" skip (folder/worktree/branch absent)
 *   - error path where applicable (archive-fail keeps live branch)
 */

const SESSION_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
const SESSION_SHORT = 'a1b2c3d4';
const APP = 'applicator';

function makeDeps(output: string) {
  return {
    sendSsmCommand: vi.fn().mockResolvedValue('cmd-1'),
    waitForSsmOutput: vi.fn().mockResolvedValue(output),
  };
}

describe('cleanupPartyBranch', () => {
  it('happy path — both branches deleted', async () => {
    const deps = makeDeps('CLEANUP_PARTY_BRANCH_DONE\nLOCAL_DELETE_WARN no\n');
    const r = await cleanupPartyBranch(
      { workingDirSlug: APP, sessionIdShort: SESSION_SHORT },
      deps,
    );
    expect(r.status).toBe('done');
    expect(r.detail).toContain('remote=deleted');
    expect(r.detail).toContain('local=warn');
  });

  it('happy path — fully deleted (no warnings)', async () => {
    const deps = makeDeps('CLEANUP_PARTY_BRANCH_DONE');
    const r = await cleanupPartyBranch(
      { workingDirSlug: APP, sessionIdShort: SESSION_SHORT },
      deps,
    );
    expect(r.status).toBe('done');
    expect(r.detail).toBe('remote=deleted local=deleted');
  });

  it('nothing-to-do skip (remote + local both absent)', async () => {
    const deps = makeDeps(
      'REMOTE_BRANCH_ABSENT: party/applicator/a1b2c3d4\nLOCAL_BRANCH_ABSENT: party/applicator/a1b2c3d4\nCLEANUP_PARTY_BRANCH_DONE',
    );
    const r = await cleanupPartyBranch(
      { workingDirSlug: APP, sessionIdShort: SESSION_SHORT },
      deps,
    );
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('nothing-to-do');
  });

  it('skipped when folder missing', async () => {
    const deps = makeDeps('FOLDER_MISSING');
    const r = await cleanupPartyBranch(
      { workingDirSlug: APP, sessionIdShort: SESSION_SHORT },
      deps,
    );
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('worktree folder absent');
  });

  it('rejects malformed sessionIdShort', async () => {
    const deps = makeDeps('');
    await expect(
      cleanupPartyBranch({ workingDirSlug: APP, sessionIdShort: 'A1B2C3D4' }, deps),
    ).rejects.toThrow(/sessionIdShort/);
    expect(deps.sendSsmCommand).not.toHaveBeenCalled();
  });
});

describe('archivePartyBranch', () => {
  it('happy path — archive push succeeds + live branch dropped', async () => {
    const deps = makeDeps('ARCHIVE_PUSH_OK\nARCHIVE_PARTY_BRANCH_DONE');
    const r = await archivePartyBranch(
      { workingDirSlug: APP, sessionIdShort: SESSION_SHORT },
      deps,
    );
    expect(r.status).toBe('done');
    expect(r.detail).toMatch(/archive\/party\/applicator\/a1b2c3d4/);
  });

  it('archive-fail preserves live branch', async () => {
    const deps = makeDeps('ARCHIVE_PUSH_FAIL\nARCHIVE_PARTY_BRANCH_DONE');
    const r = await archivePartyBranch(
      { workingDirSlug: APP, sessionIdShort: SESSION_SHORT },
      deps,
    );
    expect(r.status).toBe('error');
    expect(r.detail).toBe('archive-failed; live branch preserved');
  });

  it('nothing-to-do skip when neither remote nor local exists', async () => {
    const deps = makeDeps('ARCHIVE_NOTHING_TO_DO\nARCHIVE_PARTY_BRANCH_DONE');
    const r = await archivePartyBranch(
      { workingDirSlug: APP, sessionIdShort: SESSION_SHORT },
      deps,
    );
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('nothing-to-do');
  });

  it('skipped when folder missing', async () => {
    const deps = makeDeps('FOLDER_MISSING');
    const r = await archivePartyBranch(
      { workingDirSlug: APP, sessionIdShort: SESSION_SHORT },
      deps,
    );
    expect(r.status).toBe('skipped');
  });
});

describe('reapPartyWorktree', () => {
  it('happy path — worktree removed cleanly', async () => {
    const deps = makeDeps('REAP_PARTY_WORKTREE_DONE');
    const r = await reapPartyWorktree({ workingDirSlug: APP, sessionIdShort: SESSION_SHORT }, deps);
    expect(r.status).toBe('done');
    expect(r.detail).toBe('removed');
  });

  it('records warning flags', async () => {
    const deps = makeDeps('BARE_REPO_ABSENT\nREAP_PARTY_WORKTREE_DONE');
    const r = await reapPartyWorktree({ workingDirSlug: APP, sessionIdShort: SESSION_SHORT }, deps);
    expect(r.status).toBe('done');
    expect(r.detail).toContain('bare-repo=absent');
  });

  it('nothing-to-do skip when worktree absent', async () => {
    const deps = makeDeps('WORKTREE_ABSENT\nREAP_PARTY_WORKTREE_DONE');
    const r = await reapPartyWorktree({ workingDirSlug: APP, sessionIdShort: SESSION_SHORT }, deps);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('nothing-to-do');
  });
});

describe('countResidualPartyCommits', () => {
  it('counts commits matching the Session-Id trailer', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const deps = makeDeps(`RESIDUAL_PARTY_BEGIN\n${sha1}\n${sha2}\nRESIDUAL_PARTY_END`);
    const r = await countResidualPartyCommits({ workingDirSlug: APP, sessionId: SESSION_ID }, deps);
    expect(r.count).toBe(2);
    expect(r.sample).toEqual([sha1, sha2]);
  });

  it('returns zero when folder is missing', async () => {
    const deps = makeDeps('FOLDER_MISSING');
    const r = await countResidualPartyCommits({ workingDirSlug: APP, sessionId: SESSION_ID }, deps);
    expect(r).toEqual({ count: 0, sample: [] });
  });

  it('rejects malformed sessionId (must be full UUID)', async () => {
    const deps = makeDeps('');
    await expect(
      countResidualPartyCommits({ workingDirSlug: APP, sessionId: SESSION_SHORT }, deps),
    ).rejects.toThrow(/sessionId/);
    expect(deps.sendSsmCommand).not.toHaveBeenCalled();
  });

  it('caps sample to first 5 SHAs', async () => {
    const shas = Array.from({ length: 8 }, (_, i) => String(i).repeat(40).slice(0, 40));
    const valid = shas.map((s) => s.replace(/[^0-9a-f]/g, '0')).map((s) => s.padEnd(40, '0'));
    const deps = makeDeps(`RESIDUAL_PARTY_BEGIN\n${valid.join('\n')}\nRESIDUAL_PARTY_END`);
    const r = await countResidualPartyCommits({ workingDirSlug: APP, sessionId: SESSION_ID }, deps);
    expect(r.count).toBe(8);
    expect(r.sample).toHaveLength(5);
  });
});
