'use client';

import { useEffect, useState } from 'react';
import type { PlanWithEpics } from '@/hooks/use-plans';
import { useAgentJobs } from '@/hooks/use-agent-job';
import { formatDuration } from '@/lib/format-duration';

/**
 * Concept v2 — timing intelligence for the Concept stage (the analog of the
 * Developing stage's TimingPanel). Shows, per specialized agent, how long it
 * took and what it cost, plus stage totals — so a slow run (e.g. the architect
 * taking minutes) is legible at a glance instead of feeling "stuck".
 *
 * Sourced from each concept job's createdAt/updatedAt/totalCost (no new
 * instrumentation). For a still-RUNNING agent we show live elapsed (now −
 * createdAt) since the daemon doesn't heartbeat updatedAt mid-run.
 */
const AGENTS: Array<{
  kind: string;
  name: string;
  role: string;
  icon: string;
  fk: (p: PlanWithEpics) => string | undefined;
}> = [
  { kind: 'route', name: 'Mary', role: 'Analyst', icon: '📊', fk: (p) => p.conceptRouteJobId },
  {
    kind: 'prd',
    name: 'John',
    role: 'Product Manager',
    icon: '📋',
    fk: (p) => p.conceptArtifactJobIds?.prd,
  },
  {
    kind: 'ux',
    name: 'Sally',
    role: 'UX Expert',
    icon: '🎨',
    fk: (p) => p.conceptArtifactJobIds?.ux,
  },
  {
    kind: 'architecture',
    name: 'Winston',
    role: 'Architect',
    icon: '🏗️',
    fk: (p) => p.conceptArtifactJobIds?.architecture,
  },
  {
    kind: 'plan',
    name: 'Plan',
    role: 'epics → waves',
    icon: '📐',
    fk: (p) => p.conceptPmPlanJobId,
  },
];

export function ConceptTimingPanel({ plan }: { plan: PlanWithEpics }) {
  const [open, setOpen] = useState(false);
  const rows = AGENTS.map((a) => ({ ...a, jobId: a.fk(plan) })).filter((a) => a.jobId) as Array<{
    kind: string;
    name: string;
    role: string;
    icon: string;
    jobId: string;
  }>;
  const jobIds = rows.map((r) => r.jobId);
  const queries = useAgentJobs(jobIds, true);
  // Live-ticking clock so a RUNNING agent's elapsed updates each second (the
  // daemon doesn't heartbeat updatedAt mid-run). Kept in state to stay render-pure.
  const anyRunning = queries.some((q) => {
    const s = q?.data?.status;
    return !!s && s !== 'COMPLETED' && s !== 'FAILED';
  });
  const [now, setNow] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  if (rows.length === 0) return null;

  const items = rows.map((r, i) => {
    const job = queries[i]?.data;
    const start = job?.createdAt ? Date.parse(job.createdAt) : null;
    const terminal = job?.status === 'COMPLETED' || job?.status === 'FAILED';
    const end = terminal && job?.updatedAt ? Date.parse(job.updatedAt) : now;
    const durationMs = start ? Math.max(0, end - start) : null;
    return {
      ...r,
      status: job?.status ?? 'PENDING',
      running: !terminal,
      durationMs,
      cost: job?.totalCost ?? 0,
    };
  });
  const totalCost = items.reduce((s, it) => s + (it.cost || 0), 0);
  const longest = items.reduce((m, it) => Math.max(m, it.durationMs ?? 0), 0);

  return (
    <section
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 16,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
          }}
        >
          Concept timing
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {items.filter((i) => !i.running).length}/{items.length} done
          {longest > 0 && <> · slowest {formatDuration(longest)}</>}
          {totalCost > 0 && <> · ${totalCost.toFixed(3)}</>}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
          }}
        >
          {open ? '▾ HIDE' : '▸ SHOW'}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
          {items.map((it) => (
            <div
              key={it.kind}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 16px',
                fontSize: 12,
              }}
            >
              <span style={{ fontSize: 14, width: 18 }}>{it.icon}</span>
              <span style={{ fontWeight: 600, minWidth: 64 }}>{it.name}</span>
              <span style={{ color: 'var(--text-mute)', flex: 1, minWidth: 0 }}>{it.role}</span>
              {/* duration bar */}
              <div
                style={{
                  flex: 2,
                  height: 6,
                  background: 'var(--border)',
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width:
                      longest > 0 ? `${Math.round(((it.durationMs ?? 0) / longest) * 100)}%` : '0%',
                    height: '100%',
                    background: it.running ? 'var(--accent-purple)' : 'var(--accent-blue)',
                    opacity: it.running ? 0.7 : 1,
                  }}
                />
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  minWidth: 64,
                  textAlign: 'right',
                }}
              >
                {it.durationMs != null ? formatDuration(it.durationMs) : '—'}
                {it.running && ' …'}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--text-faint)',
                  minWidth: 56,
                  textAlign: 'right',
                }}
              >
                {it.cost > 0 ? `$${it.cost.toFixed(3)}` : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
