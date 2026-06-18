'use client';

/**
 * Live deploy step tracker. Shows the 4 pipeline stages (build → sync →
 * invalidate → verify) with per-step status. The backend projects a single
 * deploy job onto 4 display steps; when we migrate to per-step jobs this
 * component renders finer-grained signals automatically.
 */

import { useMemo } from 'react';
import type { DeployRecord, DeployStepStatus } from '@/types/deploy-report';
import { useAgentJob } from '@/hooks/use-agent-job';
import type { AgentJob } from '@/types/agent-orchestrator';

const STATUS_META: Record<DeployStepStatus['status'], { color: string; glyph: string }> = {
  pass: { color: 'var(--success)', glyph: '✓' },
  running: { color: 'var(--accent-purple)', glyph: '●' },
  fail: { color: 'var(--destructive)', glyph: '✗' },
  pending: { color: 'var(--text-faint)', glyph: '○' },
  skipped: { color: 'var(--text-faint)', glyph: '—' },
};

/**
 * Project a raw AgentJob (the active env deploy job) onto the same 4 display
 * steps the aggregator emits for `current`. The daemon runs one shell step, so
 * we collapse status into a coarse build → sync → invalidate → verify view.
 */
function projectJobToSteps(status: AgentJob['status'] | undefined): DeployStepStatus[] {
  const ids: DeployStepStatus['id'][] = ['build', 'sync', 'invalidate', 'verify'];
  const labels: Record<DeployStepStatus['id'], string> = {
    build: 'Build',
    sync: 'Sync to bucket',
    invalidate: 'Invalidate cache',
    verify: 'Verify URL',
  };
  const stepStatus = (i: number): DeployStepStatus['status'] => {
    if (status === 'COMPLETED') return 'pass';
    if (status === 'FAILED') return i === 0 ? 'fail' : 'skipped';
    if (status === 'RUNNING') return i === 0 ? 'running' : 'pending';
    return 'pending'; // PENDING / unknown
  };
  return ids.map((id, i) => ({ id, label: labels[id], status: stepStatus(i) }));
}

export function DeploySteps({
  current,
  activeJobId,
}: {
  current: DeployRecord | null;
  activeJobId?: string | null;
}) {
  // When an env (dev/staging) deploy is active and it's NOT the production
  // `current` job, track that job instead so dev/staging deploys show a live
  // tracker rather than a frozen production-only view (A3).
  const trackingEnvJob = !!activeJobId && activeJobId !== current?.jobId;
  if (trackingEnvJob) {
    return <EnvDeploySteps jobId={activeJobId as string} />;
  }
  if (!current) {
    return (
      <div
        style={{
          padding: '24px 18px',
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          color: 'var(--text-mute)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        No deploy has run yet — use the ladder above to promote dev → staging → production.
      </div>
    );
  }
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
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
          {current.status === 'PENDING' || current.status === 'RUNNING'
            ? 'Deploy in progress'
            : 'Last deploy'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.06em',
          }}
        >
          {fmtDuration(current.durationSec)} · job {current.jobId.slice(0, 8)}
        </span>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {current.steps.map((step, i) => {
          const meta = STATUS_META[step.status];
          return (
            <li
              key={step.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 18px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}
            >
              <span
                className={step.status === 'running' ? 'animate-pulse-soft' : ''}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
                  border: `1px solid ${meta.color}`,
                  color: meta.color,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {meta.glyph}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--foreground)',
                    fontWeight: 500,
                    letterSpacing: '-0.005em',
                  }}
                >
                  {step.label}
                </div>
                {step.detail && (
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--text-mute)',
                      marginTop: 3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {step.detail}
                  </div>
                )}
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: meta.color,
                  textTransform: 'uppercase',
                  letterSpacing: '0.18em',
                  flexShrink: 0,
                }}
              >
                {step.status}
              </span>
            </li>
          );
        })}
      </ol>
      {current.status === 'FAILED' && current.errorMessage && (
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--destructive)',
            background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
            color: 'var(--destructive)',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.04em',
          }}
        >
          {current.errorMessage}
        </div>
      )}
    </div>
  );
}

/**
 * Step tracker for a non-production (dev/staging) env deploy job. Polls the
 * AgentJob and projects its coarse status onto the 4 display steps. Carries a
 * banner so the operator knows which env this tracker reflects.
 */
function EnvDeploySteps({ jobId }: { jobId: string }) {
  const { data: job } = useAgentJob(jobId);
  const steps = useMemo(() => projectJobToSteps(job?.status), [job?.status]);
  const running = job?.status === 'PENDING' || job?.status === 'RUNNING';

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
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
          {running ? 'Env deploy in progress' : 'Env deploy'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.06em',
          }}
        >
          job {jobId.slice(0, 8)}
        </span>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {steps.map((step, i) => {
          const meta = STATUS_META[step.status];
          return (
            <li
              key={step.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 18px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}
            >
              <span
                className={step.status === 'running' ? 'animate-pulse-soft' : ''}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
                  border: `1px solid ${meta.color}`,
                  color: meta.color,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {meta.glyph}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--foreground)',
                    fontWeight: 500,
                    letterSpacing: '-0.005em',
                  }}
                >
                  {step.label}
                </div>
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: meta.color,
                  textTransform: 'uppercase',
                  letterSpacing: '0.18em',
                  flexShrink: 0,
                }}
              >
                {step.status}
              </span>
            </li>
          );
        })}
      </ol>
      {job?.status === 'FAILED' && job.errorMessage && (
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--destructive)',
            background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
            color: 'var(--destructive)',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.04em',
          }}
        >
          {job.errorMessage}
        </div>
      )}
    </div>
  );
}

function fmtDuration(s: number | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}
