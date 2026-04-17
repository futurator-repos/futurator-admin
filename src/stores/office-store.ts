import { create } from 'zustand';
import type {
  OfficeWorker,
  OfficeAction,
  KanbanStory,
  KanbanColumn,
  LocationKey,
  OfficeLogEntry,
} from '@/types/agentic-office';
import type { EpicStory } from '@/types/epic-workflow';
import type { OrchestratorAnimationIntent } from '@/components/agentic-office/event-translator';
import {
  applyOrchestratorIntent,
  initialOrchestratorSceneState,
  reconcileFromStories,
  type OrchestratorSceneState,
} from '@/components/agentic-office/scene/orchestrator-scene-state';

const MAX_DESKS = 10;
const MAX_LOG = 80;

/** Phase reported by StoryTracker based on the current pipeline step */
export type StoryPhase = 'dev' | 'review' | 'fixing';

interface OfficeStoreState {
  // Core state
  workers: Map<string, OfficeWorker>;
  actionQueue: OfficeAction[];
  kanbanStories: KanbanStory[];
  deskAssignments: (string | null)[];
  /** Tracks the current phase of each running story. Key: "epicId_storyId" */
  storyPhases: Map<string, StoryPhase>;

  // UI state
  activeEpicIds: string[];
  selectedKanbanEpicId: string | null;
  kanbanOpen: boolean;
  isPaused: boolean;
  speed: number;
  eventLog: OfficeLogEntry[];

  // Orchestrator visualization state (Epic 6)
  orchestrator: OrchestratorSceneState;
  applyOrchestratorIntent: (intent: OrchestratorAnimationIntent) => void;
  reconcileOrchestratorFromStories: (stories: EpicStory[]) => void;

  // Actions
  spawnWorker: (worker: OfficeWorker) => void;
  despawnWorker: (id: string) => void;
  moveWorker: (id: string, to: LocationKey) => void;
  updateWorkerState: (id: string, state: OfficeWorker['state'], location?: LocationKey) => void;
  queueChat: (workerId: string, text: string, emoji: string, isMilestone: boolean) => void;
  queueAction: (action: OfficeAction) => void;
  consumeActions: (n: number) => OfficeAction[];
  setStoryPhase: (epicId: string, storyId: string, phase: StoryPhase) => void;
  clearStoryPhase: (epicId: string, storyId: string) => void;
  updateKanban: (epicId: string, epicTitle: string, stories: EpicStory[]) => void;
  allocateDesk: (workerId: string) => number | null;
  freeDesk: (workerId: string) => void;
  setActiveEpics: (ids: string[]) => void;
  selectKanbanEpic: (id: string | null) => void;
  setKanbanOpen: (open: boolean) => void;
  togglePause: () => void;
  setSpeed: (s: number) => void;
  pushEvent: (entry: Omit<OfficeLogEntry, 'time'>) => void;
  getWorker: (id: string) => OfficeWorker | undefined;
  hasWorker: (id: string) => boolean;
}

function storyToKanbanColumn(
  story: EpicStory,
  epicId: string,
  storyPhases: Map<string, StoryPhase>,
): KanbanColumn {
  if (story.status === 'done') return 'done';
  if (story.status === 'pending' || story.status === 'skipped') return 'backlog';
  if (story.status === 'failed') return 'backlog'; // stays visible with red indicator
  if (story.status === 'in_review') return 'in_review';
  if (story.status === 'fixing') return 'fixing';

  // story.status === 'running' — use phase reported by StoryTracker
  const phase = storyPhases.get(`${epicId}_${story.storyId}`);
  if (phase === 'review') return 'in_review';
  if (phase === 'fixing') return 'fixing';
  return 'in_progress';
}

