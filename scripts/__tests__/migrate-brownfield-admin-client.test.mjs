import { describe, it, expect, vi } from 'vitest';
import { createAdminClient, AdminApiError } from '../lib/migrate-brownfield/admin-client.mjs';

function makeFetch(handlers) {
  // handlers: Array<{ match: (url, init) => boolean, response: { status, body? } }>
  return vi.fn(async (url, init = {}) => {
    for (const h of handlers) {
      if (h.match(url, init)) {
        const body = h.response.body;
        const text =
          body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
        return {
          ok: h.response.status >= 200 && h.response.status < 300,
          status: h.response.status,
          text: async () => text,
        };
      }
    }
    throw new Error(`unmocked URL: ${init.method || 'GET'} ${url}`);
  });
}

describe('createAdminClient — baseUrl handling', () => {
  it('trims trailing slash from baseUrl', async () => {
    const fetchImpl = makeFetch([
      {
        match: (url) => url === 'http://x/api/health',
        response: { status: 200, body: { ok: true } },
      },
    ]);
    const c = createAdminClient({ baseUrl: 'http://x/api/', token: null, fetchImpl });
    await c.healthCheck();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://x/api/health');
  });

  it('throws when baseUrl is missing', () => {
    expect(() => createAdminClient({ baseUrl: '', token: null })).toThrow();
  });
});

describe('createAdminClient — auth', () => {
  it('attaches Bearer token on authed requests', async () => {
    const fetchImpl = makeFetch([
      {
        match: (url) => url === 'http://x/api/party/projects/songster',
        response: { status: 200, body: { projectId: 'songster' } },
      },
    ]);
    const c = createAdminClient({ baseUrl: 'http://x/api', token: 'jwt.token', fetchImpl });
    await c.getProject('songster');
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer jwt.token');
  });

  it('does NOT attach Bearer on healthCheck (no auth required)', async () => {
    const fetchImpl = makeFetch([
      {
        match: (url) => url === 'http://x/api/health',
        response: { status: 200, body: { ok: true } },
      },
    ]);
    const c = createAdminClient({ baseUrl: 'http://x/api', token: 'jwt.token', fetchImpl });
    await c.healthCheck();
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers).toBeUndefined();
  });
});

describe('createAdminClient — registerBrownfield', () => {
  it('POSTs the discriminated body shape', async () => {
    const fetchImpl = makeFetch([
      {
        match: (url, init) => url === 'http://x/api/party/projects' && init.method === 'POST',
        response: {
          status: 201,
          body: { jobId: 'job-1', projectId: 'songster', kind: 'brownfield' },
        },
      },
    ]);
    const c = createAdminClient({ baseUrl: 'http://x/api', token: 'jwt', fetchImpl });
    const result = await c.registerBrownfield({
      name: 'songster',
      gitRepoUrl: 'https://github.com/foo/songster.git',
      gitBranch: 'main',
    });
    expect(result.jobId).toBe('job-1');
    const sentBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sentBody).toEqual({
      kind: 'brownfield',
      name: 'songster',
      gitRepoUrl: 'https://github.com/foo/songster.git',
      gitBranch: 'main',
    });
  });

  it('throws AdminApiError with status + body on 4xx', async () => {
    const fetchImpl = makeFetch([
      {
        match: (url) => url === 'http://x/api/party/projects',
        response: {
          status: 409,
          body: { error: { code: 'PROJECT_ALREADY_EXISTS', message: 'taken' } },
        },
      },
    ]);
    const c = createAdminClient({ baseUrl: 'http://x/api', token: 'jwt', fetchImpl });
    try {
      await c.registerBrownfield({ name: 'songster', gitRepoUrl: 'https://github.com/x/y' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminApiError);
      expect(err.status).toBe(409);
      expect(err.body.error.code).toBe('PROJECT_ALREADY_EXISTS');
    }
  });
});

describe('createAdminClient — refreshProject + getProject', () => {
  it('refreshProject POSTs /:id/refresh', async () => {
    const fetchImpl = makeFetch([
      {
        match: (url, init) =>
          url === 'http://x/api/party/projects/songster/refresh' && init.method === 'POST',
        response: { status: 202, body: { jobId: 'job-r', projectId: 'songster' } },
      },
    ]);
    const c = createAdminClient({ baseUrl: 'http://x/api', token: 'jwt', fetchImpl });
    const r = await c.refreshProject('songster');
    expect(r.jobId).toBe('job-r');
  });

  it('getProject GETs /party/projects/:id', async () => {
    const fetchImpl = makeFetch([
      {
        match: (url) => url === 'http://x/api/party/projects/songster',
        response: { status: 200, body: { projectId: 'songster', kind: 'brownfield' } },
      },
    ]);
    const c = createAdminClient({ baseUrl: 'http://x/api', token: 'jwt', fetchImpl });
    const r = await c.getProject('songster');
    expect(r.kind).toBe('brownfield');
  });
});

describe('createAdminClient — pollJobEvents', () => {
  it('returns completed outcome when a terminal event lands', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      const text =
        call === 1
          ? JSON.stringify({
              events: [{ eventType: 'party.bootstrap.step.started', eventSeq: '1' }],
              lastSeq: '1',
            })
          : JSON.stringify({
              events: [{ eventType: 'party.bootstrap.completed', eventSeq: '2' }],
              lastSeq: '2',
            });
      return { ok: true, status: 200, text: async () => text };
    });
    const events = [];
    const c = createAdminClient({
      baseUrl: 'http://x/api',
      token: 'jwt',
      fetchImpl,
      sleep: async () => {},
    });
    const r = await c.pollJobEvents('job-1', {
      intervalMs: 0,
      timeoutMs: 60000,
      onEvent: (e) => events.push(e.eventType),
    });
    expect(r.outcome).toBe('completed');
    expect(events).toEqual(['party.bootstrap.step.started', 'party.bootstrap.completed']);
  });

  it('returns failed outcome on a .failed terminal event', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          events: [{ eventType: 'party.bootstrap.failed', eventSeq: '1' }],
          lastSeq: '1',
        }),
    }));
    const c = createAdminClient({
      baseUrl: 'http://x/api',
      token: 'jwt',
      fetchImpl,
      sleep: async () => {},
    });
    const r = await c.pollJobEvents('job-1', { intervalMs: 0 });
    expect(r.outcome).toBe('failed');
  });

  it('returns timeout when no terminal event lands in time', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ events: [], lastSeq: '0' }),
      };
    });

    let nowMs = 0;
    const realDateNow = Date.now;
    Date.now = () => nowMs;
    try {
      const c = createAdminClient({
        baseUrl: 'http://x/api',
        token: 'jwt',
        fetchImpl,
        sleep: async () => {
          nowMs += 1500;
        },
      });
      const r = await c.pollJobEvents('job-1', { intervalMs: 1500, timeoutMs: 4500 });
      expect(r.outcome).toBe('timeout');
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('routes refresh terminal events as completed/failed', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          events: [{ eventType: 'party.refresh.completed', eventSeq: '1' }],
          lastSeq: '1',
        }),
    }));
    const c = createAdminClient({
      baseUrl: 'http://x/api',
      token: 'jwt',
      fetchImpl,
      sleep: async () => {},
    });
    const r = await c.pollJobEvents('job-1', { intervalMs: 0 });
    expect(r.outcome).toBe('completed');
    expect(r.terminal.eventType).toBe('party.refresh.completed');
  });
});
