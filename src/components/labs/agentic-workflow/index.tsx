'use client';
import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Activity,
  GitBranch,
  Server,
  CheckCircle2,
  ExternalLink,
  Plus,
  Loader2,
  Clock,
  DollarSign,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import {
  useEpicWorkflow,
  useEpicList,
  useUpdateEpic,
  useRunStory,
  useRunPoReview,
  useRunVisualQa,
  useStartDevServer,
  useStartEpicOrchestrator,
  useDeleteEpic,
} from '@/hooks/use-epic-workflow';
import { useAgentJob, useAgentJobs } from '@/hooks/use-agent-job';
import { StoryCard } from './story-card';
import { EpicInfoPanel } from './epic-info-panel';
import { EpicGenerator } from './epic-generator';
import { EpicTree } from './epic-tree';
import { ResolveBlockerDrawer } from './resolve-blocker-drawer';
import type { EpicStory, EpicWorkflow } from '@/types/epic-workflow';

function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  }
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

const MODEL_OPTIONS = [
  { value: '', label: 'Default (opus)' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

const EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

const EPIC_ID_KEY = 'futurator.labs.agenticWorkflow.epicId';

function readStoredEpicId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(EPIC_ID_KEY);
}

function storeEpicId(id: string | null) {
  if (typeof window === 'undefined') return;
  if (id) window.localStorage.setItem(EPIC_ID_KEY, id);
  else window.localStorage.removeItem(EPIC_ID_KEY);
}

type VersionStage = 'concept' | 'development' | 'review' | 'deploy' | 'delivered';

const VERSION_STAGES: { id: VersionStage; label: string }[] = [
  { id: 'concept', label: 'Concept' },
  { id: 'development', label: 'Development' },
  { id: 'review', label: 'Review' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'delivered', label: 'Delivered' },
];

function epicStatusToStage(status?: string): VersionStage {
  switch (status) {
    case 'draft':
    case 'ready':
      return 'concept';
    case 'in_progress':
    case 'fixing':
      return 'development';
    case 'in_review':
      return 'review';
    case 'completed':
      return 'deploy';
    case 'deployed':
      return 'delivered';
    case 'failed':
      return 'development';
    default:
      return 'concept';
  }
}

export function AgenticWorkflow() {
  const [epicId, setEpicIdState] = useState<string | null>(() => readStoredEpicId());
  const setEpicId = (id: string | null) => {
    storeEpicId(id);
    setEpicIdState(id);
  };
  const [appName, setAppName] = useState('');
  const workingDir = appName.trim()
    ? `/home/ubuntu/projects/${appName.trim().toLowerCase().replace(/\s+/g, '-')}`
    : '';
  const [devModel, setDevModel] = useState('');
  const [devEffort, setDevEffort] = useState('');
  const [reviewerModel, setReviewerModel] = useState('sonnet');
  const [reviewerEffort, setReviewerEffort] = useState('');
  const [yoloMode, setYoloMode] = useState(false);
  const [, setActiveStoryId] = useState<string | null>(null);
  const [expandedStory, setExpandedStory] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'workflow' | 'tree'>('workflow');
  const [selectedWave, setSelectedWave] = useState<number>(0);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const updateEpic = useUpdateEpic();
  const deleteEpic = useDeleteEpic();
  const runStory = useRunStory();
  const runPoReview = useRunPoReview();
  const runVisualQa = useRunVisualQa();
  const startDevServer = useStartDevServer();
  const { data: epic, error: epicError, refetch: refetchEpic } = useEpicWorkflow(epicId);
  const { data: epicList } = useEpicList();

  // Clear stale epicId if the epic no longer exists (deleted or 404)
  useEffect(() => {
    if (epicId && epicError && epicError.message?.includes('not found')) {
      console.log('[Labs] Clearing stale epicId from localStorage:', epicId.slice(0, 8));
      setEpicId(null);
    }
  }, [epicId, epicError]);

  // Sync yoloMode from loaded epic
  const epicYoloSynced = useRef<string | null>(null);
  useEffect(() => {
    if (epic && epicId && epicYoloSynced.current !== epicId) {
      epicYoloSynced.current = epicId;
      setYoloMode(!!epic.yoloMode);
    }
  }, [epic, epicId]);

  // Track QA and PO jobs for YOLO chain
  const { data: qaJob } = useAgentJob(epic?.qaJobId || null);
  const { data: poJob } = useAgentJob(epic?.poJobId || null);

  useEffect(() => {
    if (epic?.yoloMode !== undefined && epic.yoloMode !== yoloMode) {
      setYoloMode(epic.yoloMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epic?.epicId]);

  // YOLO chain triggers
  const yoloTriggeredStoryIds = useRef<Set<string>>(new Set());
  const yoloQaTriggered = useRef<boolean>(false);
  const yoloPoTriggered = useRef<boolean>(false);
  const yoloDevServerTriggered = useRef<boolean>(false);

  useEffect(() => {
    // YOLO only applies to epics that are actively in development (have stories, not draft)
    if (!yoloMode || !epic || !epicId || epic.status === 'draft' || epic.stories.length === 0) {
      yoloTriggeredStoryIds.current = new Set();
      yoloQaTriggered.current = false;
      yoloPoTriggered.current = false;
      yoloDevServerTriggered.current = false;
      return;
    }

    const doneSet = new Set(epic.stories.filter((s) => s.status === 'done').map((s) => s.storyId));
    const retryableStories = epic.stories.filter(
      (s) => s.status === 'pending' || s.status === 'failed',
    );
    const readyToStart = retryableStories.filter(
      (s) =>
        (s.dependsOn || []).every((depId) => doneSet.has(depId)) &&
        !yoloTriggeredStoryIds.current.has(s.storyId),
    );

    for (const story of readyToStart) {
      console.log(`[YOLO] Triggering story: ${story.title} (wave ${story.wave ?? '?'})`);
      yoloTriggeredStoryIds.current.add(story.storyId);
      runStory.mutate({ epicId, storyId: story.storyId });
    }

    const allDone = epic.stories.length > 0 && epic.stories.every((s) => s.status === 'done');

    if (
      allDone &&
      epic.testingProfile?.hasBrowserTests &&
      !yoloQaTriggered.current &&
      !epic.qaJobId
    ) {
      yoloQaTriggered.current = true;
      console.log('[YOLO] All stories done, triggering Visual QA');
      runVisualQa.mutate(epicId);
      return;
    }

    const qaComplete = !epic.testingProfile?.hasBrowserTests || qaJob?.status === 'COMPLETED';
    if (allDone && qaComplete && !yoloPoTriggered.current && !epic.poJobId) {
      yoloPoTriggered.current = true;
      console.log('[YOLO] Triggering PO review');
      runPoReview.mutate(epicId);
    }
  }, [yoloMode, epic, epicId, qaJob?.status, runStory, runPoReview, runVisualQa]);

  useEffect(() => {
    if (!yoloMode || !epicId || !epic?.poJobId) return;
    if (poJob?.status === 'COMPLETED' && !yoloDevServerTriggered.current) {
      yoloDevServerTriggered.current = true;
      console.log('[YOLO] PO review complete, triggering dev server');
      startDevServer.mutate(epicId);
    }
  }, [yoloMode, epicId, epic?.poJobId, poJob?.status, startDevServer]);

  void refetchEpic;

  function handleRunStory(story: EpicStory) {
    if (!epicId) return;
    setActiveStoryId(story.storyId);
    setExpandedStory(story.storyId);
    runStory.mutate({ epicId, storyId: story.storyId });
  }

  const completedCount = epic?.stories.filter((s) => s.status === 'done').length || 0;
  const totalStories = epic?.stories.length || 0;
  const blockedCount = epic?.stories.filter((s) => s.status === 'blocked').length || 0;

  // EO-5.5 drawer target — lifted to parent so there's a single drawer instance.
  const [resolveStoryId, setResolveStoryId] = useState<string | null>(null);

  // Group stories by wave
  const waves = useMemo(() => {
    if (!epic?.stories) return [];
    const map = new Map<number, EpicStory[]>();
    for (const story of epic.stories) {
      const w = story.wave ?? 0;
      if (!map.has(w)) map.set(w, []);
      map.get(w)!.push(story);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [epic?.stories]);

  // Fetch ALL jobs (running + done + failed) for real-time aggregation
  const hasRunning = (epic?.stories || []).some(
    (s) => s.status === 'running' || s.status === 'in_review' || s.status === 'fixing',
  );
  const allJobIds = useMemo(
    () => (epic?.stories || []).filter((s) => s.jobId).map((s) => s.jobId!),
    [epic?.stories],
  );
  const jobResults = useAgentJobs(allJobIds, hasRunning);

  // Tick every second when stories are running
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  // Build story stats map + wave aggregates + version aggregate
  const { versionAggregate, waveAggregates } = useMemo(() => {
    const storyStats = new Map<string, { durationMs: number; cost: number; isLive: boolean }>();
    for (const story of epic?.stories || []) {
      if (!story.jobId) continue;
      const idx = allJobIds.indexOf(story.jobId);
      if (idx === -1) continue;
      const job = jobResults[idx]?.data;
      if (!job) continue;
      const isActive =
        story.status === 'running' || story.status === 'in_review' || story.status === 'fixing';
      if (isActive && job.createdAt) {
        storyStats.set(story.storyId, {
          durationMs: Math.max(0, tickNow - new Date(job.createdAt).getTime()),
          cost: job.totalCost || 0,
          isLive: true,
        });
      } else {
        const dur = (job.stepResults || []).reduce((s, r) => s + (r.durationMs || 0), 0);
        storyStats.set(story.storyId, { durationMs: dur, cost: job.totalCost || 0, isLive: false });
      }
    }

    // Wave aggregates
    const wAgg = new Map<number, { durationMs: number; cost: number; hasLive: boolean }>();
    for (const [waveNum, waveStories] of waves) {
      let durationMs = 0,
        cost = 0,
        live = false;
      for (const s of waveStories) {
        const st = storyStats.get(s.storyId);
        if (st) {
          durationMs += st.durationMs;
          cost += st.cost;
          if (st.isLive) live = true;
        }
      }
      wAgg.set(waveNum, { durationMs, cost, hasLive: live });
    }

    // Version aggregate
    let totalTimeMs = 0,
      totalCost = 0,
      anyLive = false;
    for (const a of wAgg.values()) {
      totalTimeMs += a.durationMs;
      totalCost += a.cost;
      if (a.hasLive) anyLive = true;
    }

    return { versionAggregate: { totalTimeMs, totalCost, hasLive: anyLive }, waveAggregates: wAgg };
  }, [epic?.stories, allJobIds, jobResults, waves, tickNow]);

  // Stage for pipeline display
  const currentStage = epicStatusToStage(epic?.status);
  const currentStageIndex = VERSION_STAGES.findIndex((s) => s.id === currentStage);

  // Select the current epic summary for dropdown display
  const currentEpicSummary = epicList?.find((e) => e.epicId === epicId);

  // Ensure selectedWave is valid
  useEffect(() => {
    if (waves.length > 0 && !waves.some(([w]) => w === selectedWave)) {
      setSelectedWave(waves[0][0]);
    }
  }, [waves, selectedWave]);

  return (
    <div className="space-y-0">
      {/* ── Compact project header ── */}
      <div className="flex items-center gap-3 px-1 pb-3">
        {/* Project dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowProjectDropdown(!showProjectDropdown)}
            className="flex items-center gap-2 rounded-md border border-input bg-secondary/20 px-3 py-1.5 text-sm hover:bg-secondary/40 transition-colors min-w-[180px]"
          >
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                currentEpicSummary
                  ? currentEpicSummary.status === 'deployed'
                    ? 'bg-blue-400'
                    : currentEpicSummary.status === 'completed'
                      ? 'bg-green-500'
                      : currentEpicSummary.doneStories > 0
                        ? 'bg-yellow-500'
                        : 'bg-muted-foreground/40'
                  : 'bg-muted-foreground/40'
              }`}
            />
            <span className="truncate font-medium">
              {currentEpicSummary
                ? currentEpicSummary.title?.replace(/^Epic:\s*/i, '') || currentEpicSummary.appName
                : epicId
                  ? 'Loading...'
                  : 'Select project'}
            </span>
            {currentEpicSummary && (
              <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                {currentEpicSummary.doneStories}/{currentEpicSummary.totalStories}
              </span>
            )}
            <svg
              className="h-3 w-3 text-muted-foreground shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {/* Dropdown menu */}
          {showProjectDropdown && epicList && epicList.length > 0 && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowProjectDropdown(false)} />
              <div className="absolute top-full left-0 mt-1 z-50 w-72 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
                {epicList.map((ep) => {
                  const progress =
                    ep.totalStories > 0 ? (ep.doneStories / ep.totalStories) * 100 : 0;
                  return (
                    <button
                      key={ep.epicId}
                      onClick={() => {
                        setEpicId(ep.epicId);
                        setExpandedStory(null);
                        setShowProjectDropdown(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 hover:bg-secondary/30 transition-colors border-b border-border/20 last:border-b-0 ${
                        ep.epicId === epicId ? 'bg-secondary/20' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            ep.status === 'deployed'
                              ? 'bg-blue-400'
                              : ep.status === 'completed'
                                ? 'bg-green-500'
                                : ep.doneStories > 0
                                  ? 'bg-yellow-500'
                                  : 'bg-muted-foreground/40'
                          }`}
                        />
                        <span className="text-sm font-medium truncate flex-1">
                          {ep.title?.replace(/^Epic:\s*/i, '') || ep.appName}
                        </span>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {ep.doneStories}/{ep.totalStories}
                        </span>
                      </div>
                      {ep.totalStories > 0 && (
                        <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-green-500 transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <button
          onClick={() => {
            setEpicId(null);
            setExpandedStory(null);
            setConfirmDelete(false);
          }}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </button>

        {/* Delete project — inline with confirmation */}
        {epicId && !confirmDelete && (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-400 transition-colors"
            title="Delete project"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {epicId && confirmDelete && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-red-400">Delete?</span>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                deleteEpic.mutate(epicId, {
                  onSuccess: () => {
                    setEpicId(null);
                    setExpandedStory(null);
                    setConfirmDelete(false);
                  },
                });
              }}
              disabled={deleteEpic.isPending}
              className="rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleteEpic.isPending ? 'Deleting...' : 'Confirm'}
            </button>
          </div>
        )}

        {/* Aggregated stats */}
        {epic && (
          <div className="hidden md:flex items-center gap-4 text-xs text-muted-foreground ml-auto">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span className="font-mono">
                {completedCount}/{totalStories}
              </span>
            </div>
            {blockedCount > 0 && (
              <div className="flex items-center gap-1.5 text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="font-mono">{blockedCount} blocked</span>
              </div>
            )}
            {(versionAggregate.totalTimeMs > 0 || versionAggregate.hasLive) && (
              <div
                className={`flex items-center gap-1.5 ${versionAggregate.hasLive ? 'text-yellow-500' : ''}`}
              >
                <Clock className="h-3.5 w-3.5" />
                <span className="font-mono">{formatElapsedMs(versionAggregate.totalTimeMs)}</span>
              </div>
            )}
            {versionAggregate.totalCost > 0 && (
              <div className="flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5" />
                <span className="font-mono">${versionAggregate.totalCost.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Version container ── */}
      {epic && (
        <div className="rounded-lg border border-border/40 bg-secondary/5 px-4 py-3 mb-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">
                {epic.title?.replace(/^Epic:\s*/i, '') || 'Untitled'}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {waves.length} waves &middot; {totalStories} stories
                {(versionAggregate.totalTimeMs > 0 || versionAggregate.hasLive) && (
                  <span
                    className={`ml-2 font-mono ${versionAggregate.hasLive ? 'text-yellow-500' : ''}`}
                  >
                    &middot; {formatElapsedMs(versionAggregate.totalTimeMs)}
                  </span>
                )}
                {versionAggregate.totalCost > 0 && (
                  <span className="ml-1 font-mono">
                    &middot; ${versionAggregate.totalCost.toFixed(2)}
                  </span>
                )}
              </p>
            </div>

            <div className="flex items-center gap-1">
              {VERSION_STAGES.map((stage, index) => {
                const isPast = index < currentStageIndex;
                const isCurrent = index === currentStageIndex;

                return (
                  <div key={stage.id} className="flex items-center">
                    <span
                      className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                        isCurrent
                          ? 'bg-primary text-primary-foreground'
                          : isPast
                            ? 'bg-green-500/15 text-green-500'
                            : 'bg-secondary/50 text-muted-foreground'
                      }`}
                    >
                      {stage.label}
                    </span>
                    {index < VERSION_STAGES.length - 1 && (
                      <div className={`w-4 h-px mx-0.5 ${isPast ? 'bg-green-500' : 'bg-border'}`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── View tabs ── */}
      {epic && (
        <div className="flex items-center gap-4 px-1 pb-2 border-b border-border/30">
          <button
            onClick={() => setActiveView('workflow')}
            className={`flex items-center gap-2 pb-2 text-sm font-medium transition-colors border-b-2 ${
              activeView === 'workflow'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Activity className="h-4 w-4" />
            Devs Workflow
          </button>
          <button
            onClick={() => setActiveView('tree')}
            className={`flex items-center gap-2 pb-2 text-sm font-medium transition-colors border-b-2 ${
              activeView === 'tree'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <GitBranch className="h-4 w-4" />
            Epic Tree
          </button>
        </div>
      )}

      {/* ── Content ── */}
      {!epicId ? (
        /* New epic creation */
        <div className="mt-4 space-y-4">
          {/* Config bar */}
          <div className="rounded-lg border border-border/50 p-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex-1 min-w-[250px]">
                <label className="mb-1 block text-xs text-muted-foreground">App Name</label>
                <input
                  type="text"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  placeholder="guess-the-number"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {workingDir && (
                  <p className="mt-0.5 text-[10px] text-muted-foreground font-mono">
                    {workingDir} &rarr; futurator.ai/apps/
                    {appName.trim().toLowerCase().replace(/\s+/g, '-')}/
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Dev Model</label>
                <select
                  value={devModel}
                  onChange={(e) => setDevModel(e.target.value)}
                  className="rounded border border-input bg-background px-2 py-2 text-xs"
                >
                  {MODEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Dev Effort</label>
                <select
                  value={devEffort}
                  onChange={(e) => setDevEffort(e.target.value)}
                  className="rounded border border-input bg-background px-2 py-2 text-xs"
                >
                  {EFFORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Reviewer</label>
                <select
                  value={reviewerModel}
                  onChange={(e) => setReviewerModel(e.target.value)}
                  className="rounded border border-input bg-background px-2 py-2 text-xs"
                >
                  {MODEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Rev Effort</label>
                <select
                  value={reviewerEffort}
                  onChange={(e) => setReviewerEffort(e.target.value)}
                  className="rounded border border-input bg-background px-2 py-2 text-xs"
                >
                  {EFFORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <YoloToggle
                checked={yoloMode}
                onChange={(next) => {
                  setYoloMode(next);
                  if (epicId) updateEpic.mutate({ epicId, yoloMode: next });
                }}
              />
            </div>
          </div>

          <EpicGenerator
            workingDir={workingDir}
            devModel={devModel}
            devEffort={devEffort}
            reviewerModel={reviewerModel}
            reviewerEffort={reviewerEffort}
            yoloMode={yoloMode}
            onEpicCreated={(id) => setEpicId(id)}
          />
        </div>
      ) : epic ? (
        <>
          {activeView === 'workflow' ? (
            <DevsWorkflowView
              epic={epic}
              waves={waves}
              waveAggregates={waveAggregates}
              selectedWave={selectedWave}
              onSelectWave={setSelectedWave}
              expandedStory={expandedStory}
              onToggleStory={(id) => setExpandedStory(expandedStory === id ? null : id)}
              yoloMode={yoloMode}
              onYoloChange={(next) => {
                setYoloMode(next);
                if (epicId) updateEpic.mutate({ epicId, yoloMode: next });
              }}
              onUseEpicOrchestratorChange={(next) => {
                if (epicId) updateEpic.mutate({ epicId, useEpicOrchestrator: next });
              }}
              onRunStory={handleRunStory}
              onResolveBlocker={(story) => setResolveStoryId(story.storyId)}
            />
          ) : (
            <EpicTree epic={epic} />
          )}
        </>
      ) : (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Loading...
        </div>
      )}

      {/* Resolve Blocker drawer (EO-5.5) — single instance mounted at root */}
      {epicId && (
        <ResolveBlockerDrawer
          epicId={epicId}
          story={epic?.stories.find((s) => s.storyId === resolveStoryId) ?? null}
          open={resolveStoryId !== null}
          onOpenChange={(next) => {
            if (!next) setResolveStoryId(null);
          }}
        />
      )}
    </div>
  );
}

/* ── Devs Workflow View ── */
function DevsWorkflowView({
  epic,
  waves,
  waveAggregates,
  selectedWave,
  onSelectWave,
  expandedStory,
  onToggleStory,
  yoloMode,
  onYoloChange,
  onUseEpicOrchestratorChange,
  onRunStory,
  onResolveBlocker,
}: {
  epic: EpicWorkflow;
  waves: [number, EpicStory[]][];
  waveAggregates: Map<number, { durationMs: number; cost: number; hasLive: boolean }>;
  selectedWave: number;
  onSelectWave: (w: number) => void;
  expandedStory: string | null;
  onToggleStory: (id: string) => void;
  yoloMode: boolean;
  onYoloChange: (v: boolean) => void;
  onUseEpicOrchestratorChange: (v: boolean) => void;
  onRunStory: (s: EpicStory) => void;
  onResolveBlocker?: (story: EpicStory) => void;
}) {
  const { data: poJob } = useAgentJob(epic.poJobId || null);
  const poVerdict = poJob?.variables?.VERDICT;
  const poCost = poJob?.totalCost;

  const startOrchestrator = useStartEpicOrchestrator();
  const orchestratorOn = !!epic.useEpicOrchestrator;
  const toggleDisabled = epic.status === 'in_progress';
  const canStartEpic =
    orchestratorOn &&
    (epic.status === 'ready' || epic.status === 'fixing' || epic.status === 'failed');

  return (
    <div className="space-y-0">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-3 py-2.5 px-1 border-b border-border/20">
        <div className="flex items-center gap-2.5">
          <ActionButton
            icon={Server}
            label="Dev Server"
            status={epic.status === 'deployed' ? 'deployed' : 'running'}
          />
          <ActionButton
            icon={CheckCircle2}
            label="PO Review"
            status={poVerdict === 'PASS' ? 'pass' : epic.poJobId ? 'running' : 'pending'}
            statusText={poCost ? `$${poCost.toFixed(2)}` : undefined}
          />
          <ActionButton
            icon={ExternalLink}
            label="Publish"
            status={epic.deployUrl ? 'deployed' : 'pending'}
            href={epic.deployUrl}
          />
          {orchestratorOn && (
            <button
              type="button"
              onClick={() => startOrchestrator.mutate(epic.epicId)}
              disabled={!canStartEpic || startOrchestrator.isPending}
              className="flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/10 px-2.5 py-1.5 text-xs text-primary hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                !canStartEpic
                  ? `Epic must be ready/fixing/failed to start (current: ${epic.status})`
                  : 'Start the epic orchestrator — one job for the entire epic'
              }
            >
              {startOrchestrator.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Activity className="h-3 w-3" />
              )}
              <span>Start Epic</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-4">
          <OrchestratorToggle
            checked={orchestratorOn}
            disabled={toggleDisabled}
            onChange={onUseEpicOrchestratorChange}
          />
          <YoloToggle checked={yoloMode} onChange={onYoloChange} />
        </div>
      </div>
      {startOrchestrator.error && (
        <div className="px-1 py-2 text-xs text-red-400">
          {startOrchestrator.error instanceof Error
            ? startOrchestrator.error.message
            : 'Failed to start orchestrator'}
        </div>
      )}

      {/* Epic info panel (expandable) */}
      <details className="border-b border-border/20">
        <summary className="px-1 py-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5">
          <svg
            className="h-3 w-3 transition-transform [details[open]>&]:rotate-90"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Epic Details & Controls
        </summary>
        <div className="pb-3">
          <EpicInfoPanel epic={epic} />
        </div>
      </details>

      {/* Wave tabs */}
      {waves.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto py-2.5 px-1">
          {waves.map(([waveNum, waveStories]) => {
            const doneCt = waveStories.filter((s) => s.status === 'done').length;
            const totalCt = waveStories.length;
            const isComplete = doneCt === totalCt;
            const isRunning = waveStories.some(
              (s) => s.status === 'running' || s.status === 'in_review' || s.status === 'fixing',
            );
            const isSelected = selectedWave === waveNum;
            const wAgg = waveAggregates.get(waveNum);

            return (
              <button
                key={waveNum}
                onClick={() => onSelectWave(waveNum)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-all shrink-0 ${
                  isSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
                }`}
              >
                <span>Wave {waveNum}</span>
                <span className="font-mono">
                  {doneCt}/{totalCt}
                </span>
                {totalCt > 1 && (
                  <span
                    className={`text-[9px] px-1 rounded border ${
                      isSelected
                        ? 'border-primary-foreground/30 text-primary-foreground/80'
                        : 'border-blue-500/20 text-blue-400'
                    }`}
                  >
                    {totalCt}P
                  </span>
                )}
                {wAgg && wAgg.durationMs > 0 && (
                  <span
                    className={`text-[10px] font-mono ${
                      isSelected
                        ? wAgg.hasLive
                          ? 'text-yellow-300'
                          : 'text-primary-foreground/70'
                        : wAgg.hasLive
                          ? 'text-yellow-500'
                          : 'opacity-70'
                    }`}
                  >
                    {formatElapsedMs(wAgg.durationMs)}
                  </span>
                )}
                {isComplete && (
                  <CheckCircle2
                    className={`h-3 w-3 ${isSelected ? 'text-primary-foreground/80' : 'text-green-500'}`}
                  />
                )}
                {isRunning && !isComplete && (
                  <Loader2
                    className={`h-3 w-3 animate-spin ${isSelected ? 'text-primary-foreground/80' : 'text-yellow-500'}`}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Story list for selected wave */}
      <div className="rounded-lg border border-border/30 overflow-hidden">
        {waves
          .filter(([w]) => w === selectedWave)
          .flatMap(([, stories]) => stories)
          .map((story) => (
            <StoryCard
              key={story.storyId}
              story={story}
              expanded={story.storyId === expandedStory}
              onToggle={() => onToggleStory(story.storyId)}
              canRun={story.status === 'pending' || story.status === 'failed'}
              showRunButton={!yoloMode || story.status === 'failed'}
              onRun={() => onRunStory(story)}
              onResolveBlocker={onResolveBlocker}
            />
          ))}
        {waves.filter(([w]) => w === selectedWave).flatMap(([, s]) => s).length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No stories in this wave
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Action button (compact) ── */
function ActionButton({
  icon: Icon,
  label,
  status,
  statusText,
  href,
}: {
  icon: React.ElementType;
  label: string;
  status: 'running' | 'pass' | 'pending' | 'deployed';
  statusText?: string;
  href?: string;
}) {
  const inner = (
    <>
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          status === 'running'
            ? 'bg-green-500 animate-pulse-soft'
            : status === 'pass'
              ? 'bg-green-500'
              : status === 'deployed'
                ? 'bg-blue-400'
                : 'bg-muted-foreground/40'
        }`}
      />
      <Icon className="h-3 w-3" />
      <span>{label}</span>
      {statusText && <span className="text-muted-foreground">{statusText}</span>}
    </>
  );

  const className =
    'flex items-center gap-1.5 rounded-md border border-border/50 bg-secondary/20 px-2.5 py-1.5 text-xs hover:bg-secondary/40 transition-colors';

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {inner}
      </a>
    );
  }

  return <div className={className}>{inner}</div>;
}

/* ── YOLO toggle ── */
function YoloToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">YOLO</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`h-5 w-9 rounded-full transition-colors ${checked ? 'bg-green-500' : 'bg-muted'}`}
      >
        <span
          className={`block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

/* ── Epic Orchestrator toggle (EO-4.6) ── */
function OrchestratorToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className="flex items-center gap-2"
      title={
        disabled
          ? 'Cannot change orchestrator mode while the epic is in progress'
          : 'Run the entire epic as one orchestrator job instead of per-story'
      }
    >
      <span className="text-xs text-muted-foreground">Orchestrator</span>
      <button
        type="button"
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={`h-5 w-9 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          checked ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <span
          className={`block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}
