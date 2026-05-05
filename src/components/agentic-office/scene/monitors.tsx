'use client';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { PersonaRole } from '../types';

// ── Per-role theme (screen bg + emissive) ──

export const MONITOR_THEMES: Record<
  PersonaRole,
  { color: string; emissive: string; intensity: number }
> = {
  developer: { color: '#1a0e05', emissive: '#3a1c0a', intensity: 0.7 },
  reviewer: { color: '#141820', emissive: '#1f2a3a', intensity: 0.6 },
  tester: { color: '#05141a', emissive: '#0a3a4a', intensity: 0.65 },
  orchestrator: { color: '#000000', emissive: '#000000', intensity: 0 },
  pm: { color: '#1a0e2a', emissive: '#2a1350', intensity: 0.55 },
};

// ── Developer terminal: typing lines + blinking caret ──

export function DevContent({ w, h }: { w: number; h: number }) {
  const COUNT = 12;
  const LINE_H = h * 0.07;
  const TYPE_MS = 380;
  const CYCLE = COUNT * TYPE_MS;

  const lines = useMemo(
    () =>
      Array.from({ length: COUNT }, (_, i) => ({
        y: h / 2 - LINE_H * 1.2 - i * LINE_H,
        indent: w * (((i * 13) % 4) * 0.03),
        targetW: w * (0.25 + ((i * 7) % 10) * 0.035),
        color:
          i % 5 === 0
            ? '#a3e635'
            : i % 5 === 1
              ? '#fbbf24'
              : i % 5 === 2
                ? '#60a5fa'
                : i % 5 === 3
                  ? '#f472b6'
                  : '#d4d4d4',
      })),
    [w, h, LINE_H],
  );

  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const caretRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const elapsed = (clock.elapsedTime * 1000) % CYCLE;
    const activeIdx = Math.floor(elapsed / TYPE_MS);
    const activeT = (elapsed % TYPE_MS) / TYPE_MS;

    lines.forEach((ln, i) => {
      const m = meshRefs.current[i];
      if (!m) return;
      let drawnW: number;
      if (i < activeIdx) drawnW = ln.targetW;
      else if (i === activeIdx) drawnW = ln.targetW * activeT;
      else drawnW = 0;
      m.scale.x = Math.max(0.0001, drawnW);
      m.position.x = -w / 2 + ln.indent + drawnW / 2;
    });

    const caret = caretRef.current;
    if (caret) {
      const ln = lines[activeIdx];
      const drawnW = ln.targetW * activeT;
      caret.position.x = -w / 2 + ln.indent + drawnW + 0.015;
      caret.position.y = ln.y;
      (caret.material as THREE.MeshBasicMaterial).opacity =
        Math.sin(clock.elapsedTime * 8) > 0 ? 1 : 0;
    }
  });

  return (
    <>
      {lines.map((ln, i) => (
        <mesh
          key={i}
          position={[0, ln.y, 0]}
          ref={(el) => {
            meshRefs.current[i] = el;
          }}
        >
          <planeGeometry args={[1, 0.035]} />
          <meshBasicMaterial color={ln.color} toneMapped={false} />
        </mesh>
      ))}
      <mesh ref={caretRef}>
        <planeGeometry args={[0.02, 0.05]} />
        <meshBasicMaterial color="#d4d4d4" transparent toneMapped={false} />
      </mesh>
    </>
  );
}

// ── Reviewer code-scan: sweeping line + ✓/⚠/✗ marks ──

const REVIEW_MARKS = [
  { ch: '✓', color: '#22c55e' },
  { ch: '⚠', color: '#f59e0b' },
  { ch: '✗', color: '#ef4444' },
  { ch: '✓', color: '#22c55e' },
  { ch: '🔍', color: '#60a5fa' },
  { ch: '✓', color: '#22c55e' },
] as const;

