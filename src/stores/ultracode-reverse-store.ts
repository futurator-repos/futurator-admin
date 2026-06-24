/**
 * ultracode-reverse-store.ts — Zustand store for the Ultracode-Reverse bench page.
 *
 * Holds the active run id + the intent-form draft (persists across navigation, like
 * free-agent's composerText). No business logic — lifecycle lives in use-ultracode-run.
 */

import { create } from 'zustand';
import type { UltracodeTarget, UltracodeRigor } from '@/types/ultracode-run';

export interface IntentDraft {
  intent: string;
  target: UltracodeTarget;
  rigor: UltracodeRigor;
  reps: number;
}

const DEFAULT_DRAFT: IntentDraft = {
  intent: '',
  target: 'greenfield',
  rigor: 'production',
  reps: 5,
};

interface UltracodeReverseStore {
  activeRunId: string | null;
  draft: IntentDraft;
  setActiveRunId(id: string | null): void;
  setDraft(patch: Partial<IntentDraft>): void;
  resetDraft(): void;
}

export const useUltracodeReverseStore = create<UltracodeReverseStore>((set) => ({
  activeRunId: null,
  draft: { ...DEFAULT_DRAFT },
  setActiveRunId: (id) => set({ activeRunId: id }),
  setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
  resetDraft: () => set({ draft: { ...DEFAULT_DRAFT } }),
}));
