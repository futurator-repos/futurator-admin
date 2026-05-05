import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type VersionStage = 'concept' | 'development' | 'review' | 'deploy' | 'delivered';

export const VERSION_STAGES: { id: VersionStage; label: string }[] = [
  { id: 'concept', label: 'Concept' },
  { id: 'development', label: 'Development' },
  { id: 'review', label: 'Review' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'delivered', label: 'Delivered' },
];

export function epicStatusToStage(status?: string): VersionStage {
  switch (status) {
    case 'draft':
    case 'ready':
      return 'concept';
    case 'in_progress':
    case 'fixing':
      return 'development';
    case 'in_review':
      return 'review';
    case 'completed':
      return 'deploy';
    case 'deployed':
      return 'delivered';
    case 'failed':
      return 'development';
    default:
      return 'concept';
  }
}

export function normalizeAppName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

interface LabsStore {
  activeAppName: string | null;
  setActiveAppName: (appName: string | null) => void;
}

export const useLabsStore = create<LabsStore>()(
  persist(
    (set) => ({
      activeAppName: null,
      setActiveAppName: (activeAppName) => set({ activeAppName }),
    }),
    { name: 'futurator.labs.activeAppName' },
  ),
);
