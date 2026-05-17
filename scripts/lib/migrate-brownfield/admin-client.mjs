/**
 * Admin API client for migrate-brownfield.mjs.
 *
 * Thin fetch wrapper that:
 *   - prefixes baseUrl
 *   - attaches Bearer auth
 *   - parses JSON responses (or returns raw on non-JSON)
 *   - throws AdminApiError with status + body for non-2xx
 *
 * Plus three convenience methods that map to the brownfield endpoints
 * shipped in Story 15.4:
 *   - registerBrownfield()    → POST /party/projects
 *   - refreshProject()        → POST /party/projects/:id/refresh
 *   - getProject()            → GET /party/projects/:id
 *   - pollJobEvents()         → GET /agent-jobs/:id/events polling
 *   - healthCheck()           → GET /health (no auth)
 *
 * Tests inject a custom `fetchImpl` so we never hit the network.
 */

export class AdminApiError extends Error {
  constructor(status, body, message) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Create an admin-client instance.
 *
 * @param {object} args
 * @param {string} args.baseUrl              e.g. https://admin.futurator.ai/api
 * @param {string} args.token                Bearer JWT (or null for unauthed calls)
 * @param {Function} [args.fetchImpl=fetch]  override for tests
 * @param {Function} [args.sleep]            override for tests (defaults to setTimeout)
 */
export function createAdminClient({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!baseUrl) throw new Error('createAdminClient: baseUrl is required');

  const normalizedBase = baseUrl.replace(/\/$/, '');

  async function request(method, path, body = undefined) {
    const url = `${normalizedBase}${path}`;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(url, init);
    let parsed;
    const text = await res.text();
    if (text.length === 0) parsed = null;
    else {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const message =
        typeof parsed === 'object' && parsed?.error?.message
          ? parsed.error.message
          : `admin API ${method} ${path} → ${res.status}`;
      throw new AdminApiError(res.status, parsed, message);
    }
    return parsed;
  }

  return {
    async healthCheck() {
      const res = await fetchImpl(`${normalizedBase}/health`, { method: 'GET' });
      if (!res.ok) {
        throw new AdminApiError(res.status, null, `admin API health check failed (${res.status})`);
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },

    async registerBrownfield({ name, gitRepoUrl, gitBranch }) {
      return request('POST', '/party/projects', {
        kind: 'brownfield',
        name,
        gitRepoUrl,
        gitBranch,
      });
    },

    async refreshProject(projectId) {
      return request('POST', `/party/projects/${encodeURIComponent(projectId)}/refresh`, {});
    },

    async getProject(projectId) {
      return request('GET', `/party/projects/${encodeURIComponent(projectId)}`);
    },

    /**
     * Poll /agent-jobs/:jobId/events at `intervalMs` until a terminal
     * event lands or the deadline is hit.
     *
     * Terminal eventTypes (returned as `outcome`):
     *   - 'party.bootstrap.completed'  → outcome='completed' (kind='brownfield' bootstrap)
     *   - 'party.bootstrap.failed'     → outcome='failed'
     *   - 'party.refresh.completed'    → outcome='completed' (refresh)
     *   - 'party.refresh.failed'       → outcome='failed'
     *
     * Calls `onEvent(event)` for each new event so the CLI can stream
     * progress to stdout.
     *
     * @returns {Promise<{ outcome: 'completed'|'failed'|'timeout', events: object[] }>}
     */
    async pollJobEvents(
      jobId,
      { intervalMs = 1500, timeoutMs = 5 * 60 * 1000, onEvent = () => {} } = {},
    ) {
      const deadline = Date.now() + timeoutMs;
      let lastSeq = '000000';
      const all = [];
      const terminalTypes = new Set([
        'party.bootstrap.completed',
        'party.bootstrap.failed',
        'party.refresh.completed',
        'party.refresh.failed',
      ]);

      while (Date.now() < deadline) {
        const data = await request(
          'GET',
          `/agent-jobs/${encodeURIComponent(jobId)}/events?after=${encodeURIComponent(lastSeq)}`,
        );
        const events = Array.isArray(data?.events) ? data.events : [];
        for (const e of events) {
          all.push(e);
          await onEvent(e);
        }
        if (typeof data?.lastSeq !== 'undefined') {
          lastSeq = String(data.lastSeq).padStart(6, '0');
        }
        const terminal = events.find((e) => terminalTypes.has(e.eventType));
        if (terminal) {
          return {
            outcome: terminal.eventType.endsWith('.completed') ? 'completed' : 'failed',
            events: all,
            terminal,
          };
        }
        await sleep(intervalMs);
      }
      return { outcome: 'timeout', events: all };
    },
  };
}
