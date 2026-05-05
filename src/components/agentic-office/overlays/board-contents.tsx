'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { useEc2Status } from '@/hooks/use-ec2-daemon';
import type { PlanSummary } from '@/types/plan';
import { paletteForPlanId } from '../plan-palette';

// ── Modal content — EC2 Monitor ────────────────────────────────────────
// Lightweight summary pulled from the same hook the full
// `/development/monitor` page uses. Includes a "view full" deep-link so
// users can jump to the dedicated page without re-renders inside an iframe.

export function EC2BoardContent() {
  const { data: status, isLoading: statusLoading } = useEc2Status(true);

  const daemonRunning = status?.state === 'running';
  const daemonAlive = status?.daemonAlive === true;
  const authValid = status?.auth?.valid === true;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <StatTile
          label="Instance"
          value={
            statusLoading
              ? '…'
              : daemonRunning
                ? 'running'
                : (status?.state ?? 'unknown')
          }
          tone={daemonRunning ? 'ok' : 'warn'}
        />
        <StatTile
          label="Daemon"
          value={daemonAlive ? 'alive' : 'silent'}
          tone={daemonAlive ? 'ok' : 'warn'}
        />
        <StatTile
          label="Auth"
          value={authValid ? 'ok' : status?.auth?.valid === false ? 'expired' : '…'}
          tone={authValid ? 'ok' : status?.auth?.valid === false ? 'warn' : 'dim'}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 text-[11px] text-white/60">
        <div>
          Instance: <code className="text-white/80">{status?.instanceId ?? '—'}</code>
        </div>
        <div>
          Active: <span className="text-white/80">
            {status ? `${status.activeCount}/${status.maxConcurrent}` : '—'}
          </span>
        </div>
      </div>
      {status && status.processes.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-white/40">
            Running jobs
          </div>
          <ul className="space-y-1 text-[11px] text-white/80">
            {status.processes.slice(0, 6).map((p) => (
              <li
                key={p.jobId}
                className="flex items-center gap-2 rounded border border-border/40 bg-white/5 px-2 py-1"
              >
                <code className="truncate text-white/70">{p.jobId.slice(0, 10)}</code>
                <span className="text-white/50">·</span>
                <span className="truncate">
                  {p.agentId ?? 'shell'} / {p.stepId ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end">
        <Link
          href="/development/monitor"
          className="rounded border border-border/60 bg-black/40 px-3 py-1 text-[11px] text-white/80 hover:border-border hover:text-white"
        >
          View full monitor →
        </Link>
      </div>
    </div>
  );
}

// ── Modal content — Gantt preview ──────────────────────────────────────
// Wave summary across currently-active plans. Per-plan color bar + story
// counts. A deep-link per plan jumps straight into its plan-dashboard
// Gantt view, which is the full-fidelity render.

export function GanttBoardContent({
  waves,
  planIds,
  plansById,
}: {
  waves: { planId: string; wave: number; count: number; doneCount: number }[];
  planIds: readonly string[];
  plansById: Map<string, PlanSummary>;
}) {
  const byPlan = useMemo(() => {
    const m = new Map<string, typeof waves>();
    for (const w of waves) {
      const list = m.get(w.planId) ?? [];
      list.push(w);
      m.set(w.planId, list);
    }
    for (const [, list] of m) list.sort((a, b) => a.wave - b.wave);
    return m;
  }, [waves]);

  if (planIds.length === 0) {
    return (
      <div className="py-8 text-center text-[11px] italic text-white/50">
        No active plans. Start one from the Labs page.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {planIds.map((planId) => {
        const plan = plansById.get(planId);
        const palette = paletteForPlanId(planId);
        const list = byPlan.get(planId) ?? [];
        const totalStories = list.reduce((n, w) => n + w.count, 0);
        const totalDone = list.reduce((n, w) => n + w.doneCount, 0);
        return (
          <div
            key={planId}
            className="rounded-md border border-border/40 bg-white/5 p-3"
          >
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: palette.hex }}
              />
              <span className="text-[12px] font-semibold text-white">
                {plan?.displayName ?? plan?.name ?? planId.slice(0, 8)}
              </span>
              <span className="ml-auto text-[10px] text-white/50">
                {totalDone}/{totalStories} done
              </span>
              <Link
                href={`/labs?planId=${planId}`}
                className="rounded border border-border/40 bg-black/40 px-2 py-0.5 text-[10px] text-white/80 hover:text-white"
              >
                Open →
              </Link>
            </div>
            <div className="mt-2 flex items-end gap-2">
              {list.length === 0 && (
                <span className="text-[10px] italic text-white/40">
                  no waves
                </span>
              )}
              {list.map((w) => {
                const frac = w.count > 0 ? w.doneCount / w.count : 0;
                return (
                  <div
                    key={w.wave}
                    className="flex w-10 flex-col items-center"
                    title={`W${w.wave}: ${w.doneCount}/${w.count}`}
                  >
                    <div className="h-20 w-6 overflow-hidden rounded bg-slate-800">
                      <div
                        className="w-full"
                        style={{
                          height: `${frac * 100}%`,
                          backgroundColor: palette.hex,
                          marginTop: `${(1 - frac) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 text-[9px] text-white/60">
                      W{w.wave}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Modal content — Plans list ─────────────────────────────────────────

export function PlansBoardContent({
  plans,
  storyCounts,
}: {
  plans: PlanSummary[];
  storyCounts: Map<string, { total: number; done: number }>;
}) {
  if (plans.length === 0) {
    return (
      <div className="py-8 text-center text-[11px] italic text-white/50">
        No active plans.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {plans.map((p) => {
        const palette = paletteForPlanId(p.planId);
        const counts = storyCounts.get(p.planId) ?? { total: 0, done: 0 };
        return (
          <Link
            key={p.planId}
            href={`/labs?planId=${p.planId}`}
            className="flex items-center gap-3 rounded-md border border-border/40 bg-white/5 p-2.5 hover:border-border hover:bg-white/10"
          >
            <span
              className="inline-block h-4 w-4 shrink-0 rounded"
              style={{ backgroundColor: palette.hex }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold text-white">
                {p.displayName ?? p.name}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/50">
                <span className="uppercase tracking-wide">{p.status}</span>
                <span>·</span>
                <span>
                  {counts.done}/{counts.total} stories
                </span>
              </div>
            </div>
            <span className="text-[11px] text-white/50">→</span>
          </Link>
        );
      })}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'ok' | 'warn' | 'dim';
}) {
  const toneClass =
    tone === 'ok'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'dim'
          ? 'text-white/40'
          : 'text-white/90';
  return (
    <div className="rounded-md border border-border/40 bg-white/5 p-3 text-center">
      <div className="text-[10px] uppercase tracking-wider text-white/40">
        {label}
      </div>
      <div className={`mt-1 text-[18px] font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
