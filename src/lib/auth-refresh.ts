import { API_BASE_URL } from './constants';
import { useAuthStore } from '@/stores/auth-store';

const baseUrl = API_BASE_URL.replace(/\/+$/, '');

let refreshPromise: Promise<boolean> | null = null;

/**
 * Single-flight token refresh. Exchanges the stored rotating refresh token for
 * a fresh access+refresh pair via `POST /api/auth/refresh` and updates the
 * auth store. All three callers share one in-flight request:
 *   1. the api-client (proactive refresh + 401 retry)
 *   2. the session-keepalive timer (refresh before idle expiry)
 *   3. the on-restore path in use-auth (expired access token, valid refresh)
 *
 * Returns `true` on success, `false` if there's no refresh token or the broker
 * rejects it (genuinely expired — the 30-day refresh window has lapsed).
 */
export function refreshTokens(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function doRefresh(): Promise<boolean> {
  const { tokens, updateTokens } = useAuthStore.getState();
  if (!tokens?.refreshToken) return false;

  try {
    const response = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: tokens.refreshToken,
        familyId: tokens.familyId,
        tokenId: tokens.tokenId,
      }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    updateTokens(data);
    return true;
  } catch {
    return false;
  }
}
