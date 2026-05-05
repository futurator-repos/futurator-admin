import * as THREE from 'three';
import {
  CHARACTER_RADIUS,
  COFFEE_POS,
  COUCH_POS,
  DESK_OFFSET,
  DESK_SCALE,
  DOOR_WIDTH,
  MEETING_DOOR_WIDTH,
  MEETING_DOOR_Z,
  MEETING_TABLE_BBOX,
  MEETING_TABLE_POS,
  MGMT,
  MGMT_DOOR_WIDTH,
  MGMT_DOOR_Z,
  MGMT_TABLE_POS,
  MGMT_TABLE_RADIUS,
  ROOM,
  ROOM2,
  ROOM3,
  SERVER_DOOR_Z,
  SUPERVISOR_POS,
  WORKSTATIONS,
} from './constants';

// ── Obstacle model ─────────────────────────────────────────────────────────
// Every visible prop a character must not walk through has one AABB here.
// AABBs are INFLATED by CHARACTER_RADIUS so the character's footprint, not
// its origin, respects the boundary. Used for (a) rasterizing the grid and
// (b) string-pulling line-of-sight checks.

export interface Obstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  tag?: string;
}

function inflate(ob: Omit<Obstacle, 'tag'> & { tag?: string }): Obstacle {
  return {
    minX: ob.minX - CHARACTER_RADIUS,
    maxX: ob.maxX + CHARACTER_RADIUS,
    minZ: ob.minZ - CHARACTER_RADIUS,
    maxZ: ob.maxZ + CHARACTER_RADIUS,
    tag: ob.tag,
  };
}

