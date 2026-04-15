'use client';
import { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { StoryLiveOutput } from './story-live-output';
import { StoryResult } from './story-result';
import type { EpicStory } from '@/types/epic-workflow';

interface StoryCardProps {
  story: EpicStory;
  expanded: boolean;
  onToggle: () => void;
  canRun: boolean;
  showRunButton: boolean;
  onRun: () => void;
}

function shortModel(model?: string): string {
  if (!model) return '';
  const match = model.match(/opus|sonnet|haiku/);
  return match ? match[0].toUpperCase() : '';
}

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

function Timer({ startIso }: { startIso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = now - new Date(startIso).getTime();
  return <span className="font-mono text-yellow-500 text-xs">{formatElapsed(elapsed)}</span>;
}

function getStatusDot(status: string): string {
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
      return 'bg-muted-foreground/30';
  }
}

function getStatusBadgeClasses(status: string): string {
  switch (status) {
    case 'done':
      return 'border-green-500/30 text-green-500';
    case 'running':
      return 'border-yellow-500/30 text-yellow-500';
    case 'in_review':
      return 'border-purple-500/30 text-purple-500';
    case 'fixing':
      return 'border-orange-500/30 text-orange-500';
    case 'failed':
      return 'border-red-500/30 text-red-500';
    default:
      return 'border-border text-muted-foreground';
  }
}

function getStatusLabel(status: string): string {
  if (status === 'in_review') return 'REVIEW';
  return status.toUpperCase();
}

export function StoryCard({
  story,
  expanded,
  onToggle,
  canRun,
  showRunButton,
  onRun,
}: StoryCardProps) {
  const { data: job } = useAgentJob(story.jobId || null);

  const isRunning = story.status === 'running';
  const isDone = story.status === 'done';
  const isFailed = story.status === 'failed';
  const stepResults = job?.stepResults || [];

  const currentStep = job?.stepResults?.[job.stepResults.length - 1];
  const model = shortModel(currentStep?.model);

  const currentPipelineStep = job?.pipeline?.steps?.[job?.currentStepIndex ?? 0];
  const phaseLabel = isRunning
    ? currentPipelineStep?.id === 'build-check'
      ? 'Building...'
      : currentPipelineStep?.id === 'server-check'
        ? 'Server check...'
        : currentPipelineStep?.id === 'dev-build-fix'
          ? 'Fixing build...'
          : currentPipelineStep?.id === 'dev-server-fix'
            ? 'Fixing server...'
            : currentPipelineStep?.agentId === 'REVIEWER'
              ? 'In Review...'
              : currentPipelineStep?.id === 'retry'
                ? 'Fixing...'
                : 'Developing...'
    : null;

  const totalDuration = stepResults.reduce((s, r) => s + (r.durationMs || 0), 0);
  const totalCost = job?.totalCost || 0;

  const ringClass = isRunning
    ? 'ring-1 ring-yellow-500/30'
    : story.status === 'in_review'
      ? 'ring-1 ring-purple-500/30'
      : story.status === 'fixing'
        ? 'ring-1 ring-orange-500/30'
        : '';

  return (
    <div className={`border-b border-border/10 last:border-b-0 ${ringClass}`}>
      {/* Row header — clickable */}
      <button
        className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-secondary/10 transition-colors text-left"
        onClick={onToggle}
      >
        {/* Chevron */}
        <ChevronRight
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}
        />

        {/* Status dot */}
        <span className={`w-2 h-2 rounded-full shrink-0 ${getStatusDot(story.status)}`} />

        {/* Title */}
        <span className="flex-1 text-sm font-medium truncate">{story.title}</span>

        {/* Browser test badge */}
        {story.hasBrowserTests && (
          <span className="rounded bg-purple-900/50 px-1.5 py-0.5 text-[8px] uppercase text-purple-400 shrink-0">
            browser
          </span>
        )}

        {/* Dependencies */}
        {story.dependsOn && story.dependsOn.length > 0 && (
          <span className="text-[10px] text-muted-foreground font-mono shrink-0">
            {story.dependsOn.map((d) => d.replace('story-', 'S')).join(', ')}
          </span>
        )}

        {/* Model badge */}
        {model && (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono shrink-0">
            {model}
          </span>
        )}

        {/* Timer when running — show even before job data loads */}
        {isRunning &&
          (job?.createdAt ? (
            <Timer startIso={job.createdAt} />
          ) : (
            <span className="font-mono text-yellow-500 text-xs animate-pulse">0s</span>
          ))}

        {/* Phase label when running */}
        {isRunning && phaseLabel && (
          <span className="text-[10px] text-yellow-500 font-medium shrink-0">{phaseLabel}</span>
        )}

        {/* Duration when done */}
        {!isRunning && totalDuration > 0 && (
          <span className="text-xs text-muted-foreground font-mono w-14 text-right shrink-0">
            {formatElapsed(totalDuration)}
          </span>
        )}

        {/* Cost — only when story has actually run and cost > 0 */}
        {!isRunning && totalCost > 0 && (
          <span className="text-xs text-muted-foreground font-mono w-12 text-right shrink-0">
            ${totalCost.toFixed(2)}
          </span>
        )}

        {/* Status badge — hide when running (timer is enough) */}
        {!isRunning && (
          <span
            className={`text-[10px] h-5 px-1.5 uppercase border rounded flex items-center justify-center w-16 shrink-0 ${getStatusBadgeClasses(story.status)}`}
          >
            {getStatusLabel(story.status)}
          </span>
        )}

        {/* Run button */}
        {canRun && showRunButton && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRun();
            }}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 shrink-0"
          >
            Run
          </button>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 py-3 bg-secondary/5 border-t border-border/10 space-y-3 ml-8">
          {/* Live output — most important when running */}
          {isRunning && story.jobId && <StoryLiveOutput jobId={story.jobId} />}

          {/* Error */}
          {isFailed && job?.errorMessage && (
            <div className="rounded border border-red-900 bg-red-950/30 p-2 text-xs text-red-400">
              <span className="font-medium">Error: </span>
              {job.errorMessage}
            </div>
          )}

          {/* Completed results — uses expandable sections */}
          {(isDone || isFailed) && story.jobId && <StoryResult jobId={story.jobId} />}

          {/* Story description — expandable at bottom */}
          <ExpandableSection title="Story Description" defaultOpen={false}>
            <pre className="whitespace-pre-wrap text-xs text-muted-foreground bg-muted/50 rounded p-3 max-h-48 overflow-auto">
              {story.description}
            </pre>
          </ExpandableSection>
        </div>
      )}
    </div>
  );
}

export function ExpandableSection({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        {title}
      </button>
      {isOpen && <div className="mt-2 pl-4">{children}</div>}
    </div>
  );
}