export const useOfficeStore = create<OfficeStoreState>((set, get) => ({
  workers: new Map(),
  actionQueue: [],
  kanbanStories: [],
  deskAssignments: new Array(MAX_DESKS).fill(null),
  storyPhases: new Map(),

  activeEpicIds: [],
  selectedKanbanEpicId: null,
  kanbanOpen: false,
  isPaused: false,
  speed: 1,
  eventLog: [],

  orchestrator: initialOrchestratorSceneState(),

  applyOrchestratorIntent: (intent) =>
    set((s) => ({ orchestrator: applyOrchestratorIntent(s.orchestrator, intent) })),

  reconcileOrchestratorFromStories: (stories) =>
    set((s) => ({ orchestrator: reconcileFromStories(s.orchestrator, stories) })),

  spawnWorker: (worker) =>
    set((s) => {
      const next = new Map(s.workers);
      next.set(worker.id, worker);
      return { workers: next };
    }),

  despawnWorker: (id) =>
    set((s) => {
      const next = new Map(s.workers);
      next.delete(id);
      // Free desk
      const desks = [...s.deskAssignments];
      const idx = desks.indexOf(id);
      if (idx >= 0) desks[idx] = null;
      return { workers: next, deskAssignments: desks };
    }),

  moveWorker: (id, to) =>
    set((s) => {
      const w = s.workers.get(id);
      if (!w) return s;
      const next = new Map(s.workers);
      next.set(id, { ...w, targetLocation: to, state: 'walking' });
      return { workers: next };
    }),

  updateWorkerState: (id, state, location) =>
    set((s) => {
      const w = s.workers.get(id);
      if (!w) return s;
      const next = new Map(s.workers);
      next.set(id, {
        ...w,
        state,
        ...(location ? { location, targetLocation: null } : {}),
      });
      return { workers: next };
    }),

  queueChat: (workerId, text, emoji, isMilestone) =>
    set((s) => ({
      actionQueue: [
        ...s.actionQueue,
        {
          type: isMilestone ? 'milestone' : 'chat',
          workerId,
          message: text,
          emoji,
          timestamp: Date.now(),
        },
      ],
    })),

  queueAction: (action) => set((s) => ({ actionQueue: [...s.actionQueue, action] })),

  consumeActions: (n) => {
    const q = get().actionQueue;
    const consumed = q.slice(0, n);
    set({ actionQueue: q.slice(n) });
    return consumed;
  },

  setStoryPhase: (epicId, storyId, phase) =>
    set((s) => {
      const next = new Map(s.storyPhases);
      next.set(`${epicId}_${storyId}`, phase);
      return { storyPhases: next };
    }),

  clearStoryPhase: (epicId, storyId) =>
    set((s) => {
      const next = new Map(s.storyPhases);
      next.delete(`${epicId}_${storyId}`);
      return { storyPhases: next };
    }),

  updateKanban: (epicId, epicTitle, stories) =>
    set((s) => {
      // Remove old entries for this epic, then add fresh ones
      const other = s.kanbanStories.filter((k) => k.epicId !== epicId);
      const fresh: KanbanStory[] = stories.map((story) => {
        const column = storyToKanbanColumn(story, epicId, s.storyPhases);
        // Find worker name if any
        const worker = [...s.workers.values()].find(
          (w) => w.epicId === epicId && w.storyId === story.storyId,
        );
        return {
          storyId: story.storyId,
          epicId,
          epicTitle,
          title: story.title,
          column,
          wave: story.wave ?? null,
          workerName: worker?.name ?? null,
          failed: story.status === 'failed',
        };
      });
      return { kanbanStories: [...other, ...fresh] };
    }),

  allocateDesk: (workerId) => {
    const desks = [...get().deskAssignments];
    const free = desks.indexOf(null);
    if (free < 0) return null;
    desks[free] = workerId;
    set({ deskAssignments: desks });
    return free;
  },

  freeDesk: (workerId) =>
    set((s) => {
      const desks = [...s.deskAssignments];
      const idx = desks.indexOf(workerId);
      if (idx >= 0) desks[idx] = null;
      return { deskAssignments: desks };
    }),

  setActiveEpics: (ids) => set({ activeEpicIds: ids }),
  selectKanbanEpic: (id) => set({ selectedKanbanEpicId: id }),
  setKanbanOpen: (open) => set({ kanbanOpen: open }),
  togglePause: () => set((s) => ({ isPaused: !s.isPaused })),
  setSpeed: (s) => set({ speed: s }),

  pushEvent: (entry) =>
    set((s) => ({
      eventLog: [
        { ...entry, time: new Date().toLocaleTimeString() },
        ...s.eventLog.slice(0, MAX_LOG - 1),
      ],
    })),

  getWorker: (id) => get().workers.get(id),
  hasWorker: (id) => get().workers.has(id),
}));
