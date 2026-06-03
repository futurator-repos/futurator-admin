/**
 * Per-session composer draft persistence.
 *
 * The Debates composer text otherwise lives only in React state, so any
 * redirect/reload (token expiry → /login, accidental tab close, refresh)
 * silently destroyed an in-progress answer. We mirror the draft into
 * localStorage keyed by sessionId so it always survives and can be restored.
 *
 * Writes are synchronous (no debounce) on purpose: the logout redirect that
 * caused the original data loss is JS we control, but a synchronous write on
 * each keystroke guarantees the very last character is never lost even on a
 * hard navigation. localStorage writes for chat-sized text are cheap.
 */

const PREFIX = 'party:draft:';

function key(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function loadDraft(sessionId: string): string {
  if (typeof window === 'undefined' || !sessionId) return '';
  try {
    return window.localStorage.getItem(key(sessionId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(sessionId: string, value: string): void {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    // Empty draft → remove the key entirely so we don't accumulate stale rows.
    if (value) window.localStorage.setItem(key(sessionId), value);
    else window.localStorage.removeItem(key(sessionId));
  } catch {
    /* quota exceeded / storage disabled — best effort, never throw */
  }
}

export function clearDraft(sessionId: string): void {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    window.localStorage.removeItem(key(sessionId));
  } catch {
    /* ignore */
  }
}
