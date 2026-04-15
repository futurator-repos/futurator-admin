import * as THREE from 'three';
import { COLORS } from './office-constants';

// ── Geometry helpers ──

function bx(w: number, h: number, d: number, c: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: c }),
  );
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cy(rt: number, rb: number, h: number, c: number, x = 0, y = 0, z = 0, s = 8): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(rt, rb, h, s),
    new THREE.MeshLambertMaterial({ color: c }),
  );
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ── Furniture builders ──

export function buildDesk(x: number, z: number, deskIndex: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  // Desktop
  g.add(bx(1.2, 0.06, 0.7, COLORS.desk, 0, 0.72, 0));
  // Legs
  for (const lx of [-0.5, 0.5]) {
    for (const lz of [-0.28, 0.28]) {
      g.add(cy(0.03, 0.03, 0.7, COLORS.deskLeg, lx, 0.35, lz));
    }
  }
  // Monitor
  g.add(bx(0.5, 0.35, 0.03, COLORS.monitor, 0, 1.1, -0.2));
  // Monitor screen — named so we can update its material later
  const screen = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.28, 0.01),
    new THREE.MeshLambertMaterial({ color: 0x1a1a2a }), // off = dark
  );
  screen.position.set(0, 1.12, -0.185);
  screen.castShadow = true;
  screen.receiveShadow = true;
  screen.name = `monitor-screen-${deskIndex}`;
  g.add(screen);
  g.add(cy(0.02, 0.02, 0.18, COLORS.monitor, 0, 0.84, -0.2));
  g.add(cy(0.08, 0.08, 0.02, COLORS.monitor, 0, 0.75, -0.2));
  return g;
}

export function buildChair(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.add(bx(0.45, 0.06, 0.45, COLORS.chairSeat, 0, 0.45, 0));
  g.add(bx(0.45, 0.4, 0.05, COLORS.chairSeat, 0, 0.7, -0.22));
  g.add(cy(0.03, 0.03, 0.4, COLORS.chair, 0, 0.24, 0));
  g.add(cy(0.18, 0.18, 0.03, COLORS.chair, 0, 0.04, 0));
  return g;
}

export function buildPlant(x: number, z: number, sc = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(sc);
  g.add(cy(0.15, 0.12, 0.25, COLORS.plantPot, 0, 0.125, 0));
  const f = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 8, 6),
    new THREE.MeshLambertMaterial({ color: COLORS.plant }),
  );
  f.position.y = 0.42;
  f.castShadow = true;
  g.add(f);
  return g;
}

export function buildKitchen(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.add(bx(2.5, 0.9, 0.6, COLORS.kitchenCounter, 0, 0.45, -0.7));
  g.add(bx(2.6, 0.04, 0.7, 0xcccccc, 0, 0.92, -0.7));
  g.add(bx(0.3, 0.4, 0.3, COLORS.coffeeMachine, -0.6, 1.12, -0.7));
  g.add(bx(0.05, 0.06, 0.15, 0xcc4444, -0.6, 1.05, -0.48));
  g.add(bx(0.5, 0.08, 0.35, 0x999999, 0.4, 0.94, -0.7));
  g.add(bx(0.7, 1.7, 0.6, 0xdddddd, -1.5, 0.85, -0.7));
  g.add(bx(0.68, 0.02, 0.02, 0xaaaaaa, -1.5, 1.1, -0.38));
  g.add(bx(0.68, 0.02, 0.02, 0xaaaaaa, -1.5, 0.5, -0.38));
  return g;
}

export function buildMeetingTable(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const t = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 0.06, 16),
    new THREE.MeshLambertMaterial({ color: COLORS.meetingTable }),
  );
  t.position.y = 0.72;
  t.castShadow = true;
  t.receiveShadow = true;
  g.add(t);
  g.add(cy(0.08, 0.12, 0.7, COLORS.deskLeg, 0, 0.35, 0));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const ch = buildChair(Math.cos(a) * 1.6, Math.sin(a) * 1.6);
    ch.rotation.y = -a + Math.PI;
    ch.scale.setScalar(0.8);
    g.add(ch);
  }
  return g;
}

export function buildWhiteboard(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.add(bx(1.8, 1.2, 0.05, COLORS.whiteboardFrame, 0, 1.4, -0.5));
  // Whiteboard surface — named for raycasting + dynamic texture
  const surface = new THREE.Mesh(
    new THREE.BoxGeometry(1.65, 1.05, 0.02),
    new THREE.MeshLambertMaterial({ color: COLORS.whiteboard }),
  );
  surface.position.set(0, 1.42, -0.47);
  surface.castShadow = true;
  surface.receiveShadow = true;
  surface.name = 'whiteboard-surface';
  g.add(surface);
  g.add(cy(0.03, 0.03, 0.7, COLORS.whiteboardFrame, -0.7, 0.35, -0.5));
  g.add(cy(0.03, 0.03, 0.7, COLORS.whiteboardFrame, 0.7, 0.35, -0.5));
  g.add(bx(0.6, 0.04, 0.08, COLORS.whiteboardFrame, 0, 0.82, -0.42));
  return g;
}

