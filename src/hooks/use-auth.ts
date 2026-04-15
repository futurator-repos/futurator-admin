'use client';
import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth-store';

export function useAuth() {
  const { user, isAuthenticated, isLoading, setAuth, setUser } = useAuthStore();

  useEffect(() => {
    if (!isLoading) return;

    // Restore session from localStorage
    try {
      const storedTokens = localStorage.getItem('futurator_tokens');
      const storedUser = localStorage.getItem('futurator_user');
      if (storedTokens && storedUser) {
        const tokens = JSON.parse(storedTokens);
        const savedUser = JSON.parse(storedUser);
        if (tokens.expiresAt > Date.now()) {
          setAuth(savedUser, {
            ...tokens,
            expiresIn: Math.floor((tokens.expiresAt - Date.now()) / 1000),
          });
          return;
        }
      }
    } catch {
      /* ignore parse errors */
    }

    setUser(null);
  }, [isLoading, setAuth, setUser]);

  return { user, isAuthenticated, isLoading };
}
