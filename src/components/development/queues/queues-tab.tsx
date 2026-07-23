'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useQueueRequests } from '@/hooks/use-queue-requests';
import { useAgentJobs } from '@/hooks/use-agent-job';
import { useServers, deriveFleetCapacity } from '@/hooks/use-servers';
import { deriveServerState } from '@/lib/server-state';
import { api } from '@/lib/api-client';
import type { QueueRequest } from '@/types/queue';
import type { StoryNodeRow } from '@/types/plan-spec';
import type { AgentJob } from '@/types/agent-orchestrator';
import { QueueDetail, StatusBadge } from './queue-detail';

/**
 * A4 — the dispatch/frontier path (A1) links its audit row to a plan/run
 * (`kind:'dispatch'`, `planId`/`runId`), not directly to a job; those fields
 * already flow from the backend (functions/shared/types/queue-request.ts) but
 * the narrow frontend `QueueRequest` type hasn't caught up yet. Widen locally
 * rather than touch the shared type file — out of this fix's scope.
 */
type LinkedQueueRequest = QueueRequest & {
  kind?: 'ingest' | 'dispatch';
  runId?: string;
  planId?: string;
  dispatchStage?: string;
};

/**
 * A5 — the fleet model (`futurator-servers` / `useServers()` /
 * `deriveServerState`) is the single source of truth for "which server is
 * executing right now". The legacy singleton `DAEMON_HEARTBEAT` read
 * (`useEc2Status`) is deliberately NOT used here: fleet daemons are forbidden
 * to write that row, so it reported "local · offline" while a GCP box ran the
 * work. Slots + the active-server list are now derived live from the server
 * rows, provider-agnostically — no provider is hardcoded, and a dormant AWS row
 * simply isn't heartbeating so it drops out of "live" on its own.
 */
function CapStrip() {
  const { data: serversData } = useServers();
  // A ticking clock (pure read in render) so heartbeat freshness re-evaluates
  // every 5s — calling Date.now() directly in render is an impurity.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const fleet = deriveFleetCapacity(serversData?.servers ?? [], now);
  const { activeCount: active, maxConcurrent: max, saturated, live } = fleet;
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <span className="text-[10px] uppercase text-muted-foreground">Shared slots</span>
      <div className="h-2 w-32 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full transition-all ${saturated ? 'bg-red-500' : 'bg-green-500'}`}
          style={{ width: `${max > 0 ? (active / Math.max(max, 1)) * 100 : 0}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums">
        {active} / {max}
      </span>
      {saturated && <span className="text-[10px] text-amber-400">at cap — new calls queue</span>}
      <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
        {live.length === 0 ? (
          <span>no live server</span>
        ) : (
          live.map((s) => {
            const st = deriveServerState(s, now);
            return (
              <span key={s.serverId} title={st.help} className="flex items-center gap-1">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    st.tone === 'success'
                      ? 'bg-green-500'
                      : st.tone === 'destructive'
                        ? 'bg-red-500'
                        : 'bg-amber-400'
                  }`}
                />
                <span className="lowercase">{s.provider}</span>
                <span className="font-mono normal-case">{s.name}</span>
              </span>
            );
          })
        )}
      </span>
    </div>
  );
}

function relTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

/**
 * Resolve one representative jobId per plan for rows that carry a `planId`
 * but no `jobId` of their own (the dispatch/frontier path — A1 links plan/run,
 * not job). Every job of a plan shares the same `assignedServerId` once
 * affinity locks in (`planAffinityStamp`, daemon/lib/plan-affinity.mjs pins
 * every job of a plan to one server), so any of the plan's story jobs tells
 * us the executing server. Picks the most-recently-updated story that has a
 * jobId. App-agnostic: keys only on planId/updatedAt/jobId presence, never on
 * story content.
 */
function useJobIdsByPlan(planIds: string[]) {
  const results = useQueries({
    queries: planIds.map((planId) => ({
      queryKey: ['story-nodes', planId],
      queryFn: () =>
        api.get<{ stories: StoryNodeRow[] }>(`/plans/${planId}/story-nodes`).then((d) => d.stories),
      enabled: !!planId,
      staleTime: 5_000,
    })),
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    planIds.forEach((planId, i) => {
      const stories = results[i]?.data;
      const withJob = (stories ?? []).filter((s): s is StoryNodeRow & { jobId: string } =>
        Boolean(s.jobId),
      );
      if (withJob.length === 0) return;
      const latest = withJob.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
      map.set(planId, latest.jobId);
    });
    return map;
    // `results` (useQueries) gets a fresh array identity whenever any query's
    // data/status changes, so depending on it directly keeps this live as
    // stories get jobIds assigned — the recompute itself is a cheap filter+reduce
    // over a small row set.
  }, [planIds, results]);
}

