'use client';
import { Text, Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * Countdown sprite floating above a dev desk while a story is waiting for
 * its retry window to elapse (Epic B.5).
 *
 * Format: `⏳ <mm>m` or `⏳ <ss>s`. Billboarded so it faces the camera from
 * any orbit angle. Renders a subtle vertical bobbing animation via
 * transform-only change so it reads as "live" without costing paint.
 */
export function RetryHourglass({
  worldPos,
  retryAfter,
  attempt,
}: {
  /** Top-of-desk world position to anchor the sprite above. */
  worldPos: [number, number, number];
  /** ISO timestamp — when the story will next be eligible to retry. */
  retryAfter: string;
  /** 1-based attempt number (shown as `try 2`, `try 3`). */
  attempt: number;
}) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.round((new Date(retryAfter).getTime() - Date.now()) / 1000)),
  );
  const groupRef = useRef<THREE.Group>(null);

  // Countdown — per-second tick is plenty; the scene runs at 60fps but the
  // label only needs second-level precision.
  useEffect(() => {
    const target = new Date(retryAfter).getTime();
    const tick = () => {
      setSecondsLeft(Math.max(0, Math.round((target - Date.now()) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [retryAfter]);

  // Gentle bob — compositor-only (transform.y lerp).
  useFrame(({ clock }) => {
    const g = groupRef.current;
    if (!g) return;
    g.position.y = worldPos[1] + 1.6 + Math.sin(clock.elapsedTime * 1.6) * 0.08;
  });

  const label =
    secondsLeft >= 60 ? `⏳ ${Math.ceil(secondsLeft / 60)}m` : `⏳ ${secondsLeft}s`;

  return (
    <group ref={groupRef} position={[worldPos[0], worldPos[1] + 1.6, worldPos[2]]}>
      <Billboard follow lockX={false} lockY={false} lockZ={false}>
        <Text
          fontSize={0.22}
          color="#fcd34d"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.03}
          outlineColor="#0f172a"
          material-depthTest={false}
          renderOrder={13}
        >
          {label}
        </Text>
        <Text
          position={[0, -0.28, 0]}
          fontSize={0.14}
          color={attempt >= 3 ? '#fca5a5' : attempt === 2 ? '#fdba74' : '#e2e8f0'}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.025}
          outlineColor="#0f172a"
          material-depthTest={false}
          renderOrder={13}
        >
          {`try ${attempt}`}
        </Text>
      </Billboard>
    </group>
  );
}
