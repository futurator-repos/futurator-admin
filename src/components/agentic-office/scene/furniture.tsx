'use client';
import * as THREE from 'three';
import type { PersonaRole } from '../types';
import { MONITOR_THEMES, MonitorContent } from './monitors';
import { Prop } from './prop';
import {
  CHAIR_URL,
  COFFEE_POS,
  COFFEE_TABLE_URL,
  COUCH_PILLOWS_URL,
  COUCH_POS,
  COUCH_URL,
  DESK_OFFSET,
  DESK_SCALE,
  DESK_TOP_Y,
  DESK_URL,
  LONG_TABLE_URL,
  MEETING_SEATS,
  MEETING_TABLE_POS,
  MEETING_TABLE_SCALE,
  MGMT_SEATS,
  MGMT_TABLE_POS,
  MGMT_TABLE_SCALE,
  ROUND_TABLE_URL,
  SUPERVISOR_POS,
  SUPERVISOR_ROT_Y,
  WORKSTATIONS,
} from './constants';

// ── Workstation = chair + desk + simple monitor box ──
// Procedural per-role monitor content (terminal / scan / matrix / kanban)
// lands in Slice 5.

function Monitor({ role }: { role: PersonaRole | null }) {
  const MON_BASE = [0.5, 0.06, 0.32] as const;
  const MON_STAND_H = 0.45;
  const MON_HOUSING = [1.4, 0.9, 0.08] as const;
  const MON_SCREEN: [number, number] = [1.3, 0.8];
  const MON_SCREEN_Y = MON_STAND_H + MON_HOUSING[1] / 2;
  const basePos: [number, number, number] = [DESK_OFFSET.x, DESK_TOP_Y, DESK_OFFSET.z + 0.05];
  const theme = role ? MONITOR_THEMES[role] : null;
  return (
    <group position={basePos}>
      <mesh position={[0, MON_BASE[1] / 2, 0]} castShadow>
        <boxGeometry args={[MON_BASE[0], MON_BASE[1], MON_BASE[2]]} />
        <meshStandardMaterial color="#1a1a1a" metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh position={[0, MON_STAND_H / 2 + 0.02, 0]} castShadow>
        <boxGeometry args={[0.1, MON_STAND_H, 0.1]} />
        <meshStandardMaterial color="#1a1a1a" metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh position={[0, MON_SCREEN_Y, 0.025]} castShadow>
        <boxGeometry args={[MON_HOUSING[0], MON_HOUSING[1], MON_HOUSING[2]]} />
        <meshStandardMaterial color="#111" metalness={0.2} roughness={0.7} />
      </mesh>
      <mesh position={[0, MON_SCREEN_Y, -0.018]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={MON_SCREEN} />
        <meshStandardMaterial
          color={theme ? theme.color : '#0a0a0a'}
          emissive={theme ? theme.emissive : '#000000'}
          emissiveIntensity={theme ? theme.intensity : 0}
          toneMapped={false}
        />
      </mesh>
      {role && (
        <group position={[0, MON_SCREEN_Y, -0.024]} rotation={[0, Math.PI, 0]}>
          <MonitorContent role={role} w={MON_SCREEN[0]} h={MON_SCREEN[1]} />
        </group>
      )}
    </group>
  );
}

/**
 * Small colored flag on the desk surface indicating the occupying
 * assignment's plan (Epic C). 30cm × 5cm strip positioned beside the
 * monitor base. Absent when no plan color is assigned — the desk looks
 * neutral, matching its idle state.
 */
function PlanFlag({ color }: { color: string }) {
  const POS: [number, number, number] = [
    DESK_OFFSET.x - 0.5,
    DESK_TOP_Y + 0.01,
    DESK_OFFSET.z - 0.15,
  ];
  return (
    <group position={POS}>
      {/* Base strip — flat on the desk, compositor-friendly material. */}
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.3, 0.05]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      {/* Tiny vertical stem so the flag reads from the isometric camera. */}
      <mesh position={[0.12, 0.08, 0]}>
        <boxGeometry args={[0.015, 0.16, 0.015]} />
        <meshStandardMaterial color="#1a1a22" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0.055, 0.12, 0]}>
        <planeGeometry args={[0.13, 0.08]} />
        <meshBasicMaterial color={color} toneMapped={false} side={2} />
      </mesh>
    </group>
  );
}

