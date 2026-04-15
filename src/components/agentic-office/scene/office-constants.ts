import type { LocationKey } from '@/types/agentic-office';

// ── Colors ──

export const COLORS = {
  floor: 0xe8e0d4,
  floorAlt: 0xddd5c8,
  wall: 0x8b9dad,
  wallTop: 0xa3b5c7,
  desk: 0xc4a882,
  deskLeg: 0x8a7460,
  monitor: 0x2a2a2a,
  monitorScreen: 0x4a90d9,
  chair: 0x4a4a4a,
  chairSeat: 0x5a7a9a,
  plant: 0x5a8a5a,
  plantPot: 0xb8845a,
  whiteboard: 0xf0f0f0,
  whiteboardFrame: 0x888888,
  meetingTable: 0x7a6a5a,
  kitchenCounter: 0xaaaaaa,
  coffeeMachine: 0x333333,
  rug: 0x6a5a7a,
  bookshelf: 0x9a7a5a,
  bg: 0x1a1a2e,
} as const;

// ── Locations — 10 desks in 2 rows of 5 ──

export interface LocationDef {
  x: number;
  z: number;
  label: string;
  type: 'desk' | 'meeting' | 'lounge' | 'stand';
}

export const LOCATIONS: Record<string, LocationDef> = {
  // Row 1: 5 desks
  'desk-0': { x: -7, z: -5, label: 'Desk 1', type: 'desk' },
  'desk-1': { x: -7, z: -2, label: 'Desk 2', type: 'desk' },
  'desk-2': { x: -7, z: 1, label: 'Desk 3', type: 'desk' },
  'desk-3': { x: -7, z: 4, label: 'Desk 4', type: 'desk' },
  'desk-4': { x: -4, z: -5, label: 'Desk 5', type: 'desk' },
  // Row 2: 5 desks
  'desk-5': { x: -4, z: -2, label: 'Desk 6', type: 'desk' },
  'desk-6': { x: -4, z: 1, label: 'Desk 7', type: 'desk' },
  'desk-7': { x: -4, z: 4, label: 'Desk 8', type: 'desk' },
  'desk-8': { x: -1, z: -5, label: 'Desk 9', type: 'desk' },
  'desk-9': { x: -1, z: -2, label: 'Desk 10', type: 'desk' },
  // Functional areas
  kitchen: { x: 6, z: -5, label: 'Kitchen', type: 'stand' },
  meeting: { x: 6, z: 3, label: 'Meeting Room', type: 'meeting' },
  lounge: { x: 2, z: -5, label: 'Lounge', type: 'lounge' },
  whiteboard: { x: 6, z: 0, label: 'Whiteboard', type: 'stand' },
  entrance: { x: 0, z: 7, label: 'Entrance', type: 'stand' },
  hallway: { x: 0, z: 0, label: 'Hallway', type: 'stand' },
};

// ── Seat offsets ──

export const DESK_SEAT = { dx: 0, dz: 0.55, faceY: Math.PI };

export const MEETING_CENTER = { x: 6, z: 3 };
export const MEETING_SEATS = Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2;
  return { dx: Math.cos(a) * 1.5, dz: Math.sin(a) * 1.5, faceY: -a + Math.PI, taken: false };
});

export const LOUNGE_CENTER = { x: 2, z: -5 };
export const LOUNGE_SEATS = [
  { dx: -0.55, dz: -0.5, faceY: 0, taken: false },
  { dx: 0, dz: -0.5, faceY: 0, taken: false },
  { dx: 0.55, dz: -0.5, faceY: 0, taken: false },
];

// ── Poses ──

export interface Pose {
  bodyY: number;
  legRot: number;
  armRot: number;
  armZ: number;
  legY: number;
  shoeY: number;
}

