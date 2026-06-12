'use client';

/**
 * Per-epic Visual QA logs — one live-streaming card per epic that has a
 * qaJobId. Matches the story-logs pattern in the Hierarchy view:
 *   — current-step indicator ("qa-evaluate · running")
 *   — live event stream via useAgentEvents (1s polling)
 *   — CopyLogButton per card so you can paste just one epic's output
 *   — live dev-server preview link once qa-start-server completes
 *
 * Daemon-offline warning sits at the top — the #1 cause of "job PENDING
 * forever" is the daemon not running on EC2.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import { useEc2Status } from '@/hooks/use-ec2-daemon';
import type { AgentEvent, AgentJob, AgentJobStatus } from '@/types/agent-orchestrator';
import type { QaRunPanel } from '@/types/qa-report';
import { CopyLogButton } from '../../shared/copy-log-button';

interface Props {
  /**
   * QA-A (pong1 2026-06-12) — UNIQUE runs, not per-epic rows. Plan-scoped QA
   * resolves every epic to the SAME job; the old per-epic mapping rendered N
   * byte-identical log panels for one run (the operator's "why are there 2
   * epic QA logs?"). One panel per distinct qaJobId, scope spelled out.
   */
  runs: QaRunPanel[];
}

export function VqaLogs({ runs }: Props) {
  const { data: ec2Status } = useEc2Status(true);

  if (runs.length === 0) {
    return (
      <div
        style={{
          padding: '24px 18px',
          border: '1px dashed var(--border-2)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          color: 'var(--text-mute)',
          fontSize: 12,
          textAlign: 'center',
          letterSpacing: '0.04em',
        }}
      >
        No Visual QA jobs have run for this plan yet. Click <strong>Re-run QA</strong> at the top to
        kick one off.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <DaemonDiagnostics ec2Status={ec2Status} />
      {runs.map((run) => (
        <VqaRunLog
          key={run.qaJobId}
          label={run.scope === 'plan' ? 'PLAN' : run.epicLabels.join(' ')}
          title={run.title}
          qaJobId={run.qaJobId}
        />
      ))}
    </div>
  );
}

// ── Daemon diagnostics ──────────────────────────────────────────────

function DaemonDiagnostics({ ec2Status }: { ec2Status: ReturnType<typeof useEc2Status>['data'] }) {
  // Live-ticking clock so "last heartbeat · 42s ago" actually counts up
  // instead of freezing between 3s status polls.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!ec2Status) {
    return (
      <div style={stripBaseStyle('var(--text-faint)')}>
        <Loader2 size={12} className="animate-spin" />
        <span>Loading daemon status…</span>
      </div>
    );
  }

  const {
    state,
    daemonAlive,
    activeCount,
    maxConcurrent,
    lastHeartbeat,
    auth,
    publicIp,
    processes,
  } = ec2Status;
  const hbMs: number | null = lastHeartbeat ? nowMs - Date.parse(lastHeartbeat) : null;
  const hbStale: boolean = hbMs != null && hbMs > 30_000;

  // Color decision: any sign of trouble goes red/amber, otherwise green.
  const alive = daemonAlive && !hbStale;
  const stripColor = !daemonAlive
    ? 'var(--destructive)'
    : hbStale
      ? 'var(--warning)'
      : auth?.valid === false
        ? 'var(--warning)'
        : 'var(--success)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={stripBaseStyle(stripColor)}>
        <span
          className={alive ? 'animate-pulse-soft' : ''}
          style={{
            background: stripColor,
            width: 7,
            height: 7,
            borderRadius: '50%',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span style={{ color: stripColor, fontWeight: 500, letterSpacing: '0.04em' }}>
          Daemon {daemonAlive ? 'online' : 'offline'}
        </span>
        <Pill label="instance" value={state ?? 'unknown'} />
        <Pill label="slots" value={`${activeCount}/${maxConcurrent}`} />
        <Pill
          label="heartbeat"
          value={hbMs == null ? 'never' : fmtDuration(hbMs / 1000) + ' ago'}
          warn={hbStale}
        />
        {auth && <Pill label="auth" value={auth.valid ? 'valid' : 'expired'} warn={!auth.valid} />}
        {publicIp && <Pill label="ip" value={publicIp} />}

        {/* Specific diagnosis line — most-common-first. */}
        <DiagnosisHint
          state={state}
          daemonAlive={daemonAlive}
          hbStale={hbStale}
          authValid={auth?.valid}
          slotsFull={activeCount >= maxConcurrent}
          processes={processes}
          nowMs={nowMs}
        />
      </div>

      {/* Surface what the daemon is actually executing — when slots are full
          but our QA jobs are pending, this tells the operator *what* is
          hogging the slots so they can restart or wait. */}
      {processes && processes.length > 0 && <HoldingSlots processes={processes} nowMs={nowMs} />}
    </div>
  );
}

function HoldingSlots({
  processes,
  nowMs,
}: {
  processes: NonNullable<ReturnType<typeof useEc2Status>['data']>['processes'];
  nowMs: number;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 6,
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
        }}
      >
        Holding slots ({processes.length})
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content max-content max-content 1fr max-content',
          gap: '4px 14px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          alignItems: 'center',
        }}
      >
        <div style={gridHeaderStyle}>job</div>
        <div style={gridHeaderStyle}>step / agent</div>
        <div style={gridHeaderStyle}>model</div>
        <div style={gridHeaderStyle}>workdir</div>
        <div style={{ ...gridHeaderStyle, textAlign: 'right' }}>running</div>
        {processes.map((p) => {
          const startedMs = p.startedAt ? Date.parse(p.startedAt) : NaN;
          const dur = Number.isFinite(startedMs) ? (nowMs - startedMs) / 1000 : null;
          const stuck = dur != null && dur > 600; // >10 min with one step = suspicious
          return (
            <ProcessRow
              key={p.jobId}
              jobId={p.jobId}
              step={p.stepId}
              agent={p.agentId}
              model={p.model}
              pid={p.pid}
              workingDir={p.workingDir}
              durationSec={dur}
              stuck={stuck}
            />
          );
        })}
      </div>
    </div>
  );
}

