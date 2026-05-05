# Develope-IT Mobile — Auth Module (Drop-In)

> Copy-pasteable TypeScript that mirrors `admin.futurator.ai`'s `src/lib/api-client.ts`
> and `src/stores/auth-store.ts`, adapted for React Native / Expo:
>
> - `expo-secure-store` instead of `localStorage`
> - Bearer tokens, no cookies (cross-domain → cookies wouldn't work anyway)
> - Hydration on app boot (mobile cold-starts; web didn't)
> - Concurrent-refresh dedupe (web inherited from the admin pattern)
> - 401 → refresh → retry once → bounce to login
>
> **Auth strategy for MVP: email/password against the Identity Broker directly.**
> No deep links, no OAuth callback handling, no app registration changes — works
> in Expo Go on day one. OAuth (Google/GitHub) is a future upgrade documented at
> the bottom.

---

## 1. Install dependencies

```bash
npx expo install expo-secure-store
npm install zustand
```

That's it. No `@react-native-async-storage/async-storage`, no `aws-amplify`, no `amazon-cognito-identity-js`.

## 2. Environment

Create `.env` (and load via `expo-constants` or `react-native-dotenv` — your call):

```bash
# Identity Broker — same broker the admin hub uses
EXPO_PUBLIC_BROKER_URL=https://uyocidd3ll.execute-api.us-east-1.amazonaws.com/v1

# Admin Lambda Function URL (verified live, us-east-1)
EXPO_PUBLIC_API_BASE=https://rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1.on.aws
```

Two things to note:
- **No `clientId`/`clientSecret` in the mobile app.** Email/password login doesn't need them. (OAuth would, and that's why we're punting OAuth — never ship a `clientSecret` in a mobile bundle.)
- **Use the prod broker URL above.** Dev broker (`vnfmz85xj1`) talks to a different DDB and won't validate tokens for the prod admin Lambda.

## 3. Files to drop into the mobile repo

### `src/auth/types.ts`

```ts
export interface User {
  userId: string;
  email: string;
  name?: string;
  tenantId?: string;
  role?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  familyId: string;
  tokenId: string;
  expiresAt: number; // epoch ms; computed from expiresIn at store time
}

// Shape the broker returns from /auth/login and /auth/refresh
export interface BrokerTokenResponse {
  accessToken: string;
  refreshToken: string;
  familyId: string;
  tokenId: string;
  expiresIn: number; // seconds
  user?: User;
}
```

### `src/auth/storage.ts`

```ts
import * as SecureStore from 'expo-secure-store';
import type { TokenSet, User } from './types';

const TOKENS_KEY = 'futuratorit_tokens';
const USER_KEY = 'futuratorit_user';

// SecureStore values are strings; we JSON-encode on the way in/out.
// SecureStore is unavailable on web — guard if you ever run this in Expo Web.

export async function loadTokens(): Promise<TokenSet | null> {
  const raw = await SecureStore.getItemAsync(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenSet;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: TokenSet): Promise<void> {
  await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens));
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKENS_KEY);
}

export async function loadUser(): Promise<User | null> {
  const raw = await SecureStore.getItemAsync(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export async function saveUser(user: User): Promise<void> {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function clearUser(): Promise<void> {
  await SecureStore.deleteItemAsync(USER_KEY);
}
```

### `src/auth/store.ts`

```ts
import { create } from 'zustand';
import type { BrokerTokenResponse, TokenSet, User } from './types';
import { clearTokens, clearUser, loadTokens, loadUser, saveTokens, saveUser } from './storage';

interface AuthState {
  user: User | null;
  tokens: TokenSet | null;
  isAuthenticated: boolean;
  isHydrating: boolean; // true until SecureStore is read on cold start

  hydrate: () => Promise<void>;
  setAuth: (user: User, tokenResponse: BrokerTokenResponse) => Promise<void>;
  updateTokens: (tokenResponse: BrokerTokenResponse) => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => string | null;
}

function toTokenSet(r: BrokerTokenResponse): TokenSet {
  return {
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    familyId: r.familyId,
    tokenId: r.tokenId,
    expiresAt: Date.now() + r.expiresIn * 1000,
  };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  tokens: null,
  isAuthenticated: false,
  isHydrating: true,

  hydrate: async () => {
    const [tokens, user] = await Promise.all([loadTokens(), loadUser()]);
    set({
      tokens,
      user,
      isAuthenticated: !!tokens && !!user,
      isHydrating: false,
    });
  },

  setAuth: async (user, tokenResponse) => {
    const tokens = toTokenSet(tokenResponse);
    await Promise.all([saveTokens(tokens), saveUser(user)]);
    set({ user, tokens, isAuthenticated: true });
  },

  updateTokens: async (tokenResponse) => {
    const tokens = toTokenSet(tokenResponse);
    await saveTokens(tokens);
    set({ tokens });
  },

  logout: async () => {
    await Promise.all([clearTokens(), clearUser()]);
    set({ user: null, tokens: null, isAuthenticated: false });
  },

  getAccessToken: () => get().tokens?.accessToken ?? null,
}));
```

### `src/auth/api-client.ts`

```ts
import { useAuthStore } from './store';
import type { BrokerTokenResponse } from './types';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE!;
const BROKER_URL = process.env.EXPO_PUBLIC_BROKER_URL!;

if (!API_BASE) throw new Error('EXPO_PUBLIC_API_BASE not set');
if (!BROKER_URL) throw new Error('EXPO_PUBLIC_BROKER_URL not set');

export class ApiError extends Error {
  status: number;
  code?: string;
  correlationId?: string | null;
  constructor(message: string, status: number, code?: string, correlationId?: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

class ApiClient {
  private baseUrl: string;
  private refreshPromise: Promise<boolean> | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    const token = useAuthStore.getState().getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // Refresh proactively if token expires within 2 minutes.
  // Multiple parallel callers share the same in-flight refresh promise.
  private async ensureFreshToken(): Promise<void> {
    const tokens = useAuthStore.getState().tokens;
    if (!tokens) return;
    const timeLeft = tokens.expiresAt - Date.now();
    if (timeLeft > 120_000) return;

    if (!this.refreshPromise) {
      this.refreshPromise = this.tryRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  private async tryRefresh(): Promise<boolean> {
    const { tokens, updateTokens } = useAuthStore.getState();
    if (!tokens?.refreshToken) return false;

    try {
      // IMPORTANT: refresh hits the BROKER, not the admin Lambda.
      // The admin Lambda's /api/auth/refresh proxies to the same broker;
      // calling broker directly avoids one extra network hop.
      const res = await fetch(`${BROKER_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: tokens.refreshToken,
          familyId: tokens.familyId,
          tokenId: tokens.tokenId,
        }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as BrokerTokenResponse;
      await updateTokens(data);
      return true;
    } catch {
      return false;
    }
  }

  async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    await this.ensureFreshToken();

    const doFetch = () =>
      fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
          ...(options.headers ?? {}),
        },
      });

    let response = await doFetch();

    if (response.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        response = await doFetch();
      }
      if (response.status === 401) {
        await useAuthStore.getState().logout();
        throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED');
      }
    }

    if (!response.ok) {
      const correlationId = response.headers.get('X-Correlation-Id');
      const parsed = await response.json().catch(() => null as unknown);
      const message =
        (parsed as { error?: { message?: string } })?.error?.message ??
        (parsed as { detail?: string })?.detail ??
        `Request failed (${response.status})`;
      const code = (parsed as { error?: { code?: string } })?.error?.code;
      throw new ApiError(message, response.status, code, correlationId);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  get<T>(path: string) {
    return this.fetch<T>(path);
  }
  post<T>(path: string, body?: unknown) {
    return this.fetch<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  }
  put<T>(path: string, body?: unknown) {
    return this.fetch<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
  }
  patch<T>(path: string, body?: unknown) {
    return this.fetch<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
  }
  delete<T>(path: string) {
    return this.fetch<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient(API_BASE);
```

### `src/auth/login.ts`

```ts
import { useAuthStore } from './store';
import type { BrokerTokenResponse, User } from './types';

const BROKER_URL = process.env.EXPO_PUBLIC_BROKER_URL!;

interface LoginResponse extends BrokerTokenResponse {
  user: User;
}

export async function loginWithEmail(email: string, password: string): Promise<User> {
  const res = await fetch(`${BROKER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}));
    throw new Error(parsed.detail ?? parsed.title ?? `Login failed (${res.status})`);
  }

  const data = (await res.json()) as LoginResponse;
  await useAuthStore.getState().setAuth(data.user, data);
  return data.user;
}

export async function logout(): Promise<void> {
  // Best-effort broker logout; clear local state regardless.
  const tokens = useAuthStore.getState().tokens;
  if (tokens?.accessToken) {
    await fetch(`${BROKER_URL}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }).catch(() => {});
  }
  await useAuthStore.getState().logout();
}
```

### `src/auth/AuthGate.tsx`

```tsx
import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useAuthStore } from './store';