export const POSE: Record<string, Pose> = {
  stand: { bodyY: 0.55, legRot: 0, armRot: 0, armZ: 0, legY: 0.22, shoeY: 0.05 },
  desk: { bodyY: 0.44, legRot: -1.3, armRot: -0.5, armZ: 0, legY: 0.35, shoeY: 0.22 },
  meet: { bodyY: 0.44, legRot: -1.3, armRot: -0.15, armZ: 0, legY: 0.35, shoeY: 0.22 },
  sofa: { bodyY: 0.3, legRot: -0.6, armRot: 0.25, armZ: 0.35, legY: 0.22, shoeY: 0.1 },
};

export function poseForLocation(key: string): Pose {
  const t = LOCATIONS[key]?.type;
  if (t === 'desk') return POSE.desk;
  if (t === 'meeting') return POSE.meet;
  if (t === 'lounge') return POSE.sofa;
  return POSE.stand;
}

// ── Seat position resolver ──

export function getSeatPosition(
  locKey: string,
  workerIdx: number,
): { x: number; z: number; faceY: number } {
  const loc = LOCATIONS[locKey];
  if (!loc) return { x: 0, z: 0, faceY: 0 };

  if (loc.type === 'desk') {
    return { x: loc.x + DESK_SEAT.dx, z: loc.z + DESK_SEAT.dz, faceY: DESK_SEAT.faceY };
  }
  if (loc.type === 'meeting') {
    const seat = MEETING_SEATS.find((s) => !s.taken) ?? MEETING_SEATS[workerIdx % 6];
    seat.taken = true;
    return { x: MEETING_CENTER.x + seat.dx, z: MEETING_CENTER.z + seat.dz, faceY: seat.faceY };
  }
  if (loc.type === 'lounge') {
    const seat = LOUNGE_SEATS.find((s) => !s.taken) ?? LOUNGE_SEATS[workerIdx % 3];
    seat.taken = true;
    return { x: LOUNGE_CENTER.x + seat.dx, z: LOUNGE_CENTER.z + seat.dz, faceY: seat.faceY };
  }
  // Stand: slight random offset
  return { x: loc.x + (Math.random() - 0.5) * 0.5, z: loc.z + 0.6, faceY: Math.PI };
}

export function releaseSeats() {
  MEETING_SEATS.forEach((s) => (s.taken = false));
  LOUNGE_SEATS.forEach((s) => (s.taken = false));
}

// ── Worker color palette ──

export interface WorkerAppearance {
  body: number;
  head: number;
  name: string;
}

const HEAD_TONES = [
  0xf5d0a9, 0xe8c090, 0xf0c8a0, 0xeac0a0, 0xf2d0b0, 0xe0b890, 0xd4a870, 0xc49060, 0xb87848,
  0xa06838, 0xdab890, 0xf0d8b0,
];

export const WORKER_PALETTE: WorkerAppearance[] = [
  { body: 0x4a90d9, head: HEAD_TONES[0], name: 'Alice' },
  { body: 0xd94a6a, head: HEAD_TONES[1], name: 'Bob' },
  { body: 0x5ab88a, head: HEAD_TONES[2], name: 'Carol' },
  { body: 0xd9a04a, head: HEAD_TONES[3], name: 'Dave' },
  { body: 0x8a5ad9, head: HEAD_TONES[4], name: 'Eve' },
  { body: 0xd95a4a, head: HEAD_TONES[5], name: 'Frank' },
  { body: 0x4ad9d9, head: HEAD_TONES[6], name: 'Grace' },
  { body: 0x9ad94a, head: HEAD_TONES[7], name: 'Hank' },
  { body: 0xd94ad9, head: HEAD_TONES[8], name: 'Ivy' },
  { body: 0x6a8ad9, head: HEAD_TONES[9], name: 'Jake' },
  { body: 0xd98a4a, head: HEAD_TONES[10], name: 'Kara' },
  { body: 0x4ad98a, head: HEAD_TONES[11], name: 'Leo' },
];

let nameCounter = 0;

export function nextWorkerAppearance(): WorkerAppearance {
  const appearance = WORKER_PALETTE[nameCounter % WORKER_PALETTE.length];
  nameCounter++;
  return appearance;
}

export function deskKeyForIndex(index: number): LocationKey {
  return `desk-${index}` as LocationKey;
}
