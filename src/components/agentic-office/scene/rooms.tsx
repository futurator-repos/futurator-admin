'use client';
import {
  DOOR_HEIGHT,
  DOOR_WIDTH,
  MEETING_DOOR_WIDTH,
  MEETING_DOOR_Z,
  MEETING_FLOOR_COLOR,
  MEETING_WALL_COLOR,
  MGMT,
  MGMT_DOOR_WIDTH,
  MGMT_DOOR_Z,
  MGMT_FLOOR_COLOR,
  MGMT_WALL_COLOR,
  ROOM,
  ROOM2,
  ROOM3,
  SERVER_DOOR_Z,
  SERVER_FLOOR_COLOR,
  SERVER_WALL_COLOR,
  WALL_COLOR,
} from './constants';

// ── Wall segment primitive ──

function WallSlab({
  from,
  to,
  onAxis,
  height = ROOM.height,
  thickness = ROOM.thickness,
  color = WALL_COLOR,
  visible = true,
}: {
  from: number;
  to: number;
  /** 'x' → wall runs along X; 'z' → wall runs along Z. */
  onAxis: 'x' | 'z';
  /** position of the wall on the perpendicular axis */
  height?: number;
  thickness?: number;
  color?: string;
  visible?: boolean;
  position: [number, number, number];
}) {
  void from;
  void to;
  void onAxis;
  void height;
  void thickness;
  void color;
  void visible;
  return null;
}
void WallSlab;

/**
 * Rectangular wall with a rectangular door cutout. Built as three boxes:
 *   - below the door header (none in this implementation — full-height gap)
 *   - left of the opening
 *   - right of the opening
 *   - above the opening (header)
 */
function WallWithDoor({
  // Wall runs along Z at fixed X
  x,
  z0,
  z1,
  doorCenterZ,
  doorWidth,
  height = ROOM.height,
  thickness = ROOM.thickness,
  color = WALL_COLOR,
  opacity = 1,
  visible = true,
}: {
  x: number;
  z0: number;
  z1: number;
  doorCenterZ: number;
  doorWidth: number;
  height?: number;
  thickness?: number;
  color?: string;
  opacity?: number;
  visible?: boolean;
}) {
  const doorZ0 = doorCenterZ - doorWidth / 2;
  const doorZ1 = doorCenterZ + doorWidth / 2;
  const leftLen = doorZ0 - z0;
  const rightLen = z1 - doorZ1;
  const transparent = opacity < 1;

  return (
    <group visible={visible}>
      {leftLen > 0 && (
        <mesh
          position={[x, height / 2, z0 + leftLen / 2]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[thickness, height, leftLen]} />
          <meshStandardMaterial color={color} transparent={transparent} opacity={opacity} />
        </mesh>
      )}
      {rightLen > 0 && (
        <mesh
          position={[x, height / 2, doorZ1 + rightLen / 2]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[thickness, height, rightLen]} />
          <meshStandardMaterial color={color} transparent={transparent} opacity={opacity} />
        </mesh>
      )}
      {/* Header above the door */}
      {height > DOOR_HEIGHT && (
        <mesh
          position={[x, (DOOR_HEIGHT + height) / 2, doorCenterZ]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[thickness, height - DOOR_HEIGHT, doorWidth]} />
          <meshStandardMaterial color={color} transparent={transparent} opacity={opacity} />
        </mesh>
      )}
    </group>
  );
}

function SolidWall({
  position,
  size,
  color = WALL_COLOR,
  opacity = 1,
  visible = true,
}: {
  position: [number, number, number];
  size: [number, number, number];
  color?: string;
  opacity?: number;
  visible?: boolean;
}) {
  const transparent = opacity < 1;
  return (
    <mesh position={position} castShadow receiveShadow visible={visible}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} transparent={transparent} opacity={opacity} />
    </mesh>
  );
}

// ── Floor primitive ──

