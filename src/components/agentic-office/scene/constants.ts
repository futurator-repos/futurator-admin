import * as THREE from 'three';
import { FURN_URL, RESTAURANT_URL } from '../cast';

// ── Asset URLs ──

export const CHAIR_URL = `${FURN_URL}/chair_A.gltf`;
export const DESK_URL = `${FURN_URL}/table_medium.gltf`;
export const LONG_TABLE_URL = `${FURN_URL}/table_medium_long.gltf`;
export const COFFEE_TABLE_URL = `${FURN_URL}/table_low.gltf`;
export const RUG_URL = `${FURN_URL}/rug_rectangle_A.gltf`;
export const RUG_LOUNGE_URL = `${FURN_URL}/rug_rectangle_B.gltf`;
export const PLANT_URL = `${FURN_URL}/cactus_medium_A.gltf`;
export const COUCH_URL = `${FURN_URL}/couch.gltf`;
export const COUCH_PILLOWS_URL = `${FURN_URL}/couch_pillows.gltf`;
export const SHELF_BIG_URL = `${FURN_URL}/shelf_A_big.gltf`;
export const SHELF_DECOR_URL = `${FURN_URL}/shelf_B_large_decorated.gltf`;
export const ROUND_TABLE_URL = `${RESTAURANT_URL}/table_round_B.gltf`;

// ── Room geometry ──
// Origin is the center of the main office. Y is up, distances in metres.
//
//                           -Z  (back)
//                        ┌─────────────────────────────┐
//                        │                             │
//                        │                             │ ← Server room
//                        │                             │   x ∈ [12, 24]
//                        │   Main Office               │   z ∈ [-12, -2]
//                        │   x ∈ [-12, 12]             │ ← Management room
//                        │   z ∈ [-12, 12]             │   x ∈ [12, 24]
//                        │                             │   z ∈ [-2, 6]
//                        │                             │ ← Meeting room
//                        │                             │   x ∈ [12, 24]
//                        │                             │   z ∈ [6, 16]
//                        └─────────────────────────────┘
//                           +Z  (front / camera)

export const ROOM = { half: 12, height: 4, thickness: 0.2 } as const;

export const ROOM2 = {
  minX: ROOM.half,
  maxX: ROOM.half + 12,
  minZ: -ROOM.half,
  maxZ: -2,
  height: ROOM.height,
} as const;

export const MGMT = {
  minX: ROOM.half,
  maxX: ROOM2.maxX,
  minZ: ROOM2.maxZ,
  maxZ: 6,
  height: ROOM.height,
} as const;

export const ROOM3 = {
  minX: ROOM.half,
  maxX: ROOM2.maxX,
  minZ: MGMT.maxZ,
  maxZ: MGMT.maxZ + 10,
  height: ROOM.height,
} as const;

// ── Doors ──

export const SERVER_DOOR_Z = -7;
export const MGMT_DOOR_Z = 2;
export const MEETING_DOOR_Z = 9;
export const DOOR_WIDTH = 2.4;
export const DOOR_HEIGHT = 3.2;
export const MGMT_DOOR_WIDTH = 2.4;
export const MEETING_DOOR_WIDTH = 2.4;

// ── Palette ──

export const WALL_COLOR = '#e9dfc7';
export const SERVER_FLOOR_COLOR = '#f3f4f8';
export const SERVER_WALL_COLOR = '#fafafc';
export const MGMT_FLOOR_COLOR = '#3b3a55';
export const MGMT_WALL_COLOR = '#e8e4dc';
export const MEETING_FLOOR_COLOR = '#b08968';
export const MEETING_WALL_COLOR = '#ede0cf';

