import * as THREE from 'three';

// ── Roles ──
// Mirrors the concept's taxonomy and the orchestrator event vocabulary.

export type PersonaRole = 'pm' | 'orchestrator' | 'developer' | 'reviewer' | 'tester';

// ── Named cast ──
// The office is a portfolio view of the whole EC2 daemon — the same 10
// people work on every plan. `developer` and `reviewer` personas are a
// finite pool; stories beyond the pool's capacity sit in the `queued`
// column until a persona frees up.

export type CharacterId =
  | 'milena'
  | 'ricardo'
  | 'bob'
  | 'carol'
  | 'dave'
  | 'eve'
  | 'frank'
  | 'joseph'
  | 'sonia'
  | 'manuel'
  | 'nadia'
  | 'olaf'
  | 'priya'
  | 'quinn';

export type CharacterKind =
  | 'Suit_Male'
  | 'Suit_Female'
  | 'Casual_Male'
  | 'Casual_Female'
  | 'Casual2_Male'
  | 'Casual3_Male'
  | 'Casual3_Female'
  | 'Casual_Bald'
  | 'Worker_Male'
  | 'Worker_Female';

export type HatKind = 'none' | 'cap' | 'tophat' | 'beanie' | 'headphones';

export interface CharacterLook {
  kind: CharacterKind;
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  hat: HatKind;
  hatColor: string;
}

export interface Persona {
  id: CharacterId;
  name: string;
  role: PersonaRole;
  homeSeat: SeatRef;
  look: CharacterLook;
}

// ── Seating model ──
// Every seatable location in the office is described as a {kind, slot}
// pair. Slot is stable: desk-0..desk-5, couch-0..2, meeting-0..7, mgmt-0..7,
// coffee-0, whiteboard-0, supervisor-0. Assignment lookups use this key.

export type SeatKind =
  | 'desk'
  | 'couch'
  | 'meeting'
  | 'mgmt'
  | 'coffee'
  | 'whiteboard'
  | 'supervisor'
  | 'entrance';

export interface SeatRef {
  kind: SeatKind;
  slot: number;
}

// ── Persona runtime — what the scene reads each frame ──

export type PersonaActivity =
  | 'idle'
  | 'walking'
  | 'sitting'
  | 'standing'
  | 'pointing' // whiteboard gesture — Shoot_OneHanded clip
  | 'drinking' // coffee — PickUp clip
  | 'cheering' // Victory clip (milestone)
  | 'dejected'; // Defeat clip (terminal-fail)

export type PersonaPresence = 'offstage' | 'entering' | 'onstage' | 'leaving';

export interface PersonaRuntime {
  position: THREE.Vector3;
  facing: number;
  activity: PersonaActivity;
  seat: SeatRef | null;
  target: PersonaTarget | null;
  presence: PersonaPresence;
  presenceScale: number; // 0..1 spawn/despawn lerp
}

export interface PersonaTarget {
  kind: 'seat' | 'floor';
  seat: SeatRef | null; // null when walking to a floor point
  position: THREE.Vector3;
  facing: number;
  arrivalActivity: PersonaActivity;
}

// ── Assignments — which persona is currently working which story ──

export interface StoryAssignment {
  storyId: string;
  epicId: string;
  role: 'developer' | 'reviewer' | 'tester';
  characterId: CharacterId;
  deskSlot: number; // dev/reviewer/tester desk the persona sits at
  attempt: number;
  /** Multi-plan color (Epic C). Hex. Null if the epic has no planId. */
  planColor: string | null;
}

// ── Action queue — what the translator emits, the scene consumes ──

export type OfficeActionType =
  | 'goto_seat' // send persona to a seat (desk, meeting, couch, etc.)
  | 'goto_floor' // send persona to a floor point
  | 'chat' // chat bubble above the head (TTL 4s)
  | 'milestone' // milestone bubble + optional Victory/Defeat clip
  | 'enter' // bring persona onstage from entrance
  | 'leave'; // send persona offstage via entrance

export type BubbleTier = 'thought' | 'action' | 'milestone' | 'blocker';

/** Tool categorization used to pick the bubble's left-side dot color. */
export type BubbleToolKind = 'read' | 'edit' | 'write' | 'bash' | 'other';

export interface OfficeAction {
  type: OfficeActionType;
  characterId: CharacterId;
  seat?: SeatRef;
  position?: { x: number; z: number };
  message?: string;
  emoji?: string;
  milestone?: 'cheer' | 'defeat' | 'neutral';
  /** Epic E: bubble tier. Defaults to `thought` (for chat) or `milestone`. */
  tier?: BubbleTier;
  /** Epic E: tool category for the action-tier dot icon. */
  toolKind?: BubbleToolKind;
  timestamp: number;
}

// ── Kanban (new column set) ──
// backlog → queued → in_progress → in_review → done
// `fixing` story status folds into `in_progress` (remediation attempt).
// `failed` stays visible in its current column with a red treatment.
// `skipped` reads as `done` (grey).

export type KanbanColumn = 'backlog' | 'queued' | 'in_progress' | 'in_review' | 'done';

export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  'backlog',
  'queued',
  'in_progress',
  'in_review',
  'done',
] as const;

export interface KanbanStory {
  storyId: string;
  epicId: string;
  epicTitle: string;
  /** FK to owning plan. `null` for legacy epics created before Epic 17. */
  planId: string | null;
  title: string;
  column: KanbanColumn;
  wave: number | null;
  assigneeCharacterId: CharacterId | null;
  assigneeName: string | null;
  failed: boolean;
  attempt: number;
}

// ── Chat bubble ──

export interface ChatBubble {
  id: string;
  characterId: CharacterId;
  text: string;
  emoji: string;
  createdAt: number;
  isMilestone: boolean;
  /** Epic E — visual tier. Drives color + outline + lifetime. */
  tier: BubbleTier;
  /** Tool family for `action` tier — picks the leading dot color. */
  toolKind?: BubbleToolKind;
  /** Hex plan color inherited from assignment at push time. */
  planColor?: string;
}

// ── Event log entry ──

export interface OfficeLogEntry {
  id: string;
  characterId: CharacterId | 'system';
  characterName: string;
  role: PersonaRole | 'system';
  message: string;
  emoji: string;
  time: string;
  color: number;
}
