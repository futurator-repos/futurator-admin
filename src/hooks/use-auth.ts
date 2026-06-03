'use client';
import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { refreshTokens } from '@/lib/auth-refresh';
import { startSessionKeepalive } from '@/lib/session-keepalive';

export function useAuth() {
  const { user, isAuthenticated, isLoading, setAuth, setUser } = useAuthStore();

  useEffect(() => {
    if (!isLoading) return;
    let cancelled = false;

    (async () => {
      try {
        const storedTokens = localStorage.getItem('futurator_tokens');
        const storedUser = localStorage.getItem('futurator_user');
        if (storedTokens && storedUser) {
          const tokens = JSON.parse(storedTokens);
          const savedUser = JSON.parse(storedUser);

          // Access token still valid — restore directly.
          if (tokens.expiresAt > Date.now()) {
            setAuth(savedUser, {
              ...tokens,
              expiresIn: Math.floor((tokens.expiresAt - Date.now()) / 1000),
            });
            startSessionKeepalive();
            return;
          }

          // Access token expired, but the rotating refresh token may still be
          // valid (30-day rolling window). Try to refresh before logging the
          // user out — this is the case that used to dump them on /login
          // mid-debate. Seed the store first so refreshTokens() can read the
          // refresh token; keep isLoading=true so AuthGuard shows the spinner
          // (not a login redirect) while the refresh is in flight.
          if (tokens.refreshToken) {
            useAuthStore.setState({ user: savedUser, tokens, isAuthenticated: true });
            const ok = await refreshTokens();
            if (cancelled) return;
            if (ok) {
              useAuthStore.setState({ user: savedUser, isAuthenticated: true, isLoading: false });
              startSessionKeepalive();
              return;
            }
          }
        }
      } catch {
        /* ignore parse errors — fall through to logged-out */
      }
      if (!cancelled) setUser(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoading, setAuth, setUser]);

  return { user, isAuthenticated, isLoading };
}
