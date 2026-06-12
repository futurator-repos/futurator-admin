/**
 * Unit tests for cleanupAppArtifacts (2026-05-19).
 *
 * Stubs SSM, GitHub, S3, and Secrets Manager clients so we can assert that:
 *   - The five teardown steps fire in the right order.
 *   - Each step returns the correct status sentinel (done/skipped/error).
 *   - 404 from GitHub becomes skipped (not error).
 *   - ResourceNotFound from Secrets Manager becomes skipped.
 *   - Folder safety regex refuses sketchy slugs.
 */

import { describe, expect, it, vi } from 'vitest';
import { cleanupAppArtifacts } from '../app-artifact-service';

/**
 * Command-aware SSM stub. The legacy projects-folder rm and the
 * worktrees+bare-repo rm both flow through sendSsmCommand/waitForSsmOutput;
 * route the response by inspecting the command text so each step gets the
 * sentinel it parses.
 *
 * `folderOutput` drives the legacy `/home/ubuntu/projects/<app>` step.
 * `worktreesOutput` drives the `/home/ubuntu/worktrees/<app>` + bare-repo
 * step (defaults to both DELETED).
 */
function makeSsmDeps(
  folderOutput: string,
  worktreesOutput = 'WORKTREES_DELETED BAREREPO_DELETED',
  residueOutput = 'RESIDUE transcripts=2 dangling=1',
) {
  let lastCmd = '';
  return {
    sendSsmCommand: vi.fn(async (cmd: string) => {
      lastCmd = cmd;
      return 'cmd-id';
    }),
    waitForSsmOutput: vi.fn(async () => {
      // dino1 hygiene (2026-06-12) — the residue sweep step.
      if (lastCmd.includes('RESIDUE transcripts=')) return residueOutput;
      if (lastCmd.includes('/home/ubuntu/worktrees/')) return worktreesOutput;
      return folderOutput;
    }),
  };
}

function makeS3Stub(contents: Record<string, string[]>) {
  // contents: prefix → keys to return on ListObjectsV2
  const sent: Array<{ cmd: string; input: unknown }> = [];
  return {
    sent,
    send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
      const name = cmd.constructor.name;
      sent.push({ cmd: name, input: cmd.input });
      if (name === 'ListObjectsV2Command') {
        const prefix = (cmd.input as { Prefix: string }).Prefix;
        const keys = contents[prefix] ?? [];
        return { Contents: keys.map((k) => ({ Key: k })), IsTruncated: false };
      }
      if (name === 'DeleteObjectsCommand') return { Deleted: [] };
      return {};
    }),
  };
}

function makeSecretsStub(opts: { notFound?: boolean; throwOther?: boolean } = {}) {
  return {
    send: vi.fn(async () => {
      if (opts.notFound) {
        const err = new Error("Secrets Manager can't find the specified secret.");
        (err as Error & { name: string }).name = 'ResourceNotFoundException';
        throw err;
      }
      if (opts.throwOther) {
        throw new Error('arbitrary aws failure');
      }
      return { Name: 'futurator/brownfield-pat/snake-4', DeletionDate: new Date() };
    }),
  };
}

