'use client';
import { useEffect, useRef } from 'react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { useOfficeStore } from '@/stores/office-store';
import { translateEvent, createThinkingAction, type TranslationContext } from './event-translator';
import { nextWorkerAppearance, deskKeyForIndex } from './scene/office-constants';
import type { WorkerRole, LocationKey } from '@/types/agentic-office';

const CHAT_THROTTLE_MS = 3000;
const THINKING_INTERVAL_MS = 5000;

/**
 * Headless component that tracks one running story's events
 * and translates them into office actions.
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

  const lastProcessedSeq = useRef(0);
  const lastChatTime = useRef(0);
  const lastThinkingTime = useRef(0);
  const currentWorkerId = useRef<string | null>(null);
  const currentRole = useRef<WorkerRole>('DEV');
  const assignedDesk = useRef<number | null>(null);
  const spawnedWorkers = useRef<Set<string>>(new Set());

  const store = useOfficeStore;

  // Determine current agent role from job step
  useEffect(() => {
    if (!job?.pipeline?.steps) return;
    const stepIdx = job.currentStepIndex ?? 0;
    const step = job.pipeline.steps[stepIdx];
    if (!step) return;

    const agentId = step.agentId?.toUpperCase() as WorkerRole;
    const newRole = (
      ['DEV', 'REVIEWER', 'PO', 'DEPLOY'].includes(agentId) ? agentId : 'DEV'
    ) as WorkerRole;

    // Role changed — spawn new worker, move old to lounge
    if (newRole !== currentRole.current || !currentWorkerId.current) {
      const prevWorkerId = currentWorkerId.current;

      // Move previous worker to lounge
      if (prevWorkerId && store.getState().hasWorker(prevWorkerId)) {
        store.getState().moveWorker(prevWorkerId, 'lounge');
        store.getState().queueAction({
          type: 'move',
          workerId: prevWorkerId,
          location: 'lounge',
          timestamp: Date.now(),
        });
      }

      currentRole.current = newRole;

      // Update the story phase so the Kanban board reflects the correct column
      const phase =
        newRole === 'REVIEWER'
          ? ('review' as const)
          : step.resumeFromStep
            ? ('fixing' as const)
            : ('dev' as const);
      store.getState().setStoryPhase(epicId, storyId, phase);

      const workerId = `${epicId}_${storyId}_${newRole}_${stepIdx}`;
      currentWorkerId.current = workerId;

      // Allocate desk on first DEV/REVIEWER for this story
      if (assignedDesk.current === null && (newRole === 'DEV' || newRole === 'REVIEWER')) {
        assignedDesk.current = store.getState().allocateDesk(workerId);
      }

      const appearance = nextWorkerAppearance();
      const targetLoc: LocationKey =
        newRole === 'PO'
          ? 'meeting'
          : newRole === 'DEPLOY'
            ? 'kitchen'
            : assignedDesk.current !== null
              ? deskKeyForIndex(assignedDesk.current)
              : 'hallway';

      store.getState().spawnWorker({
        id: workerId,
        role: newRole,
        epicId,
        storyId,
        storyTitle,
        name: appearance.name,
        color: appearance.body,
        headColor: appearance.head,
        location: 'entrance',
        targetLocation: targetLoc,
        state: 'entering',
        deskIndex: assignedDesk.current,
      });

      store.getState().queueAction({
        type: 'spawn',
        workerId,
        role: newRole,
        epicId,
        storyId,
        storyTitle,
        timestamp: Date.now(),
      });

      // Queue movement to target
      store.getState().queueAction({
        type: 'move',
        workerId,
        location: targetLoc,
        timestamp: Date.now(),
      });

      spawnedWorkers.current.add(workerId);

      store.getState().pushEvent({
        worker: appearance.name,
        role: newRole,
        message: `Arrived for ${storyTitle}`,
        emoji: '🚶',
        color: appearance.body,
      });
    }
  }, [job?.currentStepIndex, job?.pipeline?.steps, epicId, storyId, storyTitle, store]);

  // Process new events
  useEffect(() => {
    if (!events.length || !currentWorkerId.current) return;

    const workerId = currentWorkerId.current;
    const newEvents = events.filter((e) => e.seq > lastProcessedSeq.current);
    if (!newEvents.length) return;

    lastProcessedSeq.current = events[events.length - 1].seq;

    const ctx: TranslationContext = {
      workerId,
      role: currentRole.current,
      epicId,
      storyId,
      storyTitle,
      deskLocation: assignedDesk.current !== null ? deskKeyForIndex(assignedDesk.current) : null,
    };

    const now = Date.now();
    let hasTextDelta = false;

    for (const event of newEvents) {
      if (event.eventType === 'text_delta') {
        hasTextDelta = true;
        continue; // handled below as periodic "thinking"
      }
      if (event.eventType === 'tool_result') continue; // skip raw results

      const actions = translateEvent(event, ctx);
      for (const action of actions) {
        const isMilestone = action.type === 'milestone';
        // Throttle chat bubbles (not milestones)
        if (!isMilestone && now - lastChatTime.current < CHAT_THROTTLE_MS) continue;

        store.getState().queueAction(action);
        if (!isMilestone) lastChatTime.current = now;

        // Also push to event log
        const w = store.getState().getWorker(workerId);
        if (w && action.message) {
          store.getState().pushEvent({
            worker: w.name,
            role: w.role,
            message: action.message,
            emoji: action.emoji ?? '',
            color: w.color,
          });
        }
      }
    }

    // Periodic "thinking" bubble from text_delta
    if (hasTextDelta && now - lastThinkingTime.current > THINKING_INTERVAL_MS) {
      lastThinkingTime.current = now;
      store.getState().queueAction(createThinkingAction(workerId));
    }
  }, [events, epicId, storyId, storyTitle, store]);

  // Cleanup: when job completes or fails, despawn workers
  useEffect(() => {
    if (!job) return;
    if (job.status !== 'COMPLETED' && job.status !== 'FAILED') return;

    // Give a short delay for final milestone bubble to show
    const timer = setTimeout(() => {
      for (const id of spawnedWorkers.current) {
        if (store.getState().hasWorker(id)) {
          store.getState().queueAction({
            type: 'move',
            workerId: id,
            location: 'entrance',
            timestamp: Date.now(),
          });
          // Despawn after walk time
          setTimeout(() => {
            store.getState().despawnWorker(id);
          }, 4000);
        }
      }
      // Free desk and clear story phase
      if (assignedDesk.current !== null && currentWorkerId.current) {
        store.getState().freeDesk(currentWorkerId.current);
      }
      store.getState().clearStoryPhase(epicId, storyId);
    }, 2000);

    return () => clearTimeout(timer);
  }, [job, store, epicId, storyId]);

  return null;
}
