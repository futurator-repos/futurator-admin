'use client';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

// ── Server-room bounds (ROOM2: x=[12,24], z=[-12,-2]) minus 1m wall pad ──
const SR_BOUNDS = {
  minX: 13,
  maxX: 23,
  minZ: -11,
  maxZ: -3,
} as const;

// ── Tunables ─────────────────────────────────────────────────────────────
// Slower than human walk (WALK_SPEED=2.4) so the creatures read as their
// own species and don't overtake Milena/Ricardo if anyone wanders past.
const CC_WALK_SPEED = 1.5;
const CC_SCALE_LERP_PER_SEC = 4;
const CC_TURN_LERP_PER_SEC = 6;
const CC_FOOT_STEP_HZ = 10;
const CC_ARRIVAL_THRESHOLD = 0.3;
const CC_DWELL_MIN_S = 1;
const CC_DWELL_MAX_S = 3;

// ── Palette ──────────────────────────────────────────────────────────────
// Tuned to the reference image — the Claude Code pixel mascot is a warm
// terracotta/orange on a dark background, with near-black eye squares.
const BODY_COLOR = '#c97b5a';
const FOOT_COLOR = '#8a4a31';
const EYE_COLOR = '#1a0a0a';

function randomPointInServerRoom(): { x: number; z: number } {
  return {
    x: SR_BOUNDS.minX + Math.random() * (SR_BOUNDS.maxX - SR_BOUNDS.minX),
    z: SR_BOUNDS.minZ + Math.random() * (SR_BOUNDS.maxZ - SR_BOUNDS.minZ),
  };
}

/**
 * A single Claude Code creature — procedural boxes, ~0.75m tall, walks
 * around the server room in a lazy random-waypoint pattern. One instance
 * per active Claude CLI subprocess on EC2 (see ClaudeCodeSwarm).
 *
 * Not clickable, not assignable, not tied to a story. Pure ambient
 * telemetry — "the daemon is doing something; this many workers are
 * live right now."
 */
export function ClaudeCodeCharacter({
  initialPos,
  targetScale,
}: {
  initialPos: { x: number; z: number };
  /** 1 = spawn/stay, 0 = despawn (scale lerps to 0, swarm then GCs). */
  targetScale: 1 | 0;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const scaleRef = useRef(0);
  const walkTargetRef = useRef(randomPointInServerRoom());
  const dwellUntilRef = useRef(0);
  const bodyRef = useRef<THREE.Mesh>(null);
  const leftFootRef = useRef<THREE.Mesh>(null);
  const rightFootRef = useRef<THREE.Mesh>(null);

  useFrame((state, dt) => {
    const group = groupRef.current;
    if (!group) return;

    // ── Scale lerp for spawn/despawn (compositor-only animation) ──
    scaleRef.current = THREE.MathUtils.lerp(
      scaleRef.current,
      targetScale,
      Math.min(1, dt * CC_SCALE_LERP_PER_SEC),
    );
    group.scale.setScalar(scaleRef.current);

    // Fully despawned — don't run walking math.
    if (targetScale === 0 && scaleRef.current < 0.05) return;

    const target = walkTargetRef.current;
    const dx = target.x - group.position.x;
    const dz = target.z - group.position.z;
    const dist = Math.hypot(dx, dz);

    const now = state.clock.elapsedTime;

    if (dist < CC_ARRIVAL_THRESHOLD) {
      // Arrived. Start a dwell window the first time we notice arrival,
      // then pick a fresh target once the dwell elapses.
      if (dwellUntilRef.current === 0) {
        dwellUntilRef.current =
          now + CC_DWELL_MIN_S + Math.random() * (CC_DWELL_MAX_S - CC_DWELL_MIN_S);
      } else if (now >= dwellUntilRef.current) {
        walkTargetRef.current = randomPointInServerRoom();
        dwellUntilRef.current = 0;
      }
      // While dwelling: body stands still, feet rest flat.
      if (leftFootRef.current) leftFootRef.current.position.y = 0.075;
      if (rightFootRef.current) rightFootRef.current.position.y = 0.075;
      if (bodyRef.current) bodyRef.current.position.y = 0.5;
    } else {
      // Walking — move at constant speed toward target.
      const step = CC_WALK_SPEED * dt;
      group.position.x += (dx / dist) * step;
      group.position.z += (dz / dist) * step;

      // Face direction of travel (short-arc slerp on Y axis).
      const targetAngle = Math.atan2(dx, dz);
      let delta = targetAngle - group.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      group.rotation.y += delta * Math.min(1, dt * CC_TURN_LERP_PER_SEC);

      // Walk cycle — feet alternate up, body bobs gently (compositor-only).
      const t = now * CC_FOOT_STEP_HZ;
      if (leftFootRef.current) {
        leftFootRef.current.position.y = 0.075 + Math.max(0, Math.sin(t)) * 0.08;
      }
      if (rightFootRef.current) {
        rightFootRef.current.position.y =
          0.075 + Math.max(0, Math.sin(t + Math.PI)) * 0.08;
      }
      if (bodyRef.current) {
        bodyRef.current.position.y = 0.5 + Math.abs(Math.sin(t)) * 0.03;
      }
    }
  });

  return (
    <group ref={groupRef} position={[initialPos.x, 0, initialPos.z]}>
      {/* Body — main orange cube. Cast shadow so it reads grounded. */}
      <mesh ref={bodyRef} position={[0, 0.5, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.8, 0.6, 0.55]} />
        <meshStandardMaterial color={BODY_COLOR} roughness={0.8} metalness={0.04} />
      </mesh>

      {/* Eyes — two dark squares on the forward face (+Z local). */}
      <mesh position={[-0.2, 0.58, 0.28]}>
        <boxGeometry args={[0.1, 0.12, 0.02]} />
        <meshBasicMaterial color={EYE_COLOR} toneMapped={false} />
      </mesh>
      <mesh position={[0.2, 0.58, 0.28]}>
        <boxGeometry args={[0.1, 0.12, 0.02]} />
        <meshBasicMaterial color={EYE_COLOR} toneMapped={false} />
      </mesh>

      {/* Mouth hint — small dark rectangle below eyes, gives more
          personality than eyes alone at the isometric camera angle. */}
      <mesh position={[0, 0.36, 0.28]}>
        <boxGeometry args={[0.22, 0.05, 0.02]} />
        <meshBasicMaterial color={EYE_COLOR} toneMapped={false} />
      </mesh>

      {/* Feet — two stubby blocks below body, animated for walk cycle. */}
      <mesh ref={leftFootRef} position={[-0.22, 0.075, 0.05]} castShadow>
        <boxGeometry args={[0.18, 0.15, 0.25]} />
        <meshStandardMaterial color={FOOT_COLOR} roughness={0.85} />
      </mesh>
      <mesh ref={rightFootRef} position={[0.22, 0.075, 0.05]} castShadow>
        <boxGeometry args={[0.18, 0.15, 0.25]} />
        <meshStandardMaterial color={FOOT_COLOR} roughness={0.85} />
      </mesh>
    </group>
  );
}