describe('cleanupAppArtifacts (2026-05-19)', () => {
  it('refuses unsafe slugs', async () => {
    await expect(
      cleanupAppArtifacts('../etc', {
        ...makeSsmDeps('FOLDER_DELETED'),
        deleteGithubRepo: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        s3Client: makeS3Stub({}) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretsClient: makeSecretsStub() as any,
      }),
    ).rejects.toThrow(/folder name/);
  });

  it('returns done for every step on a happy path', async () => {
    const deleteRepo = vi.fn(async () => {});
    const ssm = makeSsmDeps('FOLDER_DELETED');
    const s3 = makeS3Stub({
      'apps/snake-4/': ['apps/snake-4/index.html', 'apps/snake-4/assets/main.js'],
      'knowledge-live/snake-4/': ['knowledge-live/snake-4/wiki.json'],
    });
    const sm = makeSecretsStub();

    const results = await cleanupAppArtifacts('snake-4', {
      ...ssm,
      deleteGithubRepo: deleteRepo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: s3 as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: sm as any,
    });

    expect(results.map((r) => r.step)).toEqual([
      'party-cleanup',
      'folder',
      'worktrees',
      'residue',
      'github-repo',
      's3-apps',
      's3-knowledge',
      'brownfield-pat',
    ]);
    // Story 20.11 — party-cleanup is rollout-safe: when no
    // listPartySessionsByProject dep is wired, it skips (not 'done').
    for (const r of results) {
      const expected = r.step === 'party-cleanup' ? 'skipped' : 'done';
      expect(r.status, `step ${r.step}: ${r.detail}`).toBe(expected);
    }
    expect(deleteRepo).toHaveBeenCalledWith('futurator-repos', 'snake-4');
    // S3: two list-then-delete cycles (one per prefix).
    const listCount = s3.sent.filter((s) => s.cmd === 'ListObjectsV2Command').length;
    const delCount = s3.sent.filter((s) => s.cmd === 'DeleteObjectsCommand').length;
    expect(listCount).toBe(2);
    expect(delCount).toBe(2);
  });

  it('treats GitHub 404 as skipped (repo already deleted)', async () => {
    const deleteRepo = vi.fn(async () => {
      throw new Error('GitHub responded 404: Not Found');
    });
    const results = await cleanupAppArtifacts('snake-4', {
      ...makeSsmDeps('FOLDER_DELETED'),
      deleteGithubRepo: deleteRepo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    const gh = results.find((r) => r.step === 'github-repo');
    expect(gh?.status).toBe('skipped');
  });

  it('treats Secrets Manager ResourceNotFound as skipped (greenfield App, no PAT)', async () => {
    const results = await cleanupAppArtifacts('snake-4', {
      ...makeSsmDeps('FOLDER_DELETED'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub({ notFound: true }) as any,
    });
    const pat = results.find((r) => r.step === 'brownfield-pat');
    expect(pat?.status).toBe('skipped');
    expect(pat?.detail).toContain('no per-app secret');
  });

  it('surfaces non-404 Secrets Manager errors as error', async () => {
    const results = await cleanupAppArtifacts('snake-4', {
      ...makeSsmDeps('FOLDER_DELETED'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub({ throwOther: true }) as any,
    });
    const pat = results.find((r) => r.step === 'brownfield-pat');
    expect(pat?.status).toBe('error');
  });

  it('reports skipped for the folder step when EC2 folder is absent', async () => {
    const results = await cleanupAppArtifacts('snake-4', {
      ...makeSsmDeps('FOLDER_ABSENT'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    // Story 20.11 — party-cleanup is now index 0; folder is index 1.
    expect(results[0]).toMatchObject({ step: 'party-cleanup' });
    expect(results[1]).toMatchObject({ step: 'folder', status: 'skipped' });
  });

  it('reports done for the worktrees step when the subtree + bare repo are deleted', async () => {
    const results = await cleanupAppArtifacts('snake-4', {
      ...makeSsmDeps('FOLDER_DELETED', 'WORKTREES_DELETED BAREREPO_DELETED'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    const wt = results.find((r) => r.step === 'worktrees');
    expect(wt?.status).toBe('done');
    expect(wt?.detail).toContain('worktrees=DELETED');
    expect(wt?.detail).toContain('bareRepo=DELETED');
  });

  it('reports skipped for the worktrees step when both are already absent', async () => {
    const results = await cleanupAppArtifacts('snake-4', {
      ...makeSsmDeps('FOLDER_DELETED', 'WORKTREES_ABSENT BAREREPO_ABSENT'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    expect(results.find((r) => r.step === 'worktrees')?.status).toBe('skipped');
  });

  it('reports error for the worktrees step when rm fails', async () => {
    const results = await cleanupAppArtifacts('snake-4', {
      ...makeSsmDeps('FOLDER_DELETED', 'WORKTREES_FAILED BAREREPO_ABSENT'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    expect(results.find((r) => r.step === 'worktrees')?.status).toBe('error');
  });

  it('sweeps the worktrees subtree even when the legacy projects folder is already gone', async () => {
    // The reported bug: projects/<app> deleted but worktrees/<app> lingered.
    const ssm = makeSsmDeps('FOLDER_ABSENT', 'WORKTREES_DELETED BAREREPO_DELETED');
    const results = await cleanupAppArtifacts('applicator', {
      ...ssm,
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    expect(results.find((r) => r.step === 'folder')?.status).toBe('skipped');
    expect(results.find((r) => r.step === 'worktrees')?.status).toBe('done');
    // The worktrees command targeted the shared root + the bare repo.
    const wtCmdCall = ssm.sendSsmCommand.mock.calls.find((call) =>
      String(call[0]).includes('/home/ubuntu/worktrees/applicator'),
    );
    expect(wtCmdCall).toBeTruthy();
    expect(String(wtCmdCall![0])).toContain('/home/ubuntu/repos/applicator.git');
  });

  it('reports skipped for an S3 step when the prefix has no objects', async () => {
    const results = await cleanupAppArtifacts('snake-4', {
      ...makeSsmDeps('FOLDER_DELETED'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    expect(results.find((r) => r.step === 's3-apps')?.status).toBe('skipped');
    expect(results.find((r) => r.step === 's3-knowledge')?.status).toBe('skipped');
  });
});

// ── dino1 hygiene (2026-06-12) — per-app residue sweep ──────────────
describe('residue step', () => {
  it('removes claude transcripts + dangling symlinks, AFTER the folder rm', async () => {
    const ssm = makeSsmDeps('FOLDER_DELETED');
    const results = await cleanupAppArtifacts('dino1', {
      ...ssm,
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    const residue = results.find((r) => r.step === 'residue');
    expect(residue?.status).toBe('done');
    expect(residue?.detail).toContain('claude-transcript dirs=2');
    expect(residue?.detail).toContain('dangling-symlinks=1');
    // Ordering: residue runs after worktrees (symlinks must already dangle).
    const steps = results.map((r) => r.step);
    expect(steps.indexOf('residue')).toBeGreaterThan(steps.indexOf('worktrees'));
    expect(steps.indexOf('residue')).toBeLessThan(steps.indexOf('github-repo'));
    // The SSM command targets the app's transcript slugs with the
    // path-separator suffix (an app "dino" must never match "dino1" dirs).
    const residueCmd = ssm.sendSsmCommand.mock.calls
      .map((c) => c[0])
      .find((c: string) => c.includes('RESIDUE transcripts='))!;
    expect(residueCmd).toContain('-home-ubuntu-projects-dino1"');
    expect(residueCmd).toContain('-home-ubuntu-projects-dino1-"*');
    expect(residueCmd).toContain('-home-ubuntu-worktrees-dino1-"*');
    expect(residueCmd).toContain('-xtype l');
    expect(residueCmd).toContain('qa-*');
  });

  it('reports skipped when nothing was found', async () => {
    const results = await cleanupAppArtifacts('dino1', {
      ...makeSsmDeps('FOLDER_DELETED', undefined, 'RESIDUE transcripts=0 dangling=0'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    expect(results.find((r) => r.step === 'residue')?.status).toBe('skipped');
  });

  it('reports error (not throw) on unexpected ssm output — cascade continues', async () => {
    const results = await cleanupAppArtifacts('dino1', {
      ...makeSsmDeps('FOLDER_DELETED', undefined, 'ssm exploded'),
      deleteGithubRepo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3Client: makeS3Stub({}) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretsClient: makeSecretsStub() as any,
    });
    expect(results.find((r) => r.step === 'residue')?.status).toBe('error');
    // Steps after residue still ran.
    expect(results.find((r) => r.step === 'github-repo')).toBeDefined();
    expect(results.find((r) => r.step === 'brownfield-pat')).toBeDefined();
  });
});
