'use client';
import { useEffect, useMemo, useRef } from 'react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useEpicWorkflow } from '@/hooks/use-epic-workflow';
import { useOfficeStore } from '../store';
import { StoryTracker } from './story-tracker';
import { useOfficeActions } from '../scene/action-processor';

/**
 * Per-epic headless tracker. Handles the three epic-scoped concerns:
 *   1. Reconcile orchestrator scene state from DDB on cold load (blockers,
 *      terminal fails, attempt counts).
 *   2. Milena reacts to every story transition — chat bubble pointing at
 *      the whiteboard. No walk (she lives at the board throughout).
 *   3. Mount a StoryTracker for each running story.
 *
 * Epic-level orchestration (QA / PO / Deploy) is wired via separate job
 * tracker children so they run in parallel.
 */
export function EpicTracker({ epicId }: { epicId: string }) {
  const { data: epic } = useEpicWorkflow(epicId);
  const actions = useOfficeActions();

  // Epic F.2: filter-gate. If the kanban filter is non-empty and this
  // epic's plan is NOT selected, suppress the heaviest child trackers
  // (StoryTracker fan-out, JobMilestoneBridges). We STILL keep the epic
  // query + reconcile + kanban sync alive so the kanban overlay keeps
  // showing the whole portfolio even while the user focuses on N plans.
  const selectedPlanIds = useOfficeStore((s) => s.selectedKanbanPlanIds);
  const suppressFanOut = useMemo(() => {
    if (selectedPlanIds.length === 0) return false; // "all plans" mode
    const epicPlanId = epic?.planId ?? null;
    if (epicPlanId === null) {
      return !selectedPlanIds.includes('__unassigned__');
    }
    return !selectedPlanIds.includes(epicPlanId);
  }, [selectedPlanIds, epic?.planId]);

  // Keep the pure orchestrator reducer snapshot aligned with DDB state.
  useEffect(() => {
    if (!epic?.stories) return;
    useOfficeStore.getState().reconcileOrchestratorFromStories(epic.stories);
  }, [epic?.stories]);

  // Keep the kanban store in sync so the overlay lists every story.
  useEffect(() => {
    if (!epic) return;
    useOfficeStore
      .getState()
      .updateKanban(epicId, epic.title, epic.stories, epic.planId ?? null);
  }, [epic, epicId]);

  // Milena reacts to story-status transitions — one bubble per flip.
  const lastStatusRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!epic?.stories) return;
    for (const story of epic.stories) {
      const prev = lastStatusRef.current[story.storyId];
      if (prev === story.status) continue;
      lastStatusRef.current[story.storyId] = story.status;
      if (!prev) continue; // skip initial snapshot
      const msg =
        story.status === 'queued'
          ? `Queued: ${story.title}`
          : story.status === 'running'
            ? `Starting: ${story.title}`
            : story.status === 'in_review'
              ? `In review: ${story.title}`
              : story.status === 'done'
                ? `Done: ${story.title}`
                : story.status === 'failed'
                  ? `Failed: ${story.title}`
                  : story.status === 'blocked'
                    ? `Blocked: ${story.title}`
                    : null;
      if (msg) actions.chat('milena', msg, '📋');
    }
  }, [epic?.stories, actions]);

  // Stories that have a job and are actively executing — each gets its own
  // StoryTracker so its events stream into the correct persona.
  const stories = epic?.stories;
  const runningStories = useMemo(() => {
    if (!stories) return [];
    return stories.filter(
      (s) =>
        s.jobId && (s.status === 'running' || s.status === 'in_review' || s.status === 'fixing'),
    );
  }, [stories]);

  // Epic F.2: when gated out, skip the child tracker tree entirely.
  if (suppressFanOut) return null;

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

      {/* Epic-scoped job streams — QA / PO / Deploy. Each sends simple
          milestone bubbles via the orchestrator (Ricardo) so the user sees
          handoff without us needing extra personas. */}
      {epic?.qaJobId && (
        <JobMilestoneBridge
          jobId={epic.qaJobId}
          onStart="Running visual QA…"
          onPass="QA passed!"
          onFail="QA found issues"
          emoji="🧪"
        />
      )}
      {epic?.poJobId && (
        <JobMilestoneBridge
          jobId={epic.poJobId}
          onStart="PO review starting…"
          onPass="Product approved!"
          onFail="Needs more work"
          emoji="📋"
        />
      )}
      {epic?.deployJobId && (
        <JobMilestoneBridge
          jobId={epic.deployJobId}
          onStart="Deploying to production…"
          onPass="App is live!"
          onFail="Deploy failed"
          emoji="🚀"
        />
      )}
    </>
  );
}

/**
 * Tiny bridge — fires start/complete bubbles on the orchestrator.
 *
 * Snapshots the job's status the first time we see it; if it was ALREADY
 * terminal at mount (e.g. user is refreshing the page hours after QA
 * ran), we suppress both the start AND finish bubbles. Only live
 * transitions observed after mount produce animations. Otherwise every
 * page refresh would parrot "QA passed! / App is live!" for any
 * long-completed job on an epic that's still technically in_development.
 */
function JobMilestoneBridge({
  jobId,
  onStart,
  onPass,
  onFail,
  emoji,
}: {
  jobId: string;
  onStart: string;
  onPass: string;
  onFail: string;
  emoji: string;
}) {
  const { data: job } = useAgentJob(jobId);
  const actions = useOfficeActions();
  const startedRef = useRef(false);
  const finishedRef = useRef(false);
  /**
   * null until the first job fetch lands. Once we see the initial status,
   * we decide whether to arm (PENDING / RUNNING) or suppress (already
   * COMPLETED / FAILED).
   */
  const initialSeenRef = useRef(false);

  useEffect(() => {
    if (!job) return;

    // First sighting — if the job is already terminal, flip both flags so
    // the transition handlers below become no-ops. This is what prevents
    // stale bubbles from firing on every page refresh.
    if (!initialSeenRef.current) {
      initialSeenRef.current = true;
      if (job.status === 'COMPLETED' || job.status === 'FAILED') {
        startedRef.current = true;
        finishedRef.current = true;
        return;
      }
      if (job.status === 'RUNNING') {
        // Already running when we first saw it — suppress the start bubble
        // too (it would have fired hours ago when the job actually
        // started). Still allow the finish bubble to fire live.
        startedRef.current = true;
      }
    }

    if (job.status === 'RUNNING' && !startedRef.current) {
      startedRef.current = true;
      actions.chat('ricardo', onStart, emoji);
    }
    if (
      (job.status === 'COMPLETED' || job.status === 'FAILED') &&
      !finishedRef.current
    ) {
      finishedRef.current = true;
      const passed = job.status === 'COMPLETED';
      actions.milestone(
        'ricardo',
        passed ? onPass : onFail,
        passed ? '✅' : '❌',
        passed ? 'cheer' : 'defeat',
      );
    }
  }, [job, actions, onStart, onPass, onFail, emoji]);

  return null;
}
