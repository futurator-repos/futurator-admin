'use client';
import { useEffect, useRef, useMemo } from 'react';
import { useEpicWorkflow } from '@/hooks/use-epic-workflow';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { useOfficeStore } from '@/stores/office-store';
import {
  translateEvent,
  translateOrchestratorIntent,
  isOrchestratorEventType,
  type TranslationContext,
} from './event-translator';
import type { OrchestratorEvent } from '@/types/agent-orchestrator';
import { StoryTracker } from './story-tracker';
import { nextWorkerAppearance } from './scene/office-constants';
import type { WorkerRole } from '@/types/agentic-office';

/**
 * Headless component — tracks one epic's stories and manages:
 * - Kanban board state
 * - StoryTracker rendering for running stories
 * - PO and Deploy agent workers
 */
export function EpicTracker({ epicId }: { epicId: string }) {
  const { data: epic } = useEpicWorkflow(epicId);
  const store = useOfficeStore;

  // Track QA, PO and Deploy jobs
  const { data: qaJob } = useAgentJob(epic?.qaJobId ?? null);
  const { data: poJob } = useAgentJob(epic?.poJobId ?? null);
  const { data: deployJob } = useAgentJob(epic?.deployJobId ?? null);

  const pmSpawned = useRef(false);
  const qaSpawned = useRef(false);
  const poSpawned = useRef(false);
  const deploySpawned = useRef(false);

  // Reconcile orchestrator scene state (blocker cards, blocked/terminal-fail
  // desks) from the authoritative DDB story records whenever the epic loads
  // or its stories change. Event stream drives animation; DDB state drives
  // cold-load rendering (Epic 6.3 persistence AC).
  useEffect(() => {
    if (!epic?.stories) return;
    store.getState().reconcileOrchestratorFromStories(epic.stories);
  }, [epic?.stories, store]);

  // Spawn PM worker at whiteboard when epic starts (in_progress)
  useEffect(() => {
    if (!epic || pmSpawned.current) return;
    if (epic.status !== 'in_progress') return;

    pmSpawned.current = true;
    const appearance = nextWorkerAppearance();
    const workerId = `${epicId}_PM`;

    store.getState().spawnWorker({
      id: workerId,
      role: 'PM',
      epicId,
      storyId: null,
      storyTitle: epic.title,
      name: appearance.name,
      color: appearance.body,
      headColor: appearance.head,
      location: 'entrance',
      targetLocation: 'whiteboard',
      state: 'entering',
      deskIndex: null,
    });

    store.getState().queueAction({ type: 'spawn', workerId, timestamp: Date.now() });
    store
      .getState()
      .queueAction({ type: 'move', workerId, location: 'whiteboard', timestamp: Date.now() });
    store.getState().queueAction({
      type: 'milestone',
      workerId,
      message: `Planned ${epic.stories.length} stories in ${new Set(epic.stories.map((s) => s.wave)).size} waves`,
      emoji: '📋',
      timestamp: Date.now(),
    });

    store.getState().pushEvent({
      worker: appearance.name,
      role: 'PM',
      message: `Epic "${epic.title}" — development started`,
      emoji: '📋',
      color: appearance.body,
    });

    // PM stays at whiteboard overseeing, leaves when all stories done
  }, [epic, epicId, store]);

  // Despawn PM when epic completes
  useEffect(() => {
    if (!epic || !pmSpawned.current) return;
    if (epic.status !== 'completed' && epic.status !== 'failed' && epic.status !== 'deployed')
      return;

    const workerId = `${epicId}_PM`;
    if (!store.getState().hasWorker(workerId)) return;

    store.getState().queueAction({
      type: 'milestone',
      workerId,
      message:
        epic.status === 'deployed'
          ? 'App is live!'
          : epic.status === 'completed'
            ? 'All stories done!'
            : 'Epic failed',
      emoji: epic.status === 'failed' ? '❌' : '🎉',
      timestamp: Date.now(),
    });

    setTimeout(() => {
      store
        .getState()
        .queueAction({ type: 'move', workerId, location: 'entrance', timestamp: Date.now() });
      setTimeout(() => store.getState().despawnWorker(workerId), 4000);
    }, 3000);
  }, [epic, epicId, store]);

  // Collect all running stories with jobIds
  const runningStories = useMemo(() => {
    if (!epic?.stories) return [];
    return epic.stories.filter((s) => s.status === 'running' && s.jobId);
  }, [epic?.stories]);

  // Update Kanban whenever stories change
  useEffect(() => {
    if (!epic) return;
    store.getState().updateKanban(epicId, epic.title, epic.stories);
  }, [epic, epicId, store]);

  // Spawn QA worker when qaJobId appears
  useEffect(() => {
    if (!epic?.qaJobId || qaSpawned.current) return;
    if (qaJob?.status !== 'RUNNING') return;

    qaSpawned.current = true;
    const appearance = nextWorkerAppearance();
    const workerId = `${epicId}_QA`;

    store.getState().spawnWorker({
      id: workerId,
      role: 'QA',
      epicId,
      storyId: null,
      storyTitle: 'Visual QA',
      name: appearance.name,
      color: appearance.body,
      headColor: appearance.head,
      location: 'entrance',
      targetLocation: 'meeting',
      state: 'entering',
      deskIndex: null,
    });

    store.getState().queueAction({ type: 'spawn', workerId, timestamp: Date.now() });
    store
      .getState()
      .queueAction({ type: 'move', workerId, location: 'meeting', timestamp: Date.now() });
    store.getState().queueAction({
      type: 'chat',
      workerId,
      message: 'Running visual tests...',
      emoji: '🔍',
      timestamp: Date.now(),
    });

    store.getState().pushEvent({
      worker: appearance.name,
      role: 'QA',
      message: 'Starting visual QA testing',
      emoji: '🔍',
      color: appearance.body,
    });
  }, [epic?.qaJobId, qaJob?.status, epicId, store]);

  // Despawn QA when done
  useEffect(() => {
    if (!qaJob || !qaSpawned.current) return;
    if (qaJob.status !== 'COMPLETED' && qaJob.status !== 'FAILED') return;

    const workerId = `${epicId}_QA`;
    const pass = qaJob.variables?.OVERALL_VERDICT?.toUpperCase() === 'PASS';

    store.getState().queueAction({
      type: 'milestone',
      workerId,
      message: pass ? 'All visual tests passed!' : 'Visual issues found',
      emoji: pass ? '✅' : '❌',
      timestamp: Date.now(),
    });

    setTimeout(() => {
      store
        .getState()
        .queueAction({ type: 'move', workerId, location: 'entrance', timestamp: Date.now() });
      setTimeout(() => store.getState().despawnWorker(workerId), 4000);
    }, 3000);
  }, [qaJob, epicId, store]);

  // Spawn PO worker when poJobId appears
  useEffect(() => {
    if (!epic?.poJobId || poSpawned.current) return;
    if (poJob?.status !== 'RUNNING') return;

    poSpawned.current = true;
    const appearance = nextWorkerAppearance();
    const workerId = `${epicId}_PO`;

    store.getState().spawnWorker({
      id: workerId,
      role: 'PO',
      epicId,
      storyId: null,
      storyTitle: 'Product Review',
      name: appearance.name,
      color: appearance.body,
      headColor: appearance.head,
      location: 'entrance',
      targetLocation: 'meeting',
      state: 'entering',
      deskIndex: null,
    });

    store.getState().queueAction({ type: 'spawn', workerId, timestamp: Date.now() });
    store
      .getState()
      .queueAction({ type: 'move', workerId, location: 'meeting', timestamp: Date.now() });
    store.getState().queueAction({
      type: 'chat',
      workerId,
      message: 'Running acceptance tests...',
      emoji: '📋',
      timestamp: Date.now(),
    });

    store.getState().pushEvent({
      worker: appearance.name,
      role: 'PO',
      message: 'Starting product review',
      emoji: '📋',
      color: appearance.body,
    });
  }, [epic?.poJobId, poJob?.status, epicId, store]);

  // Despawn PO when done
  useEffect(() => {
    if (!poJob || !poSpawned.current) return;
    if (poJob.status !== 'COMPLETED' && poJob.status !== 'FAILED') return;

    const workerId = `${epicId}_PO`;
    const pass = poJob.variables?.VERDICT?.toUpperCase() === 'PASS';

    store.getState().queueAction({
      type: 'milestone',
      workerId,
      message: pass ? 'Product approved!' : 'Needs more work',
      emoji: pass ? '🎉' : '👎',
      timestamp: Date.now(),
    });

    setTimeout(() => {
      store
        .getState()
        .queueAction({ type: 'move', workerId, location: 'entrance', timestamp: Date.now() });
      setTimeout(() => store.getState().despawnWorker(workerId), 4000);
    }, 3000);
  }, [poJob, epicId, store]);

  // Spawn Deploy worker when deployJobId appears
  useEffect(() => {
    if (!epic?.deployJobId || deploySpawned.current) return;
    if (deployJob?.status !== 'RUNNING') return;

    deploySpawned.current = true;
    const appearance = nextWorkerAppearance();
    const workerId = `${epicId}_DEPLOY`;

    store.getState().spawnWorker({
      id: workerId,
      role: 'DEPLOY',
      epicId,
      storyId: null,
      storyTitle: 'Deployment',
      name: appearance.name,
      color: appearance.body,
      headColor: appearance.head,
      location: 'entrance',
      targetLocation: 'kitchen',
      state: 'entering',
      deskIndex: null,
    });

    store.getState().queueAction({ type: 'spawn', workerId, timestamp: Date.now() });
    store
      .getState()
      .queueAction({ type: 'move', workerId, location: 'kitchen', timestamp: Date.now() });
    store.getState().queueAction({
      type: 'chat',
      workerId,
      message: 'Deploying to production...',
      emoji: '🚀',
      timestamp: Date.now(),
    });

    store.getState().pushEvent({
      worker: appearance.name,
      role: 'DEPLOY',
      message: 'Starting deployment',
      emoji: '🚀',
      color: appearance.body,
    });
  }, [epic?.deployJobId, deployJob?.status, epicId, store]);

  // Despawn Deploy when done
  useEffect(() => {
    if (!deployJob || !deploySpawned.current) return;
    if (deployJob.status !== 'COMPLETED' && deployJob.status !== 'FAILED') return;

    const workerId = `${epicId}_DEPLOY`;
    const success = deployJob.status === 'COMPLETED';

    store.getState().queueAction({
      type: 'milestone',
      workerId,
      message: success ? 'App is live!' : 'Deploy failed',
      emoji: success ? '🎉' : '❌',
      timestamp: Date.now(),
    });

    setTimeout(() => {
      store
        .getState()
        .queueAction({ type: 'move', workerId, location: 'entrance', timestamp: Date.now() });
      setTimeout(() => store.getState().despawnWorker(workerId), 4000);
    }, 3000);
  }, [deployJob, epicId, store]);

  return (
    <>
      {runningStories.map((story) => (
        <StoryTracker
          key={story.storyId}
          epicId={epicId}
          storyId={story.storyId}
          storyTitle={story.title}
          jobId={story.jobId!}
        />
      ))}

      {/* Stream live events for QA worker */}
      {epic?.qaJobId && qaSpawned.current && qaJob?.status === 'RUNNING' && (
        <JobEventBridge
          jobId={epic.qaJobId}
          jobStatus={qaJob.status}
          workerId={`${epicId}_QA`}
          role="QA"
          epicId={epicId}
          storyTitle="Visual QA"
        />
      )}

      {/* Stream live events for PO worker */}
      {epic?.poJobId && poSpawned.current && poJob?.status === 'RUNNING' && (
        <JobEventBridge
          jobId={epic.poJobId}
          jobStatus={poJob.status}
          workerId={`${epicId}_PO`}
          role="PO"
          epicId={epicId}
          storyTitle="Product Review"
        />
      )}

      {/* Stream live events for Deploy worker */}
      {epic?.deployJobId && deploySpawned.current && deployJob?.status === 'RUNNING' && (
        <JobEventBridge
          jobId={epic.deployJobId}
          jobStatus={deployJob.status}
          workerId={`${epicId}_DEPLOY`}
          role="DEPLOY"
          epicId={epicId}
          storyTitle="Deployment"
        />
      )}
    </>
  );
}