function Floor({
  minX,
  maxX,
  minZ,
  maxZ,
  color,
  onClick,
}: {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  color: string;
  onClick?: () => void;
}) {
  const w = maxX - minX;
  const d = maxZ - minZ;
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[(minX + maxX) / 2, 0, (minZ + maxZ) / 2]}
      receiveShadow
      onClick={(e) => {
        if (!onClick) return;
        e.stopPropagation();
        onClick();
      }}
    >
      <planeGeometry args={[w, d]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

// ── Main office + adjacent rooms ──

export function Rooms() {
  return (
    <>
      {/* ── Floors ── */}
      <Floor
        minX={-ROOM.half}
        maxX={ROOM.half}
        minZ={-ROOM.half}
        maxZ={ROOM.half}
        color="#e8e0d4"
      />
      <Floor
        minX={ROOM2.minX}
        maxX={ROOM2.maxX}
        minZ={ROOM2.minZ}
        maxZ={ROOM2.maxZ}
        color={SERVER_FLOOR_COLOR}
      />
      <Floor
        minX={MGMT.minX}
        maxX={MGMT.maxX}
        minZ={MGMT.minZ}
        maxZ={MGMT.maxZ}
        color={MGMT_FLOOR_COLOR}
      />
      <Floor
        minX={ROOM3.minX}
        maxX={ROOM3.maxX}
        minZ={ROOM3.minZ}
        maxZ={ROOM3.maxZ}
        color={MEETING_FLOOR_COLOR}
      />

      {/* ── Main office walls ── */}
      {/* Left wall (full) */}
      <SolidWall
        position={[-ROOM.half, ROOM.height / 2, 0]}
        size={[ROOM.thickness, ROOM.height, ROOM.half * 2]}
      />
      {/* Back wall (full) */}
      <SolidWall
        position={[0, ROOM.height / 2, -ROOM.half]}
        size={[ROOM.half * 2, ROOM.height, ROOM.thickness]}
      />
      {/* Right wall — three doors: server @ -7, mgmt @ 2, meeting @ 9.
          Render as four stacked WallWithDoor segments for isolation. */}
      <WallWithDoor
        x={ROOM.half}
        z0={-ROOM.half}
        z1={(SERVER_DOOR_Z + MGMT_DOOR_Z) / 2}
        doorCenterZ={SERVER_DOOR_Z}
        doorWidth={DOOR_WIDTH}
      />
      <WallWithDoor
        x={ROOM.half}
        z0={(SERVER_DOOR_Z + MGMT_DOOR_Z) / 2}
        z1={(MGMT_DOOR_Z + MEETING_DOOR_Z) / 2}
        doorCenterZ={MGMT_DOOR_Z}
        doorWidth={MGMT_DOOR_WIDTH}
      />
      <WallWithDoor
        x={ROOM.half}
        z0={(MGMT_DOOR_Z + MEETING_DOOR_Z) / 2}
        z1={ROOM.half}
        doorCenterZ={MEETING_DOOR_Z}
        doorWidth={MEETING_DOOR_WIDTH}
      />
      {/* Front side of the main office is OPEN (camera side) */}

      {/* ── Server room walls ── */}
      <SolidWall
        position={[(ROOM2.minX + ROOM2.maxX) / 2, ROOM.height / 2, ROOM2.minZ]}
        size={[ROOM2.maxX - ROOM2.minX, ROOM.height, ROOM.thickness]}
        color={SERVER_WALL_COLOR}
      />
      <SolidWall
        position={[(ROOM2.minX + ROOM2.maxX) / 2, ROOM.height / 2, ROOM2.maxZ]}
        size={[ROOM2.maxX - ROOM2.minX, ROOM.height, ROOM.thickness]}
        color={SERVER_WALL_COLOR}
      />
      <SolidWall
        position={[ROOM2.maxX, ROOM.height / 2, (ROOM2.minZ + ROOM2.maxZ) / 2]}
        size={[ROOM.thickness, ROOM.height, ROOM2.maxZ - ROOM2.minZ]}
        color={SERVER_WALL_COLOR}
        visible={false}
      />

      {/* ── Management room walls ── */}
      {/* South wall (shared with meeting room's north) — rendered translucent
          so the camera can see through into the meeting room */}
      <SolidWall
        position={[(MGMT.minX + MGMT.maxX) / 2, ROOM.height / 2, MGMT.maxZ]}
        size={[MGMT.maxX - MGMT.minX, ROOM.height, ROOM.thickness]}
        color={MGMT_WALL_COLOR}
        opacity={0.2}
      />
      <SolidWall
        position={[MGMT.maxX, ROOM.height / 2, (MGMT.minZ + MGMT.maxZ) / 2]}
        size={[ROOM.thickness, ROOM.height, MGMT.maxZ - MGMT.minZ]}
        color={MGMT_WALL_COLOR}
        visible={false}
      />

      {/* ── Meeting room walls ── */}
      <SolidWall
        position={[(ROOM3.minX + ROOM3.maxX) / 2, ROOM.height / 2, ROOM3.maxZ]}
        size={[ROOM3.maxX - ROOM3.minX, ROOM.height, ROOM.thickness]}
        color={MEETING_WALL_COLOR}
        visible={false}
      />
      <SolidWall
        position={[ROOM3.maxX, ROOM.height / 2, (ROOM3.minZ + ROOM3.maxZ) / 2]}
        size={[ROOM.thickness, ROOM.height, ROOM3.maxZ - ROOM3.minZ]}
        color={MEETING_WALL_COLOR}
        visible={false}
      />
      {/* West outer wall — from main office front edge to meeting room back */}
      <SolidWall
        position={[ROOM.half, ROOM.height / 2, (ROOM.half + ROOM3.maxZ) / 2]}
        size={[ROOM.thickness, ROOM.height, ROOM3.maxZ - ROOM.half]}
        color={MEETING_WALL_COLOR}
      />
    </>
  );
}
