import * as THREE from 'three';
import { COLORS } from './office-constants';
import type { SupervisorStatus } from '../event-translator';

// ── Supervisor desk (persistent, whiteboard-adjacent) ─────────────────────

export function buildSupervisorDesk(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);

  // Platform — taller + wider than a dev desk so it reads as "supervisor".
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.07, 0.9),
    new THREE.MeshLambertMaterial({ color: COLORS.supervisorDesk }),
  );
  top.position.y = 0.78;
  top.castShadow = true;
  top.receiveShadow = true;
  g.add(top);

  // Legs
  const legMat = new THREE.MeshLambertMaterial({ color: COLORS.deskLeg });
  for (const lx of [-0.7, 0.7]) {
    for (const lz of [-0.38, 0.38]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.78, 8), legMat);
      leg.position.set(lx, 0.39, lz);
      leg.castShadow = true;
      g.add(leg);
    }
  }

  // Tablet/laptop prop on the desk.
  const laptop = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.04, 0.3),
    new THREE.MeshLambertMaterial({ color: 0x222233 }),
  );
  laptop.position.set(0, 0.83, 0);
  laptop.castShadow = true;
  g.add(laptop);

  // Name plate (emissive tag) so the supervisor desk reads visually.
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.08, 0.02),
    new THREE.MeshBasicMaterial({ color: 0xe8e0c0 }),
  );
  plate.position.set(0, 0.9, 0.35);
  g.add(plate);

  g.name = 'supervisor-desk';
  return g;
}

// ── Review booth (persistent, distinct from dev desks) ────────────────────

export function buildReviewBooth(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);

  // Cubicle walls (three sides, open toward the dev row).
  const wallMat = new THREE.MeshLambertMaterial({ color: COLORS.reviewBooth });
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.06), wallMat);
  back.position.set(0, 0.6, -0.45);
  back.castShadow = true;
  back.receiveShadow = true;
  g.add(back);
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.9), wallMat);
  leftWall.position.set(-0.57, 0.5, 0);
  leftWall.castShadow = true;
  g.add(leftWall);
  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.9), wallMat);
  rightWall.position.set(0.57, 0.5, 0);
  rightWall.castShadow = true;
  g.add(rightWall);

  // Booth counter.
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.05, 0.5),
    new THREE.MeshLambertMaterial({ color: COLORS.reviewBoothSeat }),
  );
  counter.position.set(0, 0.78, -0.2);
  counter.castShadow = true;
  counter.receiveShadow = true;
  g.add(counter);

  // Monitor on the counter.
  const monitor = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.3, 0.03),
    new THREE.MeshLambertMaterial({ color: 0x1a1a2a }),
  );
  monitor.position.set(0, 1.0, -0.35);
  monitor.castShadow = true;
  g.add(monitor);

  g.name = 'review-booth';
  return g;
}

// ── Supervisor status ring ────────────────────────────────────────────────
//
// A flat ring suspended above the supervisor desk whose color encodes the
// orchestrator's current status (dispatching / waiting / conflict / failed).
// Idle fades to gray.

export function buildStatusRing(): THREE.Mesh {
  const geo = new THREE.RingGeometry(0.35, 0.48, 32);
  const mat = new THREE.MeshBasicMaterial({
    color: COLORS.statusRingIdle,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.name = 'supervisor-status-ring';
  return ring;
}

export function colorForSupervisorStatus(status: SupervisorStatus | 'idle'): number {
  switch (status) {
    case 'dispatching':
      return COLORS.statusRingGreen;
    case 'waiting':
      return COLORS.statusRingYellow;
    case 'conflict':
      return COLORS.statusRingOrange;
    case 'failed':
      return COLORS.statusRingRed;
    default:
      return COLORS.statusRingIdle;
  }
}

// ── Attempt badge (sprite hovering above a desk) ──────────────────────────
//
// A small canvas-textured sprite showing the attempt number. Updated in
// place when the attempt changes — we do not tear down and rebuild.

function makeBadgeTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#00000055';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = 'bold 58px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 2);
  }
  return new THREE.CanvasTexture(canvas);
}

