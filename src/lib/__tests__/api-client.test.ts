import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';

// Control the reactive refresh so the 401 branch is deterministic.
vi.mock('../auth-refresh', () => ({ refreshTokens: vi.fn() }));
import { refreshTokens } from '../auth-refresh';
import { api } from '../api-client';

const refreshMock = vi.mocked(refreshTokens);

/** Minimal Response stand-in whose body is re-readable via clone(). */
function jsonResponse(status: number, body: unknown): Response {
  const make = () =>
    ({
      status,
      ok: status >= 200 && status < 300,
      clone: () => make(),
      json: async () => body,
    }) as unknown as Response;
  return make();
}

function seedSession() {
  // jsdom can't navigate; replace location so the logout redirect is a no-op.
  Object.defineProperty(window, 'location', {
    value: { href: '' },
    writable: true,
    configurable: true,
  });
  useAuthStore.setState({
    user: { id: 'u1', email: 'op@example.com' } as never,
    isAuthenticated: true,
    isLoading: false,
    // far-future expiry so ensureFreshToken() does NOT pre-refresh
    tokens: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      familyId: 'fam-1',
      tokenId: 'tok-1',
      expiresAt: Date.now() + 600_000,
    },
    logout: vi.fn(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  refreshMock.mockReset();
  useAuthStore.setState({ user: null, tokens: null, isAuthenticated: false, isLoading: true });
});

describe('api-client 401 handling', () => {
  it('does NOT log out on a relayed (non-session) 401 — surfaces the real error', async () => {
    seedSession();
    const logout = useAuthStore.getState().logout;
    // A GitHub-connector failure the route relayed: plain string `error`, no code.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Bad credentials' })),
    );

    await expect(api.get('/github/repos/futurator-repos/pacman1')).rejects.toThrow(
      'Bad credentials',
    );
    expect(logout).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('logs out on a genuine session 401 (AUTH_EXPIRED) when refresh fails', async () => {
    seedSession();
    const logout = useAuthStore.getState().logout;
    refreshMock.mockResolvedValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'AUTH_EXPIRED' } })),
    );

    await expect(api.get('/projects')).rejects.toThrow('Unauthorized');
    expect(refreshMock).toHaveBeenCalled();
    expect(logout).toHaveBeenCalled();
  });

  it('recovers a session 401 when refresh succeeds and the retry is ok', async () => {
    seedSession();
    const logout = useAuthStore.getState().logout;
    refreshMock.mockResolvedValue(true);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_EXPIRED' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.get('/projects')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logout).not.toHaveBeenCalled();
  });
});
