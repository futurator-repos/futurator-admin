import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth-refresh', () => ({
  refreshTokens: vi.fn().mockResolvedValue(true),
}));

import { refreshTokens } from '../auth-refresh';
import { startSessionKeepalive, stopSessionKeepalive } from '../session-keepalive';
import { useAuthStore } from '@/stores/auth-store';

function setTokens(expiresAt: number | null) {
  useAuthStore.setState({
    tokens: expiresAt
      ? {
          accessToken: 'a',
          refreshToken: 'r',
          familyId: 'f',
          tokenId: 't',
          expiresAt,
        }
      : null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopSessionKeepalive();
  vi.clearAllMocks();
  vi.useRealTimers();
  useAuthStore.setState({ tokens: null });
});

describe('session-keepalive', () => {
  it('refreshes ~1 min before the access token expires, not before', () => {
    setTokens(Date.now() + 100_000); // expires in 100s → refresh at lead (40s in)
    startSessionKeepalive();

    vi.advanceTimersByTime(39_000);
    expect(refreshTokens).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000); // cross the 40s lead boundary
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('does not arm when there is no refresh token', () => {
    setTokens(null);
    startSessionKeepalive();
    vi.advanceTimersByTime(10 * 60_000);
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('re-arms against the new expiry when tokens are refreshed/updated', () => {
    setTokens(Date.now() + 100_000);
    startSessionKeepalive();
    expect(refreshTokens).not.toHaveBeenCalled();

    // Simulate a fresh login/refresh extending expiry far into the future;
    // the old 40s timer must be replaced so it does not fire early.
    setTokens(Date.now() + 3_600_000);
    vi.advanceTimersByTime(50_000);
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('stops cleanly — no refresh after stopSessionKeepalive', () => {
    setTokens(Date.now() + 100_000);
    startSessionKeepalive();
    stopSessionKeepalive();
    vi.advanceTimersByTime(10 * 60_000);
    expect(refreshTokens).not.toHaveBeenCalled();
  });
});
