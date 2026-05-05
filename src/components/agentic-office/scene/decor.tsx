'use client';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FURN_URL } from '../cast';
import {
  MEETING_DOOR_Z,
  MGMT_DOOR_Z,
  ROOM,
  ROOM2,
  ROOM3,
  SERVER_DOOR_Z,
} from './constants';
import { Prop } from './prop';

const CACTUS_URL = `${FURN_URL}/cactus_medium_A.gltf`;
const CACTUS_SMALL_URL = `${FURN_URL}/cactus_small_A.gltf`;
const SHELF_URL = `${FURN_URL}/shelf_A_big.gltf`;
const SHELF_DECOR_URL = `${FURN_URL}/shelf_B_large_decorated.gltf`;
const RUG_YELLOW_URL = `${FURN_URL}/rug_rectangle_A.gltf`;
const RUG_BLUE_URL = `${FURN_URL}/rug_rectangle_B.gltf`;
const FRAME_LARGE_URL = `${FURN_URL}/pictureframe_large_A.gltf`;
const FRAME_SMALL_URL = `${FURN_URL}/pictureframe_small_A.gltf`;

// ── Generic wall-mounted screen frame + face (bezel + glow) ──

function WallScreen({
  position,
  rotation = [0, 0, 0] as [number, number, number],
  size,
  color,
  emissive,
  children,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  size: [number, number];
  color: string;
  emissive: string;
  children?: React.ReactNode;
}) {
  const [w, h] = size;
  return (
    <group position={position} rotation={rotation}>
      {/* Bezel */}
      <mesh castShadow>
        <boxGeometry args={[w + 0.18, h + 0.18, 0.07]} />
        <meshStandardMaterial color="#222" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Screen face */}
      <mesh position={[0, 0, 0.04]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={0.55}
          toneMapped={false}
        />
      </mesh>
      {/* Content layer */}
      <group position={[0, 0, 0.045]}>{children}</group>
    </group>
  );
}

// ── Project Roadmap (Gantt) — animated sweeping cursor + 5 task bars ──

const GANT_TASKS = [
  { y: 0.5, start: 0, end: 0.55, color: '#4cc9f0', label: 'Discovery' },
  { y: 0.2, start: 0.1, end: 0.5, color: '#80ed99', label: 'Design' },
  { y: -0.1, start: 0.3, end: 0.85, color: '#c77dff', label: 'Build' },
  { y: -0.4, start: 0.5, end: 0.8, color: '#ffcc66', label: 'QA' },
  { y: -0.7, start: 0.7, end: 0.95, color: '#ef476f', label: 'Ship' },
] as const;
const GANT_PERIOD = 9;

function GanttContent({ w, h }: { w: number; h: number }) {
  const PAD_L = 0.7;
  const trackW = w - PAD_L - 0.15;
  const trackX0 = -w / 2 + PAD_L;
  const cursorRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = (clock.elapsedTime % GANT_PERIOD) / GANT_PERIOD;
    if (cursorRef.current) {
      cursorRef.current.position.x = trackX0 + t * trackW;
    }
  });

  return (
    <>
      <Text
        position={[0, h / 2 - 0.18, 0.01]}
        fontSize={0.13}
        color="#e0e0e0"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        PROJECT ROADMAP
      </Text>
      {GANT_TASKS.map((task) => {
        const taskWidth = (task.end - task.start) * trackW;
        const taskX = trackX0 + task.start * trackW + taskWidth / 2;
        return (
          <group key={task.label} position={[0, task.y, 0]}>
            <Text
              position={[-w / 2 + 0.05, 0, 0.005]}
              fontSize={0.09}
              color="#cbd5e1"
              anchorX="left"
              anchorY="middle"
              material-toneMapped={false}
            >
              {task.label}
            </Text>
            <mesh position={[taskX, 0, 0.002]}>
              <planeGeometry args={[taskWidth, 0.13]} />
              <meshStandardMaterial
                color={task.color}
                emissive={task.color}
                emissiveIntensity={0.7}
                toneMapped={false}
              />
            </mesh>
          </group>
        );
      })}
      {/* Sweeping cursor */}
      <mesh ref={cursorRef} position={[trackX0, 0, 0.003]}>
        <planeGeometry args={[0.02, h * 0.85]} />
        <meshBasicMaterial color="#f8fafc" transparent opacity={0.9} toneMapped={false} />
      </mesh>
    </>
  );
}

