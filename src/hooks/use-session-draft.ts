'use client';
import { useCallback, useState } from 'react';
import { loadDraft, saveDraft } from '@/lib/draft-store';

type DraftUpdater = string | ((prev: string) => string);

/**
 * Composer draft state that transparently persists to localStorage per
 * session (see `lib/draft-store.ts`). Drop-in replacement for
 * `useState('')` — returns `[draft, setDraft]` where `setDraft` accepts
 * either a value or an updater fn (the DocTray "insert reference" path uses
 * the functional form).
 *
 * Restores synchronously on first mount and re-hydrates when `sessionId`
 * changes without a remount (the Debates left-pane session switcher swaps the
 * prop in place rather than remounting the chat).
 */
export function useSessionDraft(sessionId: string): [string, (next: DraftUpdater) => void] {
  const [draft, setDraftState] = useState<string>(() => loadDraft(sessionId));

  // Re-hydrate on session switch. The chat component is not keyed by
  // sessionId, so a lazy initializer alone wouldn't pick up the new session's
  // saved draft. This is the React-sanctioned "adjust state during render"
  // pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // — React bails out of the in-progress render and re-renders immediately,
  // which avoids the cascading-render cost of doing this in an effect.
  const [trackedId, setTrackedId] = useState(sessionId);
  if (trackedId !== sessionId) {
    setTrackedId(sessionId);
    setDraftState(loadDraft(sessionId));
  }

  const setDraft = useCallback(
    (next: DraftUpdater) => {
      setDraftState((prev) => {
        const value = typeof next === 'function' ? next(prev) : next;
        saveDraft(sessionId, value);
        return value;
      });
    },
    [sessionId],
  );

  return [draft, setDraft];
}