interface Props {
  children: ReactNode;
  loginScreen: ReactNode;
}

export function AuthGate({ children, loginScreen }: Props) {
  const { isHydrating, isAuthenticated, hydrate } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (isHydrating) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return <>{isAuthenticated ? children : loginScreen}</>;
}
```

## 4. Wire it into the app

`app/_layout.tsx` (Expo Router) or your root component:

```tsx
import { AuthGate } from '@/src/auth/AuthGate';
import { LoginScreen } from '@/src/screens/LoginScreen';
import { Slot } from 'expo-router';

export default function RootLayout() {
  return (
    <AuthGate loginScreen={<LoginScreen />}>
      <Slot />
    </AuthGate>
  );
}
```

Sample `LoginScreen`:

```tsx
import { useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { loginWithEmail } from '@/src/auth/login';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      await loginWithEmail(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: '600' }}>Sign in</Text>
      <TextInput
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        style={{ borderWidth: 1, padding: 12, borderRadius: 8 }}
      />
      <TextInput
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        style={{ borderWidth: 1, padding: 12, borderRadius: 8 }}
      />
      {error && <Text style={{ color: 'red' }}>{error}</Text>}
      <Button title={loading ? 'Signing in…' : 'Sign in'} onPress={onSubmit} disabled={loading} />
    </View>
  );
}
```

## 5. Use the API client

```ts
import { api } from '@/src/auth/api-client';