export function buildBookshelf(x: number, z: number, rY = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rY;
  g.add(bx(1.0, 1.6, 0.3, COLORS.bookshelf, 0, 0.8, 0));
  for (let i = 0; i < 4; i++) {
    g.add(bx(0.96, 0.03, 0.28, 0x8a6a4a, 0, 0.3 + i * 0.38, 0));
  }
  const bc = [0xcc4444, 0x4444cc, 0x44aa44, 0xccaa44, 0x8844aa];
  for (let s = 0; s < 3; s++) {
    let bxx = -0.4;
    const count = 4 + Math.floor(Math.random() * 2);
    for (let b = 0; b < count; b++) {
      const bw = 0.06 + Math.random() * 0.08;
      const bh = 0.25 + Math.random() * 0.1;
      g.add(
        bx(
          bw,
          bh,
          0.2,
          bc[Math.floor(Math.random() * bc.length)],
          bxx + bw / 2,
          0.32 + s * 0.38 + bh / 2,
          0,
        ),
      );
      bxx += bw + 0.02;
    }
  }
  return g;
}

export function buildLounge(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.add(bx(1.8, 0.35, 0.7, 0x5a6a7a, 0, 0.25, -0.6));
  g.add(bx(1.8, 0.45, 0.12, 0x4a5a6a, 0, 0.55, -0.9));
  g.add(bx(0.12, 0.25, 0.7, 0x4a5a6a, -0.9, 0.45, -0.6));
  g.add(bx(0.12, 0.25, 0.7, 0x4a5a6a, 0.9, 0.45, -0.6));
  g.add(bx(0.8, 0.04, 0.5, 0x9a7a5a, 0, 0.38, 0.3));
  g.add(cy(0.03, 0.03, 0.36, COLORS.deskLeg, -0.32, 0.18, 0.3));
  g.add(cy(0.03, 0.03, 0.36, COLORS.deskLeg, 0.32, 0.18, 0.3));
  g.add(bx(2.4, 0.01, 2.0, COLORS.rug, 0, 0.005, -0.1));
  return g;
}

export function buildWalls(scene: THREE.Scene): void {
  const H = 2.2;
  const T = 0.12;
  const W = 20;
  const D = 16;
  scene.add(bx(W, H, T, COLORS.wall, 0, H / 2, -D / 2));
  scene.add(bx(W, 0.08, T + 0.1, COLORS.wallTop, 0, H, -D / 2));
  scene.add(bx(T, H, D, COLORS.wall, W / 2, H / 2, 0));
  scene.add(bx(T + 0.1, 0.08, D, COLORS.wallTop, W / 2, H, 0));
  scene.add(bx(T, H, 8, COLORS.wall, -W / 2, H / 2, -4));
  scene.add(bx(T + 0.1, 0.08, 8, COLORS.wallTop, -W / 2, H, -4));
  // Glass partition
  const gl = new THREE.Mesh(
    new THREE.BoxGeometry(T, H * 0.7, 5),
    new THREE.MeshLambertMaterial({ color: 0xaaccee, transparent: true, opacity: 0.3 }),
  );
  gl.position.set(3.5, H * 0.35, 3);
  scene.add(gl);
  scene.add(bx(T + 0.04, 0.06, 5, 0x666666, 3.5, H * 0.7, 3));
  scene.add(bx(T + 0.04, H * 0.7, 0.06, 0x666666, 3.5, H * 0.35, 0.5));
  scene.add(bx(T + 0.04, H * 0.7, 0.06, 0x666666, 3.5, H * 0.35, 5.5));
}

export function buildFloor(scene: THREE.Scene): void {
  const S = 20;
  const D = 16;
  const TS = 2;
  for (let x = -S / 2; x < S / 2; x += TS) {
    for (let z = -D / 2; z < D / 2; z += TS) {
      const alt = (((x / TS + z / TS) % 2) + 2) % 2 === 0;
      const t = bx(
        TS - 0.02,
        0.05,
        TS - 0.02,
        alt ? COLORS.floor : COLORS.floorAlt,
        x + TS / 2,
        -0.025,
        z + TS / 2,
      );
      t.receiveShadow = true;
      t.castShadow = false;
      scene.add(t);
    }
  }
}