export const OBSTACLES: readonly Obstacle[] = [
  // Workstation desks (6)
  ...WORKSTATIONS.map((ws): Obstacle => {
    const off = DESK_OFFSET.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ws.rotY);
    const cx = ws.pos[0] + off.x;
    const cz = ws.pos[2] + off.z;
    return inflate({
      minX: cx - DESK_SCALE[0],
      maxX: cx + DESK_SCALE[0],
      minZ: cz - DESK_SCALE[2],
      maxZ: cz + DESK_SCALE[2],
      tag: `desk-${ws.slot}`,
    });
  }),
  // Supervisor desk — one extra workstation along the left wall
  inflate({
    minX: SUPERVISOR_POS[0] - DESK_SCALE[0],
    maxX: SUPERVISOR_POS[0] + DESK_SCALE[0],
    minZ: SUPERVISOR_POS[2] + 1 - DESK_SCALE[2],
    maxZ: SUPERVISOR_POS[2] + 1 + DESK_SCALE[2],
    tag: 'desk-supervisor',
  }),
  // Coffee table
  inflate({
    minX: COFFEE_POS.x - 1.2,
    maxX: COFFEE_POS.x + 1.2,
    minZ: COFFEE_POS.z - 0.75,
    maxZ: COFFEE_POS.z + 0.75,
    tag: 'coffee-table',
  }),
  // Couch (8,0,9) rotated — long edge along Z
  inflate({
    minX: COUCH_POS[0] - 0.5,
    maxX: COUCH_POS[0] + 0.5,
    minZ: COUCH_POS[2] - 1,
    maxZ: COUCH_POS[2] + 1,
    tag: 'couch',
  }),
  // Mgmt round table (approx square AABB around the circle)
  inflate({
    minX: MGMT_TABLE_POS[0] - MGMT_TABLE_RADIUS,
    maxX: MGMT_TABLE_POS[0] + MGMT_TABLE_RADIUS,
    minZ: MGMT_TABLE_POS[2] - MGMT_TABLE_RADIUS,
    maxZ: MGMT_TABLE_POS[2] + MGMT_TABLE_RADIUS,
    tag: 'mgmt-round-table',
  }),
  // Meeting long table
  inflate({
    minX: MEETING_TABLE_POS[0] - MEETING_TABLE_BBOX.halfX,
    maxX: MEETING_TABLE_POS[0] + MEETING_TABLE_BBOX.halfX,
    minZ: MEETING_TABLE_POS[2] - MEETING_TABLE_BBOX.halfZ,
    maxZ: MEETING_TABLE_POS[2] + MEETING_TABLE_BBOX.halfZ,
    tag: 'meeting-long-table',
  }),

  // ── Main office right wall (4 segments + 3 doors) ──
  inflate({
    minX: ROOM.half - 0.1,
    maxX: ROOM.half + 0.1,
    minZ: -ROOM.half,
    maxZ: SERVER_DOOR_Z - DOOR_WIDTH / 2,
    tag: 'wall-right-a',
  }),
  inflate({
    minX: ROOM.half - 0.1,
    maxX: ROOM.half + 0.1,
    minZ: SERVER_DOOR_Z + DOOR_WIDTH / 2,
    maxZ: MGMT_DOOR_Z - MGMT_DOOR_WIDTH / 2,
    tag: 'wall-right-b',
  }),
  inflate({
    minX: ROOM.half - 0.1,
    maxX: ROOM.half + 0.1,
    minZ: MGMT_DOOR_Z + MGMT_DOOR_WIDTH / 2,
    maxZ: MEETING_DOOR_Z - MEETING_DOOR_WIDTH / 2,
    tag: 'wall-right-c',
  }),
  inflate({
    minX: ROOM.half - 0.1,
    maxX: ROOM.half + 0.1,
    minZ: MEETING_DOOR_Z + MEETING_DOOR_WIDTH / 2,
    maxZ: ROOM.half,
    tag: 'wall-right-d',
  }),

  // Main office left wall (full) — Milena stands just off this wall at the
  // whiteboard position, so no door gap here.
  inflate({
    minX: -ROOM.half - 0.1,
    maxX: -ROOM.half + 0.1,
    minZ: -ROOM.half,
    maxZ: ROOM.half,
    tag: 'wall-left',
  }),
  // Main office back wall
  inflate({
    minX: -ROOM.half,
    maxX: ROOM.half,
    minZ: -ROOM.half - 0.1,
    maxZ: -ROOM.half + 0.1,
    tag: 'wall-back',
  }),

  // ── Server room perimeter ──
  inflate({
    minX: ROOM2.minX,
    maxX: ROOM2.maxX,
    minZ: ROOM2.minZ - 0.1,
    maxZ: ROOM2.minZ + 0.1,
    tag: 'srv-wall-back',
  }),
  inflate({
    minX: ROOM2.minX,
    maxX: ROOM2.maxX,
    minZ: ROOM2.maxZ - 0.1,
    maxZ: ROOM2.maxZ + 0.1,
    tag: 'srv-wall-front',
  }),
  inflate({
    minX: ROOM2.maxX - 0.1,
    maxX: ROOM2.maxX + 0.1,
    minZ: ROOM2.minZ,
    maxZ: ROOM2.maxZ,
    tag: 'srv-wall-east',
  }),

  // ── Management room perimeter ──
  inflate({
    minX: MGMT.minX,
    maxX: MGMT.maxX,
    minZ: MGMT.maxZ - 0.1,
    maxZ: MGMT.maxZ + 0.1,
    tag: 'mgmt-wall-south',
  }),
  inflate({
    minX: MGMT.maxX - 0.1,
    maxX: MGMT.maxX + 0.1,
    minZ: MGMT.minZ,
    maxZ: MGMT.maxZ,
    tag: 'mgmt-wall-east',
  }),

  // ── Meeting room perimeter ──
  inflate({
    minX: ROOM3.minX,
    maxX: ROOM3.maxX,
    minZ: ROOM3.maxZ - 0.1,
    maxZ: ROOM3.maxZ + 0.1,
    tag: 'mtg-wall-south',
  }),
  inflate({
    minX: ROOM3.maxX - 0.1,
    maxX: ROOM3.maxX + 0.1,
    minZ: ROOM3.minZ,
    maxZ: ROOM3.maxZ,
    tag: 'mtg-wall-east',
  }),
  inflate({
    minX: ROOM.half - 0.1,
    maxX: ROOM.half + 0.1,
    minZ: ROOM.half,
    maxZ: ROOM3.maxZ,
    tag: 'mtg-wall-west-outer',
  }),
];

// ── Slab-method segment/AABB hit — XZ-only ──