// ── Workstations — a clean 4-column × 3-row grid, all facing -Z ──
// Column X positions are shared across all rows so the layout reads as a
// proper office with pods of 4. Role rows stack north→south following the
// pipeline flow: DEV → TEST → REVIEW.
//
//   Back   row  (z=-3)   slot 0..3   Bob / Carol / Dave / Eve        (devs)
//   Middle row  (z=0.5)  slot 8..11  Nadia / Olaf / Priya / Quinn    (testers)
//   Front  row  (z=4)    slot 4..7   Frank / Joseph / Sonia / Manuel (reviewers)
//
// Every desk has its own WORKSTATIONS entry — no more modulo-fallback
// (slots 6/7 used to share Bob/Carol's desks, which caused overlapping
// characters and "dead monitor" confusion when assignments cleared).

export interface WorkstationDef {
  slot: number;
  pos: [number, number, number];
  rotY: number;
  role?: 'developer' | 'reviewer' | 'tester'; // hint for monitor theme fallback
}

export const DESK_ROW_Z = { dev: -3, tester: 0.5, reviewer: 4 } as const;
export const TESTER_ROW_Z = DESK_ROW_Z.tester;
export const DESK_COLUMN_X = [-9, -3, 3, 9] as const;

export const WORKSTATIONS: readonly WorkstationDef[] = [
  // Dev row (back, z=-3)
  { slot: 0, pos: [DESK_COLUMN_X[0], 0, DESK_ROW_Z.dev], rotY: Math.PI, role: 'developer' },
  { slot: 1, pos: [DESK_COLUMN_X[1], 0, DESK_ROW_Z.dev], rotY: Math.PI, role: 'developer' },
  { slot: 2, pos: [DESK_COLUMN_X[2], 0, DESK_ROW_Z.dev], rotY: Math.PI, role: 'developer' },
  { slot: 3, pos: [DESK_COLUMN_X[3], 0, DESK_ROW_Z.dev], rotY: Math.PI, role: 'developer' },
  // Reviewer row (front, z=4)
  { slot: 4, pos: [DESK_COLUMN_X[0], 0, DESK_ROW_Z.reviewer], rotY: Math.PI, role: 'reviewer' },
  { slot: 5, pos: [DESK_COLUMN_X[1], 0, DESK_ROW_Z.reviewer], rotY: Math.PI, role: 'reviewer' },
  { slot: 6, pos: [DESK_COLUMN_X[2], 0, DESK_ROW_Z.reviewer], rotY: Math.PI, role: 'reviewer' },
  { slot: 7, pos: [DESK_COLUMN_X[3], 0, DESK_ROW_Z.reviewer], rotY: Math.PI, role: 'reviewer' },
  // Tester row (middle, z=0.5)
  { slot: 8, pos: [DESK_COLUMN_X[0], 0, DESK_ROW_Z.tester], rotY: Math.PI, role: 'tester' },
  { slot: 9, pos: [DESK_COLUMN_X[1], 0, DESK_ROW_Z.tester], rotY: Math.PI, role: 'tester' },
  { slot: 10, pos: [DESK_COLUMN_X[2], 0, DESK_ROW_Z.tester], rotY: Math.PI, role: 'tester' },
  { slot: 11, pos: [DESK_COLUMN_X[3], 0, DESK_ROW_Z.tester], rotY: Math.PI, role: 'tester' },
];

const WORKSTATIONS_BY_SLOT: ReadonlyMap<number, WorkstationDef> = new Map(
  WORKSTATIONS.map((w) => [w.slot, w] as const),
);

// Per-workstation geometry in chair-local frame.
export const SEAT_LOCAL_OFFSET = new THREE.Vector3(0, 0.05, 0.5);
export const DESK_OFFSET = new THREE.Vector3(0, 0, 1.7);
export const DESK_SCALE: [number, number, number] = [0.9, 0.75, 0.7];
export const DESK_TOP_Y = DESK_SCALE[1];

// ── Supervisor (Ricardo's) desk ──
// Adjacent to the whiteboard-stand, along the left wall.

export const SUPERVISOR_POS: [number, number, number] = [-7, 0, -9];
export const SUPERVISOR_ROT_Y = Math.PI;

// ── Whiteboard — Milena's home ──
// Flush on the LEFT wall (x = -ROOM.half) rotated π/2 → face normal +X.

