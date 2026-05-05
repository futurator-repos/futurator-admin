import { create } from 'zustand';

interface PartyStore {
  selectedProjectId: string | null;
  activeSessionId: string | null;
  draftMessage: string;
  selectProject: (projectId: string | null) => void;
  openSession: (sessionId: string) => void;
  closeSession: () => void;
  setDraft: (draft: string) => void;
}

export const usePartyStore = create<PartyStore>((set) => ({
  selectedProjectId: null,
  activeSessionId: null,
  draftMessage: '',
  selectProject: (selectedProjectId) =>
    set({ selectedProjectId, activeSessionId: null, draftMessage: '' }),
  openSession: (activeSessionId) => set({ activeSessionId }),
  closeSession: () => set({ activeSessionId: null, draftMessage: '' }),
  setDraft: (draftMessage) => set({ draftMessage }),
}));
