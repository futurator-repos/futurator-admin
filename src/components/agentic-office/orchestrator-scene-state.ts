import type { EpicStory } from '@/types/epic-workflow';

// Pure scene state derived from the stream of OrchestratorAnimationIntents.
// The Three.js scene reads this snapshot each frame; the store wraps it in
// a Zustand slice so imperative scene code can subscribe/read cheaply.
//
// This file is decoupled from the event-translator — types the translator
// needs (SupervisorStatus, OrchestratorAnimationIntent) are re-exported
// from here so `event-translator.ts` can consume them without a circular
// import with the store.

export type SupervisorStatus = 'dispatching' | 'waiting' | 'conflict' | 'failed';

export type OrchestratorAnimationIntent =
  | {
      type: 'supervisor_dispatch';
      status: SupervisorStatus;
      epicId: string;
      maxParallel?: number;
      storyCount?: number;
      totalWaves?: number;
    }
  | { type: 'supervisor_complete'; epicId: string; summary?: unknown }
  | { type: 'supervisor_fail'; epicId: string; reason?: string }
  | {
      type: 'wave_band_activate';
      waveNumber: number;
      storyIds: string[];
    }
  | {
      type: 'wave_band_deactivate';
      waveNumber: number;
      outcomes?: Record<string, string>;
    }
  | {
      type: 'wave_collision_flash';
      waveNumber: number;
      storyId?: string;
      siblingStoryId?: string;
      offendingFiles?: string[];
      subWaves?: string[][];
    }
  | {
      type: 'touch_points_update';
      storyId: string;
      before?: string[];
      after?: string[];
      source?: string;
    }
  | {
      type: 'dev_spawn';
      storyId: string;
      subagentId: string;
      attempt: number;
    }
  | {
      type: 'reviewer_spawn';
      storyId: string;
      subagentId: string;
      attempt: number;
    }
  | {
      type: 'dev_despawn';
      storyId: string;
      subagentId: string;
      durationMs?: number;
    }
  | {
      type: 'reviewer_despawn';
      storyId: string;
      subagentId: string;
      durationMs?: number;
    }
  | {
      type: 'remediation_respawn';
      storyId: string;
      subagentId?: string;
      attempt: number;
    }
  | {
      type: 'review_verdict_pulse';
      storyId: string;
      verdict: string;
      attempt: number;
      findings?: unknown[];
    }
  | {
      type: 'blocker_card_place';
      storyId: string;
      blockerCode?: string;
      description?: string;
    }
  | {
      type: 'blocker_card_remove';
      storyId: string;
      action?: 'amend' | 'skip' | 'retry';
    }
  | {
      type: 'story_desk_blocked_ring';
      storyId: string;
      blockerCode?: string;
      suggestedResolution?: string;
    }
  | {
      type: 'story_desk_terminal_fail';
      storyId: string;
      reason?: string;
    }
  | { type: 'noop'; reason: string };

export interface DeskState {
  attempt: number;
  blocked: boolean;
  terminalFail: boolean;
  lastVerdict?: string;
}

export interface BlockerCardState {
  storyId: string;
  blockerCode?: string;
  description?: string;
  placedAt: number;
}

export interface SubagentState {
  storyId: string;
  attempt: number;
  isRemediation: boolean;
}

export interface OrchestratorSceneState {
  supervisorStatus: SupervisorStatus | 'idle';
  activeWaves: Record<number, { storyIds: string[] }>;
  waveFlash: { waveNumber: number; until: number } | null;
  deskStates: Record<string, DeskState>;
  blockerCards: Record<string, BlockerCardState>;
  devs: Record<string, SubagentState>;
  reviewers: Record<string, SubagentState & { pairedDevSubagentId?: string }>;
}

export function initialOrchestratorSceneState(): OrchestratorSceneState {
  return {
    supervisorStatus: 'idle',
    activeWaves: {},
    waveFlash: null,
    deskStates: {},
    blockerCards: {},
    devs: {},
    reviewers: {},
  };
}

function ensureDesk(state: OrchestratorSceneState, storyId: string): OrchestratorSceneState {
  if (state.deskStates[storyId]) return state;
  return {
    ...state,
    deskStates: {
      ...state.deskStates,
      [storyId]: { attempt: 1, blocked: false, terminalFail: false },
    },
  };
}

function setDesk(
  state: OrchestratorSceneState,
  storyId: string,
  patch: Partial<DeskState>,
): OrchestratorSceneState {
  const current = state.deskStates[storyId] ?? {
    attempt: 1,
    blocked: false,
    terminalFail: false,
  };
  return {
    ...state,
    deskStates: { ...state.deskStates, [storyId]: { ...current, ...patch } },
  };
}

function findMostRecentDevForStory(
  state: OrchestratorSceneState,
  storyId: string,
): string | undefined {
  let best: { id: string; attempt: number } | null = null;
  for (const [id, dev] of Object.entries(state.devs)) {
    if (dev.storyId !== storyId) continue;
    if (!best || dev.attempt > best.attempt) best = { id, attempt: dev.attempt };
  }
  return best?.id;
}

