import { create } from 'zustand';

interface UIStore {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  dateRange: '30d' | '60d' | '90d';
  setDateRange: (range: '30d' | '60d' | '90d') => void;
  costProvider: 'aws' | 'all';
  setCostProvider: (provider: 'aws' | 'all') => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  dateRange: '30d',
  setDateRange: (dateRange) => set({ dateRange }),
  costProvider: 'aws',
  setCostProvider: (costProvider) => set({ costProvider }),
}));
