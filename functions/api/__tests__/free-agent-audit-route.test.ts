/**
 * free-agent-audit-route.test.ts — Story 18.3 AC #5, AC #6, AC #7.
 *
 * Hermetic coverage of `GET /api/free-agent/sessions/:id/audit`:
 *   1. invalid sessionId             → 400 ValidationError
 *   2. missing session               → 404 NotFound
 *   3. caller is not the owner       → 403 FORBIDDEN
 *   4. happy path                    → 200 with combined session + events
 *   5. events sorted ascending by    eventSeq (via paginated getEventsAfter)
 *   6. pagination terminates cleanly when lastSeq stops advancing
 *
 * No real network calls. DynamoDB doc client is fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Mock auth-middleware (per-test override via vi.mocked) ───────────────
vi.mock('../../shared/auth-middleware', () => ({
  authMiddleware: vi.fn(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
      await next();
    },
  ),
}));

// ── 2. Mock dynamo-client ───────────────────────────────────────────────────
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('../../shared/dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    projects: 'test-projects',
    costs: 'test-costs',
    resources: 'test-resources',
    audits: 'test-audits',
    schedules: 'test-schedules',
    users: 'test-users',
    alerts: 'test-alerts',
    agentJobs: 'test-agent-jobs',
    agentEvents: 'test-agent-events',
    partyEvents: 'test-party-events',
    epicWorkflows: 'test-epic-workflows',
    projectRegistry: 'test-project-registry',
    partyProjects: 'test-party-projects',
    partySessions: 'test-party-sessions',
    partyInlineQuestions: 'test-party-inline-questions',
    plans: 'test-plans',
    apps: 'test-apps',
    attentionItems: 'test-attention-items',
    agentSessions: 'test-agent-sessions',
    agentConversations: 'test-agent-conversations',
    timingSummary: 'test-timing-summary',
    reflections: 'test-reflections',
    freeAgentSessions: 'test-free-agent-sessions',
  },
}));

// ── 3. Import the app after mocks are registered ────────────────────────────
import { app } from '../index';

const VALID_SESSION_ID = '11111111-2222-3333-4444-555555555555';

function freeAgentSessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: VALID_SESSION_ID,
    operatorId: 'u1',
    projectId: 'dino-7',
    scope: { kind: 'plan', id: 'plan-abc' },
    scopeIdComposite: 'plan#plan-abc',
    status: 'ACTIVE',
    model: 'sonnet',
    costCapUsd: 10,
    costUsdAccumulated: 0.42,
    tokensInAccumulated: 1500,
    tokensOutAccumulated: 250,
    claudeSessionId: 'claude-xyz',
    turnCount: 3,
    createdAt: '2026-05-17T10:00:00.000Z',
    lastActivityAt: '2026-05-17T10:30:00.000Z',
    lastTurnAt: '2026-05-17T10:30:00.000Z',
    expiresAt: 1771600000,
    ...overrides,
  };
}

async function getAudit(sessionId: string) {
  return app.request(`/api/free-agent/sessions/${encodeURIComponent(sessionId)}/audit`);
}

beforeEach(async () => {
  vi.resetAllMocks();
  sendMock.mockReset();
  const { authMiddleware } = await import('../../shared/auth-middleware');
  vi.mocked(authMiddleware).mockImplementation(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
      await next();
    },
  );
});

describe('GET /api/free-agent/sessions/:id/audit — validation (AC #5)', () => {
  it('rejects an invalid sessionId with 400 (not a UUID)', async () => {
    const res = await getAudit('not-a-uuid');
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/free-agent/sessions/:id/audit — not-found path (AC #5)', () => {
  it('returns 404 when the session row is missing', async () => {
    sendMock.mockResolvedValueOnce({}); // getSession → no Item
    const res = await getAudit(VALID_SESSION_ID);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/free-agent/sessions/:id/audit — authorization (AC #6)', () => {
  it('returns 403 FORBIDDEN when caller is not the session owner', async () => {
    const { authMiddleware } = await import('../../shared/auth-middleware');
    vi.mocked(authMiddleware).mockImplementation(
      async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set('user', { userId: 'someone-else', email: 'x@y.com', name: 'X' });
        await next();
      },
    );
    sendMock.mockResolvedValueOnce({ Item: freeAgentSessionRow() });

    const res = await getAudit(VALID_SESSION_ID);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('allows the session owner', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: freeAgentSessionRow({ operatorId: 'u1' }) })
      .mockResolvedValueOnce({ Items: [] }); // events pagination terminator

    const res = await getAudit(VALID_SESSION_ID);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/free-agent/sessions/:id/audit — happy path (AC #5)', () => {
  it('returns combined session metadata + paginated events', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: freeAgentSessionRow() })
      .mockResolvedValueOnce({
        Items: [
          {
            jobId: VALID_SESSION_ID,
            eventSeq: '000001',
            timestamp: '2026-05-17T10:00:05.000Z',
            eventType: 'free-agent.turn.start',
            text: 'turn 1 started',
          },
          {
            jobId: VALID_SESSION_ID,
            eventSeq: '000002',
            timestamp: '2026-05-17T10:00:10.000Z',
            eventType: 'free-agent.turn.token',
            text: 'Hello',
          },
        ],
        LastEvaluatedKey: undefined,
      })
      .mockResolvedValueOnce({ Items: [] }); // second-page terminator

    const res = await getAudit(VALID_SESSION_ID);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sessionId).toBe(VALID_SESSION_ID);
    expect(body.session).toMatchObject({
      status: 'ACTIVE',
      model: 'sonnet',
      costUsdAccumulated: 0.42,
      tokensInAccumulated: 1500,
      tokensOutAccumulated: 250,
      turnCount: 3,
      claudeSessionId: 'claude-xyz',
    });
    expect(body.events).toHaveLength(2);
    expect(body.events[0].kind).toBe('free-agent.turn.start');
    expect(body.events[0].detail.text).toBe('turn 1 started');
    expect(body.events[1].kind).toBe('free-agent.turn.token');
  });

  it('handles sessions with no events (returns empty events array)', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: freeAgentSessionRow() })
      .mockResolvedValueOnce({ Items: [] }); // events first page is empty

    const res = await getAudit(VALID_SESSION_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });

  it('returns nullable fields as null (claudeSessionId, lastTurnAt, errorReason)', async () => {
    const row = freeAgentSessionRow({
      claudeSessionId: undefined,
      lastTurnAt: undefined,
      errorReason: undefined,
    });
    sendMock.mockResolvedValueOnce({ Item: row }).mockResolvedValueOnce({ Items: [] });

    const res = await getAudit(VALID_SESSION_ID);
    const body = await res.json();
    expect(body.session.claudeSessionId).toBeNull();
    expect(body.session.lastTurnAt).toBeNull();
    expect(body.session.errorReason).toBeNull();
  });

  it('defaults tokens to 0 when accumulator fields are absent on the row', async () => {
    const row = freeAgentSessionRow({
      tokensInAccumulated: undefined,
      tokensOutAccumulated: undefined,
    });
    sendMock.mockResolvedValueOnce({ Item: row }).mockResolvedValueOnce({ Items: [] });

    const res = await getAudit(VALID_SESSION_ID);
    const body = await res.json();
    expect(body.session.tokensInAccumulated).toBe(0);
    expect(body.session.tokensOutAccumulated).toBe(0);
  });
});

describe('GET /api/free-agent/sessions/:id/audit — pagination terminates cleanly', () => {
  it('breaks when lastSeq stops advancing (defensive against infinite loop)', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: freeAgentSessionRow() })
      // First page: events present
      .mockResolvedValueOnce({
        Items: [
          {
            jobId: VALID_SESSION_ID,
            eventSeq: '000001',
            timestamp: '2026-05-17T10:00:05.000Z',
            eventType: 'free-agent.turn.start',
          },
        ],
      })
      // Second page: 'getEventsAfter' returns lastSeq='000001' (same as cursor)
      .mockResolvedValueOnce({
        Items: [
          {
            jobId: VALID_SESSION_ID,
            eventSeq: '000001',
            timestamp: '2026-05-17T10:00:05.000Z',
            eventType: 'free-agent.turn.start',
          },
        ],
      });

    const res = await getAudit(VALID_SESSION_ID);
    expect(res.status).toBe(200);
    // The handler should NOT loop indefinitely on a non-advancing cursor.
    // (Three send calls total: session lookup + 2 event pages, the third
    // page's lastSeq == previous afterSeq, so the loop breaks.)
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
});
