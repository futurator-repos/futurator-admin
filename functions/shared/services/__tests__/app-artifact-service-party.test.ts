import { describe, it, expect, vi } from 'vitest';

import { cleanupAppArtifacts } from '../app-artifact-service';

/**
 * Story 20.11 — App-delete cascade party-cleanup step.
 *
 * Verifies the new `party-cleanup` step iterates listPartySessionsByProject
 * and reports counts. Best-effort: archive failures don't block siblings.
 */

const APP = 'applicator';

function ssmAlwaysOk() {
  return {
    sendSsmCommand: vi.fn().mockResolvedValue('cmd-x'),
    waitForSsmOutput: vi.fn().mockImplementation(async (_id) => {
      // Default benign responses for all SSM-driven steps.
      // archivePartyBranch needs ARCHIVE_PARTY_BRANCH_DONE + ARCHIVE_PUSH_OK markers.
      // reapPartyWorktree needs REAP_PARTY_WORKTREE_DONE marker.
      // deleteAppFolder needs FOLDER_ABSENT or FOLDER_DELETED.
      // We can't tell which step we're in from the mock, so we return a
      // catch-all that satisfies them all (each helper looks for its own
      // unique marker substring).
      return [
        'ARCHIVE_PUSH_OK',
        'ARCHIVE_PARTY_BRANCH_DONE',
        'REAP_PARTY_WORKTREE_DONE',
        'FOLDER_DELETED',
      ].join('\n');
    }),
  };
}

function makeS3Stub() {
  return {
    send: vi.fn().mockResolvedValue({ Contents: [] }),
  };
}

function makeSecretsStub() {
  return {
    send: vi.fn().mockResolvedValue({}),
  };
}

describe('cleanupAppArtifacts — Story 20.11 party-cleanup step', () => {
  it('reports counts when listPartySessionsByProject returns 3 sessions', async () => {
    const ssm = ssmAlwaysOk();
    const sessions = [
      { sessionId: 'a1b2c3d4-1111-2222-3333-444455556666' },
      { sessionId: 'b1b2c3d4-1111-2222-3333-444455556666' },
      { sessionId: 'c1b2c3d4-1111-2222-3333-444455556666' },
    ];
    const listPartySessionsByProject = vi.fn().mockResolvedValue(sessions);

    const results = await cleanupAppArtifacts(APP, {
      ...ssm,
      deleteGithubRepo: vi.fn().mockResolvedValue(undefined),
      listPartySessionsByProject,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });

    const partyStep = results.find((r) => r.step === 'party-cleanup');
    expect(partyStep).toBeDefined();
    expect(partyStep?.status).toBe('done');
    expect(partyStep?.detail).toMatch(/3 session\(s\).*3 archived.*3 reaped/);
    expect(listPartySessionsByProject).toHaveBeenCalledWith(APP);
  });

  it('reports skipped when listPartySessionsByProject is missing (rollout-safe)', async () => {
    const ssm = ssmAlwaysOk();
    const results = await cleanupAppArtifacts(APP, {
      ...ssm,
      deleteGithubRepo: vi.fn().mockResolvedValue(undefined),
      // listPartySessionsByProject intentionally omitted
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    const partyStep = results.find((r) => r.step === 'party-cleanup');
    expect(partyStep?.status).toBe('skipped');
    expect(partyStep?.detail).toMatch(/rollout-safe/);
  });

  it('reports skipped when there are no party sessions for the app', async () => {
    const ssm = ssmAlwaysOk();
    const results = await cleanupAppArtifacts(APP, {
      ...ssm,
      deleteGithubRepo: vi.fn().mockResolvedValue(undefined),
      listPartySessionsByProject: vi.fn().mockResolvedValue([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    const partyStep = results.find((r) => r.step === 'party-cleanup');
    expect(partyStep?.status).toBe('skipped');
    expect(partyStep?.detail).toBe('no party sessions');
  });

  it('reports error when listPartySessionsByProject throws (does NOT abort the cascade)', async () => {
    const ssm = ssmAlwaysOk();
    const results = await cleanupAppArtifacts(APP, {
      ...ssm,
      deleteGithubRepo: vi.fn().mockResolvedValue(undefined),
      listPartySessionsByProject: vi.fn().mockRejectedValue(new Error('DDB throttle')),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    const partyStep = results.find((r) => r.step === 'party-cleanup');
    expect(partyStep?.status).toBe('error');
    expect(partyStep?.detail).toMatch(/DDB throttle/);
    // Cascade continues — folder + github + s3 steps still ran.
    expect(results.find((r) => r.step === 'folder')).toBeDefined();
    expect(results.find((r) => r.step === 'github-repo')).toBeDefined();
  });
});
