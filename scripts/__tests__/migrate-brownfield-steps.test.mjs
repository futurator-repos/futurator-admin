import { describe, it, expect, vi } from 'vitest';
import { AdminApiError } from '../lib/migrate-brownfield/admin-client.mjs';
import {
  stepEnsureSecret,
  stepIamPolicyHint,
  stepDeployReminder,
  stepRegisterOrFetch,
  stepPollEvents,
  stepVerifyHealthy,
  stepRefreshExisting,
} from '../lib/migrate-brownfield/steps.mjs';

function fakeSecretsClient(map = {}) {
  return {
    send: vi.fn(async (cmd) => {
      const cn = cmd.constructor.name;
      const id = cmd.input?.SecretId || cmd.input?.Name;
      if (cn === 'GetSecretValueCommand') {
        if (map[id]) return { ARN: `arn:${id}`, SecretString: map[id] };
        const err = new Error('not found');
        err.name = 'ResourceNotFoundException';
        throw err;
      }
      if (cn === 'CreateSecretCommand') {
        map[id] = cmd.input.SecretString;
        return { ARN: `arn:${id}` };
      }
      if (cn === 'PutSecretValueCommand') {
        map[id] = cmd.input.SecretString;
        return { ARN: `arn:${id}` };
      }
      throw new Error(`unmocked: ${cn}`);
    }),
  };
}

describe('stepEnsureSecret', () => {
  it('returns done when secret is freshly created', async () => {
    const map = {};
    const r = await stepEnsureSecret({
      secretName: 'futurator/labs-brownfield-github-pat',
      pat: 'github_pat_xyz',
      rotate: false,
      secretsClient: fakeSecretsClient(map),
    });
    expect(r.outcome).toBe('done');
    expect(r.message).toMatch(/created/);
  });

  it('returns skip when secret already exists and rotate=false', async () => {
    const r = await stepEnsureSecret({
      secretName: 'x',
      pat: 'github_pat_xyz',
      rotate: false,
      secretsClient: fakeSecretsClient({ x: 'github_pat_old' }),
    });
    expect(r.outcome).toBe('skip');
  });

  it('returns done with "rotated" message when rotate=true', async () => {
    const r = await stepEnsureSecret({
      secretName: 'x',
      pat: 'github_pat_new',
      rotate: true,
      secretsClient: fakeSecretsClient({ x: 'github_pat_old' }),
    });
    expect(r.outcome).toBe('done');
    expect(r.message).toMatch(/rotated/);
  });

  it('returns fail on unexpected errors', async () => {
    const r = await stepEnsureSecret({
      secretName: 'x',
      pat: 'p',
      rotate: false,
      secretsClient: {
        send: async () => {
          const err = new Error('AccessDenied');
          err.name = 'AccessDeniedException';
          throw err;
        },
      },
    });
    expect(r.outcome).toBe('fail');
  });
});

describe('stepIamPolicyHint', () => {
  it('returns skip when --skip-iam-check is set', () => {
    const r = stepIamPolicyHint({ skipIamCheck: true, hint: 'aws iam ...' });
    expect(r.outcome).toBe('skip');
  });

  it('returns manual with the hint when not skipped', () => {
    const r = stepIamPolicyHint({ skipIamCheck: false, hint: 'aws iam put-role-policy ...' });
    expect(r.outcome).toBe('manual');
    expect(r.hint).toContain('aws iam put-role-policy');
  });
});

describe('stepDeployReminder', () => {
  it('passes when admin is healthy', () => {
    expect(stepDeployReminder({ adminHealthOk: true }).outcome).toBe('skip');
  });
  it('fails when admin is unhealthy', () => {
    const r = stepDeployReminder({ adminHealthOk: false });
    expect(r.outcome).toBe('fail');
    expect(r.message).toMatch(/sst deploy/);
  });
});

describe('stepRegisterOrFetch', () => {
  it('returns done with jobId when project does not exist', async () => {
    const adminClient = {
      getProject: vi.fn(async () => {
        throw new AdminApiError(404, null, 'not found');
      }),
      registerBrownfield: vi.fn(async () => ({ jobId: 'job-1', projectId: 'songster' })),
    };
    const r = await stepRegisterOrFetch({
      adminClient,
      name: 'songster',
      gitRepoUrl: 'https://github.com/foo/songster.git',
      gitBranch: 'main',
    });
    expect(r.outcome).toBe('done');
    expect(r.data.jobId).toBe('job-1');
  });

  it('returns skip with null jobId when project already exists as brownfield', async () => {
    const adminClient = {
      getProject: vi.fn(async () => ({
        projectId: 'songster',
        kind: 'brownfield',
        bmadStatus: 'HEALTHY',
      })),
      registerBrownfield: vi.fn(),
    };
    const r = await stepRegisterOrFetch({ adminClient, name: 'songster' });
    expect(r.outcome).toBe('skip');
    expect(adminClient.registerBrownfield).not.toHaveBeenCalled();
  });

  it('fails when project exists but is greenfield', async () => {
    const adminClient = {
      getProject: vi.fn(async () => ({ projectId: 'bmad-canon', kind: 'greenfield' })),
      registerBrownfield: vi.fn(),
    };
    const r = await stepRegisterOrFetch({ adminClient, name: 'bmad-canon' });
    expect(r.outcome).toBe('fail');
    expect(r.message).toMatch(/greenfield/);
  });

  it('surfaces 409 PROJECT_ALREADY_EXISTS as a fail with status', async () => {
    const adminClient = {
      getProject: vi.fn(async () => {
        throw new AdminApiError(404, null, 'not found');
      }),
      registerBrownfield: vi.fn(async () => {
        throw new AdminApiError(409, { error: { code: 'PROJECT_ALREADY_EXISTS' } }, 'taken');
      }),
    };
    const r = await stepRegisterOrFetch({ adminClient, name: 'x' });
    expect(r.outcome).toBe('fail');
    expect(r.data.status).toBe(409);
  });
});