export function ReviewerContent({ w, h }: { w: number; h: number }) {
  const REVIEW_PERIOD = 6.0;
  const rows = useMemo(
    () =>
      Array.from({ length: REVIEW_MARKS.length }).map((_, i) => ({
        y: h / 2 - 0.12 - i * (h * 0.13),
        barW: w * (0.4 + ((i * 5) % 4) * 0.05),
        barColor: i % 3 === 0 ? '#94a3b8' : i % 3 === 1 ? '#cbd5e1' : '#64748b',
        mark: REVIEW_MARKS[i % REVIEW_MARKS.length],
      })),
    [w, h],
  );

  const scanRef = useRef<THREE.Mesh>(null);
  const barRefs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(({ clock }) => {
    const t = (clock.elapsedTime % REVIEW_PERIOD) / REVIEW_PERIOD;
    const scan = scanRef.current;
    if (scan) scan.position.y = h / 2 - 0.06 - t * (h - 0.12);
    rows.forEach((r, i) => {
      const bar = barRefs.current[i];
      if (!bar) return;
      const rowProgress = (i + 1) / rows.length;
      const isActive = Math.abs(t - rowProgress) < 0.05;
      (bar.material as THREE.MeshBasicMaterial).color.set(isActive ? '#f1f5f9' : r.barColor);
    });
  });

  return (
    <>
      <mesh ref={scanRef} position={[0, 0, -0.001]}>
        <planeGeometry args={[w * 0.98, 0.02]} />
        <meshBasicMaterial color="#60a5fa" transparent opacity={0.55} toneMapped={false} />
      </mesh>
      {rows.map((r, i) => (
        <group key={i} position={[0, r.y, 0]}>
          <mesh
            position={[-w * 0.16, 0, 0]}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
          >
            <planeGeometry args={[r.barW, 0.05]} />
            <meshBasicMaterial color={r.barColor} toneMapped={false} />
          </mesh>
          <Text
            position={[w * 0.4, 0, 0.001]}
            fontSize={0.085}
            color={r.mark.color}
            anchorX="center"
            anchorY="middle"
            material-toneMapped={false}
          >
            {r.mark.ch}
          </Text>
        </group>
      ))}
    </>
  );
}

// ── Orchestrator matrix rain ──

const MATRIX_GLYPHS = '01アカサタナハマヤラワABCDEF$#@!*ｦｧｨｩｪｫｬｭｮ';

export function MatrixContent({ w, h }: { w: number; h: number }) {
  const COLS = 9;
  const PER_COL = 12;
  const cellH = h / PER_COL;
  const glyphs = useMemo(
    () =>
      Array.from({ length: COLS * PER_COL }, (_, i) => ({
        col: Math.floor(i / PER_COL),
        row: i % PER_COL,
      })),
    [],
  );
  const refs = useRef<(THREE.Object3D | null)[]>([]);
  const colSpeed = useMemo(
    () => Array.from({ length: COLS }, () => 0.6 + Math.random() * 0.9),
    [],
  );
  const colOffset = useRef<number[]>(Array(COLS).fill(0).map(() => Math.random()));

  useFrame((_, dt) => {
    for (let c = 0; c < COLS; c++) {
      colOffset.current[c] = (colOffset.current[c] + dt * colSpeed[c]) % 1;
    }
    glyphs.forEach((g, i) => {
      const m = refs.current[i];
      if (!m) return;
      const colW = w / COLS;
      const x = -w / 2 + colW * (g.col + 0.5);
      const off = colOffset.current[g.col];
      const y = h / 2 - ((g.row + off * PER_COL) % PER_COL) * cellH - cellH / 2;
      m.position.set(x, y, 0);
    });
  });

  return (
    <>
      {glyphs.map((g, i) => {
        const isLead = g.row === 0;
        const opacity = isLead ? 1 : Math.max(0.1, 1 - g.row * 0.1);
        return (
          <Text
            key={i}
            ref={(el) => {
              refs.current[i] = el as unknown as THREE.Object3D | null;
            }}
            position={[0, 0, 0]}
            fontSize={0.085}
            color={isLead ? '#eaffea' : '#14ff60'}
            anchorX="center"
            anchorY="middle"
            material-toneMapped={false}
            material-transparent={true}
            material-opacity={opacity}
          >
            {MATRIX_GLYPHS[(g.col * PER_COL + g.row) % MATRIX_GLYPHS.length]}
          </Text>
        );
      })}
    </>
  );
}

// ── PM mini-kanban: sticky notes migrate across 3 columns ──

const PM_NOTE_COUNT = 9;
const PM_MOVE_EVERY = 3.0;

