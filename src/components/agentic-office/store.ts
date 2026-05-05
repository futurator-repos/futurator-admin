import { create } from 'zustand';
import * as THREE from 'three';
import type { EpicStory } from '@/types/epic-workflow';
import {
  CAST,
  CAST_BY_ID,
  DEV_POOL,
  REVIEWER_POOL,
  TESTER_POOL,
  MAX_DEV_CAPACITY,
  MAX_REVIEWER_CAPACITY,
  MAX_TESTER_CAPACITY,
} from './cast';
import type {
  BubbleTier,
  BubbleToolKind,
  CharacterId,
  ChatBubble,
  KanbanColumn,
  KanbanStory,
  OfficeAction,
  OfficeLogEntry,
  PersonaRuntime,
  SeatRef,
  StoryAssignment,
} from './types';
import {
  applyOrchestratorIntent,
  initialOrchestratorSceneState,
  reconcileFromStories,
  type OrchestratorAnimationIntent,
  type OrchestratorSceneState,
} from './orchestrator-scene-state';
import { paletteForPlanId } from './plan-palette';

// ── Tunables ──

// Per-tier lifetime. Milestones stick slightly longer, blockers much longer
// so the user has time to read them before they retire to a desk ring.
const BUBBLE_TTL_MS: Record<BubbleTier, number> = {
  thought: 4_000,
  action: 5_000,
  milestone: 6_000,
  blocker: 60_000,
};
/** Legacy fallback for callers that don't specify a tier. */
const DEFAULT_BUBBLE_TTL_MS = 4_000;
const MAX_BUBBLES_PER_CHARACTER = 3;
const MAX_LOG = 200;
const MAX_ACTION_QUEUE = 400;

// ── Initial persona runtimes (everyone offstage, near entrance) ──

function makeInitialRuntimes(): Record<CharacterId, PersonaRuntime> {
  const out = {} as Record<CharacterId, PersonaRuntime>;
  for (const p of CAST) {
    out[p.id] = {
      position: new THREE.Vector3(0, 0, 11),
      facing: Math.PI,
      activity: 'idle',
      seat: null,
      target: null,
      presence: 'offstage',
      presenceScale: 0,
    };
  }
  return out;
}

// ── Kanban column mapping ──
// Story status → UI column. `fixing` folds into `in_progress` (post-review
// remediation). `failed` stays in whatever column it was in and renders red.
// `skipped` renders as `done`.

function columnForStory(story: EpicStory): KanbanColumn {
  switch (story.status) {
    case 'pending':
      return 'backlog';
    case 'queued':
      return 'queued';
    case 'running':
    case 'fixing':
    case 'blocked':
      return 'in_progress';
    case 'in_review':
      return 'in_review';
    case 'done':
    case 'skipped':
      return 'done';
    case 'failed':
      // Stays visible in the last stage it reached — if a job existed it got
      // at least to in_progress; otherwise it never left backlog. Rendered
      // red via the `failed` flag.
      return story.jobId ? 'in_progress' : 'backlog';
    default:
      return 'backlog';
  }
}

// ── Store shape ──

interface OfficeStoreState {
  // Persona state
  runtimes: Record<CharacterId, PersonaRuntime>;

  // Story → character mappings (persistent cast, ephemeral assignments)
  assignmentsByStory: Record<string, StoryAssignment>;
  /** Reverse lookup: which story (if any) is each persona currently handling. */
  assignmentByCharacter: Partial<Record<CharacterId, string>>;

  // Portfolio state
  activeEpicIds: string[];
  kanbanStories: KanbanStory[];

  // UX state
  selectedKanbanEpicId: string | null;
  /** Multi-select plan filter. Empty array = "all plans". */
  selectedKanbanPlanIds: string[];
  kanbanOpen: boolean;
  attentionOpen: boolean;
  /** Which proxy-board modal is open (Epic D). null when none. */
  openBoard: 'ec2' | 'gantt' | 'plans' | null;
  selectedCharacterId: CharacterId | null;

