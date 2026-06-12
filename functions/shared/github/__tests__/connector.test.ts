/**
 * connector.test.ts — GitHub connector hermetic tests
 *
 * All network calls are intercepted via vi.stubGlobal('fetch', mockFetch).
 * loadPat() is mocked to return a fixed token so no SSM or env setup is needed.
 *
 * Test count: 30 rows (>= 25 required by gate G-1).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock loadPat before importing connector (connector imports loadPat at module
// eval time, so the mock must be hoisted).
// ---------------------------------------------------------------------------

vi.mock('../load-pat', () => ({
  loadPat: vi.fn(() => 'ghp_test_token_123'),
}));

import { loadPat } from '../load-pat';
import {
  githubFetch,
  getUser,
  checkConnection,
  listRepos,
  getRepo,
  getRepoTree,
  getFileContent,
  createRepoFromTemplate,
  deleteRepo,
  is422NameTaken,
  markPullRequestReadyForReview,
  GitHubError,
} from '../connector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': '5000',
  'X-RateLimit-Remaining': '4999',
  'X-RateLimit-Reset': '1700000000',
};

const EXPECTED_RATE_LIMIT = { limit: 5000, remaining: 4999, reset: 1700000000 };

function mockResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...RATE_LIMIT_HEADERS, ...extraHeaders },
  });
}

function mockFetch(response: Response | Response[]) {
  if (Array.isArray(response)) {
    const queue = [...response];
    return vi.fn().mockImplementation(() => Promise.resolve(queue.shift()!));
  }
  return vi.fn().mockResolvedValue(response);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_USER = { login: 'futurator-bot', id: 12345, name: 'Futurator Bot', email: null };

const MOCK_REPO = {
  id: 999,
  name: 'dino6',
  full_name: 'futurator-repos/dino6',
  owner: { login: 'futurator-repos', id: 1 },
  private: true,
  description: null,
  default_branch: 'main',
  clone_url: 'https://github.com/futurator-repos/dino6.git',
  html_url: 'https://github.com/futurator-repos/dino6',
  is_template: false,
  pushed_at: '2026-04-28T00:00:00Z',
  created_at: '2026-04-28T00:00:00Z',
  updated_at: '2026-04-28T00:00:00Z',
};

const MOCK_TREE_ENTRIES = [
  { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'abc', size: 256, url: 'u' },
  { path: 'src', mode: '040000', type: 'tree', sha: 'def', url: 'u' },
];

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

// ===========================================================================
// githubFetch — low-level
// ===========================================================================

describe('githubFetch', () => {
  it('1. sends correct headers and returns data + rateLimit on 200', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ ok: true })));
    const { data, rateLimit } = await githubFetch<{ ok: boolean }>('/test');
    expect(data).toEqual({ ok: true });
    expect(rateLimit).toEqual(EXPECTED_RATE_LIMIT);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as string;
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(url).toBe('https://api.github.com/test');
    expect(headers['Authorization']).toBe('Bearer ghp_test_token_123');
    expect(headers['User-Agent']).toBe('Futurator-Admin-GitHub/1.0');
    expect(headers['Accept']).toBe('application/vnd.github.v3+json');
  });

  it('2. throws GitHubError on 401 with message from body', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Bad credentials' }, 401)));
    await expect(githubFetch('/test')).rejects.toMatchObject({
      status: 401,
      message: 'Bad credentials',
    });
  });

  it('3. throws GitHubError on 403 and exposes rateLimit', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'API rate limit exceeded' }, 403)));
    const err = await githubFetch('/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(403);
    expect((err as GitHubError).rateLimit).toEqual(EXPECTED_RATE_LIMIT);
  });

  it('4. throws GitHubError on 404', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Not Found' }, 404)));
    await expect(githubFetch('/repos/x/y')).rejects.toMatchObject({ status: 404 });
  });

  it('5. throws GitHubError on 500 using statusText when body.message absent', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(new Response('internal error', { status: 500, headers: RATE_LIMIT_HEADERS })),
    );
    const err = await githubFetch('/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(500);
  });

  it('6. handles 204 No Content without parsing body', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse(null, 204)));
    const { data, rateLimit } = await githubFetch<undefined>('/repos/x/y', { method: 'DELETE' });
    expect(data).toBeUndefined();
    expect(rateLimit).toEqual(EXPECTED_RATE_LIMIT);
  });

  it('7. throws GitHubError(401) when loadPat throws', async () => {
    vi.mocked(loadPat).mockImplementationOnce(() => {
      throw new Error('PAT not configured');
    });
    vi.stubGlobal('fetch', vi.fn());
    const err = await githubFetch('/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(401);
    expect((err as GitHubError).message).toContain('PAT not configured');
  });
});

// ===========================================================================
// getUser
// ===========================================================================

describe('getUser', () => {
  it('8. returns user data on success', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse(MOCK_USER)));
    const { data, rateLimit } = await getUser();
    expect(data.login).toBe('futurator-bot');
    expect(rateLimit).toEqual(EXPECTED_RATE_LIMIT);
  });

  it('9. throws GitHubError on 401', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Unauthorized' }, 401)));
    await expect(getUser()).rejects.toBeInstanceOf(GitHubError);
  });
});

// ===========================================================================
// checkConnection
// ===========================================================================

describe('checkConnection', () => {
  it('10. returns connected: true with login on success', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse(MOCK_USER)));
    const result = await checkConnection();
    expect(result.connected).toBe(true);
    expect(result.login).toBe('futurator-bot');
    expect(result.rateLimit).toEqual(EXPECTED_RATE_LIMIT);
  });

  it('11. returns connected: false with error on 401 — does not throw', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Bad credentials' }, 401)));
    const result = await checkConnection();
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/bad credentials/i);
    expect(result.rateLimit).toEqual(EXPECTED_RATE_LIMIT);
  });

  it('12. returns connected: false on PAT load failure — does not throw', async () => {
    vi.mocked(loadPat).mockImplementationOnce(() => {
      throw new Error('PAT not configured');
    });
    vi.stubGlobal('fetch', vi.fn());
    const result = await checkConnection();
    expect(result.connected).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ===========================================================================
// listRepos
// ===========================================================================

describe('listRepos', () => {
  it('13. returns merged repo list with rateLimit on single-page response', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse([MOCK_REPO])));
    const { data, rateLimit } = await listRepos();
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('dino6');
    expect(rateLimit).toEqual(EXPECTED_RATE_LIMIT);
  });

  it('14. auto-paginates using Link rel="next" header', async () => {
    const page1 = new Response(JSON.stringify([MOCK_REPO]), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...RATE_LIMIT_HEADERS,
        Link: `<https://api.github.com/orgs/futurator-repos/repos?page=2>; rel="next"`,
      },
    });
    const page2 = new Response(JSON.stringify([{ ...MOCK_REPO, id: 1000, name: 'dino7' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...RATE_LIMIT_HEADERS },
    });
    vi.stubGlobal('fetch', mockFetch([page1, page2]));
    const { data } = await listRepos();
    expect(data).toHaveLength(2);
    expect(data.map((r) => r.name)).toEqual(['dino6', 'dino7']);
  });

  it('15. throws GitHubError on 403', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Forbidden' }, 403)));
    await expect(listRepos()).rejects.toBeInstanceOf(GitHubError);
  });
});

// ===========================================================================
// getRepo
// ===========================================================================

describe('getRepo', () => {
  it('16. returns repo with default_branch on success', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse(MOCK_REPO)));
    const { data } = await getRepo('futurator-repos', 'dino6');
    expect(data.default_branch).toBe('main');
    expect(data.clone_url).toBe('https://github.com/futurator-repos/dino6.git');
    expect(data.is_template).toBe(false);
  });

  it('17. throws GitHubError(404) for a missing repo', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Not Found' }, 404)));
    const err = await getRepo('futurator-repos', 'nonexistent').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(404);
  });
});

// ===========================================================================
// getRepoTree
// ===========================================================================

describe('getRepoTree', () => {
  it('18. returns tree with count when branch provided', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(mockResponse({ sha: 'abc', url: 'u', tree: MOCK_TREE_ENTRIES, truncated: false })),
    );
    const { data } = await getRepoTree('futurator-repos', 'dino6', 'main');
    expect(data.tree).toHaveLength(2);
    expect(data.truncated).toBe(false);
    expect(data.count).toBe(2);
  });

  it('19. resolves default_branch via getRepo when branch omitted', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        mockResponse(MOCK_REPO),
        mockResponse({ sha: 'abc', url: 'u', tree: MOCK_TREE_ENTRIES, truncated: false }),
      ]),
    );
    const { data } = await getRepoTree('futurator-repos', 'dino6');
    expect(data.tree).toHaveLength(2);
  });

  it('20. returns truncated: true when GitHub truncates the tree', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(mockResponse({ sha: 'abc', url: 'u', tree: MOCK_TREE_ENTRIES, truncated: true })),
    );
    const { data } = await getRepoTree('futurator-repos', 'dino6', 'main');
    expect(data.truncated).toBe(true);
    expect(data.count).toBe(2);
  });

  it('21. throws GitHubError(404) when repo not found', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Not Found' }, 404)));
    await expect(getRepoTree('futurator-repos', 'ghost', 'main')).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ===========================================================================
// getFileContent
// ===========================================================================

describe('getFileContent', () => {
  it('22. decodes base64 content to utf-8 for small files', async () => {
    const rawContent = Buffer.from('hello world').toString('base64');
    vi.stubGlobal(
      'fetch',
      mockFetch(
        mockResponse({
          content: rawContent,
          encoding: 'base64',
          sha: 'sha1',
          size: 11,
          type: 'file',
        }),
      ),
    );
    const { data } = await getFileContent('futurator-repos', 'dino6', 'src/index.ts');
    if ('tooLarge' in data) throw new Error('Should not be tooLarge');
    expect(data.content).toBe('hello world');
    expect(data.encoding).toBe('utf-8');
    expect(data.sha).toBe('sha1');
    expect(data.size).toBe(11);
  });

  it('23. returns tooLarge: true for files > 1MB', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        mockResponse({
          content: '',
          encoding: 'base64',
          sha: 'sha2',
          size: 2_000_000,
          type: 'file',
        }),
      ),
    );
    const { data } = await getFileContent('futurator-repos', 'dino6', 'large.bin');
    expect(data).toEqual({ tooLarge: true, size: 2_000_000 });
  });

  it('24. throws GitHubError(404) for a missing file', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Not Found' }, 404)));
    await expect(
      getFileContent('futurator-repos', 'dino6', 'does-not-exist.ts'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ===========================================================================
// is422NameTaken (unit — no fetch needed)
// ===========================================================================

describe('is422NameTaken', () => {
  it('25. returns true for "name already exists on this account" in errors[]', () => {
    expect(is422NameTaken({ errors: [{ message: 'name already exists on this account' }] })).toBe(
      true,
    );
  });

  it('26. returns true for "name is already taken" in errors[]', () => {
    expect(is422NameTaken({ errors: [{ message: 'name is already taken' }] })).toBe(true);
  });

  it('27. returns true for name-taken pattern in top-level message fallback', () => {
    expect(is422NameTaken({ message: 'Name already exists on this account' })).toBe(true);
  });

  it('28. returns false for an unrelated 422 body', () => {
    expect(
      is422NameTaken({
        message: 'Repository creation failed.',
        errors: [{ message: 'invalid slug' }],
      }),
    ).toBe(false);
  });
});

// ===========================================================================
// createRepoFromTemplate
// ===========================================================================

describe('createRepoFromTemplate', () => {
  it('29. returns GitHubRepo data on 201 success', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse(MOCK_REPO, 201)));
    const { data, rateLimit } = await createRepoFromTemplate(
      'futurator-repos',
      'template-nextjs',
      'dino6',
    );
    expect('existing' in data).toBe(false);
    if (!('existing' in data)) {
      expect(data.name).toBe('dino6');
      expect(data.default_branch).toBe('main');
      expect(data.clone_url).toContain('dino6');
    }
    expect(rateLimit).toEqual(EXPECTED_RATE_LIMIT);
  });

  it('30. returns { existing: true, repo } on 422 "name already exists" — saga idempotency', async () => {
    const body422 = {
      message: 'Repository creation failed.',
      errors: [{ message: 'name already exists on this account' }],
    };
    vi.stubGlobal(
      'fetch',
      mockFetch([
        mockResponse(body422, 422),
        mockResponse(MOCK_REPO, 200), // getRepo fallback
      ]),
    );
    const { data } = await createRepoFromTemplate('futurator-repos', 'template-nextjs', 'dino6');
    expect('existing' in data).toBe(true);
    if ('existing' in data) {
      expect(data.existing).toBe(true);
      expect(data.repo.name).toBe('dino6');
    }
  });

  it('31. throws GitHubError on 422 with a generic (non-name-taken) body', async () => {
    const body422 = {
      message: 'Validation Failed',
      errors: [{ message: 'is not a valid value for field slug' }],
    };
    vi.stubGlobal('fetch', mockFetch(mockResponse(body422, 422)));
    const err = await createRepoFromTemplate(
      'futurator-repos',
      'template-nextjs',
      'INVALID-SLUG',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(422);
  });

  it('32. throws GitHubError(401) on bad credentials', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Bad credentials' }, 401)));
    await expect(
      createRepoFromTemplate('futurator-repos', 'template-nextjs', 'dino6'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('33. throws GitHubError(401) when loadPat fails', async () => {
    vi.mocked(loadPat).mockImplementationOnce(() => {
      throw new Error('PAT not configured');
    });
    vi.stubGlobal('fetch', vi.fn());
    const err = await createRepoFromTemplate('futurator-repos', 'template-nextjs', 'dino6').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(401);
  });
});

// ===========================================================================
// deleteRepo
// ===========================================================================

describe('deleteRepo', () => {
  it('34. returns { deleted: true } on 204 No Content', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse(null, 204)));
    const { data } = await deleteRepo('futurator-repos', 'dino6');
    expect(data.deleted).toBe(true);
  });

  it('35. throws GitHubError(404) when repo does not exist', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Not Found' }, 404)));
    await expect(deleteRepo('futurator-repos', 'ghost')).rejects.toMatchObject({ status: 404 });
  });
});

// ===========================================================================
// markPullRequestReadyForReview (GraphQL)
// ===========================================================================

describe('markPullRequestReadyForReview', () => {
  it('36. returns true when the mutation clears draft (isDraft=false)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        mockResponse({
          data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
        }),
      ),
    );
    expect(await markPullRequestReadyForReview('PR_node_1')).toBe(true);
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain('/graphql');
  });

  it('37. treats "already ready" GraphQL errors as success (idempotent)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(mockResponse({ errors: [{ message: 'Pull request is not a draft' }] })),
    );
    expect(await markPullRequestReadyForReview('PR_node_1')).toBe(true);
  });

  it('38. returns false (non-fatal) on a network/HTTP failure', async () => {
    vi.stubGlobal('fetch', mockFetch(mockResponse({ message: 'Bad credentials' }, 401)));
    expect(await markPullRequestReadyForReview('PR_node_1')).toBe(false);
  });
});
