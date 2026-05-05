'use client';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { SUPERVISOR_POS, SUPERVISOR_ROT_Y, DESK_OFFSET, DESK_TOP_Y } from './constants';

// ── Attention tray state → visual treatment ──
// `none` → flat grey, static.
// `low`/`medium` → amber rim light, no animation.
// `high` → red rim light, slow pulse (0.7 Hz).
// `critical` → red rim light, fast pulse (1.4 Hz).
// All states use compositor-only animation (opacity + color, no transform).

export type AttentionSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_TO_COLOR: Record<AttentionSeverity, string> = {
  none: '#475569',
  low: '#f59e0b',
  medium: '#f59e0b',
  high: '#ef4444',
  critical: '#ef4444',
};

const SEVERITY_TO_FREQ_HZ: Record<AttentionSeverity, number> = {
  none: 0,
  low: 0,
  medium: 0,
  high: 0.7,
  critical: 1.4,
};

/**
 * Small colored tray mesh on Ricardo's supervisor desk. Displays the
 * aggregated portfolio attention count and pulses based on the worst
 * severity present. Click opens the overlay attention panel (Epic B.4).
 *
 * Layout: placed slightly to the right of Ricardo's monitor so it stays
 * visible from the isometric camera angle without being obscured by the
 * monitor housing.
 */
export function AttentionTray({
  severity,
  filteredCount,
  portfolioCount,
  onClick,
}: {
  severity: AttentionSeverity;
  filteredCount: number;
  portfolioCount: number;
  onClick: () => void;
}) {
  const rimRef = useRef<THREE.MeshBasicMaterial>(null);
  const freq = SEVERITY_TO_FREQ_HZ[severity];
  const rimColor = SEVERITY_TO_COLOR[severity];

  useFrame(({ clock }) => {
    const mat = rimRef.current;
    if (!mat) return;
    if (freq === 0) {
      mat.opacity = severity === 'none' ? 0.25 : 0.7;
      return;
    }
    // 0.6..1.0 pulse, compositor-only via alpha.
    const t = clock.elapsedTime * freq * 2 * Math.PI;
    mat.opacity = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t));
  });

  // World position: supervisor desk + local offset rotated by desk's rotY.
  // Rotate the offset (dx, 0, dz) by SUPERVISOR_ROT_Y.
  const localOffset = new THREE.Vector3(DESK_OFFSET.x - 0.55, DESK_TOP_Y + 0.03, DESK_OFFSET.z);
  localOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), SUPERVISOR_ROT_Y);
  const worldPos: [number, number, number] = [
    SUPERVISOR_POS[0] + localOffset.x,
    SUPERVISOR_POS[1] + localOffset.y,
    SUPERVISOR_POS[2] + localOffset.z,
  ];

  const displayCount = filteredCount > 0 ? filteredCount : portfolioCount;
  const dualDisplay =
    filteredCount > 0 && filteredCount !== portfolioCount
      ? `${filteredCount}/${portfolioCount}`
      : `${displayCount}`;

  return (
    <group
      position={worldPos}
      rotation={[0, SUPERVISOR_ROT_Y, 0]}
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
      {/* Base tray — flat dark slab. */}
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[0.4, 0.06, 0.3]} />
        <meshStandardMaterial color="#1f1f28" metalness={0.35} roughness={0.55} />
      </mesh>
      {/* Rim glow — additive plane just above the tray slab, color/opacity
          driven by useFrame above. */}
      <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.42, 0.32]} />
        <meshBasicMaterial
          ref={rimRef}
          color={rimColor}
          transparent
          opacity={0.3}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      {/* Count label — only visible when count > 0 (hides clutter when
          tray is silent). */}
      {portfolioCount > 0 && (
        <Text
          position={[0, 0.08, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={0.12}
          color="#fff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.015}
          outlineColor="#000"
          material-toneMapped={false}
          renderOrder={10}
        >
          {dualDisplay}
        </Text>
      )}
    </group>
  );
}

export function severityFromTop(
  top: 'critical' | 'high' | 'medium' | 'low' | null,
): AttentionSeverity {
  return top ?? 'none';
}
