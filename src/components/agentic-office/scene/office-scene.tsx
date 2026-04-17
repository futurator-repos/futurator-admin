'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useOfficeStore } from '@/stores/office-store';
import type { OfficeAction, OfficeWorker } from '@/types/agentic-office';
import { COLORS, LOCATIONS, POSE, poseForLocation, getSeatPosition } from './office-constants';
import {
  buildDesk,
  buildChair,
  buildFloor,
  buildWalls,
  buildKitchen,
  buildMeetingTable,
  buildWhiteboard,
  buildBookshelf,
  buildLounge,
  buildPlant,
} from './office-furniture';
import {
  buildSupervisorDesk,
  buildReviewBooth,
  buildStatusRing,
  colorForSupervisorStatus,
  buildAttemptBadge,
  buildAmberRing,
  buildRedRibbon,
  buildBlockerCard,
  blockerCardPosition,
  buildReviewerConnector,
  updateReviewerConnector,
  type AmberRing,
  type AttemptBadge,
} from './orchestrator-meshes';
import { createWorkerMesh, applyPose, lerp, type WorkerMesh } from './office-worker';
import { createChatBubble, updateBubble, type BubbleState } from './office-chat-bubble';
import {
  createScreenState,
  setScreenMode,
  updateScreen,
  createWhiteboardState,
  updateWhiteboard,
} from './office-screens';
import type { Pose } from './office-constants';

// Per-worker scene state (not in React/Zustand — purely Three.js local)
interface WorkerSceneState {
  mesh: WorkerMesh;
  target: { x: number; z: number; faceY: number } | null;
  targetKey: string;
  curLoc: string;
  walkPhase: number;
  sitT: number;
  curPose: Pose;
  tgtPose: Pose;
  state: 'walking' | 'sitting_down' | 'seated' | 'idle';
  bubble: BubbleState | null;
  seatFaceY: number;
}

const MAX_ACTIONS_PER_FRAME = 3;

