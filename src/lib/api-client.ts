import { API_BASE_URL } from './constants';
import { useAuthStore } from '@/stores/auth-store';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private refreshPromise: Promise<boolean> | null = null;

  private getAuthHeaders(): Record<string, string> {
    const token = useAuthStore.getState().getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // Proactively refresh if token expires within 2 minutes
  private async ensureFreshToken(): Promise<void> {
    const { tokens } = useAuthStore.getState();
    if (!tokens?.expiresAt) return;
    const timeLeft = tokens.expiresAt - Date.now();
    if (timeLeft > 120_000) return; // more than 2 min left, fine
    if (timeLeft < 0) {
      // Already expired — try refresh
      await this.tryRefresh();
    } else {
      // Expiring soon — refresh proactively
      if (!this.refreshPromise) {
        this.refreshPromise = this.tryRefresh().finally(() => {
          this.refreshPromise = null;
        });
      }
      await this.refreshPromise;
    }
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
      const refreshed = await this.tryRefresh();
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

  private async tryRefresh(): Promise<boolean> {
    const { tokens, updateTokens } = useAuthStore.getState();
    if (!tokens?.refreshToken) return false;

    try {
      const response = await fetch(`${this.baseUrl}/auth/refresh`, {
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

  get<T>(path: string) {
    return this.fetch<T>(path);
  }

  post<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  put<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  delete<T>(path: string) {
    return this.fetch<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient(API_BASE_URL);