export const WHITEBOARD_WALL_X = -ROOM.half;
export const WHITEBOARD_STAND = new THREE.Vector3(-10.5, 0, 0);
export const WHITEBOARD_FACING = -Math.PI / 2;

// ── Coffee station (main office, rear-left corner) ──

export const COFFEE_POS = new THREE.Vector3(-10, 0, -8);
export const COFFEE_STAND_OFFSET = new THREE.Vector3(0, 0, 1.6);
export const COFFEE_FACING = Math.PI;

// ── Entrance (front-center of main office) ──

export const ENTRANCE = new THREE.Vector3(0, 0, 11);

// ── Animation conventions ──

export const WALK_SPEED = 2.4;
export const ARRIVE_THRESHOLD = 0.08;
export const CHARACTER_RADIUS = 0.4;

export const ONE_SHOT_CLIPS = new Set(['SitDown', 'StandUp', 'PickUp', 'Shoot_OneHanded']);

export const ALL_CLIPS = [
  'Idle',
  'Walk',
  'Run',
  'Walk_Carry',
  'Run_Carry',
  'Jump',
  'Roll',
  'SitDown',
  'StandUp',
  'PickUp',
  'Punch',
  'SwordSlash',
  'Shoot_OneHanded',
  'RecieveHit',
  'Death',
  'Defeat',
  'Victory',
] as const;

// ── Couch (lounge) — 3 seats along world +Z axis of a rotated couch ──

export const COUCH_POS: [number, number, number] = [8, 0, 9];
export const COUCH_FACING = -Math.PI / 2;
const COUCH_SIT_FORWARD = 0.32;
const COUCH_SIT_LIFT = 0.02;

export const COUCH_SEATS: ReadonlyArray<{ slot: number; pos: THREE.Vector3; facing: number }> = [
  -0.6, 0, 0.6,
].map((dz, i) => ({
  slot: i,
  pos: new THREE.Vector3(
    COUCH_POS[0] - COUCH_SIT_FORWARD,
    COUCH_SIT_LIFT,
    COUCH_POS[2] + dz,
  ),
  facing: COUCH_FACING,
}));

// ── Management round table — 8 seats around a 3.6m-diameter table ──

export const MGMT_TABLE_POS: [number, number, number] = [
  (MGMT.minX + MGMT.maxX) / 2,
  0,
  (MGMT.minZ + MGMT.maxZ) / 2,
];
export const MGMT_TABLE_SCALE: [number, number, number] = [1.2, 0.75, 1.2];
export const MGMT_TABLE_RADIUS = 1.8;
const MGMT_CHAIR_RADIUS = 2.5;

export interface MgmtSeat {
  slot: number;
  chairPos: [number, number, number];
  chairRotY: number;
  pos: THREE.Vector3;
  facing: number;
}

export const MGMT_SEATS: readonly MgmtSeat[] = Array.from({ length: 8 }, (_, i): MgmtSeat => {
  const angle = (i / 8) * Math.PI * 2;
  const chairX = MGMT_TABLE_POS[0] + MGMT_CHAIR_RADIUS * Math.cos(angle);
  const chairZ = MGMT_TABLE_POS[2] + MGMT_CHAIR_RADIUS * Math.sin(angle);
  const rotY = Math.atan2(-Math.cos(angle), -Math.sin(angle));
  const seatX = chairX - 0.5 * Math.cos(angle);
  const seatZ = chairZ - 0.5 * Math.sin(angle);
  return {
    slot: i,
    chairPos: [chairX, 0, chairZ],
    chairRotY: rotY,
    pos: new THREE.Vector3(seatX, 0.05, seatZ),
    facing: rotY,
  };
});

// ── Meeting long table — 8 seats, 4 per side ──

export const MEETING_TABLE_POS: [number, number, number] = [18, 0, 11];
export const MEETING_TABLE_SCALE: [number, number, number] = [2.0, 1.05, 1.0];
export const MEETING_TABLE_BBOX = { halfX: 3.0, halfZ: 2.0 };

