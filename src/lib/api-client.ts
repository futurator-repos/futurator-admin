import { API_BASE_URL } from './constants';
import { useAuthStore } from '@/stores/auth-store';
import { refreshTokens } from './auth-refresh';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private getAuthHeaders(): Record<string, string> {
    const token = useAuthStore.getState().getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // Proactively refresh if the token expires within 2 minutes. Single-flight
  // dedup lives in refreshTokens(), shared with the keepalive timer.
  private async ensureFreshToken(): Promise<void> {
    const { tokens } = useAuthStore.getState();
    if (!tokens?.expiresAt) return;
    const timeLeft = tokens.expiresAt - Date.now();
    if (timeLeft > 120_000) return; // more than 2 min left, fine
    await refreshTokens();
  }

  async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    // Proactive refresh before the request
    await this.ensureFreshToken();

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
        ...options?.headers,
      },
    });

    if (response.status === 401) {
      // Distinguish a genuine session 401 (authMiddleware: AUTH_REQUIRED /
      // AUTH_EXPIRED) from a 401 a route RELAYED from an upstream — e.g. the
      // GitHub connector when the *backend* PAT can't read a repo. Only the
      // former means "this user's session is dead". Blanket-logging-out on the
      // latter turfed the operator to Google sign-in whenever the server-side
      // GitHub PAT hiccuped (e.g. right after a PAT rotation, 2026-06-16).
      // Session 401s carry `error.code`; relayed ones return a plain string
      // `error`. Unreadable body → assume session (preserves prior behavior).
      const isSessionError = await response
        .clone()
        .json()
        .then((b) => {
          const code = b?.error?.code;
          return code === 'AUTH_REQUIRED' || code === 'AUTH_EXPIRED';
        })
        .catch(() => true);

      if (isSessionError) {
        // Try refresh before giving up
        const refreshed = await refreshTokens();
        if (refreshed) {
          const retry = await fetch(`${this.baseUrl}${path}`, {
            ...options,
            headers: {
              'Content-Type': 'application/json',
              ...this.getAuthHeaders(),
              ...options?.headers,
            },
          });
          if (retry.ok) return retry.json();
        }
        useAuthStore.getState().logout();
        window.location.href = '/login';
        throw new Error('Unauthorized');
      }
      // Non-session 401: fall through to the generic error path below so the
      // caller can render the real reason without nuking the session.
    }

    if (!response.ok) {
      const parsed = await response
        .json()
        .catch(() => ({ error: { code: 'UNKNOWN', message: 'Request failed' } }));
      // Some routes return `{ error: { code, message } }`, others a plain
      // `{ error: "message" }` string (e.g. qa-review's no-visual-tests 400).
      // Accept both so callers can render the real reason instead of the
      // generic 'Request failed' (dragon1 2026-06-10: Re-run QA looked like
      // a silent no-op because the string form fell through to the generic).
      const message =
        typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || 'Request failed';
      const err = new Error(message) as Error & {
        code?: string;
        status?: number;
      };
      err.code = typeof parsed.error === 'string' ? undefined : parsed.error?.code;
      err.status = response.status;
      throw err;
    }

    return response.json();
  }

  get<T>(path: string) {
    return this.fetch<T>(path);
  }

  post<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  put<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  delete<T>(path: string) {
    return this.fetch<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient(API_BASE_URL);