export function PMContent({ w, h }: { w: number; h: number }) {
  const palette = useMemo(
    () => ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#fcbf49', '#c77dff'],
    [],
  );
  const notes = useMemo(
    () =>
      Array.from({ length: PM_NOTE_COUNT }, (_, i) => ({
        id: i,
        color: palette[i % palette.length],
        startCol: i % 3,
      })),
    [palette],
  );
  const columnOfNote = useRef<number[]>(notes.map((n) => n.startCol));
  const nextMoveAt = useRef(PM_MOVE_EVERY);
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);

  const colW = w / 3;
  const colX = (c: number) => -w / 2 + colW * (c + 0.5);
  const noteH = 0.09;
  const noteW = w * 0.22;
  const slotY = (slot: number) => h / 2 - 0.22 - slot * (noteH + 0.03);

  useFrame(({ clock }) => {
    if (clock.elapsedTime > nextMoveAt.current) {
      nextMoveAt.current = clock.elapsedTime + PM_MOVE_EVERY;
      const candidates = columnOfNote.current
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c < 2);
      const pick = candidates.length
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : { i: Math.floor(Math.random() * PM_NOTE_COUNT), c: 0 };
      const next = columnOfNote.current[pick.i] + 1;
      columnOfNote.current[pick.i] = next > 2 ? 0 : next;
    }
    const slotCursor = [0, 0, 0];
    notes.forEach((_n, i) => {
      const c = columnOfNote.current[i];
      const s = slotCursor[c]++;
      const targetX = colX(c);
      const targetY = slotY(s);
      const m = meshRefs.current[i];
      if (!m) return;
      const k = 1 - Math.exp(-0.016 * 120);
      m.position.x = THREE.MathUtils.lerp(m.position.x, targetX, k);
      m.position.y = THREE.MathUtils.lerp(m.position.y, targetY, k);
    });
  });

  return (
    <>
      {['TODO', 'DOING', 'DONE'].map((header, c) => (
        <Text
          key={header}
          position={[colX(c), h / 2 - 0.07, 0]}
          fontSize={0.075}
          color="#e9d5ff"
          anchorX="center"
          anchorY="middle"
          material-toneMapped={false}
        >
          {header}
        </Text>
      ))}
      {[1, 2].map((c) => (
        <mesh key={c} position={[-w / 2 + colW * c, -0.04, -0.002]}>
          <planeGeometry args={[0.008, h * 0.82]} />
          <meshBasicMaterial color="#5b21b6" toneMapped={false} />
        </mesh>
      ))}
      {notes.map((n, i) => (
        <mesh
          key={n.id}
          position={[colX(n.startCol), slotY(Math.floor(i / 3)), 0]}
          ref={(el) => {
            meshRefs.current[i] = el;
          }}
        >
          <planeGeometry args={[noteW, noteH]} />
          <meshBasicMaterial color={n.color} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

// ── Tester terminal: pass/fail/skip marks scrolling with a scan line ──
// Visually differentiated from reviewer by denser check-mark columns and a
// cyan scan bar. Reuses the ReviewerContent primitives.

const TEST_MARKS = [
  { ch: '✓', color: '#22c55e' },
  { ch: '✓', color: '#22c55e' },
  { ch: '✗', color: '#ef4444' },
  { ch: '✓', color: '#22c55e' },
  { ch: '●', color: '#22d3ee' },
  { ch: '✓', color: '#22c55e' },
] as const;

export function TesterContent({ w, h }: { w: number; h: number }) {
  const PERIOD = 4.5;
  const rows = useMemo(
    () =>
      Array.from({ length: TEST_MARKS.length }).map((_, i) => ({
        y: h / 2 - 0.12 - i * (h * 0.13),
        barW: w * (0.35 + ((i * 7) % 4) * 0.045),
        barColor: i % 3 === 0 ? '#67e8f9' : i % 3 === 1 ? '#22d3ee' : '#06b6d4',
        mark: TEST_MARKS[i % TEST_MARKS.length],
      })),
    [w, h],
  );

  const scanRef = useRef<THREE.Mesh>(null);
  const barRefs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(({ clock }) => {
    const t = (clock.elapsedTime % PERIOD) / PERIOD;
    const scan = scanRef.current;
    if (scan) scan.position.y = h / 2 - 0.06 - t * (h - 0.12);
    rows.forEach((r, i) => {
      const bar = barRefs.current[i];
      if (!bar) return;
      const rowProgress = (i + 1) / rows.length;
      const isActive = Math.abs(t - rowProgress) < 0.05;
      (bar.material as THREE.MeshBasicMaterial).color.set(isActive ? '#f0fdfa' : r.barColor);
    });
  });

  return (
    <>
      <mesh ref={scanRef} position={[0, 0, -0.001]}>
        <planeGeometry args={[w * 0.98, 0.02]} />
        <meshBasicMaterial color="#22d3ee" transparent opacity={0.6} toneMapped={false} />
      </mesh>
      {rows.map((r, i) => (
        <group key={i} position={[0, r.y, 0]}>
          <mesh
            position={[-w * 0.16, 0, 0]}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
          >
            <planeGeometry args={[r.barW, 0.05]} />
            <meshBasicMaterial color={r.barColor} toneMapped={false} />
          </mesh>
          <Text
            position={[w * 0.4, 0, 0.001]}
            fontSize={0.085}
            color={r.mark.color}
            anchorX="center"
            anchorY="middle"
            material-toneMapped={false}
          >
            {r.mark.ch}
          </Text>
        </group>
      ))}
    </>
  );
}

// ── Dispatcher ──

export function MonitorContent({
  role,
  w,
  h,
}: {
  role: PersonaRole;
  w: number;
  h: number;
}) {
  if (role === 'developer') return <DevContent w={w} h={h} />;
  if (role === 'reviewer') return <ReviewerContent w={w} h={h} />;
  if (role === 'tester') return <TesterContent w={w} h={h} />;
  if (role === 'orchestrator') return <MatrixContent w={w} h={h} />;
  if (role === 'pm') return <PMContent w={w} h={h} />;
  return null;
}