// Create a plan + start the PM job (replaces createEpic)
const { planId, pmJobId, plan } = await api.post<{
  planId: string;
  pmJobId: string;
  plan: Plan;
}>('/api/plans/from-intent', {
  name: 'recipe-converter',
  intent: 'Build me a recipe converter with unit toggles and favorites',
});

// Poll the PM job's events
const { events, lastSeq } = await api.get<{ events: AgentEvent[]; lastSeq: string }>(
  `/api/agent-jobs/${pmJobId}/events?after=${cursor}`,
);

// Poll job status (the "pm_complete" workaround)
const job = await api.get<{ status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' }>(
  `/api/agent-jobs/${pmJobId}`,
);

// List plans
const plans = await api.get<PlanSummary[]>('/api/plans');
```

The auth header, refresh, and retry are all handled. Callers only see clean
typed responses or `ApiError`.

## 6. Sanity checklist before flipping LIVE

- [ ] `.env` has `EXPO_PUBLIC_BROKER_URL` and `EXPO_PUBLIC_API_BASE` set to the values in §2.
- [ ] `expo-secure-store` installed via `npx expo install` (not plain `npm install` — needs the right native version).
- [ ] `AuthGate` wraps the app at the root and shows loading → login → app.
- [ ] User account exists in the broker. If not, register one once via:
      `curl -X POST $BROKER/auth/register -H 'Content-Type: application/json' -d '{"email":"...","password":"...","name":"..."}'`
      then verify via the email code with `POST /auth/verify-email`.
- [ ] After login, `useAuthStore.getState().tokens.accessToken` is populated — confirm in a debug screen before making API calls.
- [ ] First API call (e.g., `GET /api/plans`) returns 200 with an array (possibly empty — DDB was wiped 2026-04-21 and may still be sparse).

## 7. Gotchas (mobile-specific)

- **Cold start always shows the loading spinner** while SecureStore reads. Don't render anything that calls the API before `isHydrating` flips to false.
- **`expo-secure-store` requires a development build OR Expo Go.** Both work for MVP. EAS Build is fine when you're ready.
- **Tokens persist across app restarts** — that's the whole point of SecureStore. To force a fresh login during dev, call `useAuthStore.getState().logout()` from a debug button.
- **The 30-second refresh grace period** (broker docs §8) means concurrent refresh calls are safe. The `refreshPromise` dedupe in `api-client.ts` makes this even safer — only one refresh request flies at a time per app instance.
- **`AppState` background/foreground:** when the app foregrounds after a long backgrounded period, the access token may already be expired. The proactive-refresh check in `ensureFreshToken` catches that on the next API call. No extra wiring needed.
- **Token revocation cascade:** if the broker revokes the token family (security event, e.g., reused-token detection), every subsequent refresh fails → `api-client` calls `logout()` → user lands on login screen. No silent bricking.
- **Network errors look like `ApiError` with `status === 0`** — they don't, actually; `fetch` throws on network failure. Wrap your API calls in try/catch and treat thrown errors as "network down, retry".

## 8. OAuth (future, not for MVP)

When you want Google/GitHub login (e.g., to onboard external users without making them set a password), the flow is:

1. `npx expo install expo-web-browser expo-linking`
2. Add a deep-link scheme in `app.json`: `"scheme": "futuratorit"`.
3. Register the deep link with the broker:
   ```bash
   curl -X PUT $BROKER/apps/futurator-admin \
     -H "X-Registration-Key: $REG_KEY" \
     -H "Content-Type: application/json" \
     -d '{"redirectUris":["https://admin.futurator.ai/auth/callback","futuratorit://auth/callback","http://localhost:3000/auth/callback"]}'
   ```
   (Production-first ordering preserved; mobile slides into second slot.)
4. In the app, open the broker URL with `WebBrowser.openAuthSessionAsync` and pass `redirect_uri=futuratorit://auth/callback`.
5. Capture the resulting URL via `Linking.parse`, extract `?code=otp_...`.
6. Call **the admin Lambda's** `POST /api/auth/exchange` with `{ code }`. The admin Lambda holds the `clientSecret` server-side. **Never** call the broker's `/auth/oauth/exchange` directly from the mobile app — that would require shipping `clientSecret` in the bundle.
7. Receive the same `BrokerTokenResponse` shape, call `setAuth(user, tokens)`, done.

The rest of the auth pipeline (storage, refresh, 401 handling) is identical. You're swapping one login function for another.

---

*Reference implementations in admin repo:*
- `src/lib/api-client.ts` — proactive refresh + 401 retry
- `src/stores/auth-store.ts` — Zustand pattern (web variant uses `localStorage`; this doc replaces with SecureStore)
- `functions/api/index.ts:126-198` — server-side OAuth exchange + refresh proxy (only relevant if you go OAuth later)
- `docs/concepts/identity-broker-quick-guide.md` — full broker API reference
