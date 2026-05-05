'use client';
import { Text, Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

/**
 * Red failure badge floating above a desk when the occupying story has
 * either:
 *   - `failed: true` on its kanban entry (terminal fail, won't retry), or
 *   - reached attempt ≥ 3 without resolving.
 *
 * Pulses opacity (compositor-only animation) so it reads as urgent without
 * costing paint. Renders on top of the Billboard so it never gets occluded.
 */
export function FailureBadge({
  worldPos,
  label = 'FAILED',
  subLabel,
}: {
  worldPos: [number, number, number];
  label?: string;
  subLabel?: string;
}) {
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const m = matRef.current;
    if (m) {
      // 1.2 Hz pulse — draws the eye without being distracting.
      const t = clock.elapsedTime * 1.2 * 2 * Math.PI;
      m.opacity = 0.85 + 0.15 * (0.5 + 0.5 * Math.sin(t));
    }
    const g = groupRef.current;
    if (g) {
      // Subtle bob so it visually separates from the static hourglass.
      g.position.y = worldPos[1] + 1.9 + Math.sin(clock.elapsedTime * 2) * 0.06;
    }
  });

  const w = 1.6;
  const h = 0.58;
  return (
    <group ref={groupRef} position={[worldPos[0], worldPos[1] + 1.9, worldPos[2]]}>
      <Billboard follow lockX={false} lockY={false} lockZ={false}>
        {/* Red body — pulsing */}
        <mesh renderOrder={14}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial
            ref={matRef}
            color="#dc2626"
            transparent
            opacity={0.95}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
        {/* Dark border accent */}
        <mesh position={[0, 0, -0.002]} renderOrder={13}>
          <planeGeometry args={[w + 0.06, h + 0.06]} />
          <meshBasicMaterial
            color="#7f1d1d"
            transparent
            opacity={0.9}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
        {/* Icon + label */}
        <Text
          position={[0, subLabel ? 0.08 : 0, 0.002]}
          fontSize={0.24}
          color="#fff1f2"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.015}
          outlineColor="#7f1d1d"
          material-depthTest={false}
          renderOrder={15}
        >
          {`⚠ ${label}`}
        </Text>
        {subLabel && (
          <Text
            position={[0, -0.14, 0.002]}
            fontSize={0.12}
            color="#fecaca"
            anchorX="center"
            anchorY="middle"
            maxWidth={w - 0.2}
            material-depthTest={false}
            renderOrder={15}
          >
            {subLabel}
          </Text>
        )}
      </Billboard>
    </group>
  );
}