  /**
   * Per-story retry state (Epic B.5). Populated by StoryTracker from
   * `job.retryAfter` / `job.retryAttempt`. Keyed by storyId so the scene
   * can render the hourglass + attempt treatment on the right desk.
   */
  storyRetry: Record<string, { retryAfter: string; retryAttempt: number }>;

  // Streams
  actionQueue: OfficeAction[];
  bubbles: Record<CharacterId, ChatBubble[]>;
  eventLog: OfficeLogEntry[];

  // Orchestrator animation substrate (wave bands, blocker cards, etc.)
  orchestrator: OrchestratorSceneState;

  // ── Persona runtime mutations ──
  updateRuntime: (id: CharacterId, patch: Partial<PersonaRuntime>) => void;
  setPresence: (id: CharacterId, presence: PersonaRuntime['presence']) => void;

  // ── Assignment engine ──
  /**
   * Pick a free persona of the given role and bind it to the story. Returns
   * the characterId if one was free, or null if the pool was exhausted (the
   * story should stay in the `queued` column until capacity frees up).
   */
  assignStory: (
    storyId: string,
    epicId: string,
    role: 'developer' | 'reviewer' | 'tester',
    attempt?: number,
  ) => CharacterId | null;
  releaseStory: (storyId: string) => CharacterId | null;
  getAssignmentForStory: (storyId: string) => StoryAssignment | undefined;
  getAssignmentForCharacter: (id: CharacterId) => StoryAssignment | undefined;

  // ── Action queue ──
  enqueueAction: (action: OfficeAction) => void;
  consumeActions: (n: number) => OfficeAction[];

  // ── Chat bubbles ──
  pushBubble: (
    characterId: CharacterId,
    text: string,
    emoji: string,
    /** Legacy boolean maps to `milestone` tier; prefer passing tier directly. */
    isMilestoneOrOpts?: boolean | { tier?: BubbleTier; toolKind?: BubbleToolKind },
  ) => void;
  pruneBubbles: (now?: number) => void;
  clearBubbles: (characterId: CharacterId) => void;

  // ── Event log ──
  pushLog: (entry: Omit<OfficeLogEntry, 'time' | 'id'>) => void;

  // ── Portfolio ──
  setActiveEpics: (ids: string[]) => void;
  updateKanban: (
    epicId: string,
    epicTitle: string,
    stories: EpicStory[],
    planId?: string | null,
  ) => void;

  // ── Orchestrator intents ──
  applyOrchestratorIntent: (intent: OrchestratorAnimationIntent) => void;
  reconcileOrchestratorFromStories: (stories: EpicStory[]) => void;

  // ── UX ──
  selectKanbanEpic: (id: string | null) => void;
  setSelectedKanbanPlans: (ids: string[]) => void;
  toggleKanbanPlan: (id: string) => void;
  clearKanbanPlans: () => void;
  setKanbanOpen: (open: boolean) => void;
  setAttentionOpen: (open: boolean) => void;
  setOpenBoard: (board: 'ec2' | 'gantt' | 'plans' | null) => void;
  selectCharacter: (id: CharacterId | null) => void;

  // ── Retry lifecycle (Epic B.5) ──
  setStoryRetry: (
    storyId: string,
    state: { retryAfter: string; retryAttempt: number } | null,
  ) => void;
}