export interface AttemptBadge {
  sprite: THREE.Sprite;
  setAttempt: (attempt: number) => void;
  currentAttempt: number;
}

export function buildAttemptBadge(attempt: number): AttemptBadge {
  let tex = makeBadgeTexture(String(attempt), '#f3c76a', '#2a1a05');
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.4, 0.4, 0.4);
  sprite.position.set(0.55, 1.55, 0);
  sprite.name = 'attempt-badge';

  const badge: AttemptBadge = {
    sprite,
    currentAttempt: attempt,
    setAttempt: (a) => {
      if (a === badge.currentAttempt) return;
      const next = makeBadgeTexture(String(a), '#f3c76a', '#2a1a05');
      mat.map?.dispose();
      mat.map = next;
      mat.needsUpdate = true;
      tex = next;
      badge.currentAttempt = a;
    },
  };
  return badge;
}

// ── Amber pulsing ring (blocked desks) ────────────────────────────────────

export interface AmberRing {
  mesh: THREE.Mesh;
  tick: (elapsed: number) => void;
}

export function buildAmberRing(): AmberRing {
  const geo = new THREE.RingGeometry(0.7, 0.85, 32);
  const mat = new THREE.MeshBasicMaterial({
    color: COLORS.amberRing,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.7,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  ring.name = 'amber-ring';

  return {
    mesh: ring,
    tick: (elapsed) => {
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3);
      mat.opacity = 0.45 + pulse * 0.4;
      const scale = 1 + pulse * 0.08;
      ring.scale.set(scale, scale, scale);
    },
  };
}

// ── Red ribbon (terminally failed desks, persistent) ──────────────────────

export function buildRedRibbon(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(1.4, 0.04, 0.12);
  const mat = new THREE.MeshLambertMaterial({ color: COLORS.terminalFailRibbon });
  const ribbon = new THREE.Mesh(geo, mat);
  ribbon.rotation.z = Math.PI / 10;
  ribbon.position.set(0, 0.75, 0.32);
  ribbon.name = 'red-ribbon';
  ribbon.castShadow = true;
  return ribbon;
}

// ── Blocker card (🚧 on whiteboard, per blocked story) ────────────────────

function makeBlockerCardTexture(storyId: string): THREE.CanvasTexture {
  const w = 256;
  const h = 160;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#f3c76a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#2a1a05';
    ctx.font = 'bold 70px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🚧', w / 2, h / 2 - 18);
    ctx.font = 'bold 26px -apple-system, system-ui, sans-serif';
    ctx.fillText(storyId, w / 2, h / 2 + 44);
    ctx.strokeStyle = '#2a1a0588';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
  }
  return new THREE.CanvasTexture(canvas);
}

export function buildBlockerCard(storyId: string): THREE.Mesh {
  const tex = makeBlockerCardTexture(storyId);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.24), mat);
  mesh.name = `blocker-card-${storyId}`;
  return mesh;
}

/** Layout helper: place up to 12 cards in a 4×3 grid on the whiteboard. */
export function blockerCardPosition(
  index: number,
  whiteboardX: number,
  whiteboardZ: number,
): { x: number; y: number; z: number } {
  const cols = 4;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const xOff = (col - (cols - 1) / 2) * 0.44;
  const yBase = 1.82;
  const yOff = -row * 0.28;
  return {
    x: whiteboardX + xOff,
    y: yBase + yOff,
    z: whiteboardZ - 0.44,
  };
}

// ── Reviewer ↔ dev connector line ─────────────────────────────────────────

export function buildReviewerConnector(from: THREE.Vector3, to: THREE.Vector3): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({
    color: COLORS.reviewBooth,
    transparent: true,
    opacity: 0.55,
  });
  const line = new THREE.Line(geo, mat);
  line.name = 'reviewer-connector';
  return line;
}

export function updateReviewerConnector(
  line: THREE.Line,
  from: THREE.Vector3,
  to: THREE.Vector3,
): void {
  const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (positions) {
    positions.setXYZ(0, from.x, from.y, from.z);
    positions.setXYZ(1, to.x, to.y, to.z);
    positions.needsUpdate = true;
  } else {
    line.geometry.setFromPoints([from, to]);
  }
}
