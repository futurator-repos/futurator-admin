'use client';
import { useState, useMemo, useEffect } from 'react';
import {
  ChevronRight,
  Layers,
  GitMerge,
  FileCode,
  CheckCircle2,
  Loader2,
  Circle,
  Clock,
  DollarSign,
} from 'lucide-react';
import { useAgentJobs } from '@/hooks/use-agent-job';
import type { EpicWorkflow, EpicStory } from '@/types/epic-workflow';

function formatElapsed(ms: number): string {
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

function getStoryStatusDot(status: string): string {
  switch (status) {
    case 'done':
      return 'bg-green-500';
    case 'running':
      return 'bg-yellow-500 animate-pulse';
    case 'in_review':
      return 'bg-purple-500 animate-pulse';
    case 'fixing':
      return 'bg-orange-500 animate-pulse';
    case 'failed':
      return 'bg-red-500';
    default:
      return 'bg-muted-foreground/40';
  }
}

function getStoryStatusLabel(status: string): string {
  if (status === 'in_review') return 'review';
  return status;
}

interface StoryStats {
  durationMs: number;
  cost: number;
  isLive: boolean; // true = timer is ticking (running story)
  createdAt?: string;
}

/** Ticking clock — re-renders every second when any story is live */
function useTick(hasLive: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLive]);
  return now;
}