describe('stepPollEvents', () => {
  it('returns done on completed terminal', async () => {
    const adminClient = {
      pollJobEvents: vi.fn(async () => ({
        outcome: 'completed',
        events: [],
        terminal: { eventType: 'party.bootstrap.completed' },
      })),
    };
    const r = await stepPollEvents({ adminClient, jobId: 'job-1' });
    expect(r.outcome).toBe('done');
  });

  it('returns fail with failureReason on failed terminal', async () => {
    const adminClient = {
      pollJobEvents: vi.fn(async () => ({
        outcome: 'failed',
        events: [],
        terminal: {
          eventType: 'party.bootstrap.failed',
          payload: { failureReason: 'BMAD_NOT_FOUND_IN_REPO' },
        },
      })),
    };
    const r = await stepPollEvents({ adminClient, jobId: 'job-1' });
    expect(r.outcome).toBe('fail');
    expect(r.message).toMatch(/BMAD_NOT_FOUND_IN_REPO/);
  });

  it('returns fail on timeout', async () => {
    const adminClient = {
      pollJobEvents: vi.fn(async () => ({ outcome: 'timeout', events: [] })),
    };
    const r = await stepPollEvents({ adminClient, jobId: 'job-1' });
    expect(r.outcome).toBe('fail');
    expect(r.message).toMatch(/timed out/);
  });

  it('skips when jobId is null (already-registered re-run)', async () => {
    const r = await stepPollEvents({ adminClient: {}, jobId: null });
    expect(r.outcome).toBe('skip');
  });
});

describe('stepVerifyHealthy', () => {
  const base = {
    projectId: 'songster',
    kind: 'brownfield',
    bmadStatus: 'HEALTHY',
    gitBranch: 'main',
    lastCommitSha: 'abc1234',
  };

  it('returns done when project is HEALTHY and SHA matches', async () => {
    const adminClient = { getProject: vi.fn(async () => base) };
    const r = await stepVerifyHealthy({
      adminClient,
      name: 'songster',
      expectedHeadSha: 'abc1234',
    });
    expect(r.outcome).toBe('done');
    expect(r.message).toMatch(/HEALTHY/);
  });

  it('warns (but still done) when SHA mismatch', async () => {
    const adminClient = { getProject: vi.fn(async () => base) };
    const r = await stepVerifyHealthy({
      adminClient,
      name: 'songster',
      expectedHeadSha: 'different',
    });
    expect(r.outcome).toBe('done');
    expect(r.message).toMatch(/differs from local HEAD/);
  });

  it('fails when bmadStatus is not HEALTHY', async () => {
    const adminClient = {
      getProject: vi.fn(async () => ({ ...base, bmadStatus: 'FAILED', failureReason: 'X' })),
    };
    const r = await stepVerifyHealthy({ adminClient, name: 'songster' });
    expect(r.outcome).toBe('fail');
    expect(r.message).toMatch(/FAILED/);
  });

  it('fails when kind is not brownfield', async () => {
    const adminClient = {
      getProject: vi.fn(async () => ({ ...base, kind: 'greenfield' })),
    };
    const r = await stepVerifyHealthy({ adminClient, name: 'songster' });
    expect(r.outcome).toBe('fail');
    expect(r.message).toMatch(/brownfield/);
  });
});

describe('stepRefreshExisting', () => {
  it('returns done with jobId on a registered brownfield project', async () => {
    const adminClient = {
      getProject: vi.fn(async () => ({ kind: 'brownfield', bmadStatus: 'HEALTHY' })),
      refreshProject: vi.fn(async () => ({ jobId: 'job-r', projectId: 'songster' })),
    };
    const r = await stepRefreshExisting({ adminClient, name: 'songster' });
    expect(r.outcome).toBe('done');
    expect(r.data.jobId).toBe('job-r');
  });

  it('fails when project is not registered', async () => {
    const adminClient = {
      getProject: vi.fn(async () => {
        throw new AdminApiError(404, null, 'not found');
      }),
    };
    const r = await stepRefreshExisting({ adminClient, name: 'ghost' });
    expect(r.outcome).toBe('fail');
    expect(r.message).toMatch(/not registered/);
  });

  it('fails when project is greenfield', async () => {
    const adminClient = {
      getProject: vi.fn(async () => ({ kind: 'greenfield' })),
    };
    const r = await stepRefreshExisting({ adminClient, name: 'bmad-canon' });
    expect(r.outcome).toBe('fail');
  });
});