export function Workstation({
  pos,
  rotY,
  role,
  planColor,
}: {
  pos: [number, number, number];
  rotY: number;
  role: PersonaRole | null;
  planColor?: string | null;
}) {
  return (
    <group position={pos} rotation={[0, rotY, 0]}>
      <Prop url={CHAIR_URL} />
      <Prop url={DESK_URL} position={DESK_OFFSET.toArray()} scale={DESK_SCALE} />
      <Monitor role={role} />
      {planColor && <PlanFlag color={planColor} />}
    </group>
  );
}

export function Workstations({
  roleByDeskSlot,
  planColorByDeskSlot,
}: {
  roleByDeskSlot: ReadonlyMap<number, PersonaRole>;
  planColorByDeskSlot?: ReadonlyMap<number, string>;
}) {
  return (
    <>
      {WORKSTATIONS.map((ws) => (
        <Workstation
          key={ws.slot}
          pos={ws.pos}
          rotY={ws.rotY}
          role={roleByDeskSlot.get(ws.slot) ?? null}
          planColor={planColorByDeskSlot?.get(ws.slot) ?? null}
        />
      ))}
    </>
  );
}

// ── Supervisor desk (Ricardo's) — identical to a workstation ──

export function SupervisorDesk({ occupied }: { occupied: boolean }) {
  return (
    <Workstation
      pos={SUPERVISOR_POS}
      rotY={SUPERVISOR_ROT_Y}
      role={occupied ? 'orchestrator' : null}
    />
  );
}

// ── Coffee station ──

export function CoffeeStation() {
  return (
    <group position={COFFEE_POS.toArray()}>
      <Prop url={COFFEE_TABLE_URL} />
      <group position={[0, 0.5, 0]}>
        <mesh position={[0, 0.35, 0]} castShadow>
          <boxGeometry args={[0.7, 0.7, 0.55]} />
          <meshStandardMaterial color="#1a1a22" metalness={0.5} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.73, 0]} castShadow>
          <boxGeometry args={[0.72, 0.08, 0.57]} />
          <meshStandardMaterial color="#cccccc" metalness={0.9} roughness={0.15} />
        </mesh>
        <mesh position={[0, 0.55, 0.28]}>
          <planeGeometry args={[0.3, 0.12]} />
          <meshStandardMaterial color="#0a0a15" emissive="#4cc9f0" emissiveIntensity={0.9} />
        </mesh>
      </group>
    </group>
  );
}

// ── Couch (3-seat lounge) ──

export function Couch() {
  return (
    <group position={COUCH_POS} rotation={[0, -Math.PI / 2, 0]}>
      <Prop url={COUCH_URL} />
      <Prop url={COUCH_PILLOWS_URL} />
    </group>
  );
}

// ── Management round table + 8 chairs ──

export function ManagementTable() {
  return (
    <group>
      <Prop url={ROUND_TABLE_URL} position={MGMT_TABLE_POS} scale={MGMT_TABLE_SCALE} />
      {MGMT_SEATS.map((s) => (
        <Prop
          key={s.slot}
          url={CHAIR_URL}
          position={s.chairPos}
          rotation={[0, s.chairRotY, 0]}
        />
      ))}
    </group>
  );
}

// ── Meeting long table + 8 chairs ──

export function MeetingTable() {
  return (
    <group>
      <Prop url={LONG_TABLE_URL} position={MEETING_TABLE_POS} scale={MEETING_TABLE_SCALE} />
      {MEETING_SEATS.map((s) => (
        <Prop
          key={s.slot}
          url={CHAIR_URL}
          position={s.chairPos}
          rotation={[0, s.chairRotY, 0]}
        />
      ))}
    </group>
  );
}

// Whiteboard lives in its own file (scene/whiteboard.tsx) because it's
// interactive + stateful — it renders the real kanban stickies and the
// whole board is a click target that opens the overlay.

// Util for type safety on the Vector3 prop position in ManagementTable.
void THREE;
