'use client';

/**
 * Live log for a refactor-audit job — streams the daemon's `assess.*` events
 * (recon stdout/stderr per stage + terminal completed/failed) and any L3 agent
 * events, like the Labs story log. Has a copy-logs button for auditing, and
 * surfaces the job status + errorMessage prominently (so an expired-OAuth /
 * daemon-gated / recon failure is visible, not a silent "Running…" forever).
 */

import { useMemo, useState } from 'react';
import { useAgentEvents } from '@/hooks/use-agent-events';
import type { AgentEvent, AgentJob } from '@/types/agent-orchestrator';

// assess.* events spread extra fields the AgentEvent type doesn't declare.
type AssessEvent = AgentEvent & {
  step?: string;
  stream?: 'stdout' | 'stderr';
  data?: string;
  reason?: string;
  message?: string;
  hotspotCount?: number;
  projectId?: string;
  confirmed?: number;
  rejected?: number;
  gateViolations?: number;
  hasPlan?: boolean;
};

interface Line {
  ts: string;
  text: string;
  tone: 'dim' | 'fg' | 'err' | 'ok' | 'mono';
}

/** Render one event into a log line (or null to skip). Pure. */
export function lineForEvent(e: AssessEvent): Line | null {
  const ts = (e.timestamp || '').slice(11, 19);
  const t = String(e.eventType);
  switch (t) {
    case 'assess.started':
      return {
        ts,
        text: `▶ assessment started${e.projectId ? ` — ${e.projectId}` : ''}`,
        tone: 'fg',
      };
    case 'assess.step.started':
      return { ts, text: `▶ ${e.step}`, tone: 'fg' };
    case 'assess.step.output': {
      const body = (e.data || '').replace(/\n+$/, '');
      if (!body) return null;
      return { ts, text: body, tone: e.stream === 'stderr' ? 'err' : 'mono' };
    }
    case 'assess.completed':
      return { ts, text: `✓ completed — ${e.hotspotCount ?? 0} hotspots`, tone: 'ok' };
    case 'assess.failed':
      return { ts, text: `✗ FAILED [${e.reason || 'error'}] ${e.message || ''}`, tone: 'err' };
    case 'assess.l3.started':
      return {
        ts,
        text: `▶ L3 adjudication started (${e.hotspotCount ?? 0} hotspots)`,
        tone: 'fg',
      };
    case 'assess.l3.completed':
      return {
        ts,
        text: `✓ L3 — ${e.confirmed ?? 0} confirmed, ${e.rejected ?? 0} rejected${e.gateViolations ? ` · ${e.gateViolations} gate-violations` : ''}`,
        tone: 'ok',
      };
    case 'assess.l3.failed':
      return { ts, text: `✗ L3 FAILED — ${e.message || ''}`, tone: 'err' };
    // L3 agent events (spawnGateAgent), if present
    case 'tool_use':
      return {
        ts,
        text: `  · ${e.toolName || 'tool'} ${e.toolInput ? `(${String(e.toolInput).slice(0, 80)})` : ''}`,
        tone: 'dim',
      };
    case 'text_delta':
      return e.text ? { ts, text: e.text, tone: 'dim' } : null;
    case 'result':
      return e.text ? { ts, text: e.text, tone: 'dim' } : null;
    default:
      return null;
  }
}

const TONE: Record<Line['tone'], string> = {
  dim: 'var(--text-faint)',
  fg: 'var(--foreground)',
  err: 'var(--destructive)',
  ok: 'var(--success)',
  mono: 'var(--text-dim)',
};

export function AssessLiveLog({ jobId, job }: { jobId: string; job?: AgentJob }) {
  const { events } = useAgentEvents(jobId, job?.status);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(
    () => (events as AssessEvent[]).map(lineForEvent).filter((l): l is Line => l != null),
    [events],
  );

  const status = job?.status;
  const errorMessage = job?.errorMessage;
  const running = !status || status === 'PENDING' || status === 'RUNNING';

  const copyText = useMemo(
    () =>
      [
        `# Refactor-audit log — job ${jobId}${status ? ` (${status})` : ''}`,
        ...lines.map((l) => `${l.ts ? `[${l.ts}] ` : ''}${l.text}`),
        errorMessage ? `\nerrorMessage: ${errorMessage}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    [lines, jobId, status, errorMessage],
  );

  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div data-testid="assess-live-log" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {running ? 'Running recon on the EC2 clone…' : `Assessment ${status}`}
          {running && <span className="ml-1 animate-pulse">●</span>}
          <span style={{ color: 'var(--text-faint)' }}> · {lines.length} log lines</span>
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={copy}
          disabled={lines.length === 0}
          data-testid="assess-copy-logs"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding: '4px 9px',
            borderRadius: 4,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: copied ? 'var(--success)' : 'var(--text-dim)',
            cursor: lines.length === 0 ? 'not-allowed' : 'pointer',
            opacity: lines.length === 0 ? 0.5 : 1,
          }}
        >
          {copied ? 'Copied!' : 'Copy logs'}
        </button>
      </div>

      {errorMessage && (
        <div
          style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--destructive)',
            border: '1px solid color-mix(in srgb, var(--destructive) 30%, transparent)',
            borderRadius: 6,
            padding: '6px 10px',
          }}
        >
          {errorMessage}
        </div>
      )}

      <pre
        style={{
          margin: 0,
          maxHeight: 420,
          overflow: 'auto',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 12,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {lines.length === 0 ? (
          <span style={{ color: 'var(--text-faint)' }}>
            {running
              ? 'Waiting for the daemon to emit recon output… (if this stays empty, the daemon may be paused or auth-gated — check the daemon status above).'
              : 'No log output for this assessment.'}
          </span>
        ) : (
          lines.map((l, i) => (
            <div key={i} style={{ color: TONE[l.tone] }}>
              {l.ts && <span style={{ color: 'var(--text-faint)' }}>{l.ts} </span>}
              {l.text}
            </div>
          ))
        )}
      </pre>
    </div>
  );
}