export const useOfficeStore = create<OfficeStoreState>((set, get) => ({
  runtimes: makeInitialRuntimes(),

  assignmentsByStory: {},
  assignmentByCharacter: {},

  activeEpicIds: [],
  kanbanStories: [],

  selectedKanbanEpicId: null,
  selectedKanbanPlanIds: [],
  kanbanOpen: false,
  attentionOpen: false,
  openBoard: null,
  selectedCharacterId: null,
  storyRetry: {},

  actionQueue: [],
  bubbles: {} as Record<CharacterId, ChatBubble[]>,
  eventLog: [],

  orchestrator: initialOrchestratorSceneState(),

  updateRuntime: (id, patch) =>
    set((s) => ({
      runtimes: { ...s.runtimes, [id]: { ...s.runtimes[id], ...patch } },
    })),

  setPresence: (id, presence) =>
    set((s) => ({
      runtimes: { ...s.runtimes, [id]: { ...s.runtimes[id], presence } },
    })),

  assignStory: (storyId, epicId, role, attempt = 1) => {
    const existing = get().assignmentsByStory[storyId];
    if (existing) return existing.characterId;

    const pool =
      role === 'developer' ? DEV_POOL : role === 'reviewer' ? REVIEWER_POOL : TESTER_POOL;
    const capacity =
      role === 'developer'
        ? MAX_DEV_CAPACITY
        : role === 'reviewer'
          ? MAX_REVIEWER_CAPACITY
          : MAX_TESTER_CAPACITY;
    const { assignmentByCharacter, kanbanStories } = get();
    let free: CharacterId | undefined;
    for (const id of pool) {
      if (!assignmentByCharacter[id]) {
        free = id;
        break;
      }
    }
    if (!free) return null;

    const persona = CAST_BY_ID[free];
    if (!persona) return null;

    const deskSlot = persona.homeSeat.slot;

    // Resolve the owning plan's color from kanbanStories (updateKanban
    // stamps planId onto each KanbanStory). Falls back to the unassigned
    // palette for legacy epics without a planId.
    const kanban = kanbanStories.find((k) => k.storyId === storyId);
    const planColor = paletteForPlanId(kanban?.planId ?? null).hex;

    set((s) => ({
      assignmentsByStory: {
        ...s.assignmentsByStory,
        [storyId]: {
          storyId,
          epicId,
          role,
          characterId: free,
          deskSlot,
          attempt,
          planColor,
        },
      },
      assignmentByCharacter: {
        ...s.assignmentByCharacter,
        [free]: storyId,
      },
    }));

    // Silence unused-capacity warning in linter; capacity check is for future
    // overflow logic when parallelism exceeds cast size.
    void capacity;

    return free;
  },

  releaseStory: (storyId) => {
    const existing = get().assignmentsByStory[storyId];
    if (!existing) return null;
    set((s) => {
      const { [storyId]: _dropped, ...restByStory } = s.assignmentsByStory;
      const { [existing.characterId]: _dropped2, ...restByChar } = s.assignmentByCharacter;
      void _dropped;
      void _dropped2;
      return {
        assignmentsByStory: restByStory,
        assignmentByCharacter: restByChar,
      };
    });
    return existing.characterId;
  },

  getAssignmentForStory: (storyId) => get().assignmentsByStory[storyId],
  getAssignmentForCharacter: (id) => {
    const storyId = get().assignmentByCharacter[id];
    return storyId ? get().assignmentsByStory[storyId] : undefined;
  },

  enqueueAction: (action) =>
    set((s) => {
      const next = [...s.actionQueue, action];
      return {
        actionQueue: next.length > MAX_ACTION_QUEUE ? next.slice(-MAX_ACTION_QUEUE) : next,
      };
    }),

  consumeActions: (n) => {
    const q = get().actionQueue;
    const consumed = q.slice(0, n);
    set({ actionQueue: q.slice(n) });
    return consumed;
  },

  pushBubble: (characterId, text, emoji, isMilestoneOrOpts) => {
    const isMilestone =
      typeof isMilestoneOrOpts === 'boolean' ? isMilestoneOrOpts : false;
    const opts =
      typeof isMilestoneOrOpts === 'object' && isMilestoneOrOpts
        ? isMilestoneOrOpts
        : undefined;
    const tier: BubbleTier = opts?.tier ?? (isMilestone ? 'milestone' : 'thought');
    const toolKind = opts?.toolKind;

    // Inherit the plan color from the occupying assignment so the bubble
    // visually matches its character's desk tag (Epic E.5).
    const state = get();
    const storyId = state.assignmentByCharacter[characterId];
    const planColor = storyId
      ? (state.assignmentsByStory[storyId]?.planColor ?? undefined)
      : undefined;

    const bubble: ChatBubble = {
      id: `${characterId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      characterId,
      text,
      emoji,
      createdAt: Date.now(),
      isMilestone: tier === 'milestone',
      tier,
      toolKind,
      planColor: planColor ?? undefined,
    };
    set((s) => {
      const current = s.bubbles[characterId] ?? [];
      const trimmed = [...current, bubble].slice(-MAX_BUBBLES_PER_CHARACTER);
      return { bubbles: { ...s.bubbles, [characterId]: trimmed } };
    });
  },

  pruneBubbles: (now = Date.now()) =>
    set((s) => {
      let changed = false;
      const next = { ...s.bubbles };
      for (const [cid, list] of Object.entries(s.bubbles)) {
        const kept = list.filter((b) => {
          const ttl = BUBBLE_TTL_MS[b.tier] ?? DEFAULT_BUBBLE_TTL_MS;
          return now - b.createdAt < ttl;
        });
        if (kept.length !== list.length) {
          next[cid as CharacterId] = kept;
          changed = true;
        }
      }
      return changed ? { bubbles: next } : s;
    }),

  clearBubbles: (characterId) =>
    set((s) => {
      if (!s.bubbles[characterId]) return s;
      const next = { ...s.bubbles };
      delete next[characterId];
      return { bubbles: next };
    }),

  pushLog: (entry) =>
    set((s) => {
      const log: OfficeLogEntry = {
        ...entry,
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        time: new Date().toLocaleTimeString(),
      };
      return { eventLog: [log, ...s.eventLog.slice(0, MAX_LOG - 1)] };
    }),

  setActiveEpics: (ids) => set({ activeEpicIds: ids }),

  updateKanban: (epicId, epicTitle, stories, planId = null) =>
    set((s) => {
      const other = s.kanbanStories.filter((k) => k.epicId !== epicId);
      const fresh: KanbanStory[] = stories.map((story) => {
        const assignment = s.assignmentsByStory[story.storyId];
        const characterId = assignment?.characterId ?? null;
        const assigneeName = characterId ? CAST_BY_ID[characterId].name : null;
        return {
          storyId: story.storyId,
          epicId,
          epicTitle,
          planId: planId ?? null,
          title: story.title,
          column: columnForStory(story),
          wave: story.wave ?? null,
          assigneeCharacterId: characterId,
          assigneeName,
          failed: story.status === 'failed',
          attempt: assignment?.attempt ?? 1,
        };
      });
      return { kanbanStories: [...other, ...fresh] };
    }),

  applyOrchestratorIntent: (intent) =>
    set((s) => ({ orchestrator: applyOrchestratorIntent(s.orchestrator, intent) })),

  reconcileOrchestratorFromStories: (stories) =>
    set((s) => ({ orchestrator: reconcileFromStories(s.orchestrator, stories) })),

  selectKanbanEpic: (id) => set({ selectedKanbanEpicId: id }),
  setSelectedKanbanPlans: (ids) => set({ selectedKanbanPlanIds: [...ids] }),
  toggleKanbanPlan: (id) =>
    set((s) => {
      const has = s.selectedKanbanPlanIds.includes(id);
      return {
        selectedKanbanPlanIds: has
          ? s.selectedKanbanPlanIds.filter((p) => p !== id)
          : [...s.selectedKanbanPlanIds, id],
      };
    }),
  clearKanbanPlans: () => set({ selectedKanbanPlanIds: [] }),
  setKanbanOpen: (open) => set({ kanbanOpen: open }),
  setAttentionOpen: (open) => set({ attentionOpen: open }),
  setOpenBoard: (board) => set({ openBoard: board }),
  selectCharacter: (id) => set({ selectedCharacterId: id }),

  setStoryRetry: (storyId, state) =>
    set((s) => {
      if (!state) {
        if (!s.storyRetry[storyId]) return s;
        const { [storyId]: _dropped, ...rest } = s.storyRetry;
        void _dropped;
        return { storyRetry: rest };
      }
      return { storyRetry: { ...s.storyRetry, [storyId]: state } };
    }),
}));

// Silence unused-var warning for seat helper used later by scene code.
export function seatKey(seat: SeatRef): string {
  return `${seat.kind}-${seat.slot}`;
}
