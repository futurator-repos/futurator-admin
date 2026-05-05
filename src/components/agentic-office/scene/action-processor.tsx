'use client';
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CAST_BY_ID } from '../cast';
import { useOfficeStore } from '../store';
import type { OfficeAction } from '../types';
import { ENTRANCE, resolveSeatPose } from './constants';

const ACTIONS_PER_FRAME = 10;
const BUBBLE_PRUNE_INTERVAL_MS = 500;

/**
 * Headless component that drains the office action queue each frame and
 * applies actions to persona runtime state. Lives inside the Canvas so it
 * can piggy-back on R3F's useFrame for the per-frame tick.
 */
export function ActionProcessor() {
  const lastPruneRef = useRef(0);

  useFrame(() => {
    const store = useOfficeStore.getState();
    const now = Date.now();

    // Drain up to N actions per frame — avoids starvation if a burst lands.
    const batch = store.consumeActions(ACTIONS_PER_FRAME);
    for (const action of batch) {
      applyAction(action);
    }

    // Cheap throttled bubble GC.
    if (now - lastPruneRef.current > BUBBLE_PRUNE_INTERVAL_MS) {
      lastPruneRef.current = now;
      store.pruneBubbles(now);
    }
  });

  return null;
}

function applyAction(action: OfficeAction): void {
  const store = useOfficeStore.getState();
  const { characterId } = action;
  const persona = CAST_BY_ID[characterId];
  if (!persona) return;
  const runtime = store.runtimes[characterId];
  if (!runtime) return;

  switch (action.type) {
    case 'enter': {
      // Teleport to the entrance and start fading in.
      store.updateRuntime(characterId, {
        position: ENTRANCE.clone(),
        facing: Math.PI,
        activity: 'idle',
        seat: null,
        target: null,
        presence: 'entering',
        presenceScale: 0,
      });
      break;
    }

    case 'leave': {
      // Walk back to the entrance and fade out on arrival.
      store.updateRuntime(characterId, {
        target: {
          kind: 'floor',
          seat: null,
          position: ENTRANCE.clone(),
          facing: Math.PI,
          arrivalActivity: 'idle',
        },
        presence: 'leaving',
      });
      break;
    }

    case 'goto_seat': {
      if (!action.seat) return;
      const pose = resolveSeatPose(action.seat.kind, action.seat.slot);
      const seatKind = action.seat.kind;
      const arrivalActivity =
        seatKind === 'coffee'
          ? 'drinking'
          : seatKind === 'whiteboard'
            ? 'pointing'
            : seatKind === 'entrance'
              ? 'idle'
              : 'sitting';
      store.updateRuntime(characterId, {
        target: {
          kind: 'seat',
          seat: action.seat,
          position: pose.pos,
          facing: pose.facing,
          arrivalActivity,
        },
        // Ensure presence is onstage when they receive a goto.
        presence:
          runtime.presence === 'offstage' || runtime.presence === 'leaving'
            ? 'entering'
            : runtime.presence,
      });
      break;
    }

    case 'goto_floor': {
      if (!action.position) return;
      store.updateRuntime(characterId, {
        target: {
          kind: 'floor',
          seat: null,
          position: new THREE.Vector3(action.position.x, 0, action.position.z),
          facing: runtime.facing,
          arrivalActivity: 'idle',
        },
      });
      break;
    }

    case 'chat': {
      if (!action.message) return;
      store.pushBubble(characterId, action.message, action.emoji ?? '', {
        tier: action.tier ?? 'thought',
        toolKind: action.toolKind,
      });
      store.pushLog({
        characterId,
        characterName: persona.name,
        role: persona.role,
        message: action.message,
        emoji: action.emoji ?? '',
        color: 0xffffff,
      });
      break;
    }

    case 'milestone': {
      if (!action.message) return;
      store.pushBubble(characterId, action.message, action.emoji ?? '', {
        tier: action.tier ?? 'milestone',
      });
      store.pushLog({
        characterId,
        characterName: persona.name,
        role: persona.role,
        message: action.message,
        emoji: action.emoji ?? '',
        color: 0xfbbf24,
      });
      // Brief celebratory/defeat pose, then back to whatever activity follows.
      if (action.milestone === 'cheer' || action.milestone === 'defeat') {
        const clipActivity = action.milestone === 'cheer' ? 'cheering' : 'dejected';
        store.updateRuntime(characterId, { activity: clipActivity });
        // Auto-return to sitting/idle after the one-shot finishes.
        window.setTimeout(() => {
          const st = useOfficeStore.getState();
          const rt = st.runtimes[characterId];
          if (rt.activity === clipActivity) {
            st.updateRuntime(characterId, {
              activity: rt.seat ? 'sitting' : 'idle',
            });
          }
        }, 2200);
      }
      break;
    }
  }
}

/**
 * Helper that other trackers can import to enqueue a scripted sequence for
 * a persona — e.g., "enter → walk to whiteboard → point". Wraps the
 * enqueueAction calls so the ordering is explicit at the callsite.
 */
export function useOfficeActions() {
  useEffect(() => {
    // no-op; kept for future reactive hook use
  }, []);
  const store = useOfficeStore;
  return {
    enter(characterId: OfficeAction['characterId']) {
      store.getState().enqueueAction({
        type: 'enter',
        characterId,
        timestamp: Date.now(),
      });
    },
    leave(characterId: OfficeAction['characterId']) {
      store.getState().enqueueAction({
        type: 'leave',
        characterId,
        timestamp: Date.now(),
      });
    },
    gotoSeat(characterId: OfficeAction['characterId'], seat: NonNullable<OfficeAction['seat']>) {
      store.getState().enqueueAction({
        type: 'goto_seat',
        characterId,
        seat,
        timestamp: Date.now(),
      });
    },
    gotoFloor(
      characterId: OfficeAction['characterId'],
      position: { x: number; z: number },
    ) {
      store.getState().enqueueAction({
        type: 'goto_floor',
        characterId,
        position,
        timestamp: Date.now(),
      });
    },
    chat(
      characterId: OfficeAction['characterId'],
      message: string,
      emoji = '💬',
    ) {
      store.getState().enqueueAction({
        type: 'chat',
        characterId,
        message,
        emoji,
        timestamp: Date.now(),
      });
    },
    milestone(
      characterId: OfficeAction['characterId'],
      message: string,
      emoji = '🎉',
      milestone: 'cheer' | 'defeat' | 'neutral' = 'neutral',
    ) {
      store.getState().enqueueAction({
        type: 'milestone',
        characterId,
        message,
        emoji,
        milestone,
        timestamp: Date.now(),
      });
    },
  };
}
