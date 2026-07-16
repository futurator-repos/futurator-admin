/**
 * creds-fetch.test.mjs — Servers-module Task 19 (spec §6).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAgentCredentials } from '../creds-fetch.mjs';

function makeFetch({ status, body }) {
  return vi.fn().mockResolvedValue({
    status,
    text: async () => body,
  });
}

describe('fetchAgentCredentials', () => {
  it('writes the response body to credsPath with mode 0600 on 200', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-fetch-'));
    const credsPath = join(dir, '.credentials.json');
    const body = JSON.stringify({ accessToken: 'tok', refreshToken: 'rtok' });
    const fetchImpl = makeFetch({ status: 200, body });

    const ok = await fetchAgentCredentials({
      adminApiUrl: 'https://hub.futurator.ai',
      enrollToken: 'enroll-abc',
      credsPath,
      fetchImpl,
    });

    expect(ok).toBe(true);
    expect(readFileSync(credsPath, 'utf8')).toBe(body);
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hub.futurator.ai/api/servers/agent-credentials',
      expect.objectContaining({ headers: { 'x-server-token': 'enroll-abc' } }),
    );
  });

  it('returns false and leaves the file untouched on 401', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-fetch-'));
    const credsPath = join(dir, '.credentials.json');
    const fetchImpl = makeFetch({ status: 401, body: 'unauthorized' });

    const ok = await fetchAgentCredentials({
      adminApiUrl: 'https://hub.futurator.ai',
      enrollToken: 'revoked-token',
      credsPath,
      fetchImpl,
    });

    expect(ok).toBe(false);
    expect(existsSync(credsPath)).toBe(false);
  });

  it('returns false and never throws on 503', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-fetch-'));
    const credsPath = join(dir, '.credentials.json');
    const fetchImpl = makeFetch({ status: 503, body: 'unavailable' });

    const ok = await fetchAgentCredentials({
      adminApiUrl: 'https://hub.futurator.ai',
      enrollToken: 'enroll-abc',
      credsPath,
      fetchImpl,
    });

    expect(ok).toBe(false);
    expect(existsSync(credsPath)).toBe(false);
  });

  it('returns false and never throws when fetch itself rejects (network error)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-fetch-'));
    const credsPath = join(dir, '.credentials.json');
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      fetchAgentCredentials({
        adminApiUrl: 'https://hub.futurator.ai',
        enrollToken: 'enroll-abc',
        credsPath,
        fetchImpl,
      }),
    ).resolves.toBe(false);
    expect(existsSync(credsPath)).toBe(false);
  });
});