export function EpicTree({ epic }: EpicTreeProps) {
  const hasRunning = epic.stories.some(
    (s) => s.status === 'running' || s.status === 'in_review' || s.status === 'fixing',
  );

  // Collect ALL jobIds (running + done + failed)
  const jobIds = useMemo(
    () => epic.stories.filter((s) => s.jobId).map((s) => s.jobId!),
    [epic.stories],
  );

  const jobResults = useAgentJobs(jobIds, hasRunning);
  const now = useTick(hasRunning);

  // Build storyId → stats lookup (live elapsed for running, final for done)
  const storyStatsMap = useMemo(() => {
    const map = new Map<string, StoryStats>();
    for (const story of epic.stories) {
      if (!story.jobId) continue;
      const idx = jobIds.indexOf(story.jobId);
      if (idx === -1) continue;
      const job = jobResults[idx]?.data;
      if (!job) continue;

      const isActive =
        story.status === 'running' || story.status === 'in_review' || story.status === 'fixing';

      if (isActive && job.createdAt) {
        // Live timer — elapsed since job started
        const elapsed = now - new Date(job.createdAt).getTime();
        map.set(story.storyId, {
          durationMs: Math.max(0, elapsed),
          cost: job.totalCost || 0,
          isLive: true,
          createdAt: job.createdAt,
        });
      } else {
        // Completed — use final duration from stepResults
        const durationMs = (job.stepResults || []).reduce((s, r) => s + (r.durationMs || 0), 0);
        map.set(story.storyId, { durationMs, cost: job.totalCost || 0, isLive: false });
      }
    }
    return map;
  }, [epic.stories, jobIds, jobResults, now]);

  // Group stories by wave
  const sortedWaves = useMemo(() => {
    const waves = new Map<number, EpicStory[]>();
    for (const story of epic.stories) {
      const w = story.wave ?? 0;
      if (!waves.has(w)) waves.set(w, []);
      waves.get(w)!.push(story);
    }
    return [...waves.entries()].sort((a, b) => a[0] - b[0]);
  }, [epic.stories]);

  const [expandedWaves, setExpandedWaves] = useState<Set<number>>(
    () => new Set(sortedWaves.map(([w]) => w)),
  );

  const toggleWave = (waveNum: number) => {
    setExpandedWaves((prev) => {
      const next = new Set(prev);
      if (next.has(waveNum)) next.delete(waveNum);
      else next.add(waveNum);
      return next;
    });
  };

  // Wave-level aggregates
  const waveAggregates = useMemo(() => {
    const map = new Map<number, { durationMs: number; cost: number; hasLive: boolean }>();
    for (const [waveNum, stories] of sortedWaves) {
      let durationMs = 0;
      let cost = 0;
      let hasLive = false;
      for (const s of stories) {
        const stats = storyStatsMap.get(s.storyId);
        if (stats) {
          durationMs += stats.durationMs;
          cost += stats.cost;
          if (stats.isLive) hasLive = true;
        }
      }
      map.set(waveNum, { durationMs, cost, hasLive });
    }
    return map;
  }, [sortedWaves, storyStatsMap]);

  // Epic-level aggregates
  const epicAggregate = useMemo(() => {
    let durationMs = 0;
    let cost = 0;
    let hasLive = false;
    for (const agg of waveAggregates.values()) {
      durationMs += agg.durationMs;
      cost += agg.cost;
      if (agg.hasLive) hasLive = true;
    }
    return { durationMs, cost, hasLive };
  }, [waveAggregates]);

  const completedCount = epic.stories.filter((s) => s.status === 'done').length;
  const totalStories = epic.stories.length;
  const epicProgress = totalStories > 0 ? (completedCount / totalStories) * 100 : 0;
  const epicComplete = completedCount === totalStories && totalStories > 0;

  return (
    <div className="py-4 px-1">
      {/* Legend */}
      <div className="flex items-center gap-5 text-xs text-muted-foreground mb-4 px-2">
        <div className="flex items-center gap-1.5">
          <Layers className="h-3 w-3" />
          <span>Epic</span>
        </div>
        <div className="flex items-center gap-1.5">
          <GitMerge className="h-3 w-3" />
          <span>Wave</span>
        </div>
        <div className="flex items-center gap-1.5">
          <FileCode className="h-3 w-3" />
          <span>Story</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Done
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
            Running
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
            Pending
          </span>
        </div>
      </div>

      {/* Epic container */}
      <div className="rounded-lg border border-border/40 bg-secondary/5 p-3">
        {/* Epic header */}
        <div className="flex items-center gap-3 mb-3">
          <div
            className={`w-8 h-8 rounded flex items-center justify-center shrink-0 border ${
              epicComplete
                ? 'border-green-500/40 bg-green-500/10'
                : hasRunning
                  ? 'border-yellow-500/40 bg-yellow-500/10'
                  : 'border-border/30 bg-muted/20'
            }`}
          >
            {epicComplete ? (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            ) : hasRunning ? (
              <Loader2 className="h-4 w-4 text-yellow-500 animate-spin" />
            ) : (
              <Circle className="h-4 w-4 text-muted-foreground/40" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold truncate">
              {epic.title?.replace(/^Epic:\s*/i, '') || 'Untitled'}
            </h3>
            <p className="text-[10px] text-muted-foreground truncate">{epic.description}</p>
          </div>

          <div className="flex items-center gap-3 text-[10px] text-muted-foreground shrink-0">
            <span className="flex items-center gap-1 font-mono">
              <CheckCircle2 className="h-3 w-3" />
              {completedCount}/{totalStories}
            </span>
            {epicAggregate.durationMs > 0 && (
              <span
                className={`flex items-center gap-1 font-mono ${epicAggregate.hasLive ? 'text-yellow-500' : ''}`}
              >
                <Clock className="h-3 w-3" />
                {formatElapsed(epicAggregate.durationMs)}
              </span>
            )}
            {epicAggregate.cost > 0 && (
              <span className="flex items-center gap-1 font-mono">
                <DollarSign className="h-3 w-3" />${epicAggregate.cost.toFixed(2)}
              </span>
            )}
            {epicAggregate.hasLive && epicAggregate.durationMs === 0 && (
              <span className="flex items-center gap-1 font-mono text-yellow-500 animate-pulse">
                <Clock className="h-3 w-3" />
                0s
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full transition-all ${
                  epicComplete
                    ? 'bg-green-500'
                    : hasRunning
                      ? 'bg-yellow-500'
                      : 'bg-muted-foreground/30'
                }`}
                style={{ width: `${epicProgress}%` }}
              />
            </div>
          </div>
        </div>

        {/* Wave tree */}
        <div className="relative ml-1">
          <div className="absolute left-[13px] top-2 bottom-2 w-px bg-border/30" />

          <div className="space-y-1">
            {sortedWaves.map(([waveNum, waveStories]) => {
              const isExpanded = expandedWaves.has(waveNum);
              const doneCt = waveStories.filter((s) => s.status === 'done').length;
              const totalCt = waveStories.length;
              const isComplete = doneCt === totalCt;
              const isRunning = waveStories.some(
                (s) => s.status === 'running' || s.status === 'in_review' || s.status === 'fixing',
              );
              const progress = totalCt > 0 ? (doneCt / totalCt) * 100 : 0;
              const waveAgg = waveAggregates.get(waveNum);

              return (
                <div key={waveNum} className="relative">
                  <button
                    onClick={() => toggleWave(waveNum)}
                    className={`w-full flex items-center gap-2 p-2 rounded-lg transition-all hover:bg-secondary/20 ${
                      isExpanded ? 'bg-secondary/10' : ''
                    }`}
                  >
                    <div
                      className={`w-7 h-7 rounded flex items-center justify-center shrink-0 border transition-colors ${
                        isComplete
                          ? 'border-green-500/30 bg-green-500/10'
                          : isRunning
                            ? 'border-yellow-500/30 bg-yellow-500/10'
                            : 'border-border/30 bg-muted/20'
                      }`}
                    >
                      {isComplete ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                      ) : isRunning ? (
                        <Loader2 className="h-3.5 w-3.5 text-yellow-500 animate-spin" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
                      )}
                    </div>

                    <div className="flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">Wave {waveNum}</span>
                        {waveStories.length > 1 && (
                          <span className="text-[8px] px-1 rounded border border-blue-500/20 text-blue-400">
                            {waveStories.length}P
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Wave aggregated time + cost */}
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground shrink-0">
                      {waveAgg && waveAgg.durationMs > 0 && (
                        <span
                          className={`flex items-center gap-0.5 font-mono ${waveAgg.hasLive ? 'text-yellow-500' : ''}`}
                        >
                          <Clock className="h-2.5 w-2.5" />
                          {formatElapsed(waveAgg.durationMs)}
                        </span>
                      )}
                      {waveAgg && waveAgg.cost > 0 && (
                        <span className="flex items-center gap-0.5 font-mono">
                          <DollarSign className="h-2.5 w-2.5" />${waveAgg.cost.toFixed(2)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <div className="w-14 h-1 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full transition-all ${
                            isComplete
                              ? 'bg-green-500'
                              : isRunning
                                ? 'bg-yellow-500'
                                : 'bg-muted-foreground/30'
                          }`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground font-mono w-8">
                        {doneCt}/{totalCt}
                      </span>
                      <ChevronRight
                        className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                          isExpanded ? 'rotate-90' : ''
                        }`}
                      />
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="ml-5 mt-0.5 space-y-0.5 border-l border-border/20 pl-3">
                      {waveStories.map((story) => {
                        const stats = storyStatsMap.get(story.storyId);
                        return (
                          <StoryTreeNode
                            key={story.storyId}
                            story={story}
                            durationMs={stats?.durationMs || 0}
                            cost={stats?.cost || 0}
                            isLive={stats?.isLive || false}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

interface EpicTreeProps {
  epic: EpicWorkflow;
}

function StoryTreeNode({
  story,
  durationMs,
  cost,
  isLive,
}: {
  story: EpicStory;
  durationMs: number;
  cost: number;
  isLive: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1 px-1.5 rounded transition-colors hover:bg-secondary/10">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStoryStatusDot(story.status)}`} />
      <FileCode className="h-3 w-3 text-muted-foreground/50 shrink-0" />
      <span className="flex-1 text-xs text-foreground/80 truncate">{story.title}</span>

      {story.dependsOn && story.dependsOn.length > 0 && (
        <span className="text-[9px] text-muted-foreground/50 font-mono shrink-0">
          {story.dependsOn.map((d) => d.replace('story-', 'S')).join(',')}
        </span>
      )}

      {durationMs > 0 && (
        <span
          className={`text-[9px] font-mono shrink-0 flex items-center gap-0.5 ${isLive ? 'text-yellow-500' : 'text-muted-foreground'}`}
        >
          <Clock className="h-2.5 w-2.5" />
          {formatElapsed(durationMs)}
        </span>
      )}

      {cost > 0 && (
        <span className="text-[9px] text-muted-foreground font-mono shrink-0">
          ${cost.toFixed(2)}
        </span>
      )}

      <span
        className={`text-[8px] px-1.5 py-0.5 rounded uppercase font-medium shrink-0 ${
          story.status === 'done'
            ? 'text-green-500 border border-green-500/30'
            : story.status === 'running'
              ? 'text-yellow-500 border border-yellow-500/30'
              : story.status === 'in_review'
                ? 'text-purple-500 border border-purple-500/30'
                : story.status === 'fixing'
                  ? 'text-orange-500 border border-orange-500/30'
                  : story.status === 'failed'
                    ? 'text-red-500 border border-red-500/30'
                    : 'text-muted-foreground border border-border/30'
        }`}
      >
        {getStoryStatusLabel(story.status)}
      </span>
    </div>
  );
}
