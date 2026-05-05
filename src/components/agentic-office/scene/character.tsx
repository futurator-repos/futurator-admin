'use client';
import { useAnimations, useGLTF, Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import { CAST_BY_ID, modelUrlForKind } from '../cast';
import { useOfficeStore } from '../store';
import type { CharacterId, PersonaActivity } from '../types';
import { ARRIVE_THRESHOLD, ONE_SHOT_CLIPS, WALK_SPEED } from './constants';
import { computePath } from './pathfinding';
import { SpeechBubble } from './speech-bubble';

// ── Animation clip mapping ──
// Which Quaternius clip plays for each activity state. One-shot clips
// (SitDown, PickUp, Shoot_OneHanded, Victory, Defeat) fall back to Idle
// when they finish; continuous clips (Idle, Walk) loop until the activity
// changes.

const CLIP_FOR_ACTIVITY: Record<PersonaActivity, string> = {
  idle: 'Idle',
  walking: 'Walk',
  sitting: 'SitDown',
  standing: 'Idle',
  pointing: 'Shoot_OneHanded',
  drinking: 'PickUp',
  cheering: 'Victory',
  dejected: 'Defeat',
};


/**
 * Per-persona animated character. Loads a Quaternius outfit, clones the
 * rig so each character has its own independent skeleton, drives
 * position/rotation/clip imperatively from the store runtime (writes to
 * the store only on arrival — not per frame), and renders chat bubbles.
 */
export function Character({ characterId }: { characterId: CharacterId }) {
  const persona = CAST_BY_ID[characterId];
  const updateRuntime = useOfficeStore((s) => s.updateRuntime);

  // Presence + bubbles — these changes are rare enough to drive re-renders.
  const presence = useOfficeStore((s) => s.runtimes[characterId].presence);
  const bubbles = useOfficeStore((s) => s.bubbles[characterId]);

  // Selection — read here (top of body) so hook count stays constant across
  // renders. Previously these were read below the `offstage` early-return,
  // which threw React error #310 ("rendered more hooks than during the
  // previous render") as personas toggled between offstage ↔ onstage.
  const isSelected = useOfficeStore((s) => s.selectedCharacterId === characterId);
  const selectCharacter = useOfficeStore((s) => s.selectCharacter);

  const url = modelUrlForKind(persona.look.kind);
  const { scene, animations } = useGLTF(url) as unknown as {
    scene: THREE.Group;
    animations: THREE.AnimationClip[];
  };

  // Independent skeleton clone per character instance.
  const cloned = useMemo(() => {
    const c = SkeletonUtils.clone(scene);
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return c;
  }, [scene]);

  const groupRef = useRef<THREE.Group>(null);
  const { actions } = useAnimations(animations, cloned);

  // Per-character imperative state. Everything below is mutated in useFrame
  // without triggering React re-renders.
  const pathRef = useRef<THREE.Vector3[]>([]);
  const currentClipRef = useRef<string>('Idle');
  const lastTargetRef = useRef<object | null>(null);
  const scaleRef = useRef(0);

  // Play a named clip with crossfade; one-shots clamp + auto-return to Idle.
  const playClip = useMemo(
    () => (name: string) => {
      if (name === currentClipRef.current) return;
      const prev = actions[currentClipRef.current];
      const next = actions[name];
      if (!next) return;
      prev?.fadeOut(0.2);
      if (ONE_SHOT_CLIPS.has(name)) {
        next.reset().setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
        next.fadeIn(0.15).play();
      } else {
        next.reset().fadeIn(0.2).play();
      }
      currentClipRef.current = name;
    },
    [actions],
  );

  // Seed initial clip on mount.
  useEffect(() => {
    const idle = actions['Idle'];
    if (idle) idle.reset().fadeIn(0.2).play();
    currentClipRef.current = 'Idle';
    return () => {
      idle?.fadeOut(0.1);
    };
  }, [actions]);

  // Position/rotation/target driven imperatively each frame from the store.
  useFrame((_, dt) => {
    const state = useOfficeStore.getState();
    const runtime = state.runtimes[characterId];
    const g = groupRef.current;
    if (!g) return;

    // ── Presence scale lerp ──
    const targetScale =
      runtime.presence === 'leaving' || runtime.presence === 'offstage' ? 0 : 1;
    const k = Math.min(1, dt * 5);
    scaleRef.current = THREE.MathUtils.lerp(scaleRef.current, targetScale, k);
    g.scale.setScalar(scaleRef.current);
    if (runtime.presence === 'entering' && scaleRef.current > 0.98) {
      updateRuntime(characterId, { presence: 'onstage', presenceScale: 1 });
    } else if (runtime.presence === 'leaving' && scaleRef.current < 0.02) {
      updateRuntime(characterId, { presence: 'offstage', presenceScale: 0 });
    }

    // ── Target change detection (cheap identity check) ──
    if (runtime.target !== lastTargetRef.current) {
      lastTargetRef.current = runtime.target;
      if (runtime.target) {
        pathRef.current = computePath(runtime.position, runtime.target.position);
      } else {
        pathRef.current = [];
      }
    }

    // ── Walking ──
    if (pathRef.current.length > 0 && runtime.target) {
      playClip('Walk');
      const target = runtime.target;
      const wp = pathRef.current[0];
      const dx = wp.x - g.position.x;
      const dz = wp.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      const step = WALK_SPEED * dt;

      // Face the direction of travel (ease toward atan2(dx, dz)).
      const aimFacing = Math.atan2(dx, dz);
      const turnK = Math.min(1, dt * 8);
      // Shortest-arc lerp
      let delta = aimFacing - g.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      g.rotation.y += delta * turnK;

      if (dist < ARRIVE_THRESHOLD || step >= dist) {
        // Waypoint reached.
        g.position.x = wp.x;
        g.position.z = wp.z;
        pathRef.current.shift();

        if (pathRef.current.length === 0) {
          // Final arrival — snap to the exact target + flip activity.
          g.position.copy(target.position);
          g.rotation.y = target.facing;
          playClip(CLIP_FOR_ACTIVITY[target.arrivalActivity]);
          updateRuntime(characterId, {
            position: target.position.clone(),
            facing: target.facing,
            activity: target.arrivalActivity,
            seat: target.seat,
            target: null,
          });
        }
      } else {
        g.position.x += (dx / dist) * step;
        g.position.z += (dz / dist) * step;
      }
      return;
    }

    // ── Not walking — reflect store position/facing + play activity clip ──
    g.position.copy(runtime.position);
    g.rotation.y = runtime.facing;
    const desired = CLIP_FOR_ACTIVITY[runtime.activity];
    if (desired !== currentClipRef.current && actions[desired]) {
      playClip(desired);
    }
  });

  if (presence === 'offstage') return null;

  // Overlays (name tag, role, bubbles, direction arrow) only render when
  // the character is FULLY onstage. During the `entering` and `leaving`
  // presence states, the group scale is lerping through near-zero values,
  // and drei's <Html> projection math produces NaN/Infinity under an
  // ortho camera with a near-zero matrix — which Chrome rasterises as an
  // enormous DOM element covering the viewport (the "big dark arc" glitch).
  // Keeping overlays off until scale reaches ~1 side-steps the issue
  // entirely without breaking the Quaternius body fade-in.
  const showOverlays = presence === 'onstage';

  const roleColor =
    persona.role === 'pm'
      ? '#c77dff'
      : persona.role === 'orchestrator'
        ? '#fbbf24'
        : persona.role === 'developer'
          ? '#4cc9f0'
          : persona.role === 'tester'
            ? '#22d3ee'
            : '#ef476f';

  return (
    <group
      ref={groupRef}
      onClick={(e) => {
        e.stopPropagation();
        selectCharacter(characterId);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      <primitive object={cloned} />

      {/* Selection ring on the floor when this character is selected */}
      {isSelected && showOverlays && (
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.65, 0.85, 32]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.95} toneMapped={false} />
        </mesh>
      )}

      {showOverlays && (
        <>
          {/* Direction arrow — green cone + stem on the floor pointing
              along the character's local +Z (facing direction). */}
          <group position={[0, 0.02, 0]}>
            <mesh position={[0, 0, 0.3]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.03, 0.03, 0.3, 8]} />
              <meshBasicMaterial
                color="#22c55e"
                transparent
                opacity={0.85}
                toneMapped={false}
              />
            </mesh>
            <mesh position={[0, 0, 0.55]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.1, 0.2, 12]} />
              <meshBasicMaterial
                color="#22c55e"
                transparent
                opacity={0.95}
                toneMapped={false}
              />
            </mesh>
          </group>

          {/* Name tag — ON TOP of the head (top position). */}
          <Text
            position={[0, 2.95, 0]}
            fontSize={0.24}
            color="#ffffff"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.03}
            outlineColor="#000"
            material-depthTest={false}
            renderOrder={11}
          >
            {persona.name}
          </Text>

          {/* Role pill — smaller, directly under the name. */}
          <Text
            position={[0, 2.65, 0]}
            fontSize={0.13}
            color={roleColor}
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.025}
            outlineColor="#000"
            material-depthTest={false}
            renderOrder={11}
          >
            {persona.role.toUpperCase()}
          </Text>

          {/* Chat bubbles — white rounded rectangle + dark text, tiered
              by color stripe + font size. Still 3D (no drei <Html>) to
              avoid the NaN-scale bug documented during presence-fade
              transitions. */}
          {bubbles?.slice(-3).map((b, i) => (
            <SpeechBubble
              key={b.id}
              text={b.text}
              emoji={b.emoji}
              tier={b.tier}
              planColor={b.planColor}
              offsetY={3.4 + i * 0.55}
            />
          ))}
        </>
      )}
    </group>
  );
}
