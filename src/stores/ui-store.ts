import { create } from 'zustand';

export interface HeaderBreadcrumbItem {
  label: string;
  href?: string;
}

interface UIStore {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  dateRange: '30d' | '60d' | '90d';
  setDateRange: (range: '30d' | '60d' | '90d') => void;
  costProvider: 'aws' | 'all';
  setCostProvider: (provider: 'aws' | 'all') => void;
  // Page-supplied breadcrumb shown on the left of the top header. Pages
  // set on mount and clear on unmount. Each item with `href` renders as
  // a link; the last item is treated as the current page.
  headerBreadcrumbs: HeaderBreadcrumbItem[] | null;
  setHeaderBreadcrumbs: (items: HeaderBreadcrumbItem[] | null) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  dateRange: '30d',
  setDateRange: (dateRange) => set({ dateRange }),
  costProvider: 'aws',
  setCostProvider: (costProvider) => set({ costProvider }),
  headerBreadcrumbs: null,
  setHeaderBreadcrumbs: (headerBreadcrumbs) => set({ headerBreadcrumbs }),
}));