export function applyOrchestratorIntent(
  state: OrchestratorSceneState,
  intent: OrchestratorAnimationIntent,
  now: number = Date.now(),
): OrchestratorSceneState {
  switch (intent.type) {
    case 'supervisor_dispatch':
      return { ...state, supervisorStatus: intent.status };

    case 'supervisor_complete':
    case 'supervisor_fail':
      return { ...state, supervisorStatus: 'idle' };

    case 'wave_band_activate':
      return {
        ...state,
        activeWaves: {
          ...state.activeWaves,
          [intent.waveNumber]: { storyIds: intent.storyIds },
        },
      };

    case 'wave_band_deactivate': {
      const next = { ...state.activeWaves };
      delete next[intent.waveNumber];
      return { ...state, activeWaves: next };
    }

    case 'wave_collision_flash':
      return {
        ...state,
        waveFlash: { waveNumber: intent.waveNumber, until: now + 1500 },
      };

    case 'touch_points_update':
      return state;

    case 'dev_spawn': {
      let next = ensureDesk(state, intent.storyId);
      next = {
        ...next,
        devs: {
          ...next.devs,
          [intent.subagentId]: {
            storyId: intent.storyId,
            attempt: intent.attempt,
            isRemediation: false,
          },
        },
      };
      const current = next.deskStates[intent.storyId];
      return setDesk(next, intent.storyId, {
        attempt: Math.max(current.attempt, intent.attempt),
      });
    }

    case 'remediation_respawn': {
      let next = ensureDesk(state, intent.storyId);
      if (intent.subagentId) {
        next = {
          ...next,
          devs: {
            ...next.devs,
            [intent.subagentId]: {
              storyId: intent.storyId,
              attempt: intent.attempt,
              isRemediation: true,
            },
          },
        };
      }
      return setDesk(next, intent.storyId, { attempt: intent.attempt });
    }

    case 'reviewer_spawn': {
      const pairedDevSubagentId = findMostRecentDevForStory(state, intent.storyId);
      return {
        ...state,
        reviewers: {
          ...state.reviewers,
          [intent.subagentId]: {
            storyId: intent.storyId,
            attempt: intent.attempt,
            isRemediation: false,
            pairedDevSubagentId,
          },
        },
      };
    }

    case 'dev_despawn': {
      const nextDevs = { ...state.devs };
      delete nextDevs[intent.subagentId];
      return { ...state, devs: nextDevs };
    }

    case 'reviewer_despawn': {
      const nextReviewers = { ...state.reviewers };
      delete nextReviewers[intent.subagentId];
      return { ...state, reviewers: nextReviewers };
    }

    case 'review_verdict_pulse':
      return setDesk(state, intent.storyId, { lastVerdict: intent.verdict });

    case 'blocker_card_place': {
      const next = ensureDesk(state, intent.storyId);
      return {
        ...next,
        blockerCards: {
          ...next.blockerCards,
          [intent.storyId]: {
            storyId: intent.storyId,
            blockerCode: intent.blockerCode,
            description: intent.description,
            placedAt: now,
          },
        },
      };
    }

    case 'blocker_card_remove': {
      const nextCards = { ...state.blockerCards };
      delete nextCards[intent.storyId];
      const nextDesk = setDesk({ ...state, blockerCards: nextCards }, intent.storyId, {
        blocked: false,
      });
      return nextDesk;
    }

    case 'story_desk_blocked_ring':
      return setDesk(state, intent.storyId, { blocked: true });

    case 'story_desk_terminal_fail':
      return setDesk(state, intent.storyId, { terminalFail: true });

    case 'noop':
      return state;
  }
}

/**
 * Reconcile scene state against the authoritative DynamoDB story records.
 * Used on cold load and on epic refresh so BLOCKED/terminal/attempt state
 * matches the persistent truth — event stream drives animation, DDB state
 * drives what is rendered when the page opens with no events yet.
 */
export function reconcileFromStories(
  state: OrchestratorSceneState,
  stories: EpicStory[],
): OrchestratorSceneState {
  let next = state;
  const desiredCards: Record<string, BlockerCardState> = {};
  for (const story of stories) {
    const isBlocked = story.status === 'blocked';
    const isFailed = story.status === 'failed';
    next = setDesk(next, story.storyId, {
      blocked: isBlocked,
      terminalFail: isFailed,
    });
    if (isBlocked && story.blocker) {
      desiredCards[story.storyId] = {
        storyId: story.storyId,
        blockerCode: story.blocker.code,
        description: story.blocker.description,
        placedAt:
          state.blockerCards[story.storyId]?.placedAt ??
          (Date.parse(story.blocker.reportedAt) || Date.now()),
      };
    }
  }
  return { ...next, blockerCards: desiredCards };
}