/**
 * Headless bridge — streams agent events from a job into office chat actions for a worker.
 */
function JobEventBridge({
  jobId,
  jobStatus,
  workerId,
  role,
  epicId,
  storyTitle,
}: {
  jobId: string;
  jobStatus: string;
  workerId: string;
  role: WorkerRole;
  epicId: string;
  storyTitle: string;
}) {
  const { events } = useAgentEvents(jobId, jobStatus as 'RUNNING');
  const lastProcessedSeq = useRef(0);
  const lastChatTime = useRef(0);
  const store = useOfficeStore;

  useEffect(() => {
    if (!events.length) return;

    const newEvents = events.filter((e) => e.seq > lastProcessedSeq.current);
    if (!newEvents.length) return;
    lastProcessedSeq.current = events[events.length - 1].seq;

    const ctx: TranslationContext = {
      workerId,
      role,
      epicId,
      storyId: '',
      storyTitle,
      deskLocation: null,
    };

    const now = Date.now();

    for (const event of newEvents) {
      if (event.eventType === 'text_delta') continue; // skip raw text — too noisy

      // Forward orchestrator-shaped events to the scene state (Epic 6).
      // Gate on the orchestrator event vocabulary so regular tool_use /
      // step_* events don't trip the translator's unknown-event warn branch.
      if (isOrchestratorEventType(event.eventType)) {
        const intent = translateOrchestratorIntent(event as unknown as OrchestratorEvent);
        if (intent.type !== 'noop') {
          store.getState().applyOrchestratorIntent(intent);
        }
      }

      const actions = translateEvent(event, ctx);
      for (const action of actions) {
        // Throttle chat messages to avoid spam
        if (action.type === 'chat') {
          if (now - lastChatTime.current < 2000) continue;
          lastChatTime.current = now;
        }

        store.getState().queueAction(action);

        if (action.type === 'chat' || action.type === 'milestone') {
          store.getState().pushEvent({
            worker: workerId.split('_').pop() || role,
            role,
            message: action.message || '',
            emoji: action.emoji || '',
            color: 0x4a90d9,
          });
        }
      }
    }
  }, [events, workerId, role, epicId, storyTitle, store]);

  return null;
}
