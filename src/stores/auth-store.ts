import { create } from 'zustand';
import type { User } from '@/types/auth';

interface TokenState {
  accessToken: string;
  refreshToken: string;
  familyId: string;
  tokenId: string;
  expiresAt: number;
}

interface AuthStore {
  user: User | null;
  tokens: TokenState | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  setAuth: (user: User, tokens: Omit<TokenState, 'expiresAt'> & { expiresIn: number }) => void;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  updateTokens: (tokens: Omit<TokenState, 'expiresAt'> & { expiresIn: number }) => void;
  logout: () => void;
  getAccessToken: () => string | null;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  tokens: null,
  isAuthenticated: false,
  isLoading: true,
  setAuth: (user, { expiresIn, ...rest }) => {
    const tokens = { ...rest, expiresAt: Date.now() + expiresIn * 1000 };
    localStorage.setItem('futurator_tokens', JSON.stringify(tokens));
    localStorage.setItem('futurator_user', JSON.stringify(user));
    set({ user, tokens, isAuthenticated: true, isLoading: false });
  },
  setUser: (user) => set({ user, isAuthenticated: !!user, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
  updateTokens: ({ expiresIn, ...rest }) => {
    const tokens = { ...rest, expiresAt: Date.now() + expiresIn * 1000 };
    localStorage.setItem('futurator_tokens', JSON.stringify(tokens));
    set({ tokens });
  },
  logout: () => {
    localStorage.removeItem('futurator_tokens');
    localStorage.removeItem('futurator_user');
    set({ user: null, tokens: null, isAuthenticated: false, isLoading: false });
  },
  getAccessToken: () => get().tokens?.accessToken || null,
}));
