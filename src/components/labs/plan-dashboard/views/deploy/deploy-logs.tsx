'use client';

/**
 * Live deploy logs — streams AgentEvents for the active (or most-recent)
 * deploy job, with a copy-to-clipboard button so the operator can paste raw
 * logs into chat or issues. Mirrors the per-epic VQA log card: event rows
 * with type/stepId/text columns, auto-scrolling container, duration clock,
 * current-step badge.
 *
 * Hidden entirely (returns null) when there's no deploy job, so callers can
 * mount it unconditionally (e.g. per-environment in the Deploy-activity panel).
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import type { AgentEvent, AgentJobStatus } from '@/types/agent-orchestrator';
import { CopyLogButton } from '../../shared/copy-log-button';

interface Props {
  deployJobId: string | null;
}

export function DeployLogs({ deployJobId }: Props) {
  const { data: job } = useAgentJob(deployJobId);
  const { events } = useAgentEvents(deployJobId, job?.status);

  const jobRunning = job?.status === 'PENDING' || job?.status === 'RUNNING';
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!jobRunning) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [jobRunning]);

  const durationSec =
    job && job.createdAt
      ? Math.max(
          0,
          ((jobRunning ? nowMs : Date.parse(job.updatedAt)) - Date.parse(job.createdAt)) / 1000,
        )
      : null;

  const currentStep = useMemo(() => deriveCurrentStep(events, job?.status), [events, job?.status]);
  const statusColor = jobStatusColor(job?.status);

  if (!deployJobId) return null;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Deploy logs
        </span>
        <StatusPill status={job?.status ?? 'PENDING'} color={statusColor} />
        {durationSec != null && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-mute)',
              letterSpacing: '0.06em',
            }}
          >
            {fmtDuration(durationSec)}
          </span>
        )}
        {currentStep && <StepBadge label={currentStep.label} running={currentStep.running} />}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            letterSpacing: '0.04em',
          }}
        >
          job {deployJobId.slice(0, 8)}
        </span>
        <div style={{ marginLeft: 'auto' }}>
          <CopyLogButton events={events} label="Copy logs" />
        </div>
      </div>

      {/* Error banner */}
      {job?.errorMessage && (
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--destructive)',
            background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
            color: 'var(--destructive)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.02em',
          }}
        >
          {job.errorMessage}
        </div>
      )}

      {/* Event stream */}
      {events.length === 0 ? (
        <EmptyStream jobStatus={job?.status} duration={durationSec ?? 0} />
      ) : (
        <div
          style={{
            maxHeight: 340,
            overflow: 'auto',
            background: 'var(--background)',
            padding: '6px 0',
          }}
        >
          {events.map((ev) => (
            <EventRow key={`${ev.jobId}-${ev.eventSeq}`} event={ev} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers (cloned from vqa-logs.tsx — simple enough to inline) ──

function deriveCurrentStep(
  events: AgentEvent[],
  jobStatus: AgentJobStatus | undefined,
): { label: string; running: boolean } | null {
  if (!events.length) {
    if (jobStatus === 'PENDING') return { label: 'waiting for daemon', running: true };
    return null;
  }
  const stepsStarted = new Map<string, boolean>();
  for (const ev of events) {
    if (ev.eventType === 'step_start') stepsStarted.set(ev.stepId, false);
    else if (ev.eventType === 'step_complete') stepsStarted.set(ev.stepId, true);
    else if (ev.eventType === 'step_error') stepsStarted.set(ev.stepId, true);
  }
  const entries = [...stepsStarted.entries()];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!entries[i][1]) return { label: entries[i][0], running: true };
  }
  if (jobStatus === 'COMPLETED') return { label: 'complete', running: false };
  if (jobStatus === 'FAILED') return { label: 'failed', running: false };
  return null;
}

function jobStatusColor(status: AgentJobStatus | undefined): string {
  switch (status) {
    case 'COMPLETED':
      return 'var(--success)';
    case 'FAILED':
      return 'var(--destructive)';
    case 'RUNNING':
      return 'var(--accent-purple)';
    case 'PENDING':
    default:
      return 'var(--warning)';
  }
}

function StatusPill({ status, color }: { status: string; color: string }) {
  const pulse = status === 'RUNNING' || status === 'PENDING';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 2,
        border: `1px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      <span
        className={pulse ? 'animate-pulse-soft' : ''}
        style={{
          background: color,
          width: 5,
          height: 5,
          borderRadius: '50%',
          display: 'inline-block',
        }}
      />
      {status.toLowerCase()}
    </span>
  );
}

function StepBadge({ label, running }: { label: string; running: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: running ? 'var(--accent-purple)' : 'var(--text-mute)',
        letterSpacing: '0.04em',
      }}
    >
      {running && <Loader2 size={10} className="animate-spin" />}
      <span style={{ color: 'var(--text-faint)' }}>step:</span>
      <code style={{ color: 'inherit' }}>{label}</code>
    </span>
  );
}

function EmptyStream({
  jobStatus,
  duration,
}: {
  jobStatus: AgentJobStatus | undefined;
  duration: number;
}) {
  const stuck = jobStatus === 'PENDING' && duration > 30;
  return (
    <div
      style={{
        padding: '18px 16px',
        color: stuck ? 'var(--warning)' : 'var(--text-mute)',
        fontSize: 12,
        lineHeight: 1.5,
        textAlign: 'center',
      }}
    >
      {stuck ? (
        <>
          Deploy has been PENDING for {fmtDuration(duration)} with no events. Check the EC2 chip in
          the header.
        </>
      ) : jobStatus === 'PENDING' ? (
        <>Waiting for the daemon to pick up this deploy…</>
      ) : (
        <>No events recorded yet.</>
      )}
    </div>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  const color = eventColor(event.eventType);
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '3px 16px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--text-dim)',
        alignItems: 'flex-start',
      }}
    >
      <span
        style={{
          color: 'var(--text-faint)',
          width: 56,
          flexShrink: 0,
          letterSpacing: '0.04em',
        }}
      >
        {fmtTime(event.timestamp)}
      </span>
      <span
        style={{
          color,
          width: 100,
          flexShrink: 0,
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontWeight: 600,
          paddingTop: 1,
        }}
      >
        {event.eventType.replaceAll('_', ' ')}
      </span>
      <span
        style={{
          color: 'var(--text-faint)',
          width: 90,
          flexShrink: 0,
          fontSize: 9,
          paddingTop: 1,
        }}
      >
        {event.stepId}
      </span>
      <span style={{ flex: 1, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        {summarizeEvent(event)}
      </span>
    </div>
  );
}

function eventColor(type: string): string {
  switch (type) {
    case 'step_start':
      return 'var(--accent-purple)';
    case 'step_complete':
    case 'result':
      return 'var(--success)';
    case 'step_error':
      return 'var(--destructive)';
    case 'tool_use':
    case 'tool_result':
      return 'var(--cyan)';
    case 'extraction':
      return 'var(--accent-blue)';
    case 'validation':
      return 'var(--warning)';
    default:
      return 'var(--text-dim)';
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}

function summarizeEvent(ev: AgentEvent): string {
  if (ev.eventType === 'tool_use') {
    const input = ev.toolInput ?? '';
    return `${ev.toolName ?? 'tool'}(${input.slice(0, 200)})`;
  }
  if (ev.eventType === 'tool_result') return (ev.text ?? '').slice(0, 400);
  if (ev.eventType === 'step_start') return ev.text ?? `step ${ev.stepId} start`;
  if (ev.eventType === 'step_complete') return `step ${ev.stepId} complete`;
  if (ev.eventType === 'step_error') return `ERROR: ${ev.text ?? ''}`;
  if (ev.eventType === 'extraction')
    return `${ev.variableName} = ${(ev.variableValue ?? '').slice(0, 200)}`;
  if (ev.eventType === 'validation')
    return `${ev.validationPassed ? 'PASS' : 'FAIL'}: ${ev.validationLabel}${
      ev.validationDetails ? ` — ${ev.validationDetails}` : ''
    }`;
  if (ev.eventType === 'status' || ev.eventType === 'text_delta' || ev.eventType === 'result')
    return ev.text ?? '';
  return ev.text ?? '';
}
