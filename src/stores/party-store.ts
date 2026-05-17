import { create } from 'zustand';

interface PartyStore {
  selectedProjectId: string | null;
  activeSessionId: string | null;
  draftMessage: string;
  /** Story 15.4 — controls the "Add Brownfield Project" modal. */
  isBrownfieldFormOpen: boolean;
  selectProject: (projectId: string | null) => void;
  openSession: (sessionId: string) => void;
  closeSession: () => void;
  setDraft: (draft: string) => void;
  openBrownfieldForm: () => void;
  closeBrownfieldForm: () => void;
}

export const usePartyStore = create<PartyStore>((set) => ({
  selectedProjectId: null,
  activeSessionId: null,
  draftMessage: '',
  isBrownfieldFormOpen: false,
  selectProject: (selectedProjectId) =>
    set({ selectedProjectId, activeSessionId: null, draftMessage: '' }),
  openSession: (activeSessionId) => set({ activeSessionId }),
  closeSession: () => set({ activeSessionId: null, draftMessage: '' }),
  setDraft: (draftMessage) => set({ draftMessage }),
  openBrownfieldForm: () => set({ isBrownfieldFormOpen: true }),
  closeBrownfieldForm: () => set({ isBrownfieldFormOpen: false }),
}));