// ── Git graph — scrolling dashed lanes ──

function GitContent({ w, h }: { w: number; h: number }) {
  const LANES = 4;
  const laneRefs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame((_, dt) => {
    laneRefs.current.forEach((m, i) => {
      if (!m) return;
      m.position.x += dt * 0.2 * (i % 2 ? -1 : 1);
      const range = w * 0.6;
      if (m.position.x > range / 2) m.position.x = -range / 2;
      if (m.position.x < -range / 2) m.position.x = range / 2;
    });
  });

  return (
    <>
      <Text
        position={[0, h / 2 - 0.12, 0.01]}
        fontSize={0.09}
        color="#a0e87b"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        git graph
      </Text>
      {Array.from({ length: LANES }).map((_, i) => {
        const laneY = h / 2 - 0.35 - i * ((h - 0.55) / LANES);
        const color = i % 3 === 0 ? '#4cc9f0' : i % 3 === 1 ? '#80ed99' : '#c77dff';
        return (
          <group key={i} position={[0, laneY, 0]}>
            {/* Track */}
            <mesh>
              <planeGeometry args={[w * 0.85, 0.012]} />
              <meshBasicMaterial color="#1a2332" toneMapped={false} />
            </mesh>
            {/* Moving dashes */}
            <mesh
              position={[0, 0, 0.001]}
              ref={(el) => {
                laneRefs.current[i] = el;
              }}
            >
              <planeGeometry args={[0.2, 0.03]} />
              <meshBasicMaterial color={color} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

// ── Knowledge graph — pulsing network nodes + connecting lines ──

function KGContent({ w, h }: { w: number; h: number }) {
  const NODES = 9;
  const nodes = useMemo(
    () =>
      Array.from({ length: NODES }, (_, i) => {
        const angle = (i / NODES) * Math.PI * 2 + (i * 0.137);
        const r = 0.25 + ((i * 7) % 5) * 0.06;
        return {
          x: Math.cos(angle) * r * (w * 0.8),
          y: Math.sin(angle) * r * (h * 0.7),
          color: ['#4cc9f0', '#80ed99', '#c77dff', '#ffcc66'][i % 4],
        };
      }),
    [w, h],
  );
  const refs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    nodes.forEach((_n, i) => {
      const m = refs.current[i];
      if (!m) return;
      const pulse = 0.8 + 0.2 * Math.sin(t * 2 + i);
      m.scale.setScalar(pulse);
    });
  });

  return (
    <>
      <Text
        position={[0, h / 2 - 0.1, 0.01]}
        fontSize={0.09}
        color="#a5b4fc"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        KNOWLEDGE GRAPH
      </Text>
      {/* Edges — pairs of nodes */}
      {nodes.slice(0, -1).map((n, i) => {
        const m = nodes[(i + 2) % nodes.length];
        const mx = (n.x + m.x) / 2;
        const my = (n.y + m.y) / 2;
        const dx = m.x - n.x;
        const dy = m.y - n.y;
        const len = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        return (
          <mesh key={`edge-${i}`} position={[mx, my, 0]} rotation={[0, 0, angle]}>
            <planeGeometry args={[len, 0.008]} />
            <meshBasicMaterial color="#334155" toneMapped={false} />
          </mesh>
        );
      })}
      {/* Nodes */}
      {nodes.map((n, i) => (
        <mesh
          key={i}
          position={[n.x, n.y, 0.002]}
          ref={(el) => {
            refs.current[i] = el;
          }}
        >
          <circleGeometry args={[0.05, 16]} />
          <meshStandardMaterial
            color={n.color}
            emissive={n.color}
            emissiveIntensity={0.9}
            toneMapped={false}
          />
        </mesh>
      ))}
    </>
  );
}

// ── EC2 Dashboard — vertical bar chart + metric tiles ──

function EC2Content({ w, h }: { w: number; h: number }) {
  const BARS = 14;
  const barRefs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    barRefs.current.forEach((m, i) => {
      if (!m) return;
      const v = 0.3 + 0.7 * Math.abs(Math.sin(t * 1.2 + i * 0.4));
      m.scale.y = v;
      m.position.y = -h / 2 + 0.2 + (v * (h - 0.5)) / 2;
    });
  });

  return (
    <>
      <Text
        position={[0, h / 2 - 0.15, 0.01]}
        fontSize={0.11}
        color="#10b981"
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        EC2 MONITORING
      </Text>
      {Array.from({ length: BARS }).map((_, i) => {
        const barW = (w * 0.85) / BARS;
        const x = -w / 2 + 0.12 + (i + 0.5) * barW;
        const hue =
          i % 4 === 0
            ? '#ffc857'
            : i % 4 === 1
              ? '#ef476f'
              : i % 4 === 2
                ? '#06d6a0'
                : '#4cc9f0';
        return (
          <mesh
            key={i}
            position={[x, -h / 2 + 0.2 + (h - 0.5) / 2, 0.002]}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
          >
            <planeGeometry args={[barW * 0.7, h - 0.5]} />
            <meshStandardMaterial
              color={hue}
              emissive={hue}
              emissiveIntensity={0.8}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </>
  );
}

// ── Server racks — simple dark boxes along the server room back wall ──

function ServerRacks() {
  const racks: { pos: [number, number, number] }[] = [
    { pos: [14, 0, -11] },
    { pos: [15.5, 0, -11] },
    { pos: [18, 0, -11] },
    { pos: [19.5, 0, -11] },
    { pos: [22, 0, -11] },
    // Center island
    { pos: [17.5, 0, -7] },
    { pos: [18.5, 0, -7] },
  ];
  return (
    <>
      {racks.map((r, i) => (
        <group key={i} position={[r.pos[0], 1, r.pos[2]]}>
          {/* Cabinet */}
          <mesh castShadow>
            <boxGeometry args={[0.7, 2, 0.8]} />
            <meshStandardMaterial color="#1a1d24" metalness={0.6} roughness={0.3} />
          </mesh>
          {/* Door panel */}
          <mesh position={[0, 0, 0.42]}>
            <planeGeometry args={[0.6, 1.8]} />
            <meshStandardMaterial color="#0a0d14" metalness={0.4} roughness={0.5} />
          </mesh>
          {/* LED row */}
          {[0.7, 0.5, 0.3, 0.1, -0.1, -0.3, -0.5, -0.7].map((y, j) => (
            <mesh key={j} position={[0, y, 0.42]}>
              <planeGeometry args={[0.5, 0.03]} />
              <meshBasicMaterial
                color={j % 3 === 0 ? '#10b981' : j % 3 === 1 ? '#fbbf24' : '#0ea5e9'}
                toneMapped={false}
              />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

// ── Room dressing — rugs, plants, frames, shelf ──

function Decorations() {
  return (
    <>
      {/* Yellow rug under supervisor + middle workstation */}
      <Prop url={RUG_YELLOW_URL} position={[0, 0.01, 0.5]} scale={[1.6, 1, 1.6]} />

      {/* Blue rug under couch/lounge */}
      <Prop url={RUG_BLUE_URL} position={[8, 0.01, 9]} scale={[1, 1, 1]} />

      {/* Cactus plants in corners */}
      <Prop url={CACTUS_URL} position={[-11, 0, 11]} />
      <Prop url={CACTUS_SMALL_URL} position={[11, 0, -11]} />

      {/* Big shelf against the back wall */}
      <Prop url={SHELF_URL} position={[-3, 0, -11.5]} rotation={[0, 0, 0]} />
      <Prop url={SHELF_DECOR_URL} position={[3, 0, -11.5]} rotation={[0, 0, 0]} />

      {/* Picture frames on the back wall (small framed art) */}
      <Prop
        url={FRAME_SMALL_URL}
        position={[-9, 2.2, -11.89]}
        rotation={[0, 0, 0]}
      />
      <Prop
        url={FRAME_LARGE_URL}
        position={[9, 2.4, -11.89]}
        rotation={[0, 0, 0]}
      />
    </>
  );
}

// ── Composition ──

// ── Windows ──
// Procedural "window" — bright sky-blue pane with a mullion cross + a soft
// emissive glow so the office feels less like a bunker. Placed on the
// LEFT wall next to the coffee station.

function Window({
  position,
  rotation = [0, 0, 0] as [number, number, number],
  size = [1.4, 1.6] as [number, number],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  size?: [number, number];
}) {
  const [w, h] = size;
  return (
    <group position={position} rotation={rotation}>
      {/* Outer frame */}
      <mesh castShadow>
        <boxGeometry args={[w + 0.14, h + 0.14, 0.08]} />
        <meshStandardMaterial color="#6b5b45" metalness={0.2} roughness={0.6} />
      </mesh>
      {/* Glass pane */}
      <mesh position={[0, 0, 0.05]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial
          color="#9dd5ff"
          emissive="#7cc1ff"
          emissiveIntensity={0.6}
          toneMapped={false}
        />
      </mesh>
      {/* Horizontal mullion */}
      <mesh position={[0, 0, 0.055]}>
        <planeGeometry args={[w, 0.06]} />
        <meshStandardMaterial color="#6b5b45" />
      </mesh>
      {/* Vertical mullion */}
      <mesh position={[0, 0, 0.055]}>
        <planeGeometry args={[0.06, h]} />
        <meshStandardMaterial color="#6b5b45" />
      </mesh>
    </group>
  );
}

export function RoomScreens() {
  // Main office left wall (x = -ROOM.half) — Knowledge Graph at the same
  // size as the whiteboard (4.8 × 2.4) so the two boards read as a pair
  // along the wall. Whiteboard is at z=0, KG is further forward at z=7.5.
  const kgPos: [number, number, number] = [-ROOM.half + 0.12, 1.6, 7.5];
  const kgRot: [number, number, number] = [0, Math.PI / 2, 0];

  // Main office back wall (z = -ROOM.half) — Gantt + Git.
  const ganttPos: [number, number, number] = [-5, 2.6, -ROOM.half + 0.12];
  const gitPos: [number, number, number] = [5, 2.6, -ROOM.half + 0.12];

  // Server room back wall — EC2 dashboard.
  const ec2Pos: [number, number, number] = [
    (ROOM2.minX + ROOM2.maxX) / 2,
    2.4,
    ROOM2.minZ + 0.12,
  ];

  return (
    <>
      {/* Knowledge Graph — matches the whiteboard's 4.8 × 2.4 size */}
      <WallScreen
        position={kgPos}
        rotation={kgRot}
        size={[4.8, 2.4]}
        color="#0a0f24"
        emissive="#1a1d50"
      >
        <KGContent w={4.8} h={2.4} />
      </WallScreen>

      <WallScreen
        position={ganttPos}
        size={[3.0, 1.8]}
        color="#0a1429"
        emissive="#0a1429"
      >
        <GanttContent w={3.0} h={1.8} />
      </WallScreen>

      <WallScreen
        position={gitPos}
        size={[2.4, 1.6]}
        color="#050808"
        emissive="#061710"
      >
        <GitContent w={2.4} h={1.6} />
      </WallScreen>

      <WallScreen
        position={ec2Pos}
        size={[5.5, 2.0]}
        color="#02110c"
        emissive="#033521"
      >
        <EC2Content w={5.5} h={2.0} />
      </WallScreen>

      {/* Windows on the left wall, next to the coffee machine. Coffee is at
          (-10, 0, -8); the left wall is at x = -12. Mount two windows on
          that wall between z=-10 and z=-4 so the coffee area feels bright. */}
      <Window
        position={[-ROOM.half + 0.12, 1.8, -5]}
        rotation={[0, Math.PI / 2, 0]}
        size={[1.6, 1.6]}
      />
      <Window
        position={[-ROOM.half + 0.12, 1.8, -10]}
        rotation={[0, Math.PI / 2, 0]}
        size={[1.6, 1.6]}
      />
    </>
  );
}

export function RoomProps() {
  // Silence unused-door-constant warnings so TS doesn't complain if we
  // later reposition screens around doors.
  void SERVER_DOOR_Z;
  void MGMT_DOOR_Z;
  void MEETING_DOOR_Z;
  void ROOM3;
  return (
    <>
      <Decorations />
      <ServerRacks />
    </>
  );
}
