// ── Location keys ──

export type DeskKey = `desk-${number}`;
export type LocationKey =
  | DeskKey
  | 'whiteboard'
  | 'meeting'
  | 'kitchen'
  | 'lounge'
  | 'entrance'
  | 'hallway';

// ── Worker ──

export type WorkerRole = 'PM' | 'DEV' | 'REVIEWER' | 'PO' | 'DEPLOY' | 'QA';
export type WorkerState = 'entering' | 'walking' | 'sitting_down' | 'seated' | 'leaving';

export interface OfficeWorker {
  id: string;
  role: WorkerRole;
  epicId: string;
  storyId: string | null;
  storyTitle: string;
  name: string;
  color: number;
  headColor: number;
  location: LocationKey;
  targetLocation: LocationKey | null;
  state: WorkerState;
  deskIndex: number | null;
}

// ── Actions ──

export type OfficeActionType = 'spawn' | 'move' | 'chat' | 'milestone' | 'despawn';

export interface OfficeAction {
  type: OfficeActionType;
  workerId: string;
  role?: WorkerRole;
  epicId?: string;
  storyId?: string;
  storyTitle?: string;
  location?: LocationKey;
  message?: string;
  emoji?: string;
  timestamp: number;
}

// ── Kanban ──

export type KanbanColumn = 'backlog' | 'in_progress' | 'in_review' | 'fixing' | 'done';

export interface KanbanStory {
  storyId: string;
  epicId: string;
  epicTitle: string;
  title: string;
  column: KanbanColumn;
  wave: number | null;
  workerName: string | null;
  failed: boolean;
}

// ── Chat bubble ──

export interface ChatBubbleMessage {
  workerId: string;
  text: string;
  emoji: string;
  isMilestone: boolean;
}

// ── Event log entry ──

export interface OfficeLogEntry {
  worker: string;
  role: WorkerRole;
  message: string;
  emoji: string;
  time: string;
  color: number;
}
