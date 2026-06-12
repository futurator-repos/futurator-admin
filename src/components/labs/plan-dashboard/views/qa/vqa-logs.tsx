'use client';

/**
 * QA run card — pacman1 UX pass (2026-06-12).
 *
 * Replaces the raw per-run log panel (live event firehose + a 23-row
 * "extracted variables" dump) the operator called noise. The card now leads
 * with what a semi-technical reader needs — status, duration, cost, how many
 * screenshots, a link to the full-app capture — and keeps the technical
 * event log behind a collapsed expander for debugging.
 *
 * Daemon diagnostics moved OUT of the QA page entirely (the header's EC2
 * panel already owns that signal).
 */

import { useState } from 'react';
import { Camera, ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { useAgentJob } from '@/hooks/use-agent-job';
import { useAgentEvents } from '@/hooks/use-agent-events';
import type { AgentEvent, AgentJobStatus } from '@/types/agent-orchestrator';
import type { QaRunPanel } from '@/types/qa-report';
import { CopyLogButton } from '../../shared/copy-log-button';

interface Props {
  /** One entry per UNIQUE QA job (plan-scoped runs are never duplicated). */
  runs: QaRunPanel[];
}

export function VqaLogs({ runs }: Props) {
  if (runs.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {runs.map((run) => (
        <QaRunCard key={run.qaJobId} run={run} />
      ))}
    </div>
  );
}

// ── Run card ────────────────────────────────────────────────────────

function QaRunCard({ run }: { run: QaRunPanel }) {
  const { data: job } = useAgentJob(run.qaJobId ?? null);
  const { events } = useAgentEvents(run.qaJobId ?? null, job?.status);
  const [logOpen, setLogOpen] = useState(false);

  const vars = job?.variables ?? {};
  const running = job?.status === 'PENDING' || job?.status === 'RUNNING';
  const statusColor = jobStatusColor(job?.status);
  const wallclock = Number(vars.WALLCLOCK_SEC) || null;
  const cost = Number(vars.COST_USD) || null;
  const totalPass = vars.TOTAL_PASS;
  const totalFail = vars.TOTAL_FAIL;
  const overviewUrl = vars.OVERVIEW_URL;
  const screenshotCount = (vars.SCREENSHOTS?.match(/https?:\/\//g) ?? []).length;

  return (
    <section
      aria-label="QA run"
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 180 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' }}>
            Visual QA run
            {running && (
              <Loader2
                size={12}
                className="animate-spin"
                style={{ marginLeft: 8, color: 'var(--accent-purple)', verticalAlign: -1 }}
              />
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 1 }}>
            {run.scope === 'plan'
              ? `Whole plan · ${run.epicLabels.join(', ')}`
              : `Epic ${run.epicLabels.join(', ')}`}
          </div>
        </div>

        <StatusPill status={job?.status ?? 'PENDING'} color={statusColor} />

        <div
          style={{
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-dim)',
            alignItems: 'center',
          }}
        >
          {totalPass != null && totalFail != null && (
            <span>
              <span style={{ color: 'var(--success)' }}>{totalPass} pass</span>
              {' · '}
              <span
                style={{ color: Number(totalFail) > 0 ? 'var(--destructive)' : 'var(--text-dim)' }}
              >
                {totalFail} fail
              </span>
            </span>
          )}
          {wallclock != null && <span>{fmtDuration(wallclock)}</span>}
          {cost != null && <span>${cost.toFixed(2)}</span>}
          {screenshotCount > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Camera size={11} />
              {screenshotCount} screenshots
            </span>
          )}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {overviewUrl && (
            <a
              href={overviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 10px',
                borderRadius: 5,
                border: '1px solid var(--border-2)',
                color: 'var(--text-dim)',
                fontSize: 11,
                textDecoration: 'none',
              }}
            >
              Full app screenshot
              <ExternalLink size={10} />
            </a>
          )}
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            aria-expanded={logOpen}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 5,
              border: '1px solid var(--border-2)',
              background: 'transparent',
              color: 'var(--text-dim)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {logOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Technical log
          </button>
        </div>
      </div>

      {job?.errorMessage && (
        <div
          style={{
            padding: '9px 18px',
            borderTop: '1px solid var(--destructive)',
            background: 'color-mix(in srgb, var(--destructive) 8%, transparent)',
            color: 'var(--destructive)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
          }}
        >
          {job.errorMessage}
        </div>
      )}

      {logOpen && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 14px 0' }}>
            <CopyLogButton events={events} label="Copy logs" />
          </div>
          {events.length === 0 ? (
            <div
              style={{ padding: 16, color: 'var(--text-mute)', fontSize: 12, textAlign: 'center' }}
            >
              {running ? 'Waiting for the daemon to stream events…' : 'No events recorded.'}
            </div>
          ) : (
            <div
              style={{
                maxHeight: 340,
                overflow: 'auto',
                background: 'var(--background)',
                padding: '6px 0',
                margin: '6px 0 0',
              }}
            >
              {events.map((ev) => (
                <EventRow key={`${ev.jobId}-${ev.eventSeq}`} event={ev} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── Bits ────────────────────────────────────────────────────────────

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
        borderRadius: 3,
        border: `1px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color,
        letterSpacing: '0.16em',
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
        style={{ color: 'var(--text-faint)', width: 56, flexShrink: 0, letterSpacing: '0.04em' }}
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
        style={{ color: 'var(--text-faint)', width: 70, flexShrink: 0, fontSize: 9, paddingTop: 1 }}
      >
        {event.stepId}
      </span>
      <span style={{ flex: 1, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        {summarizeEvent(event)}
      </span>
    </div>
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
