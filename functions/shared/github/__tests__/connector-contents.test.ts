/**
 * connector-contents.test.ts — Skills Management Phase 2, Story 2.1 (2026-06-15).
 *
 * Hermetic tests for the Contents write surface (getFileSha / putFile /
 * deleteFile). fetch is stubbed; loadPat is mocked so no SSM/env is needed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../load-pat', () => ({ loadPat: vi.fn(() => 'ghp_test_token_123') }));

import { getFileSha, putFile, deleteFile, GitHubError } from '../connector';

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('getFileSha', () => {
  it('returns the sha when the file exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(200, { sha: 'abc123' })),
    );
    expect(await getFileSha('o', 'r', 'index.json')).toBe('abc123');
  });
  it('returns null on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(404, { message: 'Not Found' })),
    );
    expect(await getFileSha('o', 'r', 'nope.json')).toBeNull();
  });
  it('rethrows non-404 errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(500, { message: 'boom' })),
    );
    await expect(getFileSha('o', 'r', 'x')).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('putFile', () => {
  it('creates (no sha) when file absent, base64-encodes content', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (init?.method === 'PUT')
          return res(201, { commit: { sha: 'c1' }, content: { sha: 'f1' } });
        return res(404, { message: 'Not Found' }); // getFileSha lookup
      }),
    );
    const out = await putFile('o', 'r', 'skills/x/SKILL.md', 'hello', 'add x');
    expect(out).toEqual({ commitSha: 'c1', contentSha: 'f1' });
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    const body = JSON.parse(put.init!.body as string);
    expect(body.sha).toBeUndefined(); // create path
    expect(Buffer.from(body.content, 'base64').toString('utf-8')).toBe('hello');
    expect(body.message).toBe('add x');
  });

  it('updates (includes sha) when file exists', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ init });
        if (init?.method === 'PUT')
          return res(200, { commit: { sha: 'c2' }, content: { sha: 'f2' } });
        return res(200, { sha: 'existing-sha' });
      }),
    );
    await putFile('o', 'r', 'index.json', '{}', 'update', 'main');
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    const body = JSON.parse(put.init!.body as string);
    expect(body.sha).toBe('existing-sha');
    expect(body.branch).toBe('main');
  });
});

describe('deleteFile', () => {
  it('deletes with the current sha when present', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ init });
        if (init?.method === 'DELETE') return res(200, { commit: { sha: 'd1' } });
        return res(200, { sha: 'sha-to-delete' });
      }),
    );
    expect(await deleteFile('o', 'r', 'skills/x/SKILL.md', 'rm x')).toEqual({ deleted: true });
    const del = calls.find((c) => c.init?.method === 'DELETE')!;
    expect(JSON.parse(del.init!.body as string).sha).toBe('sha-to-delete');
  });

  it('is a no-op when the file is already gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(404, { message: 'Not Found' })),
    );
    expect(await deleteFile('o', 'r', 'gone.md', 'rm')).toEqual({ deleted: false });
  });
});
