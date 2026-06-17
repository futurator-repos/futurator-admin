import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rotatePat, InvalidPatError } from '../rotate-pat';

/**
 * 2026-06-17 — rotation now validates repo CAPABILITY, not just authentication
 * (the brick1 fix: a fine-grained PAT that authenticates but lacks Pull requests
 * must be rejected loudly at rotation time, not silently break GitGraph).
 */

// A fake SSM client that records writes.
function fakeSsm() {
  const writes: Array<{ Name?: string }> = [];
  return {
    writes,
    send: vi.fn(async (cmd: { input?: { Name?: string } }) => {
      writes.push({ Name: cmd?.input?.Name });
      return {};
    }),
  } as unknown as import('@aws-sdk/client-ssm').SSMClient & { writes: Array<{ Name?: string }> };
}

type FetchStub = (url: string) => { status: number; ok: boolean; json: () => Promise<unknown> };

function stubFetch(handler: FetchStub) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => handler(url)),
  );
}

const OK = (body: unknown) => ({ status: 200, ok: true, json: async () => body });
const FORBIDDEN = () => ({
  status: 403,
  ok: false,
  json: async () => ({ message: 'Resource not accessible by personal access token' }),
});

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('rotatePat — repo-capability validation (brick1 fix)', () => {
  it('rejects a token that authenticates but cannot read pull requests', async () => {
    stubFetch((url) => {
      if (url.endsWith('/user')) return OK({ login: 'futurator-repos' });
      if (url.includes('/user/repos')) return OK([{ full_name: 'futurator-repos/brick1' }]);
      if (url.includes('/commits')) return OK([]); // Contents OK
      if (url.includes('/pulls')) return FORBIDDEN(); // Pull requests MISSING
      return OK({});
    });
    const ssm = fakeSsm();
    await expect(rotatePat('ghp_fake', ssm)).rejects.toBeInstanceOf(InvalidPatError);
    await expect(rotatePat('ghp_fake', ssm)).rejects.toThrow(/Pull requests/);
    // The insufficient token is NEVER written to SSM.
    expect(ssm.writes).toHaveLength(0);
  });

  it('rejects a token that cannot read contents (commits)', async () => {
    stubFetch((url) => {
      if (url.endsWith('/user')) return OK({ login: 'futurator-repos' });
      if (url.includes('/user/repos')) return OK([{ full_name: 'futurator-repos/brick1' }]);
      if (url.includes('/commits')) return FORBIDDEN();
      return OK([]);
    });
    await expect(rotatePat('ghp_fake', fakeSsm())).rejects.toThrow(/Contents/);
  });

  it('accepts a token with full repo read access (writes to SSM)', async () => {
    stubFetch((url) => {
      if (url.endsWith('/user')) return OK({ login: 'futurator-repos' });
      if (url.includes('/user/repos')) return OK([{ full_name: 'futurator-repos/brick1' }]);
      if (url.includes('/commits')) return OK([]);
      if (url.includes('/pulls')) return OK([]);
      return OK({});
    });
    const ssm = fakeSsm();
    const res = await rotatePat('ghp_good', ssm);
    expect(res.login).toBe('futurator-repos');
    expect(res.rotatedAt).toMatch(/^\d{4}-/);
    // PAT value + rotated-at both written.
    expect(ssm.writes.length).toBe(2);
  });

  it('soft-passes when the token sees no repositories (no false reject)', async () => {
    stubFetch((url) => {
      if (url.endsWith('/user')) return OK({ login: 'fresh-account' });
      if (url.includes('/user/repos')) return OK([]); // nothing to probe
      return OK({});
    });
    const res = await rotatePat('ghp_fresh', fakeSsm());
    expect(res.login).toBe('fresh-account');
  });

  it('still rejects an unauthenticated token (401) before probing', async () => {
    stubFetch((url) => {
      if (url.endsWith('/user')) return { status: 401, ok: false, json: async () => ({}) };
      return OK({});
    });
    await expect(rotatePat('ghp_bad', fakeSsm())).rejects.toBeInstanceOf(InvalidPatError);
  });
});