export function OfficeScene() {
  const mountRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const clockRef = useRef(new THREE.Clock());
  const workersRef = useRef<Map<string, WorkerSceneState>>(new Map());

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // ── Scene setup ──
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.bg);
    scene.fog = new THREE.FogExp2(COLORS.bg, 0.018);

    const aspect = el.clientWidth / el.clientHeight;
    const frustum = 10;
    const cam = new THREE.OrthographicCamera(
      (-frustum * aspect) / 2,
      (frustum * aspect) / 2,
      frustum / 2,
      -frustum / 2,
      0.1,
      100,
    );
    const isoA = Math.PI / 6;
    const dist = 20;
    const camTarget = new THREE.Vector3(0, 0, 0);
    const camBaseOffset = new THREE.Vector3(
      dist * Math.cos(isoA),
      dist * Math.sin(Math.PI / 4),
      dist * Math.sin(isoA),
    );
    cam.position.copy(camBaseOffset);
    cam.lookAt(camTarget);
    cam.zoom = 0.85;
    cam.updateProjectionMatrix();

    const ren = new THREE.WebGLRenderer({ antialias: true });
    ren.setSize(el.clientWidth, el.clientHeight);
    ren.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    ren.shadowMap.enabled = true;
    ren.shadowMap.type = THREE.PCFSoftShadowMap;
    ren.toneMapping = THREE.ACESFilmicToneMapping;
    ren.toneMappingExposure = 1.1;
    el.appendChild(ren.domElement);

    // ── Lights ──
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dL = new THREE.DirectionalLight(0xfff4e0, 1.2);
    dL.position.set(8, 12, 6);
    dL.castShadow = true;
    dL.shadow.mapSize.set(2048, 2048);
    dL.shadow.camera.left = -15;
    dL.shadow.camera.right = 15;
    dL.shadow.camera.top = 15;
    dL.shadow.camera.bottom = -15;
    dL.shadow.camera.near = 0.1;
    dL.shadow.camera.far = 40;
    dL.shadow.bias = -0.002;
    scene.add(dL);
    const fillL = new THREE.DirectionalLight(0xc0d0ff, 0.3);
    fillL.position.set(-6, 8, -4);
    scene.add(fillL);

    // ── Environment ──
    buildFloor(scene);
    buildWalls(scene);

    // 10 desks
    for (let i = 0; i < 10; i++) {
      const loc = LOCATIONS[`desk-${i}`];
      if (loc) {
        scene.add(buildDesk(loc.x, loc.z, i));
        const ch = buildChair(loc.x, loc.z + 0.55);
        ch.rotation.y = Math.PI;
        scene.add(ch);
      }
    }

    scene.add(buildKitchen(6, -5));
    scene.add(buildMeetingTable(6, 3));
    scene.add(buildWhiteboard(6, 0));
    scene.add(buildLounge(2, -5));

    // ── Supervisor desk + status ring (Epic 6.2) ──
    const supervisorLoc = LOCATIONS['supervisor-desk'];
    const supervisorDesk = buildSupervisorDesk(supervisorLoc.x, supervisorLoc.z);
    scene.add(supervisorDesk);
    const statusRing = buildStatusRing();
    statusRing.position.set(supervisorLoc.x, 1.7, supervisorLoc.z);
    scene.add(statusRing);

    // ── Review booth (Epic 6.2) ──
    const boothLoc = LOCATIONS['review-booth'];
    const reviewBooth = buildReviewBooth(boothLoc.x, boothLoc.z);
    scene.add(reviewBooth);

    // Whiteboard location — for blocker cards layout.
    const whiteboardLoc = LOCATIONS.whiteboard;

    // Orchestrator-overlay maps (per-storyId / per-card instances).
    const attemptBadges = new Map<string, AttemptBadge>();
    const amberRings = new Map<string, AmberRing>();
    const redRibbons = new Map<string, THREE.Mesh>();
    const blockerCardMeshes = new Map<string, THREE.Mesh>();
    const reviewerConnectors = new Map<string, THREE.Line>();

    // ── Monitor screen states ──
    const screenStates: ReturnType<typeof createScreenState>[] = [];
    for (let i = 0; i < 10; i++) {
      const screenMesh = scene.getObjectByName(`monitor-screen-${i}`) as THREE.Mesh | undefined;
      if (screenMesh) {
        const ss = createScreenState();
        screenStates.push(ss);
        screenMesh.material = new THREE.MeshBasicMaterial({ map: ss.texture });
      }
    }

    // ── Whiteboard dynamic texture ──
    const wbState = createWhiteboardState();
    const wbSurface = scene.getObjectByName('whiteboard-surface') as THREE.Mesh | undefined;
    if (wbSurface) {
      wbSurface.material = new THREE.MeshBasicMaterial({ map: wbState.texture });
    }

    // ── Raycaster for clickable objects ──
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let didDrag = false;
    scene.add(buildPlant(-9, -7, 1.2));
    scene.add(buildPlant(9, -7, 0.9));
    scene.add(buildPlant(-9, 5, 1.0));
    scene.add(buildPlant(3.5, 0.3, 0.8));
    scene.add(buildPlant(3.5, 5.7, 1.1));
    scene.add(buildBookshelf(-9, -2, 0));
    scene.add(buildBookshelf(-9, 1, 0));

    // ── Camera controls ──
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.zoom = Math.max(0.35, Math.min(2.5, cam.zoom - e.deltaY * 0.001));
      cam.updateProjectionMatrix();
    };
    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      didDrag = false;
      dragStart = { x: e.clientX, y: e.clientY };
      el.style.cursor = 'grabbing';
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      didDrag = true;
      const dx = ((e.clientX - dragStart.x) * 0.02) / cam.zoom;
      const dy = ((e.clientY - dragStart.y) * 0.02) / cam.zoom;
      camTarget.x -= dx * Math.cos(isoA) + dy * Math.sin(isoA) * 0.5;
      camTarget.z += dx * Math.sin(isoA) - dy * Math.cos(isoA) * 0.5;
      camTarget.x = Math.max(-12, Math.min(12, camTarget.x));
      camTarget.z = Math.max(-10, Math.min(10, camTarget.z));
      cam.position.copy(camTarget).add(camBaseOffset);
      cam.lookAt(camTarget);
      dragStart = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      isDragging = false;
      el.style.cursor = 'grab';

      // Click detection (not a drag) → check for interactive objects
      if (!didDrag && wbSurface) {
        const rect = el.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, cam);
        const hits = raycaster.intersectObject(wbSurface);
        if (hits.length > 0) {
          const store = useOfficeStore.getState();
          store.setKanbanOpen(!store.kanbanOpen);
        }
      }
    };
    const onCtx = (e: MouseEvent) => e.preventDefault();

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointerleave', onPointerUp);
    el.addEventListener('contextmenu', onCtx);
    el.style.cursor = 'grab';

    // ── Worker management functions ──
    const workerMap = workersRef.current;

    function spawnWorkerInScene(data: OfficeWorker) {
      if (workerMap.has(data.id)) return;
      const mesh = createWorkerMesh(data.color, data.headColor);
      const entrance = LOCATIONS.entrance;
      mesh.position.set(entrance.x, 0, entrance.z);
      applyPose(mesh, POSE.stand);
      scene.add(mesh);

      workerMap.set(data.id, {
        mesh,
        target: null,
        targetKey: 'entrance',
        curLoc: 'entrance',
        walkPhase: Math.random() * Math.PI * 2,
        sitT: 1,
        curPose: { ...POSE.stand },
        tgtPose: { ...POSE.stand },
        state: 'idle',
        bubble: null,
        seatFaceY: 0,
      });
    }

    function moveWorkerInScene(workerId: string, locKey: string) {
      const ws = workerMap.get(workerId);
      if (!ws) return;
      const idx = [...workerMap.keys()].indexOf(workerId);
      const seat = getSeatPosition(locKey, idx);
      ws.target = { x: seat.x, z: seat.z, faceY: seat.faceY };
      ws.targetKey = locKey;
      ws.state = 'walking';
      ws.tgtPose = { ...POSE.stand };
      ws.sitT = 0;
    }

    function showBubble(
      workerId: string,
      text: string,
      emoji: string,
      isMilestone: boolean,
      bodyColor: number,
    ) {
      const ws = workerMap.get(workerId);
      if (!ws) return;
      // Remove existing bubble
      if (ws.bubble) {
        ws.mesh.remove(ws.bubble.sprite);
        ws.bubble = null;
      }
      const displayText = emoji ? `${emoji} ${text}` : text;
      const sprite = createChatBubble(displayText, bodyColor, isMilestone);
      ws.mesh.add(sprite);
      ws.bubble = { sprite, phase: 'fade_in', elapsed: 0, isMilestone };
    }

    function removeWorkerFromScene(workerId: string) {
      const ws = workerMap.get(workerId);
      if (!ws) return;
      if (ws.bubble) ws.mesh.remove(ws.bubble.sprite);
      scene.remove(ws.mesh);
      workerMap.delete(workerId);
    }

    // ── Process store actions ──
    function processActions() {
      const store = useOfficeStore.getState();
      const actions = store.consumeActions(MAX_ACTIONS_PER_FRAME);

      for (const action of actions) {
        handleAction(action);
      }

      // Sync: check for workers in store that aren't in scene (catch-up on missed spawns)
      for (const [id, w] of store.workers) {
        if (!workerMap.has(id)) {
          spawnWorkerInScene(w);
          if (w.targetLocation) {
            moveWorkerInScene(id, w.targetLocation);
          } else if (w.location !== 'entrance') {
            moveWorkerInScene(id, w.location);
          }
        }
      }

      // Remove workers no longer in store
      for (const id of workerMap.keys()) {
        if (!store.workers.has(id)) {
          removeWorkerFromScene(id);
        }
      }
    }

    function handleAction(action: OfficeAction) {
      switch (action.type) {
        case 'spawn': {
          const w = useOfficeStore.getState().getWorker(action.workerId);
          if (w) spawnWorkerInScene(w);
          break;
        }
        case 'move': {
          if (action.location) moveWorkerInScene(action.workerId, action.location);
          break;
        }
        case 'chat':
        case 'milestone': {
          const w = useOfficeStore.getState().getWorker(action.workerId);
          if (w && action.message) {
            showBubble(
              action.workerId,
              action.message,
              action.emoji ?? '',
              action.type === 'milestone',
              w.color,
            );
          }
          break;
        }
        case 'despawn': {
          removeWorkerFromScene(action.workerId);
          break;
        }
      }
    }

    // ── Animation loop ──
    const animate = () => {
      animRef.current = requestAnimationFrame(animate);
      const dt = clockRef.current.getDelta();
      const time = clockRef.current.getElapsedTime();
      const store = useOfficeStore.getState();
      const sp = store.speed;

      if (!store.isPaused) {
        processActions();
      }

      for (const [, ws] of workerMap) {
        const m = ws.mesh;

        // Walking
        if (ws.state === 'walking' && ws.target) {
          const dx = ws.target.x - m.position.x;
          const dz = ws.target.z - m.position.z;
          const dist = Math.sqrt(dx * dx + dz * dz);

          if (dist < 0.1) {
            ws.state = 'sitting_down';
            ws.curLoc = ws.targetKey;
            ws.tgtPose = poseForLocation(ws.targetKey);
            ws.sitT = 0;
            ws.seatFaceY = ws.target.faceY;
            ws.target = null;
          } else {
            const step = Math.min(2.0 * dt * sp, dist);
            m.position.x += (dx / dist) * step;
            m.position.z += (dz / dist) * step;
            m.rotation.y = Math.atan2(dx, dz);
            ws.walkPhase += dt * 10 * sp;
            const sw = Math.sin(ws.walkPhase) * 0.4;
            m._lA.rotation.x = sw;
            m._rA.rotation.x = -sw;
            m._lA.rotation.z = 0;
            m._rA.rotation.z = 0;
            m._lL.rotation.x = -sw * 0.6;
            m._rL.rotation.x = sw * 0.6;
            m._body.position.y = 0.55 + Math.abs(Math.sin(ws.walkPhase * 2)) * 0.03;
            m._shoulder.position.y = 0.75 + Math.abs(Math.sin(ws.walkPhase * 2)) * 0.03;
            m._lL.position.y = 0.22;
            m._rL.position.y = 0.22;
            m._lS.position.y = 0.05;
            m._rS.position.y = 0.05;
          }
        }

        // Sitting down transition
        if (ws.state === 'sitting_down') {
          ws.sitT += dt * 3 * sp;
          const t = Math.min(ws.sitT, 1);
          const e = t * (2 - t); // ease-out
          const p = ws.tgtPose;

          m.rotation.y = lerp(m.rotation.y, ws.seatFaceY, e);
          m._body.position.y = lerp(m._body.position.y, p.bodyY, e);
          m._shoulder.position.y = m._body.position.y + 0.2;
          m._lL.rotation.x = lerp(m._lL.rotation.x, p.legRot, e);
          m._rL.rotation.x = lerp(m._rL.rotation.x, p.legRot, e);
          m._lA.rotation.x = lerp(m._lA.rotation.x, p.armRot, e);
          m._rA.rotation.x = lerp(m._rA.rotation.x, p.armRot, e);
          m._lA.rotation.z = lerp(m._lA.rotation.z, -p.armZ, e);
          m._rA.rotation.z = lerp(m._rA.rotation.z, p.armZ, e);
          m._lL.position.y = lerp(m._lL.position.y, p.legY, e);
          m._rL.position.y = lerp(m._rL.position.y, p.legY, e);
          m._lS.position.y = lerp(m._lS.position.y, p.shoeY, e);
          m._rS.position.y = lerp(m._rS.position.y, p.shoeY, e);

          if (t >= 1) {
            ws.state = 'seated';
            ws.curPose = { ...p };
          }
        }

        // Seated animations
        if (ws.state === 'seated') {
          const entries = [...workerMap.entries()];
          const workerEntry = entries.find(([, v]) => v === ws);
          const wi = workerEntry ? entries.indexOf(workerEntry) : 0;
          const br = Math.sin(time * 1.5 + wi * 1.3) * 0.008;
          m._body.position.y = ws.curPose.bodyY + br;
          m._shoulder.position.y = ws.curPose.bodyY + 0.2 + br;

          const loc = LOCATIONS[ws.curLoc];
          if (loc?.type === 'desk') {
            // Suppress typing motion on blocked/terminal-fail desks so the
            // worker reads as idle/motionless (Epic 6.4).
            const workerData = workerEntry
              ? useOfficeStore.getState().workers.get(workerEntry[0])
              : null;
            const storyIdForDesk = workerData?.storyId ?? null;
            const deskState = storyIdForDesk
              ? useOfficeStore.getState().orchestrator.deskStates[storyIdForDesk]
              : undefined;
            const isQuiet = deskState?.blocked || deskState?.terminalFail;
            if (isQuiet) {
              m._lA.rotation.x = ws.curPose.armRot;
              m._rA.rotation.x = ws.curPose.armRot;
            } else {
              const ty = Math.sin(time * 8 + wi * 2) * 0.06;
              m._lA.rotation.x = ws.curPose.armRot + ty;
              m._rA.rotation.x = ws.curPose.armRot - ty;
            }
          }
        }

        // Idle
        if (ws.state === 'idle') {
          const wi = [...workerMap.keys()].indexOf(
            [...workerMap.entries()].find(([, v]) => v === ws)?.[0] ?? '',
          );
          const br = Math.sin(time * 2 + wi) * 0.01;
          m._body.position.y = 0.55 + br;
          m._shoulder.position.y = 0.75 + br;
          m._lA.rotation.x *= 0.9;
          m._rA.rotation.x *= 0.9;
          m._lL.rotation.x *= 0.9;
          m._rL.rotation.x *= 0.9;
        }

        // Chat bubbles
        if (ws.bubble) {
          const done = updateBubble(ws.bubble, dt * sp, time);
          if (done) {
            m.remove(ws.bubble.sprite);
            ws.bubble = null;
          } else if (ws.bubble.phase !== 'fade_out') {
            m._head.rotation.x = Math.sin(time * 4) * 0.08;
          }
        } else {
          m._head.rotation.x *= 0.92;
        }
      }

      // ── Update monitor screens based on desk occupancy ──
      const deskAssign = store.deskAssignments;
      for (let i = 0; i < screenStates.length; i++) {
        const ss = screenStates[i];
        const occupantId = deskAssign[i];
        if (!occupantId) {
          setScreenMode(ss, 'off');
        } else {
          const worker = store.workers.get(occupantId);
          if (worker?.role === 'REVIEWER') {
            setScreenMode(ss, 'reviewing');
          } else {
            setScreenMode(ss, 'coding');
          }
        }
        updateScreen(ss, dt * sp);
      }

      // ── Update whiteboard post-its (throttled ~3fps) ──
      if (Math.floor(time * 3) !== Math.floor((time - dt) * 3)) {
        updateWhiteboard(wbState, store.kanbanStories, store.activeEpicIds);
      }

      // ── Orchestrator overlays (Epic 6.2–6.4) ──────────────────────────
      const orch = store.orchestrator;

      // Supervisor status ring colour.
      const ringMat = statusRing.material as THREE.MeshBasicMaterial;
      const targetStatusColor = colorForSupervisorStatus(orch.supervisorStatus);
      if (ringMat.color.getHex() !== targetStatusColor) {
        ringMat.color.setHex(targetStatusColor);
      }
      statusRing.rotation.z = time * 0.6;

      // Per-desk attempt badges, amber rings, red ribbons.
      const deskOccupancy = store.deskAssignments;
      const storyIdByDesk = new Map<number, string>();
      for (let i = 0; i < deskOccupancy.length; i++) {
        const occId = deskOccupancy[i];
        if (!occId) continue;
        const w = store.workers.get(occId);
        if (w?.storyId) storyIdByDesk.set(i, w.storyId);
      }
      const deskIndexByStory = new Map<string, number>();
      for (const [deskIdx, sId] of storyIdByDesk) deskIndexByStory.set(sId, deskIdx);

      // Add / update overlays for each story the orchestrator knows about.
      for (const [storyId, deskState] of Object.entries(orch.deskStates)) {
        const deskIdx = deskIndexByStory.get(storyId);
        const loc = deskIdx != null ? LOCATIONS[`desk-${deskIdx}`] : null;
        if (!loc) continue;

        // Attempt badge (visible when attempt > 1).
        if (deskState.attempt > 1) {
          let badge = attemptBadges.get(storyId);
          if (!badge) {
            badge = buildAttemptBadge(deskState.attempt);
            badge.sprite.position.set(loc.x + 0.55, 1.55, loc.z);
            scene.add(badge.sprite);
            attemptBadges.set(storyId, badge);
          } else {
            badge.setAttempt(deskState.attempt);
            badge.sprite.position.set(loc.x + 0.55, 1.55, loc.z);
          }
        } else {
          const badge = attemptBadges.get(storyId);
          if (badge) {
            scene.remove(badge.sprite);
            badge.sprite.material.map?.dispose();
            badge.sprite.material.dispose();
            attemptBadges.delete(storyId);
          }
        }

        // Amber pulsing ring (blocked).
        if (deskState.blocked && !deskState.terminalFail) {
          let ring = amberRings.get(storyId);
          if (!ring) {
            ring = buildAmberRing();
            ring.mesh.position.set(loc.x, 0.04, loc.z);
            scene.add(ring.mesh);
            amberRings.set(storyId, ring);
          }
          ring.tick(time);
        } else {
          const ring = amberRings.get(storyId);
          if (ring) {
            scene.remove(ring.mesh);
            (ring.mesh.material as THREE.Material).dispose();
            amberRings.delete(storyId);
          }
        }

        // Terminal-fail red ribbon.
        if (deskState.terminalFail) {
          let ribbon = redRibbons.get(storyId);
          if (!ribbon) {
            ribbon = buildRedRibbon();
            ribbon.position.set(loc.x, 0.75, loc.z + 0.32);
            scene.add(ribbon);
            redRibbons.set(storyId, ribbon);
          }
        } else {
          const ribbon = redRibbons.get(storyId);
          if (ribbon) {
            scene.remove(ribbon);
            (ribbon.material as THREE.Material).dispose();
            redRibbons.delete(storyId);
          }
        }
      }

      // Cull overlays for stories no longer in orch state.
      for (const [storyId, badge] of attemptBadges) {
        if (!orch.deskStates[storyId]) {
          scene.remove(badge.sprite);
          badge.sprite.material.map?.dispose();
          badge.sprite.material.dispose();
          attemptBadges.delete(storyId);
        }
      }
      for (const [storyId, ring] of amberRings) {
        if (!orch.deskStates[storyId]) {
          scene.remove(ring.mesh);
          (ring.mesh.material as THREE.Material).dispose();
          amberRings.delete(storyId);
        }
      }
      for (const [storyId, ribbon] of redRibbons) {
        if (!orch.deskStates[storyId]) {
          scene.remove(ribbon);
          (ribbon.material as THREE.Material).dispose();
          redRibbons.delete(storyId);
        }
      }

      // Blocker cards on the whiteboard (Epic 6.3).
      const cardOrder = Object.keys(orch.blockerCards).sort();
      for (const storyId of cardOrder) {
        let mesh = blockerCardMeshes.get(storyId);
        if (!mesh) {
          mesh = buildBlockerCard(storyId);
          scene.add(mesh);
          blockerCardMeshes.set(storyId, mesh);
        }
      }
      // Reposition the whole set so the grid stays tidy as cards come/go.
      cardOrder.forEach((storyId, idx) => {
        const mesh = blockerCardMeshes.get(storyId);
        if (!mesh) return;
        const pos = blockerCardPosition(idx, whiteboardLoc.x, whiteboardLoc.z);
        mesh.position.set(pos.x, pos.y, pos.z);
      });
      // Cull removed cards.
      for (const [storyId, mesh] of blockerCardMeshes) {
        if (!orch.blockerCards[storyId]) {
          scene.remove(mesh);
          const mat = mesh.material as THREE.MeshBasicMaterial;
          mat.map?.dispose();
          mat.dispose();
          blockerCardMeshes.delete(storyId);
        }
      }

      // Reviewer ↔ dev connector lines (Epic 6.2).
      // Pair by storyId + role against the actual spawned office workers —
      // orchestrator subagentIds and office worker IDs are separate identity
      // spaces today, so we reconcile through the shared story assignment.
      const reviewerStoryIds = new Set<string>();
      for (const reviewer of Object.values(orch.reviewers)) reviewerStoryIds.add(reviewer.storyId);

      const pairKeys = new Set<string>();
      for (const storyId of reviewerStoryIds) {
        const reviewerWorker = [...store.workers.values()].find(
          (w) => w.role === 'REVIEWER' && w.storyId === storyId,
        );
        const devWorker = [...store.workers.values()].find(
          (w) => w.role === 'DEV' && w.storyId === storyId,
        );
        if (!reviewerWorker || !devWorker) continue;
        const fromLoc = LOCATIONS[reviewerWorker.location];
        const toLoc = LOCATIONS[devWorker.location];
        if (!fromLoc || !toLoc) continue;

        const key = `story::${storyId}`;
        pairKeys.add(key);
        const from = new THREE.Vector3(fromLoc.x, 1.0, fromLoc.z);
        const to = new THREE.Vector3(toLoc.x, 1.0, toLoc.z);
        let line = reviewerConnectors.get(key);
        if (!line) {
          line = buildReviewerConnector(from, to);
          scene.add(line);
          reviewerConnectors.set(key, line);
        } else {
          updateReviewerConnector(line, from, to);
        }
      }
      for (const [key, line] of reviewerConnectors) {
        if (!pairKeys.has(key)) {
          scene.remove(line);
          line.geometry.dispose();
          (line.material as THREE.Material).dispose();
          reviewerConnectors.delete(key);
        }
      }

      ren.render(scene, cam);
    };

    clockRef.current.start();
    animate();

    // ── Resize ──
    const onResize = () => {
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      const a = w / h;
      cam.left = (-frustum * a) / 2;
      cam.right = (frustum * a) / 2;
      cam.top = frustum / 2;
      cam.bottom = -frustum / 2;
      cam.updateProjectionMatrix();
      ren.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointerleave', onPointerUp);
      el.removeEventListener('contextmenu', onCtx);
      cancelAnimationFrame(animRef.current);
      if (el && ren.domElement.parentNode === el) el.removeChild(ren.domElement);
      ren.dispose();
    };
  }, []);

  return (
    <div ref={mountRef} className="absolute inset-0">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-4 bg-gradient-to-b from-[rgba(16,16,32,0.9)] to-transparent px-5 py-3.5">
        <div className="flex items-center gap-2">
          <div className="h-2.5 w-2.5 rounded-full bg-green-400 shadow-[0_0_8px_#4aff8a]" />
          <span className="text-[11px] uppercase tracking-[2px] text-green-400">Live</span>
        </div>
        <span className="text-sm font-semibold tracking-wide text-white">AGENTIC OFFICE</span>
        <span className="ml-auto text-[10px] tracking-wide text-gray-600">
          Drag to pan · Scroll to zoom
        </span>
      </div>
    </div>
  );
}