/** Requested (declared intent) vs executed-on (resolved, real machine). Never
 * a hardcoded provider — unknown resolves to the raw serverId, or "—" when
 * nothing is resolvable yet. */
function executedOnLabel(
  jobId: string | undefined,
  jobByJobId: Map<string, AgentJob>,
  serverNameById: Map<string, string>,
): { label: string; title?: string } {
  if (!jobId) return { label: '—' };
  const job = jobByJobId.get(jobId);
  const serverId = job?.assignedServerId;
  if (!serverId) return { label: '—' };
  return { label: serverNameById.get(serverId) ?? serverId, title: job?.assignReason };
}

export function QueuesTab() {
  const { data } = useQueueRequests();
  const [selected, setSelected] = useState<string | null>(null);
  const requests: LinkedQueueRequest[] = useMemo(() => data?.requests ?? [], [data]);

  // Dispatch-kind rows with a planId but no jobId of their own — look up a
  // representative job via their plan's story nodes.
  const planIdsNeedingLookup = useMemo(
    () =>
      Array.from(
        new Set(
          requests
            .filter((r) => !r.jobId && r.planId)
            .map((r) => r.planId)
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [requests],
  );
  const jobIdsByPlan = useJobIdsByPlan(planIdsNeedingLookup);

  // Every row's resolved jobId: its own, else its plan's representative job.
  const resolvedJobIdByRequestId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of requests) {
      const jobId = r.jobId ?? (r.planId ? jobIdsByPlan.get(r.planId) : undefined);
      if (jobId) map.set(r.requestId, jobId);
    }
    return map;
  }, [requests, jobIdsByPlan]);

  const uniqueJobIds = useMemo(
    () => Array.from(new Set(resolvedJobIdByRequestId.values())),
    [resolvedJobIdByRequestId],
  );
  const jobResults = useAgentJobs(uniqueJobIds, true);
  const jobByJobId = useMemo(() => {
    const map = new Map<string, AgentJob>();
    uniqueJobIds.forEach((jobId, i) => {
      const job = jobResults[i]?.data;
      if (job) map.set(jobId, job);
    });
    return map;
  }, [uniqueJobIds, jobResults]);

  // Same serverId → name join queue-detail.tsx already does.
  const { data: serversData } = useServers();
  const serverNameById = useMemo(
    () => new Map((serversData?.servers ?? []).map((s) => [s.serverId, s.name] as const)),
    [serversData],
  );

  return (
    <div className="space-y-3">
      <CapStrip />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Request list */}
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Status</th>
                <th className="px-2 py-1.5 text-left font-medium">Source</th>
                <th className="px-2 py-1.5 text-left font-medium">Requested</th>
                <th className="px-2 py-1.5 text-left font-medium">Executed on</th>
                <th className="px-2 py-1.5 text-left font-medium">Machine</th>
                <th className="px-2 py-1.5 text-left font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground italic">
                    No requests yet. Fire one from the Tests tab or POST to /api/queue/ingest.
                  </td>
                </tr>
              ) : (
                requests.map((r) => {
                  const executed = executedOnLabel(
                    resolvedJobIdByRequestId.get(r.requestId),
                    jobByJobId,
                    serverNameById,
                  );
                  return (
                    <tr
                      key={r.requestId}
                      onClick={() => setSelected(r.requestId)}
                      className={`cursor-pointer border-t border-border hover:bg-accent/50 ${
                        selected === r.requestId ? 'bg-accent' : ''
                      }`}
                    >
                      <td className="px-2 py-1.5">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-2 py-1.5">{r.source}</td>
                      <td className="px-2 py-1.5 uppercase text-[10px] text-muted-foreground">
                        {r.target ?? '—'}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[10px]" title={executed.title}>
                        {executed.label}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                        {r.response?.dispatcher?.host ?? '—'}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                        {relTime(r.createdAt)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Detail */}
        <div>
          {selected ? (
            <QueueDetail requestId={selected} />
          ) : (
            <div className="rounded-md border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
              Select a request to inspect its call details and live terminal.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
