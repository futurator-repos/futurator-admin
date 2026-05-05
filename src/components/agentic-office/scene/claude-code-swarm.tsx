'use client';
import { useEffect, useRef, useState } from 'react';
import { ClaudeCodeCharacter } from './claude-code-character';

// ── Server-room door area — where creatures materialize ──────────────────
// Door between main office and server room is along x=ROOM.half (=12) at
// z=SERVER_DOOR_Z (=-7). We spawn new creatures just inside the server
// room so they appear to "come through the door."
const SPAWN_AREA = { x: 13, z: -7 } as const;
const SPAWN_JITTER = 1.5;

// Extra-margin lifetime after targetScale=0 flip, so the lerp has time to
// complete before React unmounts the component. The character's scale lerp
// is 4/sec, so ~600 ms covers the visually-smooth fade. Pad to 1 s.
const DESPAWN_GRACE_MS = 1_000;

interface Slot {
  id: number;
  /** true while the process is active, false once we've been told to remove it. */
  alive: boolean;
  /** Wall-clock ms after which a `!alive` slot can be GC'd. */
  despawnAt: number | null;
  /** Where the creature first appears — jittered around the door. */
  initialX: number;
  initialZ: number;
}

function randomSpawn(): { x: number; z: number } {
  return {
    x: SPAWN_AREA.x + (Math.random() - 0.5) * SPAWN_JITTER,
    z: SPAWN_AREA.z + (Math.random() - 0.5) * SPAWN_JITTER,
  };
}

/**
 * Keeps `targetCount` ClaudeCodeCharacters alive in the server room.
 *
 * Stable slot IDs: an existing walker never jumps positions just because
 * a new process joined — only the newcomer materializes. If a process
 * exits, the slot marked for despawn fades out; if targetCount then
 * rebounds before GC, we resurrect the fading slot (flip alive=true
 * again) instead of allocating a new one. That keeps the visual count
 * honest under bursty daemon activity.
 */
export function ClaudeCodeSwarm({ targetCount }: { targetCount: number }) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const nextIdRef = useRef(1);

  // ── Reconcile local slot list against targetCount ──
  useEffect(() => {
    setSlots((prev) => {
      const now = Date.now();
      const aliveCount = prev.filter((s) => s.alive).length;

      if (targetCount === aliveCount) return prev;

      if (targetCount > aliveCount) {
        // Need more. First try reviving any fading-out slots, then spawn
        // the remainder at the door with jitter.
        let toAdd = targetCount - aliveCount;
        const revived = prev.map((s) => {
          if (!s.alive && toAdd > 0) {
            toAdd--;
            return { ...s, alive: true, despawnAt: null };
          }
          return s;
        });
        const fresh: Slot[] = [];
        for (let i = 0; i < toAdd; i++) {
          const p = randomSpawn();
          fresh.push({
            id: nextIdRef.current++,
            alive: true,
            despawnAt: null,
            initialX: p.x,
            initialZ: p.z,
          });
        }
        return [...revived, ...fresh];
      }

      // targetCount < aliveCount — mark tail alive slots for despawn.
      let toKill = aliveCount - targetCount;
      return prev.map((s) => {
        if (!s.alive) return s;
        if (toKill > 0) {
          toKill--;
          return { ...s, alive: false, despawnAt: now + DESPAWN_GRACE_MS };
        }
        return s;
      });
    });
  }, [targetCount]);

  // ── GC tick — remove slots whose fade-out window has elapsed ──
  useEffect(() => {
    if (!slots.some((s) => s.despawnAt !== null)) return;
    const interval = window.setInterval(() => {
      setSlots((prev) => {
        const now = Date.now();
        return prev.filter((s) => s.despawnAt === null || s.despawnAt > now);
      });
    }, 500);
    return () => window.clearInterval(interval);
  }, [slots]);

  return (
    <>
      {slots.map((s) => (
        <ClaudeCodeCharacter
          key={s.id}
          initialPos={{ x: s.initialX, z: s.initialZ }}
          targetScale={s.alive ? 1 : 0}
        />
      ))}
    </>
  );
}
