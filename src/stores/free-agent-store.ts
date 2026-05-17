/**
 * free-agent-store.ts — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Zustand store for the free-agent widget. Drives the FAB/Panel visibility,
 * the current scope label (read by the panel header), the active session id
 * (Story 18.5 will populate this when a session is created), and the
 * composer draft text (persists across panel close/re-open per AC #10).
 */

import { create } from 'zustand';

export type FreeAgentScopeKind = 'project' | 'plan' | 'app' | 'workspace';

export interface FreeAgentScope {
  kind: FreeAgentScopeKind;
  /** Required for project/plan/app; absent for workspace. */
  id?: string;
}

interface FreeAgentStore {
  isOpen: boolean;
  currentScope: FreeAgentScope;
  /** Set when a session is created in Story 18.5. */
  activeSessionId: string | null;
  composerText: string;
  /** True after a scope change while the panel is open — the header shows a callout. */
  scopeChangedSinceLastSend: boolean;

  open(): void;
  close(): void;
  toggle(): void;
  setScope(scope: FreeAgentScope): void;
  setComposerText(text: string): void;
  setActiveSessionId(id: string | null): void;
  /** Called by the header callout's "Start new conversation" action. */
  acknowledgeScopeChange(): void;
}

export const useFreeAgentStore = create<FreeAgentStore>((set, get) => ({
  isOpen: false,
  currentScope: { kind: 'workspace' },
  activeSessionId: null,
  composerText: '',
  scopeChangedSinceLastSend: false,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set({ isOpen: !get().isOpen }),

  setScope: (scope) => {
    const prev = get().currentScope;
    const same = prev.kind === scope.kind && (prev.id ?? null) === (scope.id ?? null);
    if (same) return;
    set({
      currentScope: scope,
      // Only mark "changed" if the widget is currently open — we don't want a
      // stale callout to appear the next time the operator opens the panel.
      scopeChangedSinceLastSend: get().isOpen && get().activeSessionId !== null,
    });
  },

  setComposerText: (text) => set({ composerText: text }),
  setActiveSessionId: (id) => set({ activeSessionId: id, scopeChangedSinceLastSend: false }),
  acknowledgeScopeChange: () =>
    set({ scopeChangedSinceLastSend: false, activeSessionId: null, composerText: '' }),
}));
