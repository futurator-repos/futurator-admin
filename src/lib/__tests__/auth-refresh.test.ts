import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshTokens } from '../auth-refresh';
import { useAuthStore } from '@/stores/auth-store';

function seedTokens(over: Partial<Record<string, unknown>> = {}) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'op@example.com' } as never,
    isAuthenticated: true,
    isLoading: false,
    tokens: {
      accessToken: 'old-access',
      refreshToken: 'refresh-1',
      familyId: 'fam-1',
      tokenId: 'tok-1',
      expiresAt: Date.now() + 1000,
      ...over,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useAuthStore.setState({ user: null, tokens: null, isAuthenticated: false, isLoading: true });
});

describe('refreshTokens', () => {
  it('returns false without calling the network when there is no refresh token', async () => {
    useAuthStore.setState({ tokens: null });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await refreshTokens()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('updates the store with the fresh token pair on success', async () => {
    seedTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          accessToken: 'new-access',
          refreshToken: 'refresh-2',
          familyId: 'fam-1',
          tokenId: 'tok-2',
          expiresIn: 3600,
        }),
      }),
    );
    expect(await refreshTokens()).toBe(true);
    const t = useAuthStore.getState().tokens;
    expect(t?.accessToken).toBe('new-access');
    expect(t?.refreshToken).toBe('refresh-2');
    expect(t?.tokenId).toBe('tok-2');
  });

  it('returns false and leaves tokens intact when the broker rejects the refresh', async () => {
    seedTokens();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await refreshTokens()).toBe(false);
    expect(useAuthStore.getState().tokens?.accessToken).toBe('old-access');
  });

  it('is single-flight — concurrent callers share one network request', async () => {
    seedTokens();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: 'new-access',
        refreshToken: 'refresh-2',
        familyId: 'fam-1',
        tokenId: 'tok-2',
        expiresIn: 3600,
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const [a, b] = await Promise.all([refreshTokens(), refreshTokens()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
