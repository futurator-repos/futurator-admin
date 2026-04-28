/**
 * github-routes.test.ts — Story 1.2.4
 *
 * Tests the /api/github/* Hono routes registered in functions/api/index.ts.
 *
 * Strategy:
 *   - Mock the connector so no real GitHub calls are made.
 *   - Mock auth-middleware to inject a fake user on all protected routes.
 *   - Mock dynamo-client (and transitive DDB repos) with a no-op sendMock so
 *     module-level DDB client construction does not fail.
 *   - Import `app` from the real index.ts and drive it via `app.request()`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHubRepo, TreeEntry, FileContent, FileTooLarge } from '../../shared/github/types';

// ── 1. Mock the GitHub connector ────────────────────────────────────────────
// Must be hoisted before any imports that pull in index.ts.
const connectorMocks = vi.hoisted(() => ({
  checkConnection: vi.fn(),
  listRepos: vi.fn(),
  getRepo: vi.fn(),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  createRepoFromTemplate: vi.fn(),
  GitHubError: class GitHubError extends Error {
    status: number;
    rateLimit?: { limit: number; remaining: number; reset: number };
    constructor(
      message: string,
      status: number,
      rateLimit?: { limit: number; remaining: number; reset: number },
    ) {
      super(message);
      this.name = 'GitHubError';
      this.status = status;
      this.rateLimit = rateLimit;
    }
  },
}));

vi.mock('../../shared/github/connector', () => connectorMocks);

// ── 2. Mock auth-middleware to inject a test user ───────────────────────────
vi.mock('../../shared/auth-middleware', () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => {
    await next();
  }),
}));

// ── 3. Mock dynamo-client so DDB repos don't try to connect ────────────────
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
    epicWorkflows: 'test-epic-workflows',
    projectRegistry: 'test-project-registry',
    partyProjects: 'test-party-projects',
    partySessions: 'test-party-sessions',
    plans: 'test-plans',
    apps: 'test-apps',
    attentionItems: 'test-attention-items',
    agentSessions: 'test-agent-sessions',
    agentConversations: 'test-agent-conversations',
  },
}));

// ── 4. Import the app after mocks are registered ────────────────────────────
import { app } from '../index';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RATE_LIMIT = { limit: 5000, remaining: 4900, reset: 1700000000 };

function makeRepo(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  return {
    id: 1,
    name: 'dino5',
    full_name: 'futurator-repos/dino5',
    owner: { login: 'futurator-repos', id: 42 },
    private: true,
    description: null,
    default_branch: 'main',
    clone_url: 'https://github.com/futurator-repos/dino5.git',
    html_url: 'https://github.com/futurator-repos/dino5',
    is_template: false,
    pushed_at: '2026-04-28T00:00:00Z',
    created_at: '2026-04-28T00:00:00Z',
    updated_at: '2026-04-28T00:00:00Z',
    topics: [],
    ...overrides,
  };
}

function makeTree(): { tree: TreeEntry[]; truncated: boolean; count: number } {
  const entries: TreeEntry[] = [
    { path: 'README.md', mode: '100644', type: 'blob', sha: 'abc123', size: 42, url: '' },
  ];
  return { tree: entries, truncated: false, count: entries.length };
}

function makeFileContent(): FileContent {
  return { content: 'hello world', encoding: 'utf-8', sha: 'def456', size: 11 };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function get(path: string, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'GET', headers });
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.resetAllMocks();
  sendMock.mockReset();
  // Re-wire auth middleware passthrough after each reset
  const { authMiddleware } = await import('../../shared/auth-middleware');
  vi.mocked(authMiddleware).mockImplementation(async (_c, next) => {
    await next();
  });
});

// ── GET /api/github/status ───────────────────────────────────────────────────

describe('GET /api/github/status', () => {
  it('returns 200 with connected:true when PAT is valid', async () => {
    connectorMocks.checkConnection.mockResolvedValue({
      connected: true,
      login: 'futurator-bot',
      rateLimit: RATE_LIMIT,
    });

    const res = await get('/api/github/status');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.login).toBe('futurator-bot');
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('returns 503 with connected:false when PAT is missing or invalid', async () => {
    connectorMocks.checkConnection.mockResolvedValue({
      connected: false,
      error: 'Bad credentials',
      rateLimit: RATE_LIMIT,
    });

    const res = await get('/api/github/status');
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.connected).toBe(false);
    expect(body.error).toBe('Bad credentials');
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });
});

// ── GET /api/github/repos ────────────────────────────────────────────────────

describe('GET /api/github/repos', () => {
  it('returns 200 with repos array and rateLimit on success', async () => {
    const repos = [
      makeRepo(),
      makeRepo({ id: 2, name: 'dino6', full_name: 'futurator-repos/dino6' }),
    ];
    connectorMocks.listRepos.mockResolvedValue({ data: repos, rateLimit: RATE_LIMIT });

    const res = await get('/api/github/repos');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.repos).toHaveLength(2);
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('returns the connector GitHubError status (e.g. 401) on auth failure', async () => {
    connectorMocks.listRepos.mockRejectedValue(
      new connectorMocks.GitHubError('Bad credentials', 401, RATE_LIMIT),
    );

    const res = await get('/api/github/repos');
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('Bad credentials');
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('forwards rateLimit inside JSON body on success', async () => {
    connectorMocks.listRepos.mockResolvedValue({ data: [], rateLimit: RATE_LIMIT });

    const res = await get('/api/github/repos');
    const body = await res.json();
    expect(body.rateLimit.remaining).toBe(4900);
  });
});

// ── GET /api/github/repos/:owner/:name ──────────────────────────────────────

describe('GET /api/github/repos/:owner/:name', () => {
  it('returns 200 with repo and rateLimit on success', async () => {
    const repo = makeRepo();
    connectorMocks.getRepo.mockResolvedValue({ data: repo, rateLimit: RATE_LIMIT });

    const res = await get('/api/github/repos/futurator-repos/dino5');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.repo.name).toBe('dino5');
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('returns 404 when GitHub responds with 404', async () => {
    connectorMocks.getRepo.mockRejectedValue(
      new connectorMocks.GitHubError('Not Found', 404, RATE_LIMIT),
    );

    const res = await get('/api/github/repos/futurator-repos/nonexistent');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Not Found');
  });

  it('passes owner and name to connector correctly', async () => {
    connectorMocks.getRepo.mockResolvedValue({ data: makeRepo(), rateLimit: RATE_LIMIT });

    await get('/api/github/repos/some-owner/some-repo');
    expect(connectorMocks.getRepo).toHaveBeenCalledWith('some-owner', 'some-repo');
  });
});

// ── GET /api/github/repos/:owner/:name/tree ──────────────────────────────────

describe('GET /api/github/repos/:owner/:name/tree', () => {
  it('returns 200 with tree, truncated, count, and rateLimit', async () => {
    const treeData = makeTree();
    connectorMocks.getRepoTree.mockResolvedValue({ data: treeData, rateLimit: RATE_LIMIT });

    const res = await get('/api/github/repos/futurator-repos/dino5/tree');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tree).toHaveLength(1);
    expect(body.truncated).toBe(false);
    expect(body.count).toBe(1);
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('forwards ?branch= query param to connector', async () => {
    connectorMocks.getRepoTree.mockResolvedValue({ data: makeTree(), rateLimit: RATE_LIMIT });

    await get('/api/github/repos/futurator-repos/dino5/tree?branch=feat/x');
    expect(connectorMocks.getRepoTree).toHaveBeenCalledWith('futurator-repos', 'dino5', 'feat/x');
  });

  it('calls connector with undefined branch when query param is absent', async () => {
    connectorMocks.getRepoTree.mockResolvedValue({ data: makeTree(), rateLimit: RATE_LIMIT });

    await get('/api/github/repos/futurator-repos/dino5/tree');
    expect(connectorMocks.getRepoTree).toHaveBeenCalledWith('futurator-repos', 'dino5', undefined);
  });

  it('returns GitHubError status on connector failure', async () => {
    connectorMocks.getRepoTree.mockRejectedValue(
      new connectorMocks.GitHubError('Not Found', 404, RATE_LIMIT),
    );

    const res = await get('/api/github/repos/futurator-repos/gone/tree');
    expect(res.status).toBe(404);
  });
});

// ── GET /api/github/repos/:owner/:name/files ─────────────────────────────────

describe('GET /api/github/repos/:owner/:name/files', () => {
  it('returns 200 with file content and rateLimit for a normal file', async () => {
    const fileData = makeFileContent();
    connectorMocks.getFileContent.mockResolvedValue({ data: fileData, rateLimit: RATE_LIMIT });

    const res = await get('/api/github/repos/futurator-repos/dino5/files?path=README.md');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.content).toBe('hello world');
    expect(body.encoding).toBe('utf-8');
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('returns 200 with tooLarge:true for oversized files', async () => {
    const tooLarge: FileTooLarge = { tooLarge: true, size: 2_000_000 };
    connectorMocks.getFileContent.mockResolvedValue({ data: tooLarge, rateLimit: RATE_LIMIT });

    const res = await get('/api/github/repos/futurator-repos/dino5/files?path=big.bin');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tooLarge).toBe(true);
    expect(body.size).toBe(2_000_000);
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('returns 400 when ?path= is missing', async () => {
    const res = await get('/api/github/repos/futurator-repos/dino5/files');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('forwards optional ?ref= to connector', async () => {
    connectorMocks.getFileContent.mockResolvedValue({
      data: makeFileContent(),
      rateLimit: RATE_LIMIT,
    });

    await get('/api/github/repos/futurator-repos/dino5/files?path=src/index.ts&ref=feat/x');
    expect(connectorMocks.getFileContent).toHaveBeenCalledWith(
      'futurator-repos',
      'dino5',
      'src/index.ts',
      'feat/x',
    );
  });

  it('returns GitHubError status on connector failure', async () => {
    connectorMocks.getFileContent.mockRejectedValue(
      new connectorMocks.GitHubError('Not Found', 404, RATE_LIMIT),
    );

    const res = await get('/api/github/repos/futurator-repos/dino5/files?path=missing.ts');
    expect(res.status).toBe(404);
  });
});

// ── POST /api/github/repos ───────────────────────────────────────────────────

describe('POST /api/github/repos', () => {
  it('returns 201 with repo and rateLimit on successful creation', async () => {
    const repo = makeRepo({ name: 'my-app' });
    connectorMocks.createRepoFromTemplate.mockResolvedValue({ data: repo, rateLimit: RATE_LIMIT });

    const res = await post('/api/github/repos', { templateType: 'nextjs', name: 'my-app' });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.repo.name).toBe('my-app');
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('returns 409 when connector signals existing:true (idempotency path)', async () => {
    const existingRepo = makeRepo({ name: 'my-app' });
    connectorMocks.createRepoFromTemplate.mockResolvedValue({
      data: { existing: true, repo: existingRepo },
      rateLimit: RATE_LIMIT,
    });

    const res = await post('/api/github/repos', { templateType: 'nextjs', name: 'my-app' });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe('repo-exists');
    expect(body.repo.name).toBe('my-app');
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('returns 422 (ValidationError→400) when name does not match slug regex', async () => {
    const res = await post('/api/github/repos', {
      templateType: 'nextjs',
      name: 'InvalidName', // uppercase — invalid
    });
    // ValidationError → AppError → 400 via global handler
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when templateType is not a valid BoilerplateType', async () => {
    const res = await post('/api/github/repos', {
      templateType: 'rails', // not in enum
      name: 'valid-app',
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('calls createRepoFromTemplate with the correct template owner+repo split from registry', async () => {
    const repo = makeRepo();
    connectorMocks.createRepoFromTemplate.mockResolvedValue({ data: repo, rateLimit: RATE_LIMIT });

    await post('/api/github/repos', { templateType: 'nextjs', name: 'my-app' });

    // BOILERPLATE_REGISTRY.nextjs.templateRepo = 'futurator-repos/template-nextjs'
    expect(connectorMocks.createRepoFromTemplate).toHaveBeenCalledWith(
      'futurator-repos',
      'template-nextjs',
      'my-app',
    );
  });

  it('returns GitHubError status on connector failure', async () => {
    connectorMocks.createRepoFromTemplate.mockRejectedValue(
      new connectorMocks.GitHubError('Forbidden', 403, RATE_LIMIT),
    );

    const res = await post('/api/github/repos', { templateType: 'nextjs', name: 'my-app' });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    expect(body.rateLimit).toEqual(RATE_LIMIT);
  });

  it('works with all four boilerplate types (vite)', async () => {
    const repo = makeRepo({ name: 'vite-app' });
    connectorMocks.createRepoFromTemplate.mockResolvedValue({ data: repo, rateLimit: RATE_LIMIT });

    const res = await post('/api/github/repos', { templateType: 'vite', name: 'vite-app' });
    expect(res.status).toBe(201);
    expect(connectorMocks.createRepoFromTemplate).toHaveBeenCalledWith(
      'futurator-repos',
      'template-vite',
      'vite-app',
    );
  });

  it('returns 400 when name is only one char (fails ^[a-z][a-z0-9-]{1,39}$)', async () => {
    const res = await post('/api/github/repos', { templateType: 'nextjs', name: 'a' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
