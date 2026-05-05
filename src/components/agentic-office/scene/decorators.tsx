'use client';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useOfficeStore } from '../store';
import { WORKSTATIONS } from './constants';

// ── Status ring under each occupied desk ──
// Green = happy attempt 1; amber = attempt 2+; red = terminal fail; yellow
// pulsing = blocked. Rendered as a thin disc on the floor directly under
// the chair origin.

function StatusRing({
  pos,
  color,
  pulse = false,
}: {
  pos: [number, number, number];
  color: string;
  pulse?: boolean;
}) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m || !pulse) return;
    const k = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 4);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.5 * k;
  });
  return (
    <mesh ref={ref} position={[pos[0], pos[1] + 0.02, pos[2]]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.55, 0.75, 24]} />
      <meshBasicMaterial color={color} transparent opacity={0.8} toneMapped={false} />
    </mesh>
  );
}

// ── Blocker card — a yellow sticky hovering over a desk ──

function BlockerCard({
  pos,
  code,
  description,
}: {
  pos: [number, number, number];
  code?: string;
  description?: string;
}) {
  return (
    <group position={[pos[0], pos[1] + 1.9, pos[2]]}>
      <mesh castShadow>
        <planeGeometry args={[1.2, 0.7]} />
        <meshStandardMaterial color="#f3c76a" emissive="#f3c76a" emissiveIntensity={0.35} />
      </mesh>
      <Text
        position={[0, 0.2, 0.02]}
        fontSize={0.1}
        color="#3a2a10"
        anchorX="center"
        anchorY="middle"
      >
        ⚠ BLOCKED
      </Text>
      {code && (
        <Text
          position={[0, 0.02, 0.02]}
          fontSize={0.08}
          color="#3a2a10"
          anchorX="center"
          anchorY="middle"
        >
          {code}
        </Text>
      )}
      {description && (
        <Text
          position={[0, -0.15, 0.02]}
          fontSize={0.06}
          color="#3a2a10"
          anchorX="center"
          anchorY="middle"
          maxWidth={1.1}
        >
          {description.slice(0, 60)}
        </Text>
      )}
    </group>
  );
}

// ── Terminal-fail ribbon — red banner across the desk ──

function TerminalFailRibbon({ pos }: { pos: [number, number, number] }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    (m.material as THREE.MeshBasicMaterial).opacity =
      0.7 + 0.3 * Math.sin(clock.elapsedTime * 3);
  });
  return (
    <group position={[pos[0], pos[1] + 1.1, pos[2]]} rotation={[0, 0, -0.15]}>
      <mesh ref={ref}>
        <planeGeometry args={[2.0, 0.35]} />
        <meshBasicMaterial color="#cc3344" transparent toneMapped={false} />
      </mesh>
      <Text
        position={[0, 0, 0.01]}
        fontSize={0.14}
        color="#fff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000"
      >
        TERMINAL FAIL
      </Text>
    </group>
  );
}

// ── Wave band — colored floor strip across desks in an active wave ──
// Slice 5: a single broad band behind the dev row for any non-empty wave.

function WaveBands() {
  const activeWaves = useOfficeStore((s) => s.orchestrator.activeWaves);
  const waveNumbers = useMemo(() => Object.keys(activeWaves).map(Number), [activeWaves]);

  if (waveNumbers.length === 0) return null;

  const WAVE_COLORS = ['#4cc9f0', '#80ed99', '#c77dff', '#ffcc66', '#ef476f'];

  return (
    <>
      {waveNumbers.map((w, i) => {
        const color = WAVE_COLORS[i % WAVE_COLORS.length];
        const zOffset = i === 0 ? -3 : 4;
        return (
          <mesh
            key={w}
            position={[0, 0.01, zOffset - 1.2]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[22, 0.15]} />
            <meshBasicMaterial color={color} transparent opacity={0.55} toneMapped={false} />
          </mesh>
        );
      })}
    </>
  );
}

// ── Aggregate decorators — reads from orchestrator scene state ──

export function Decorators() {
  const deskStates = useOfficeStore((s) => s.orchestrator.deskStates);
  const blockerCards = useOfficeStore((s) => s.orchestrator.blockerCards);
  const assignmentsByStory = useOfficeStore((s) => s.assignmentsByStory);

  // Map storyId → desk slot via the current assignment (if any).
  const storyToSlot = useMemo(() => {
    const map = new Map<string, number>();
    for (const [storyId, a] of Object.entries(assignmentsByStory)) {
      map.set(storyId, a.deskSlot);
    }
    return map;
  }, [assignmentsByStory]);

  const deskPosForSlot = (slot: number) => {
    const ws = WORKSTATIONS[slot] ?? WORKSTATIONS[slot % WORKSTATIONS.length];
    return ws.pos as [number, number, number];
  };

  return (
    <>
      <WaveBands />

      {Object.entries(deskStates).map(([storyId, ds]) => {
        const slot = storyToSlot.get(storyId);
        if (slot === undefined) return null;
        const pos = deskPosForSlot(slot);
        const color = ds.terminalFail
          ? '#cc3344'
          : ds.blocked
            ? '#e8c85a'
            : ds.attempt >= 3
              ? '#cc3344'
              : ds.attempt === 2
                ? '#e58a3a'
                : '#4acc6a';
        return (
          <StatusRing
            key={`ring-${storyId}`}
            pos={pos}
            color={color}
            pulse={ds.blocked || ds.terminalFail}
          />
        );
      })}

      {Object.entries(blockerCards).map(([storyId, card]) => {
        const slot = storyToSlot.get(storyId);
        if (slot === undefined) return null;
        const pos = deskPosForSlot(slot);
        return (
          <BlockerCard
            key={`blocker-${storyId}`}
            pos={pos}
            code={card.blockerCode}
            description={card.description}
          />
        );
      })}

      {Object.entries(deskStates).map(([storyId, ds]) => {
        if (!ds.terminalFail) return null;
        const slot = storyToSlot.get(storyId);
        if (slot === undefined) return null;
        const pos = deskPosForSlot(slot);
        return <TerminalFailRibbon key={`fail-${storyId}`} pos={pos} />;
      })}
    </>
  );
}
