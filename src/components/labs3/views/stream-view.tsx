'use client';

/**
 * Labs3 · Stream view — plan-wide live forensic surface.
 *
 * Unlike the Stories tab (which streams one story at a time inside an
 * expander), Stream subscribes to EVERY story-dev AgentJob in the plan at
 * once (useAgentJobs over storyJobIds(stories)) and renders a chronological
 * board of live logs. It is the "war-room" surface the operator copies /
 * exports from while a plan runs:
 *
 *   • per-row CopyLogButton (paste a story's raw Claude log into chat)
 *   • Export forensic JSON  — authenticated blob of /plans/:id/timing/forensic
 *   • Download forensic log  — an in-memory Markdown report (no fetch),
 *     mirroring the legacy downloadForensicLog pattern.
 */

import { useCallback, useMemo, useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { api } from '@/lib/api-client';
import { useAgentJobs } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { hasActiveStory } from '@/hooks/use-story-nodes';
import type { AgentJob } from '@/types/agent-orchestrator';
import type { StoryNodeRow } from '@/types/plan-spec';

import { StoryNodeStatePill, ACTIVE_STORY_NODE_STATES } from '../shared/state-pill';
import {
  storyJobIds,
  fmtCost,
  fmtTokens,
  jobCost,
  jobTokens,
} from '../plan-spec-dashboard/adapter';
import type { Labs3ViewProps } from '../plan-spec-dashboard/constants';

import { MetricChip } from '@/components/labs/plan-dashboard/shared/metric-chip';
import { LogEntry } from '@/components/labs/plan-dashboard/shared/log-entry';
import { CopyLogButton } from '@/components/labs/plan-dashboard/shared/copy-log-button';

// ── Forensic JSON download (authenticated blob; ported pattern) ──────

function useForensicDownload(planId: string) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await api.fetch<Blob>(
        `/plans/${planId}/timing/forensic?include=events&fresh=1`,
        {
          headers: { Accept: 'application/json' },
        },
      );
      const text = typeof blob === 'string' ? blob : JSON.stringify(blob, null, 2);
      const objectUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${planId}-forensic.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setDownloadError((err as Error).message ?? 'Download failed');
    } finally {
      setDownloading(false);
    }
  }, [planId]);

  return { download, downloading, downloadError };
}

// ── In-memory Markdown forensic log (no fetch) ───────────────────────