const gridHeaderStyle: React.CSSProperties = {
  color: 'var(--text-faint)',
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  fontSize: 8,
  paddingBottom: 3,
  borderBottom: '1px solid var(--border-2)',
};

function ProcessRow({
  jobId,
  step,
  agent,
  model,
  pid,
  workingDir,
  durationSec,
  stuck,
}: {
  jobId: string;
  step: string | null;
  agent: string | null;
  model: string | null;
  pid: number | null;
  workingDir: string;
  durationSec: number | null;
  stuck: boolean;
}) {
  const color = stuck ? 'var(--warning)' : 'var(--text-dim)';
  const stepLabel = step || agent || '—';
  return (
    <>
      <code style={{ color: 'var(--accent-blue)' }}>{jobId}</code>
      <span style={{ color }}>
        {stepLabel}
        {agent && step ? <span style={{ color: 'var(--text-faint)' }}> · {agent}</span> : null}
        {pid ? <span style={{ color: 'var(--text-faint)' }}> · pid {pid}</span> : null}
      </span>
      <span style={{ color: 'var(--text-mute)' }}>{model || '—'}</span>
      <span style={{ color: 'var(--text-mute)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {workingDir || '—'}
      </span>
      <span style={{ color, textAlign: 'right' }}>
        {durationSec == null ? '—' : fmtDuration(durationSec)}
        {stuck ? ' ⚠' : ''}
      </span>
    </>
  );
}

function DiagnosisHint({
  state,
  daemonAlive,
  hbStale,
  authValid,
  slotsFull,
  processes,
  nowMs,
}: {
  state: string | undefined;
  daemonAlive: boolean;
  hbStale: boolean;
  authValid: boolean | null | undefined;
  slotsFull: boolean;
  processes: NonNullable<ReturnType<typeof useEc2Status>['data']>['processes'] | undefined;
  nowMs: number;
}) {
  // If slots are full, call out whether anything looks stuck (>10min on one
  // step) — that's usually a hung orchestrator or Claude CLI waiting on an
  // exit code that never comes.
  const longestMin = (() => {
    if (!processes?.length) return 0;
    let max = 0;
    for (const p of processes) {
      const t = p.startedAt ? Date.parse(p.startedAt) : NaN;
      if (Number.isFinite(t)) max = Math.max(max, (nowMs - t) / 60_000);
    }
    return max;
  })();

  const hint =
    state !== 'running'
      ? `EC2 is ${state} — start it in the header.`
      : !daemonAlive
        ? 'Daemon process is not running on EC2. Check the EC2 toggle in the header for a Restart action.'
        : hbStale
          ? 'Daemon heartbeat is stale. It may have crashed — try Restart in the EC2 panel.'
          : authValid === false
            ? 'Claude Code auth expired. Click Re-auth in the header.'
            : slotsFull && longestMin > 10
              ? `Slots full — oldest job has been running ${Math.round(longestMin)}m (see “Holding slots” below). Likely hung; Restart will free slots.`
              : slotsFull
                ? 'All daemon slots are in use — see "Holding slots" below for what is running.'
                : null;
  if (!hint) return null;
  return (
    <span
      style={{
        marginLeft: 'auto',
        color: 'var(--warning)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.02em',
      }}
    >
      ⚠ {hint}
    </span>
  );
}

function Pill({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const color = warn ? 'var(--warning)' : 'var(--text-dim)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 2,
        border: '1px solid var(--border-2)',
        background: 'var(--surface)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.04em',
      }}
    >
      <span
        style={{
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
        }}
      >
        {label}
      </span>
      <code style={{ color }}>{value}</code>
    </span>
  );
}

