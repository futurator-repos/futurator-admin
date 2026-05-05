'use client';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { ROOM, ROOM2, WHITEBOARD_WALL_X } from './constants';
import { paletteForPlanId } from '../plan-palette';

// ── Proxy boards (Epic D) ──────────────────────────────────────────────
// Low-fi in-scene status tiles. Clicking opens a 2D modal overlay that
// shows the full data (see overlays/board-modal.tsx + proxy-board-content
// components). Meshes are intentionally minimal: one or two flat planes
// + a handful of small LED/tile meshes. No textures beyond emoji Text.

/**
 * EC2 Monitor proxy — mounted on the SERVER-ROOM back wall (the dedicated
 * "infrastructure" space), not in the main office. Keeps the main office
 * focused on dev/test/review work; infra signals live where they belong.
 */
export function EC2ProxyBoard({
  daemonUp,
  apiOk,
  dbOk,
  runningJobs,
  onClick,
}: {
  daemonUp: boolean;
  apiOk: boolean;
  dbOk: boolean;
  runningJobs: number;
  onClick: () => void;
}) {
  // ROOM2 (server room) back wall is at z = ROOM2.minZ. Centered along x.
  const POS: [number, number, number] = [
    (ROOM2.minX + ROOM2.maxX) / 2,
    2.6,
    ROOM2.minZ + 0.12,
  ];
  return (
    <group
      position={POS}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      {/* Frame */}
      <mesh>
        <boxGeometry args={[2.2, 1.1, 0.06]} />
        <meshStandardMaterial color="#0f172a" metalness={0.3} roughness={0.5} />
      </mesh>
      {/* Title */}
      <Text
        position={[0, 0.38, 0.04]}
        fontSize={0.14}
        color="#67e8f9"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        EC2 MONITOR
      </Text>
      {/* LEDs row */}
      <LED pos={[-0.7, 0.1, 0.05]} on={daemonUp} label="DAEMON" />
      <LED pos={[0, 0.1, 0.05]} on={apiOk} label="API" />
      <LED pos={[0.7, 0.1, 0.05]} on={dbOk} label="DB" />
      {/* Jobs-running */}
      <Text
        position={[0, -0.35, 0.04]}
        fontSize={0.13}
        color="#e2e8f0"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        {`${runningJobs} jobs running`}
      </Text>
    </group>
  );
}

function LED({
  pos,
  on,
  label,
}: {
  pos: [number, number, number];
  on: boolean;
  label: string;
}) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    // Subtle breathing when on — compositor-safe scale lerp.
    const base = on ? 1 : 0.9;
    const pulse = on ? 0.04 * Math.sin(clock.elapsedTime * 3) : 0;
    m.scale.setScalar(base + pulse);
  });
  return (
    <group position={pos}>
      <mesh ref={ref}>
        <sphereGeometry args={[0.06, 16, 12]} />
        <meshStandardMaterial
          color={on ? '#22c55e' : '#475569'}
          emissive={on ? '#16a34a' : '#000000'}
          emissiveIntensity={on ? 0.7 : 0}
          toneMapped={false}
        />
      </mesh>
      <Text
        position={[0, -0.16, 0]}
        fontSize={0.075}
        color="#94a3b8"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        {label}
      </Text>
    </group>
  );
}

/**
 * Gantt proxy — wall panel adjacent to the whiteboard showing wave
 * columns. Each wave = a vertical stack of small rectangles, one per
 * story. Click opens the 2D Gantt modal.
 */
