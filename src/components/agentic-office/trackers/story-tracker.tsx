'use client';
import { useEffect, useRef } from 'react';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { useAgentJob } from '@/hooks/use-agent-job';
import type { OrchestratorEvent } from '@/types/agent-orchestrator';
import {
  createThinkingAction,
  isOrchestratorEventType,
  translateEvent,
  translateOrchestratorIntent,
  type TranslationContext,
} from '../event-translator';
import { useOfficeStore } from '../store';
import { CAST_BY_ID } from '../cast';
import { useOfficeActions } from '../scene/action-processor';

const CHAT_THROTTLE_MS = 3_000;
const THINKING_INTERVAL_MS = 5_000;

type Role = 'developer' | 'reviewer' | 'tester';

function roleFromStep(agentId: string | undefined): Role {
  const id = agentId?.toUpperCase();
  if (id === 'REVIEWER') return 'reviewer';
  if (id === 'TEST') return 'tester';
  return 'developer';
}

/**
 * Headless component that tracks one running story's Claude-CLI job and
 * routes a persona into its seat. On events it emits chat bubbles; on role
 * transitions (dev → reviewer) it reassigns to a reviewer persona; on
 * completion it releases the persona back to the lounge, then home.
 */
export function StoryTracker({
  epicId,
  storyId,
  storyTitle,
  jobId,
}: {
  epicId: string;
  storyId: string;
  storyTitle: string;
  jobId: string;
}) {
  const { data: job } = useAgentJob(jobId);
  const { events } = useAgentEvents(jobId, job?.status);
  const actions = useOfficeActions();

  const lastSeqRef = useRef(0);
  const lastChatRef = useRef(0);
  const lastThinkingRef = useRef(0);
  const currentRoleRef = useRef<Role | null>(null);
  const releasedRef = useRef(false);
  /**
   * null until the first job fetch lands. If the job is already terminal
   * when we first see it (story was completed hours ago but EpicTracker
   * still has it mounted for a tick during state reconcile), we set
   * releasedRef=true so the "Story done!" milestone doesn't fire on page
   * refresh for historical completions.
   */
  const initialSeenRef = useRef(false);

  // Epic B.5 — mirror the job's retry state into the store so the scene
  // can render an hourglass + attempt treatment on the occupying desk.
  useEffect(() => {
    const store = useOfficeStore.getState();
    if (!job) {
      store.setStoryRetry(storyId, null);
      return;
    }
    const retryAfter = job.retryAfter;
    const retryAttempt = job.retryAttempt ?? 0;
    if (
      retryAfter &&
      retryAttempt > 0 &&
      new Date(retryAfter).getTime() > Date.now() &&
      job.status === 'PENDING'
    ) {
      store.setStoryRetry(storyId, { retryAfter, retryAttempt });
    } else {
      store.setStoryRetry(storyId, null);
    }
  }, [job, storyId]);

  // ── Role routing ──────────────────────────────────────────────────────────
  // Claude CLI jobs advance through ordered steps; the active step's
  // agentId tells us whether we need a dev or reviewer persona right now.
  useEffect(() => {
    if (!job?.pipeline?.steps) return;
    const stepIdx = job.currentStepIndex ?? 0;
    const step = job.pipeline.steps[stepIdx];
    if (!step) return;

    const role = roleFromStep(step.agentId);
    if (role === currentRoleRef.current) return;

    const store = useOfficeStore.getState();

    // Release the previous role's persona before picking up a new one.
    if (currentRoleRef.current) {
      const prev = store.getAssignmentForStory(storyId);
      if (prev) {
        store.releaseStory(storyId);
        const prevPersona = CAST_BY_ID[prev.characterId];
        if (prev.role === 'tester') {
          // Test steps are short — skip the couch detour, testers go
          // straight home so they're ready for the next test step.
          actions.gotoSeat(prev.characterId, prevPersona.homeSeat);
        } else {
          // Devs and reviewers get a coffee/lounge beat, then home.
          actions.gotoSeat(prev.characterId, { kind: 'couch', slot: 0 });
          window.setTimeout(() => {
            actions.gotoSeat(prev.characterId, prevPersona.homeSeat);
          }, 3_000);
        }
      }
    }

    const picked = store.assignStory(storyId, epicId, role);
    currentRoleRef.current = role;

    if (picked) {
      // Walk the freshly-picked persona to their home desk and sit.
      const persona = CAST_BY_ID[picked];
      actions.gotoSeat(picked, persona.homeSeat);
      const greeting =
        role === 'reviewer'
          ? { msg: 'Reviewing the code…', emoji: '👀' }
          : role === 'tester'
            ? { msg: 'Running tests…', emoji: '🧪' }
            : { msg: `Starting ${storyTitle}`, emoji: '💪' };
      actions.chat(picked, greeting.msg, greeting.emoji);
    }
    // If picked === null, the story stays in the `queued` kanban column —
    // no persona is available, so no walk. StoryTracker will try again on
    // the next role-change tick (in practice, when an earlier story frees
    // its persona).
  }, [job?.currentStepIndex, job?.pipeline?.steps, epicId, storyId, storyTitle, actions]);

  // ── Event → action translation ────────────────────────────────────────────
  useEffect(() => {
    if (!events.length) return;
    const store = useOfficeStore.getState();
    const assignment = store.getAssignmentForStory(storyId);
    if (!assignment) return;

    const newEvents = events.filter((e) => e.seq > lastSeqRef.current);
    if (!newEvents.length) return;
    lastSeqRef.current = events[events.length - 1].seq;

    const persona = CAST_BY_ID[assignment.characterId];
    const ctx: TranslationContext = {
      characterId: assignment.characterId,
      role: persona.role,
      epicId,
      storyId,
      storyTitle,
    };

    const now = Date.now();
    let sawTextDelta = false;

    for (const event of newEvents) {
      // Fan out orchestrator-wide events to the scene-state reducer.
      if (isOrchestratorEventType(event.eventType)) {
        const intent = translateOrchestratorIntent(event as unknown as OrchestratorEvent);
        if (intent.type !== 'noop') {
          store.applyOrchestratorIntent(intent);
        }
      }

      if (event.eventType === 'text_delta') {
        sawTextDelta = true;
        continue;
      }
      if (event.eventType === 'tool_result') continue;

      for (const action of translateEvent(event, ctx)) {
        // Throttle chat bubbles so a tool-heavy burst doesn't spam.
        if (action.type === 'chat' && now - lastChatRef.current < CHAT_THROTTLE_MS) continue;
        if (action.type === 'chat') lastChatRef.current = now;
        store.enqueueAction(action);
      }
    }

    // Periodic "Thinking…" heartbeat from text deltas.
    if (sawTextDelta && now - lastThinkingRef.current > THINKING_INTERVAL_MS) {
      lastThinkingRef.current = now;
      store.enqueueAction(createThinkingAction(assignment.characterId));
    }
  }, [events, epicId, storyId, storyTitle]);

  // ── Cleanup on job completion ─────────────────────────────────────────────
  useEffect(() => {
    if (!job) return;
    // First sighting — if the job was already terminal when we mounted,
    // suppress the completion milestone entirely. Only fire for a live
    // transition from non-terminal → terminal observed after mount.
    if (!initialSeenRef.current) {
      initialSeenRef.current = true;
      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        releasedRef.current = true;
        return;
      }
    }
    if (job.status !== 'COMPLETED' && job.status !== 'FAILED') return;
    if (releasedRef.current) return;
    releasedRef.current = true;

    const store = useOfficeStore.getState();
    const assignment = store.getAssignmentForStory(storyId);
    if (!assignment) return;

    const persona = CAST_BY_ID[assignment.characterId];
    const passed = job.status === 'COMPLETED';

    actions.milestone(
      assignment.characterId,
      passed ? 'Story done!' : 'Story failed',
      passed ? '🎉' : '😤',
      passed ? 'cheer' : 'defeat',
    );

    // Give the milestone a beat to land, then release + send home.
    window.setTimeout(() => {
      store.releaseStory(storyId);
      actions.gotoSeat(assignment.characterId, { kind: 'couch', slot: 0 });
      window.setTimeout(() => {
        actions.gotoSeat(assignment.characterId, persona.homeSeat);
      }, 2_500);
    }, 2_000);
  }, [job, storyId, actions]);

  return null;
}