function stripBaseStyle(borderColor: string): React.CSSProperties {
  return {
    padding: '10px 14px',
    border: `1px solid ${borderColor}`,
    background: `color-mix(in srgb, ${borderColor} 8%, transparent)`,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
  };
}

// (Legacy DaemonOfflineBanner + AuthExpiredBanner merged into DaemonDiagnostics
// above — keeps all daemon signal in one compact always-visible strip.)

// ── Per-run card (QA-A: one per unique qaJobId) ─────────────────────

function VqaRunLog({ label, title, qaJobId }: { label: string; title: string; qaJobId: string }) {
  const { data: job } = useAgentJob(qaJobId ?? null);
  const { events } = useAgentEvents(qaJobId ?? null, job?.status);
  const { data: ec2Status } = useEc2Status(true);
  const [expanded, setExpanded] = useState(true);

  // Live-ticking clock for duration display while the job is running.
  // Lazy initializer keeps render pure.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const jobRunning = job?.status === 'PENDING' || job?.status === 'RUNNING';
  useEffect(() => {
    if (!jobRunning) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [jobRunning]);

  const duration =
    job && job.createdAt
      ? Math.max(
          0,
          ((jobRunning ? nowMs : Date.parse(job.updatedAt)) - Date.parse(job.createdAt)) / 1000,
        )
      : null;

  const currentStep = useMemo(() => deriveCurrentStep(events, job?.status), [events, job?.status]);
  const previewUrl = derivePreviewUrl(events, job, ec2Status?.state, ec2Status?.publicIp);

  const statusColor = jobStatusColor(job?.status);
  const statusLabel = job?.status ?? 'PENDING';

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
          borderBottom: expanded ? '1px solid var(--border)' : 'none',
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--text-dim)',
          }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: 13,
            color: 'var(--foreground)',
            letterSpacing: '-0.005em',
          }}
        >
          {title}
        </span>

        <StatusPill status={statusLabel} color={statusColor} />

        {duration != null && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-mute)',
              letterSpacing: '0.06em',
            }}
          >
            {fmtDuration(duration)}
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
          job {qaJobId.slice(0, 8)}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 10px',
                borderRadius: 2,
                border: '1px solid var(--success)',
                background: 'color-mix(in srgb, var(--success) 10%, transparent)',
                color: 'var(--success)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                textDecoration: 'none',
              }}
            >
              Preview
              <ExternalLink size={10} />
            </a>
          )}
          <CopyLogButton events={events} label="Copy logs" />
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div>
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

          {/* Live event stream */}
          {events.length === 0 ? (
            <EmptyStream jobStatus={job?.status} duration={duration ?? 0} />
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

          {/* Extracted variables — compact footer. QA_REPORT + vars sit
              here for easy copy / paste without switching context. */}
          {job?.variables && Object.keys(job.variables).length > 0 && (
            <ExtractedVariables vars={job.variables} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function deriveCurrentStep(
  events: AgentEvent[],
  jobStatus: AgentJobStatus | undefined,
): { label: string; running: boolean } | null {
  if (!events.length) {
    if (jobStatus === 'PENDING') return { label: 'waiting for daemon', running: true };
    return null;
  }
  // Walk backwards: the last step_start is the currently running step,
  // unless a matching step_complete follows it.
  const stepsStarted = new Map<string, boolean>(); // stepId → complete?
  for (const ev of events) {
    if (ev.eventType === 'step_start') stepsStarted.set(ev.stepId, false);
    else if (ev.eventType === 'step_complete') stepsStarted.set(ev.stepId, true);
    else if (ev.eventType === 'step_error') stepsStarted.set(ev.stepId, true);
  }
  // Find the last entry that's still not complete.
  const entries = [...stepsStarted.entries()];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!entries[i][1]) return { label: entries[i][0], running: true };
  }
  // All steps complete → job finished.
  if (jobStatus === 'COMPLETED') return { label: 'complete', running: false };
  if (jobStatus === 'FAILED') return { label: 'failed', running: false };
  return null;
}

function derivePreviewUrl(
  events: AgentEvent[],
  job: AgentJob | undefined,
  ec2State: string | undefined,
  publicIp: string | undefined,
): string | null {
  if (!job || !publicIp || ec2State !== 'running') return null;
  const port = job.variables?.DEV_SERVER_PORT;
  if (!port) return null;
  // Preview is valid once qa-start-server step completed AND the job is
  // still running (qa-stop-server hasn't run yet).
  const stillRunning = job.status === 'PENDING' || job.status === 'RUNNING';
  if (!stillRunning) return null;
  const serverUp = events.some(
    (e) => e.stepId === 'qa-start-server' && e.eventType === 'step_complete',
  );
  if (!serverUp) return null;
  return `http://${publicIp}:${port}/`;
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
  // When a job sits PENDING with no events for > 30s, the daemon probably
  // isn't picking it up. Surface that directly instead of leaving the panel
  // empty.
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
          Job has been PENDING for {fmtDuration(duration)} with no events. The daemon may be
          offline, busy with another job, or the Claude CLI auth has expired — check the header
          chips.
        </>
      ) : jobStatus === 'PENDING' ? (
        <>Waiting for the daemon to pick up this job…</>
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
        {event.eventType.replace('_', ' ')}
      </span>
      <span
        style={{
          color: 'var(--text-faint)',
          width: 70,
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

function ExtractedVariables({ vars }: { vars: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{
        borderTop: '1px solid var(--border)',
        background: 'color-mix(in srgb, var(--foreground) 1%, transparent)',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          listStyle: 'none',
          padding: '10px 16px',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
        }}
      >
        Extracted variables ({Object.keys(vars).length})
      </summary>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: 8,
          padding: '10px 16px 14px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
        }}
      >
        {Object.entries(vars).map(([k, v]) => (
          <VarRow key={k} k={k} v={v} />
        ))}
      </div>
    </details>
  );
}

function VarRow({ k, v }: { k: string; v: string }) {
  const short = v.length > 200;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div style={{ color: 'var(--text-faint)', letterSpacing: '0.04em' }}>{k}</div>
      <div style={{ color: 'var(--text-dim)', wordBreak: 'break-all' }}>
        {short && !open ? (
          <>
            {v.slice(0, 200)}…{' '}
            <button
              type="button"
              onClick={() => setOpen(true)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--accent-blue)',
                cursor: 'pointer',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                padding: 0,
              }}
            >
              expand
            </button>
          </>
        ) : (
          <pre
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-dim)',
              margin: 0,
              padding: 0,
              background: 'transparent',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.5,
            }}
          >
            {v}
          </pre>
        )}
      </div>
    </>
  );
}

// ── Utils ───────────────────────────────────────────────────────────

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
