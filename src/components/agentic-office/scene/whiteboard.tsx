'use client';
import { Text } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { useMemo, useState } from 'react';
import * as THREE from 'three';
import { stickyHueFor, stickyTiltFor } from '../overlays/kanban-board';
import { useOfficeStore } from '../store';
import type { KanbanColumn, KanbanStory } from '../types';

// ── Whiteboard geometry ──
// Mounted flush on the LEFT wall (x = -ROOM.half). Rotated π/2 around Y so
// its face normal points +X into the office. Character renders behind the
// board (opaque from this side, transparent from the wall side).

const WB_W = 4.8;
const WB_H = 2.4;

// The 3D board folds the 5-column kanban into 3 physical columns so the
// stickies aren't too cramped at this scale. Mapping:
//   TODO  ← backlog + queued
//   DOING ← in_progress + in_review
//   DONE  ← done
type StickyColumn = 'todo' | 'doing' | 'done';

const FOLD_COLUMN: Record<KanbanColumn, StickyColumn> = {
  backlog: 'todo',
  queued: 'todo',
  in_progress: 'doing',
  in_review: 'doing',
  done: 'done',
};

const STICKY_COLUMN_LABEL: Record<StickyColumn, string> = {
  todo: 'TODO',
  doing: 'DOING',
  done: 'DONE',
};

const STICKY_W = 0.46;
const STICKY_H = 0.36;
const STICKY_GAP_X = 0.05;
const STICKY_GAP_Y = 0.06;
const STICKIES_PER_COL = 4;
const ROWS = 4;

function columnX(col: StickyColumn): number {
  const step = WB_W / 3;
  const base = -WB_W / 2 + step / 2;
  return col === 'todo' ? base : col === 'doing' ? base + step : base + 2 * step;
}

function slotY(row: number): number {
  const startY = WB_H / 2 - 0.55;
  return startY - row * (STICKY_H + STICKY_GAP_Y);
}

// Tiny sticky note rendered as a quad with text overlay. Deliberately
// simple — the overlay kanban is the readable view; the wall stickies are
// ambient atmosphere that move when stories transition.

function Sticky({
  story,
  x,
  y,
}: {
  story: KanbanStory;
  x: number;
  y: number;
}) {
  const hue = stickyHueFor(story.storyId);
  const tiltDeg = stickyTiltFor(story.storyId);
  const tilt = (tiltDeg * Math.PI) / 180;
  const titleText = story.title.length > 28 ? story.title.slice(0, 26) + '…' : story.title;
  return (
    <group position={[x, y, 0.04]} rotation={[0, 0, tilt]}>
      {/* Sticky paper */}
      <mesh>
        <planeGeometry args={[STICKY_W, STICKY_H]} />
        <meshStandardMaterial color={hue.bg} roughness={0.9} />
      </mesh>
      {/* Drop shadow — a slightly darker offset quad behind */}
      <mesh position={[0.015, -0.02, -0.002]}>
        <planeGeometry args={[STICKY_W, STICKY_H]} />
        <meshBasicMaterial color="#000" transparent opacity={0.25} />
      </mesh>
      {/* Wave + id pill */}
      <Text
        position={[-STICKY_W / 2 + 0.05, STICKY_H / 2 - 0.05, 0.001]}
        fontSize={0.035}
        color={hue.fg}
        anchorX="left"
        anchorY="top"
        material-toneMapped={false}
      >
        {story.wave !== null ? `W${story.wave}` : '·'}
      </Text>
      {/* Title */}
      <Text
        position={[0, 0, 0.001]}
        fontSize={0.045}
        color={hue.fg}
        anchorX="center"
        anchorY="middle"
        maxWidth={STICKY_W - 0.08}
        textAlign="center"
        material-toneMapped={false}
      >
        {titleText}
      </Text>
      {/* Failed marker */}
      {story.failed && (
        <Text
          position={[0, -STICKY_H / 2 + 0.05, 0.001]}
          fontSize={0.035}
          color="#c1121f"
          anchorX="center"
          anchorY="bottom"
          material-toneMapped={false}
        >
          ✗ FAILED
        </Text>
      )}
    </group>
  );
}

export function Whiteboard() {
  const stories = useOfficeStore((s) => s.kanbanStories);
  const setKanbanOpen = useOfficeStore((s) => s.setKanbanOpen);
  const [hovered, setHovered] = useState(false);

  const stickiesByCol = useMemo(() => {
    const groups: Record<StickyColumn, KanbanStory[]> = {
      todo: [],
      doing: [],
      done: [],
    };
    for (const s of stories) groups[FOLD_COLUMN[s.column]].push(s);
    // Trim each column so the board doesn't overflow its edges.
    return {
      todo: groups.todo.slice(0, STICKIES_PER_COL * ROWS),
      doing: groups.doing.slice(0, STICKIES_PER_COL * ROWS),
      done: groups.done.slice(-STICKIES_PER_COL * ROWS),
    };
  }, [stories]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    setKanbanOpen(true);
  };

  return (
    <group
      position={[-11.85, 1.6, 0]}
      rotation={[0, Math.PI / 2, 0]}
      onClick={onClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = 'auto';
      }}
    >
      {/* Frame — glows amber on hover so the board reads as clickable */}
      <mesh castShadow>
        <boxGeometry args={[WB_W + 0.15, WB_H + 0.15, 0.1]} />
        <meshStandardMaterial
          color={hovered ? '#b45309' : '#6b5b45'}
          metalness={0.25}
          roughness={0.6}
        />
      </mesh>
      {/* Whiteboard face */}
      <mesh position={[0, 0, 0.055]}>
        <planeGeometry args={[WB_W, WB_H]} />
        <meshStandardMaterial color="#f4f4f4" roughness={0.3} />
      </mesh>

      {/* Column headers */}
      {(['todo', 'doing', 'done'] as StickyColumn[]).map((col) => (
        <Text
          key={col}
          position={[columnX(col), WB_H / 2 - 0.18, 0.06]}
          fontSize={0.13}
          color="#334155"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.005}
          outlineColor="#1e293b"
          material-toneMapped={false}
        >
          {STICKY_COLUMN_LABEL[col]}
        </Text>
      ))}

      {/* Column dividers */}
      {[1, 2].map((i) => (
        <mesh key={i} position={[-WB_W / 2 + (WB_W / 3) * i, 0, 0.057]}>
          <planeGeometry args={[0.01, WB_H - 0.5]} />
          <meshBasicMaterial color="#94a3b8" />
        </mesh>
      ))}

      {/* Stickies */}
      {(['todo', 'doing', 'done'] as StickyColumn[]).flatMap((col) =>
        stickiesByCol[col].map((story, i) => (
          <Sticky
            key={`${col}-${story.epicId}-${story.storyId}`}
            story={story}
            x={columnX(col)}
            y={slotY(i)}
          />
        )),
      )}

      {/* Hint */}
      <Text
        position={[0, -WB_H / 2 - 0.2, 0.05]}
        fontSize={0.09}
        color={hovered ? '#f59e0b' : '#94a3b8'}
        anchorX="center"
        anchorY="middle"
        material-toneMapped={false}
      >
        {hovered ? 'Click to open kanban' : 'Click the board to open kanban'}
      </Text>
    </group>
  );
}

// Silence unused-var — kept for future extensions (cursor hover effects).
void THREE;
