import { describe, it, expect, vi } from 'vitest';
import {
  ensureSecret,
  buildSecretArn,
  buildPolicyDocument,
  buildPutRolePolicyCommandHint,
  POLICY_NAME,
} from '../lib/migrate-brownfield/aws-helpers.mjs';

function fakeSecretsClient(map = {}) {
  return {
    send: vi.fn(async (cmd) => {
      const cn = cmd.constructor.name;
      const id = cmd.input?.SecretId || cmd.input?.Name;
      if (cn === 'GetSecretValueCommand') {
        if (map[id]) return { ARN: `arn:${id}-xyz`, SecretString: map[id] };
        const err = new Error('not found');
        err.name = 'ResourceNotFoundException';
        throw err;
      }
      if (cn === 'CreateSecretCommand') {
        map[id] = cmd.input.SecretString;
        return { ARN: `arn:${id}-new` };
      }
      if (cn === 'PutSecretValueCommand') {
        map[id] = cmd.input.SecretString;
        return { ARN: `arn:${id}-rotated` };
      }
      throw new Error(`unmocked: ${cn}`);
    }),
  };
}

describe('buildSecretArn', () => {
  it('produces a wildcard-suffix ARN', () => {
    expect(
      buildSecretArn('us-east-1', '835745294770', 'futurator/labs-brownfield-github-pat'),
    ).toBe(
      'arn:aws:secretsmanager:us-east-1:835745294770:secret:futurator/labs-brownfield-github-pat-*',
    );
  });
});

describe('buildPolicyDocument', () => {
  it('grants GetSecretValue on exactly one resource', () => {
    const doc = buildPolicyDocument('arn:...:secret:foo-*');
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0].Action).toBe('secretsmanager:GetSecretValue');
    expect(doc.Statement[0].Resource).toBe('arn:...:secret:foo-*');
    expect(doc.Statement[0].Effect).toBe('Allow');
  });
});

describe('buildPutRolePolicyCommandHint', () => {
  it('produces a copy-pasteable aws CLI invocation', () => {
    const hint = buildPutRolePolicyCommandHint(
      'futurator-daemon-role',
      'futurator/labs-brownfield-github-pat',
      'us-east-1',
      '835745294770',
    );
    expect(hint).toContain('aws iam put-role-policy');
    expect(hint).toContain('futurator-daemon-role');
    expect(hint).toContain(POLICY_NAME);
    expect(hint).toContain('secretsmanager:GetSecretValue');
    // Verify the embedded ARN matches what the Secrets Manager build emits.
    expect(hint).toContain('futurator/labs-brownfield-github-pat-*');
  });
});

describe('ensureSecret', () => {
  it('creates the secret when it does not exist', async () => {
    const map = {};
    const client = fakeSecretsClient(map);
    const r = await ensureSecret({
      secretName: 'futurator/labs-brownfield-github-pat',
      pat: 'github_pat_abc',
      rotate: false,
      client,
    });
    expect(r.outcome).toBe('created');
    expect(map['futurator/labs-brownfield-github-pat']).toBe('github_pat_abc');
  });

  it('reports "exists" when the secret is present and rotation is off', async () => {
    const map = { 'futurator/labs-brownfield-github-pat': 'github_pat_old' };
    const client = fakeSecretsClient(map);
    const r = await ensureSecret({
      secretName: 'futurator/labs-brownfield-github-pat',
      pat: 'github_pat_new',
      rotate: false,
      client,
    });
    expect(r.outcome).toBe('exists');
    expect(map['futurator/labs-brownfield-github-pat']).toBe('github_pat_old');
  });

  it('rotates when secret exists and rotate=true', async () => {
    const map = { 'futurator/labs-brownfield-github-pat': 'github_pat_old' };
    const client = fakeSecretsClient(map);
    const r = await ensureSecret({
      secretName: 'futurator/labs-brownfield-github-pat',
      pat: 'github_pat_new',
      rotate: true,
      client,
    });
    expect(r.outcome).toBe('rotated');
    expect(map['futurator/labs-brownfield-github-pat']).toBe('github_pat_new');
  });

  it('propagates non-NotFound errors (e.g. AccessDenied)', async () => {
    const client = {
      send: vi.fn(async () => {
        const err = new Error('AccessDeniedException');
        err.name = 'AccessDeniedException';
        throw err;
      }),
    };
    await expect(
      ensureSecret({ secretName: 'x', pat: 'p', rotate: false, client }),
    ).rejects.toThrow();
  });
});
