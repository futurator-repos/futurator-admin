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

    if (!response.ok) {
      const parsed = await response
        .json()
        .catch(() => ({ error: { code: 'UNKNOWN', message: 'Request failed' } }));
      const err = new Error(parsed.error?.message || 'Request failed') as Error & {
        code?: string;
        status?: number;
      };
      err.code = parsed.error?.code;
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
