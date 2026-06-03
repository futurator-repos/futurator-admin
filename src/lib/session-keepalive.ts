import { useAuthStore } from '@/stores/auth-store';
import { refreshTokens } from './auth-refresh';

/**
 * Background session keepalive.
 *
 * The access token lives 1h; the proactive refresh in api-client only fires
 * when a request is made. On a page like Debates, polling stops once a turn
 * finishes — so while the user reads and composes a reply, zero requests fire
 * and the token silently expires, ending in a logout that destroys the draft.
 *
 * This schedules a refresh shortly before the access token's hard expiry,
 * independent of any API activity, and re-arms whenever the stored expiry
 * changes (after a refresh or a fresh login). The 30-day rotating refresh
 * token means this keeps the operator logged in across multi-hour debates and
 * up to ~30 days between actual Google logins.
 */

const REFRESH_LEAD_MS = 60_000; // refresh 1 min before hard expiry
const MIN_DELAY_MS = 5_000; // floor — guards against clock skew hot-looping

let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let lastExpiresAt: number | null = null;

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function arm(): void {
  clearTimer();
  const { tokens } = useAuthStore.getState();
  if (!tokens?.expiresAt || !tokens.refreshToken) return;
  const delay = Math.max(MIN_DELAY_MS, tokens.expiresAt - Date.now() - REFRESH_LEAD_MS);
  timer = setTimeout(() => {
    // A successful refresh updates the store, which re-arms via the
    // subscription below with the new (far-future) expiry. Re-arm here too so
    // a failed/transient refresh retries near the lead window instead of
    // giving up until the next request.
    void refreshTokens();
    arm();
  }, delay);
}

/** Idempotent — safe to call on every authenticated mount. */
export function startSessionKeepalive(): void {
  if (unsubscribe) return; // already running
  arm();
  lastExpiresAt = useAuthStore.getState().tokens?.expiresAt ?? null;
  unsubscribe = useAuthStore.subscribe((state) => {
    const next = state.tokens?.expiresAt ?? null;
    if (next !== lastExpiresAt) {
      lastExpiresAt = next;
      arm(); // re-arm on refresh / login; clears the timer on logout (no tokens)
    }
  });
}

export function stopSessionKeepalive(): void {
  clearTimer();
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  lastExpiresAt = null;
}