export function GanttProxyBoard({
  waveSummary,
  onClick,
}: {
  /** Per-wave story count + color (derived from status counts). */
  waveSummary: { wave: number; count: number; doneCount: number }[];
  onClick: () => void;
}) {
  const POS: [number, number, number] = [WHITEBOARD_WALL_X + 0.12, 2.6, -5];
  // Layout bars across the 2m-wide panel.
  const panelW = 2.2;
  const panelH = 1.1;
  return (
    <group
      position={POS}
      rotation={[0, Math.PI / 2, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      <mesh>
        <boxGeometry args={[panelW, panelH, 0.06]} />
        <meshStandardMaterial color="#0f172a" metalness={0.3} roughness={0.5} />
      </mesh>
      <Text
        position={[0, panelH / 2 - 0.14, 0.04]}
        fontSize={0.12}
        color="#a78bfa"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        GANTT · WAVES
      </Text>
      {waveSummary.length === 0 && (
        <Text
          position={[0, 0, 0.04]}
          fontSize={0.1}
          color="#64748b"
          anchorX="center"
          anchorY="middle"
          material-toneMapped={false}
        >
          no active waves
        </Text>
      )}
      {/* Simple bar chart — one vertical bar per wave, filled to done%. */}
      {waveSummary.map((w, idx) => {
        const barW = Math.min(0.18, (panelW - 0.4) / Math.max(waveSummary.length, 1) - 0.04);
        const x = -panelW / 2 + 0.25 + idx * (barW + 0.04);
        const frac = w.count > 0 ? w.doneCount / w.count : 0;
        const barH = 0.7;
        return (
          <group key={w.wave} position={[x, -0.05, 0.04]}>
            {/* Track */}
            <mesh>
              <planeGeometry args={[barW, barH]} />
              <meshBasicMaterial color="#1e293b" toneMapped={false} />
            </mesh>
            {/* Fill from bottom */}
            <mesh position={[0, -barH / 2 + (barH * frac) / 2, 0.001]}>
              <planeGeometry args={[barW * 0.95, barH * frac]} />
              <meshBasicMaterial color="#a78bfa" toneMapped={false} />
            </mesh>
            {/* Label */}
            <Text
              position={[0, -barH / 2 - 0.08, 0.002]}
              fontSize={0.06}
              color="#cbd5e1"
              anchorX="center"
              anchorY="middle"
              material-toneMapped={false}
            >
              {`W${w.wave}`}
            </Text>
          </group>
        );
      })}
    </group>
  );
}

/**
 * Plans proxy — wall panel by entrance showing stacked cards per active
 * plan with cushion-matching color and rigor badge.
 */
export function PlansProxyBoard({
  plans,
  onClick,
}: {
  plans: {
    planId: string;
    name: string;
    rigor: 'prototype' | 'mvp' | 'production' | undefined;
    storyCount: number;
    doneCount: number;
  }[];
  onClick: () => void;
}) {
  const POS: [number, number, number] = [-5, 2.6, -ROOM.half + 0.12];
  const panelW = 2.4;
  const rowH = 0.22;
  const panelH = Math.max(0.7, 0.4 + Math.min(plans.length, 6) * rowH);
  return (
    <group
      position={POS}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      <mesh>
        <boxGeometry args={[panelW, panelH, 0.06]} />
        <meshStandardMaterial color="#0f172a" metalness={0.3} roughness={0.5} />
      </mesh>
      <Text
        position={[0, panelH / 2 - 0.14, 0.04]}
        fontSize={0.12}
        color="#34d399"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        PLANS
      </Text>
      {plans.length === 0 && (
        <Text
          position={[0, 0, 0.04]}
          fontSize={0.1}
          color="#64748b"
          anchorX="center"
          anchorY="middle"
          material-toneMapped={false}
        >
          no plans
        </Text>
      )}
      {plans.slice(0, 6).map((p, idx) => {
        const palette = paletteForPlanId(p.planId);
        const y = panelH / 2 - 0.32 - idx * rowH;
        const frac = p.storyCount > 0 ? p.doneCount / p.storyCount : 0;
        const rigorIcon = p.rigor === 'production' ? '🛡' : p.rigor === 'mvp' ? '🔷' : '📎';
        return (
          <group key={p.planId} position={[0, y, 0.04]}>
            {/* Plan color dot */}
            <mesh position={[-panelW / 2 + 0.14, 0, 0]}>
              <circleGeometry args={[0.05, 16]} />
              <meshBasicMaterial color={palette.hex} toneMapped={false} />
            </mesh>
            {/* Rigor */}
            <Text
              position={[-panelW / 2 + 0.28, 0, 0]}
              fontSize={0.08}
              color="#e2e8f0"
              anchorX="left"
              anchorY="middle"
              material-toneMapped={false}
            >
              {rigorIcon}
            </Text>
            {/* Plan name */}
            <Text
              position={[-panelW / 2 + 0.42, 0, 0]}
              fontSize={0.08}
              color="#e2e8f0"
              anchorX="left"
              anchorY="middle"
              maxWidth={panelW * 0.55}
              overflowWrap="normal"
              material-toneMapped={false}
            >
              {p.name}
            </Text>
            {/* Progress bar */}
            <mesh position={[panelW / 2 - 0.4, 0, 0]}>
              <planeGeometry args={[0.55, 0.05]} />
              <meshBasicMaterial color="#1e293b" toneMapped={false} />
            </mesh>
            <mesh position={[panelW / 2 - 0.4 - 0.275 + 0.55 * frac * 0.5, 0, 0.001]}>
              <planeGeometry args={[0.55 * frac, 0.05]} />
              <meshBasicMaterial color={palette.hex} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