function buildForensicMarkdown(
  planId: string,
  stories: StoryNodeRow[],
  jobsById: Record<string, AgentJob>,
): string {
  const lines: string[] = [];
  const done = stories.filter((s) => s.state === 'done').length;
  const failed = stories.filter((s) => s.state === 'failed').length;
  const active = stories.filter((s) => ACTIVE_STORY_NODE_STATES.has(s.state)).length;
  const totalCost = Object.values(jobsById).reduce((a, j) => a + jobCost(j), 0);
  const totalTokens = Object.values(jobsById).reduce((a, j) => a + jobTokens(j), 0);

  lines.push(`# Forensic log — plan ${planId}`);
  lines.push('');
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Stories: ${stories.length}`);
  lines.push(`- Done: ${done} / ${stories.length}`);
  lines.push(`- In flight: ${active}`);
  lines.push(`- Failed: ${failed}`);
  lines.push(`- Total cost: ${fmtCost(totalCost)}`);
  lines.push(`- Total tokens: ${fmtTokens(totalTokens)}`);
  lines.push(`- Branch: plan/${planId}`);
  lines.push('');
  lines.push('## Stories');
  lines.push('');

  const ordered = [...stories].sort(
    (a, b) => a.cohortBatch - b.cohortBatch || a.storyId.localeCompare(b.storyId),
  );
  for (const s of ordered) {
    const job = s.jobId ? jobsById[s.jobId] : undefined;
    const passing = s.acceptanceCriteria.filter((a) => a.testBinding.status === 'passing').length;
    lines.push(`### ${s.storyId} · ${s.title}`);
    lines.push('');
    lines.push(
      `- Cohort: ${s.cohort.epicId}${s.cohort.epicTitle ? ` (${s.cohort.epicTitle})` : ''} · batch ${s.cohortBatch}`,
    );
    lines.push(`- State: ${s.state}`);
    lines.push(
      `- Job: ${s.jobId ?? '—'}${job ? ` (${job.status}) · ${fmtCost(jobCost(job))} · ${fmtTokens(jobTokens(job))} · retries ${job.retryAttempt ?? 0}` : ''}`,
    );
    if (s.depends_on.length) {
      lines.push(
        `- Depends on: ${s.unblockedDepsCount}/${s.depends_on.length} done — ${s.depends_on.join(', ')}`,
      );
    }
    if (s.touches.length) lines.push(`- Touches: ${s.touches.join(', ')}`);
    lines.push(`- Acceptance criteria: ${passing}/${s.acceptanceCriteria.length} passing`);
    for (const ac of s.acceptanceCriteria) {
      const mark =
        ac.testBinding.status === 'passing' ? 'x' : ac.testBinding.status === 'failing' ? '!' : ' ';
      const ref = ac.testBinding.testRef ? ` \`${ac.testBinding.testRef}\`` : '';
      const sha = ac.testBinding.lastRunSha ? ` @${ac.testBinding.lastRunSha.slice(0, 7)}` : '';
      lines.push(`  - [${mark}] (${ac.acClass}/${ac.testBinding.status}) ${ac.text}${ref}${sha}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function downloadForensicLog(
  planId: string,
  stories: StoryNodeRow[],
  jobsById: Record<string, AgentJob>,
) {
  const md = buildForensicMarkdown(planId, stories, jobsById);
  const objectUrl = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `${planId}-forensic.md`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}

// ── Top-level view ───────────────────────────────────────────────────

export function StreamView({ planId, stories, onSelectStory }: Labs3ViewProps) {
  const jobIds = useMemo(() => storyJobIds(stories), [stories]);
  const active = hasActiveStory(stories);
  const results = useAgentJobs(jobIds, active);

  const jobsById = useMemo(() => {
    const map: Record<string, AgentJob> = {};
    results.forEach((r) => {
      if (r.data) map[r.data.jobId] = r.data;
    });
    return map;
  }, [results]);

  const { download, downloading, downloadError } = useForensicDownload(planId);

  // Only stories that have minted a story-dev job get a live stream row.
  const rows = useMemo(() => stories.filter((s) => !!s.jobId), [stories]);

  const activeJobCount = Object.values(jobsById).filter(
    (j) => j.status === 'RUNNING' || j.status === 'PENDING',
  ).length;
  const totalCost = Object.values(jobsById).reduce((a, j) => a + jobCost(j), 0);
  const totalTokens = Object.values(jobsById).reduce((a, j) => a + jobTokens(j), 0);

  return (
    <div>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '16px 18px',
          border: '1px solid var(--border)',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className={active ? 'animate-pulse-soft' : undefined}
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: active ? 'var(--accent-purple)' : 'var(--text-faint)',
              display: 'inline-block',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.2em',
              color: active ? 'var(--accent-purple)' : 'var(--text-mute)',
            }}
          >
            {active ? 'live' : 'idle'}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <MetricChip label="jobs" value={String(jobIds.length)} color="var(--text-dim)" />
        <MetricChip label="active" value={String(activeJobCount)} color="var(--accent-purple)" />
        <MetricChip label="tokens" value={fmtTokens(totalTokens)} color="var(--cyan)" />
        <MetricChip label="cost" value={fmtCost(totalCost)} color="var(--amber)" />
        <ToolbarButton
          onClick={download}
          disabled={downloading}
          icon={
            downloading ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />
          }
          label="Export forensic JSON"
        />
        <ToolbarButton
          onClick={() => downloadForensicLog(planId, stories, jobsById)}
          disabled={rows.length === 0}
          icon={<FileText size={11} />}
          label="Download forensic log"
        />
      </div>

      {downloadError && (
        <p style={{ fontSize: 11, color: 'var(--destructive)', marginBottom: 10 }}>
          {downloadError}
        </p>
      )}

      {rows.length === 0 ? (
        <div
          style={{
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            borderRadius: 8,
            padding: '28px 22px',
            textAlign: 'center',
            color: 'var(--text-mute)',
            fontSize: 13,
          }}
        >
          No story-dev jobs yet. The ready-frontier dispatches stories as their dependencies land —
          live logs will stream here the moment the first one is claimed.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {rows.map((s) => (
            <StreamRow
              key={s.storyId}
              story={s}
              job={s.jobId ? jobsById[s.jobId] : undefined}
              onSelectStory={onSelectStory}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  onClick,
  disabled,
  icon,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '5px 11px',
        borderRadius: 2,
        border: '1px solid var(--border)',
        background: 'transparent',
        color: 'var(--text-mute)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Per-story live stream row ────────────────────────────────────────

function StreamRow({
  story,
  job,
  onSelectStory,
}: {
  story: StoryNodeRow;
  job: AgentJob | undefined;
  onSelectStory?: (storyId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isActive = ACTIVE_STORY_NODE_STATES.has(story.state);
  const { events } = useAgentEvents(story.jobId ?? null, job?.status);
  // Show a short tail when collapsed, the full stream when expanded.
  const visible = open ? events : events.slice(-4);

  return (
    <div style={{ border: '1px solid var(--border)' }}>
      <div
        onClick={() => {
          setOpen((v) => !v);
          onSelectStory?.(story.storyId);
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 1fr auto auto auto auto',
          alignItems: 'center',
          gap: 14,
          padding: '12px 16px',
          cursor: 'pointer',
          background: open
            ? 'color-mix(in srgb, var(--foreground) 2.5%, transparent)'
            : 'transparent',
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-faint)',
            transition: 'transform 160ms',
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
          }}
        >
          ▶
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              color: 'var(--foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {story.title}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-mute)',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginTop: 2,
            }}
          >
            {story.storyId.slice(0, 10)} · {story.cohort.epicId} · batch {story.cohortBatch}
            {story.jobId && ` · job ${story.jobId.slice(0, 8)}`} · {events.length} events
          </div>
        </div>
        <MetricChip label="tokens" value={fmtTokens(jobTokens(job))} color="var(--cyan)" />
        <MetricChip label="cost" value={fmtCost(jobCost(job))} color="var(--amber)" />
        <CopyLogButton events={events} compact />
        <StoryNodeStatePill state={story.state} pulse={isActive} />
      </div>

      <div
        style={{
          background: 'var(--background)',
          borderTop: '1px solid var(--border)',
          padding: '8px 16px',
          maxHeight: open ? 360 : 110,
          overflow: 'auto',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {visible.length > 0 ? (
          visible.map((ev) => <LogEntry key={`${ev.jobId}-${ev.eventSeq}`} event={ev} />)
        ) : (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-faint)',
              padding: '6px 0',
              textAlign: 'center',
              letterSpacing: '0.08em',
            }}
          >
            {isActive ? 'Waiting for the first log event…' : `No events — story is ${story.state}.`}
          </div>
        )}
      </div>
    </div>
  );
}