function segmentHitsObstacle(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  ob: Obstacle,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let tmin = 0;
  let tmax = 1;
  for (const [d, p, mn, mx] of [
    [dx, ax, ob.minX, ob.maxX] as const,
    [dz, az, ob.minZ, ob.maxZ] as const,
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (p < mn || p > mx) return false;
    } else {
      let t1 = (mn - p) / d;
      let t2 = (mx - p) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
  }
  return true;
}

function lineIsClear(ax: number, az: number, bx: number, bz: number): boolean {
  for (const ob of OBSTACLES) {
    if (segmentHitsObstacle(ax, az, bx, bz, ob)) return false;
  }
  return true;
}

// ── Uniform grid ──

const GRID_CELL = 0.5;
const GRID_MIN_X = -ROOM.half;
const GRID_MAX_X = ROOM2.maxX;
const GRID_MIN_Z = -ROOM.half;
const GRID_MAX_Z = ROOM3.maxZ;
const GRID_W = Math.ceil((GRID_MAX_X - GRID_MIN_X) / GRID_CELL);
const GRID_H = Math.ceil((GRID_MAX_Z - GRID_MIN_Z) / GRID_CELL);

const BLOCKED: Uint8Array = (() => {
  const arr = new Uint8Array(GRID_W * GRID_H);
  for (let gx = 0; gx < GRID_W; gx++) {
    const wx = GRID_MIN_X + (gx + 0.5) * GRID_CELL;
    for (let gz = 0; gz < GRID_H; gz++) {
      const wz = GRID_MIN_Z + (gz + 0.5) * GRID_CELL;
      for (const ob of OBSTACLES) {
        if (wx >= ob.minX && wx <= ob.maxX && wz >= ob.minZ && wz <= ob.maxZ) {
          arr[gx * GRID_H + gz] = 1;
          break;
        }
      }
    }
  }
  return arr;
})();

const isBlocked = (gx: number, gz: number): boolean =>
  gx < 0 ||
  gx >= GRID_W ||
  gz < 0 ||
  gz >= GRID_H ||
  BLOCKED[gx * GRID_H + gz] === 1;

const worldToGrid = (x: number, z: number): [number, number] => [
  Math.max(0, Math.min(GRID_W - 1, Math.floor((x - GRID_MIN_X) / GRID_CELL))),
  Math.max(0, Math.min(GRID_H - 1, Math.floor((z - GRID_MIN_Z) / GRID_CELL))),
];

const gridToWorld = (gx: number, gz: number): [number, number] => [
  GRID_MIN_X + (gx + 0.5) * GRID_CELL,
  GRID_MIN_Z + (gz + 0.5) * GRID_CELL,
];

function nearestWalkable(gx: number, gz: number): [number, number] | null {
  if (!isBlocked(gx, gz)) return [gx, gz];
  const visited = new Uint8Array(GRID_W * GRID_H);
  const q: number[] = [gx * GRID_H + gz];
  visited[gx * GRID_H + gz] = 1;
  for (let head = 0; head < q.length; head++) {
    const id = q[head];
    const cx = (id / GRID_H) | 0;
    const cz = id % GRID_H;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nx >= GRID_W || nz < 0 || nz >= GRID_H) continue;
      const nid = nx * GRID_H + nz;
      if (visited[nid]) continue;
      visited[nid] = 1;
      if (!isBlocked(nx, nz)) return [nx, nz];
      q.push(nid);
    }
  }
  return null;
}

// Octile heuristic — admissible + consistent for 8-way grids.
const octile = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
};

// Tiny binary min-heap keyed by `f`.
class MinHeap {
  private items: { id: number; f: number }[] = [];
  size() {
    return this.items.length;
  }
  push(item: { id: number; f: number }) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].f > this.items[i].f) {
        [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
        i = p;
      } else break;
    }
  }
  pop(): { id: number; f: number } | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let best = i;
        if (l < n && this.items[l].f < this.items[best].f) best = l;
        if (r < n && this.items[r].f < this.items[best].f) best = r;
        if (best === i) break;
        [this.items[i], this.items[best]] = [this.items[best], this.items[i]];
        i = best;
      }
    }
    return top;
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