export interface MeetingSeat {
  slot: number;
  chairPos: [number, number, number];
  chairRotY: number;
  pos: THREE.Vector3;
  facing: number;
}

export const MEETING_SEATS: readonly MeetingSeat[] = (
  [-2.25, -0.75, 0.75, 2.25] as const
).flatMap((dx, i): MeetingSeat[] => {
  const northZ = MEETING_TABLE_POS[2] - MEETING_TABLE_BBOX.halfZ - 0.35;
  const southZ = MEETING_TABLE_POS[2] + MEETING_TABLE_BBOX.halfZ + 0.35;
  const xx = MEETING_TABLE_POS[0] + dx;
  return [
    {
      slot: i * 2,
      chairPos: [xx, 0, northZ],
      chairRotY: 0,
      pos: new THREE.Vector3(xx, 0.05, northZ + 0.5),
      facing: 0,
    },
    {
      slot: i * 2 + 1,
      chairPos: [xx, 0, southZ],
      chairRotY: Math.PI,
      pos: new THREE.Vector3(xx, 0.05, southZ - 0.5),
      facing: Math.PI,
    },
  ];
});

// ── Seat position resolver ──
// Maps a SeatRef {kind, slot} to a world-space target. Used by routing
// code when it commands a persona to `goto_seat`.

export interface SeatWorldPose {
  pos: THREE.Vector3;
  facing: number;
}

export function deskSeatPose(slot: number): SeatWorldPose {
  // All 12 slots (0..11) have explicit WORKSTATIONS entries in the 4×3
  // grid — the fallback only triggers for out-of-range slot numbers.
  // Facing = ws.rotY: the chair's +Z is where the seat opens (in chair
  // frame), and that's also the direction the seated character looks —
  // toward the desk/monitor which is placed at DESK_OFFSET (+Z local).
  const ws = WORKSTATIONS_BY_SLOT.get(slot) ?? WORKSTATIONS[0];
  const local = SEAT_LOCAL_OFFSET.clone();
  local.applyAxisAngle(new THREE.Vector3(0, 1, 0), ws.rotY);
  local.add(new THREE.Vector3(...ws.pos));
  return { pos: local, facing: ws.rotY };
}

export function workstationRoleForSlot(
  slot: number,
): 'developer' | 'reviewer' | 'tester' | null {
  return WORKSTATIONS_BY_SLOT.get(slot)?.role ?? null;
}

export function resolveSeatPose(
  kind:
    | 'desk'
    | 'couch'
    | 'meeting'
    | 'mgmt'
    | 'coffee'
    | 'whiteboard'
    | 'supervisor'
    | 'entrance',
  slot: number,
): SeatWorldPose {
  switch (kind) {
    case 'desk':
      return deskSeatPose(slot);
    case 'couch': {
      const s = COUCH_SEATS[slot] ?? COUCH_SEATS[0];
      return { pos: s.pos.clone(), facing: s.facing };
    }
    case 'meeting': {
      const s = MEETING_SEATS[slot] ?? MEETING_SEATS[0];
      return { pos: s.pos.clone(), facing: s.facing };
    }
    case 'mgmt': {
      const s = MGMT_SEATS[slot] ?? MGMT_SEATS[0];
      return { pos: s.pos.clone(), facing: s.facing };
    }
    case 'coffee':
      return {
        pos: COFFEE_POS.clone().add(COFFEE_STAND_OFFSET),
        facing: COFFEE_FACING,
      };
    case 'whiteboard':
      return { pos: WHITEBOARD_STAND.clone(), facing: WHITEBOARD_FACING };
    case 'supervisor': {
      const local = SEAT_LOCAL_OFFSET.clone();
      local.applyAxisAngle(new THREE.Vector3(0, 1, 0), SUPERVISOR_ROT_Y);
      local.add(new THREE.Vector3(...SUPERVISOR_POS));
      return { pos: local, facing: SUPERVISOR_ROT_Y };
    }
    case 'entrance':
    default:
      return { pos: ENTRANCE.clone(), facing: Math.PI };
  }
}