function aStar(sx: number, sz: number, ex: number, ez: number): Array<[number, number]> | null {
  const startId = sx * GRID_H + sz;
  const endId = ex * GRID_H + ez;
  if (startId === endId) return [[sx, sz]];

  const open = new MinHeap();
  const came = new Map<number, number>();
  const gScore = new Map<number, number>();
  gScore.set(startId, 0);
  open.push({ id: startId, f: octile(sx, sz, ex, ez) });

  while (open.size() > 0) {
    const cur = open.pop()!;
    if (cur.id === endId) {
      const path: Array<[number, number]> = [];
      let n: number | undefined = cur.id;
      while (n !== undefined) {
        path.unshift([(n / GRID_H) | 0, n % GRID_H]);
        n = came.get(n);
      }
      return path;
    }
    const cx = (cur.id / GRID_H) | 0;
    const cz = cur.id % GRID_H;
    const curG = gScore.get(cur.id)!;
    for (const [dx, dz, cost] of NEIGHBOURS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (isBlocked(nx, nz)) continue;
      // No corner-cutting across diagonals.
      if (dx !== 0 && dz !== 0 && (isBlocked(cx + dx, cz) || isBlocked(cx, cz + dz))) continue;
      const nid = nx * GRID_H + nz;
      const tentativeG = curG + cost;
      if (tentativeG < (gScore.get(nid) ?? Infinity)) {
        came.set(nid, cur.id);
        gScore.set(nid, tentativeG);
        open.push({ id: nid, f: tentativeG + octile(nx, nz, ex, ez) });
      }
    }
  }
  return null;
}

function smoothPath(cells: Array<[number, number]>): Array<[number, number]> {
  if (cells.length <= 2) return cells.slice();
  const out: Array<[number, number]> = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    const [ax, az] = gridToWorld(cells[i][0], cells[i][1]);
    while (j > i + 1) {
      const [bx, bz] = gridToWorld(cells[j][0], cells[j][1]);
      if (lineIsClear(ax, az, bx, bz)) break;
      j--;
    }
    out.push(cells[j]);
    i = j;
  }
  return out;
}

export function computePath(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3[] {
  let [sx, sz] = worldToGrid(start.x, start.z);
  let [ex, ez] = worldToGrid(end.x, end.z);
  if (isBlocked(sx, sz)) {
    const n = nearestWalkable(sx, sz);
    if (n) [sx, sz] = n;
  }
  if (isBlocked(ex, ez)) {
    const n = nearestWalkable(ex, ez);
    if (n) [ex, ez] = n;
  }
  const cells = aStar(sx, sz, ex, ez);
  if (!cells || cells.length === 0) return [end.clone()];

  const smoothed = smoothPath(cells);
  const out: THREE.Vector3[] = [];
  for (let i = 1; i < smoothed.length; i++) {
    if (i === smoothed.length - 1) {
      out.push(end.clone());
    } else {
      const [wx, wz] = gridToWorld(smoothed[i][0], smoothed[i][1]);
      out.push(new THREE.Vector3(wx, 0, wz));
    }
  }
  if (out.length === 0) out.push(end.clone());
  return out;
}

export function snapToWalkable(p: THREE.Vector3): THREE.Vector3 {
  const east = p.x > ROOM.half;
  const inMeetingRoom = east && p.z >= MGMT.maxZ - 0.1;
  const inMgmtRoom = east && !inMeetingRoom && p.z >= ROOM2.maxZ - 0.1;
  const inServerRoom = east && !inMeetingRoom && !inMgmtRoom;
  let x = THREE.MathUtils.clamp(
    p.x,
    east ? ROOM2.minX + 0.4 : -ROOM.half + 0.4,
    east ? ROOM2.maxX - 0.4 : ROOM.half - 0.4,
  );
  let z = THREE.MathUtils.clamp(
    p.z,
    inServerRoom
      ? ROOM2.minZ + 0.4
      : inMgmtRoom
        ? MGMT.minZ + 0.4
        : inMeetingRoom
          ? ROOM3.minZ + 0.4
          : -ROOM.half + 0.4,
    inServerRoom
      ? ROOM2.maxZ - 0.4
      : inMgmtRoom
        ? MGMT.maxZ - 0.4
        : inMeetingRoom
          ? ROOM3.maxZ - 0.4
          : ROOM.half + 0.8,
  );
  for (const ob of OBSTACLES) {
    if (x < ob.minX || x > ob.maxX || z < ob.minZ || z > ob.maxZ) continue;
    const dxMin = x - ob.minX;
    const dxMax = ob.maxX - x;
    const dzMin = z - ob.minZ;
    const dzMax = ob.maxZ - z;
    const m = Math.min(dxMin, dxMax, dzMin, dzMax);
    if (m === dxMin) x = ob.minX - 0.05;
    else if (m === dxMax) x = ob.maxX + 0.05;
    else if (m === dzMin) z = ob.minZ - 0.05;
    else z = ob.maxZ + 0.05;
  }
  return new THREE.Vector3(x, p.y, z);
}
