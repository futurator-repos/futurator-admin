/**
 * EO-7.3 — orchestrator metrics aggregator.
 *
 * Pure function: takes a raw event stream and returns the dashboard's shape.
 * No DDB calls, no IO — the HTTP handler is responsible for pulling events
 * out of `futurator-agent-events` and handing them to this aggregator.
 */

import type { AgentEvent } from '../types/agent-orchestrator';

export type ModelTier = 'opus' | 'sonnet' | 'haiku' | 'unknown';

export interface MetricsFilter {
  /** Inclusive lower bound as epoch ms. `undefined` = no lower bound. */
  from?: number;
  /** Exclusive upper bound as epoch ms. `undefined` = no upper bound. */
  to?: number;
  /** Project filter (matches `event.projectId`). */
  projectId?: string;
}

export interface WallClockStats {
  count: number;
  medianMs: number;
  p95Ms: number;
}

export interface OrchestratorMetrics {
  sampleSize: number;
  epic: WallClockStats;
  story: WallClockStats;
  tokenSpend: Record<ModelTier, number>;
  remediation: {
    epicsWithRemediations: number;
    epicsTotal: number;
    rate: number; // 0..1 — fraction of epics that saw ≥1 remediation
  };
  blockerTaxonomy: Record<string, number>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseTs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : undefined;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function stats(durations: number[]): WallClockStats {
  if (durations.length === 0) return { count: 0, medianMs: 0, p95Ms: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
  };
}

function classifyModel(model: string | undefined): ModelTier {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'unknown';
}

function inRange(event: AgentEvent, filter: MetricsFilter): boolean {
  const t = parseTs(event.timestamp);
  if (t === undefined) return false;
  if (filter.from !== undefined && t < filter.from) return false;
  if (filter.to !== undefined && t >= filter.to) return false;
  if (filter.projectId && event.projectId !== filter.projectId) return false;
  return true;
}

// ── Aggregator ────────────────────────────────────────────────────────────

export function aggregateOrchestratorMetrics(
  events: AgentEvent[],
  filter: MetricsFilter = {},
): OrchestratorMetrics {
  const scoped = events.filter((e) => inRange(e, filter));

  // Epic wall-clock: pair epic_start with epic_complete / epic_failed per jobId.
  const epicStartByJob = new Map<string, number>();
  const epicDurations: number[] = [];
  const epicsWithRemediation = new Set<string>();
  const epicJobs = new Set<string>();

  // Story wall-clock: pair subagent_dispatch (role=dev) with subagent_return
  // keyed by (jobId, subagentId). Reviewer dispatches are excluded — they
  // track review turnaround, not story wall-clock.
  const devDispatchByKey = new Map<string, number>();
  const storyDurations: number[] = [];

  const tokenSpend: Record<ModelTier, number> = {
    opus: 0,
    sonnet: 0,
    haiku: 0,
    unknown: 0,
  };

  const blockerTaxonomy: Record<string, number> = {};

  for (const event of scoped) {
    const t = parseTs(event.timestamp) ?? 0;

    switch (event.eventType) {
      case 'epic_start': {
        epicStartByJob.set(event.jobId, t);
        epicJobs.add(event.jobId);
        break;
      }
      case 'epic_complete':
      case 'epic_failed': {
        const start = epicStartByJob.get(event.jobId);
        if (start !== undefined) {
          epicDurations.push(Math.max(0, t - start));
          epicStartByJob.delete(event.jobId);
        }
        epicJobs.add(event.jobId);
        break;
      }
      case 'subagent_dispatch': {
        if (event.role === 'dev' && event.subagentId) {
          devDispatchByKey.set(`${event.jobId}:${event.subagentId}`, t);
        }
        break;
      }
      case 'subagent_return': {
        if (event.role === 'dev' && event.subagentId) {
          const key = `${event.jobId}:${event.subagentId}`;
          const start = devDispatchByKey.get(key);
          if (start !== undefined) {
            storyDurations.push(Math.max(0, t - start));
            devDispatchByKey.delete(key);
          }
        }
        break;
      }
      case 'remediation_start': {
        epicsWithRemediation.add(event.jobId);
        break;
      }
      case 'story_blocked':
      case 'dev_blocker_reported': {
        const code = (typeof event.payload?.code === 'string' && event.payload.code) || 'unknown';
        blockerTaxonomy[code] = (blockerTaxonomy[code] ?? 0) + 1;
        break;
      }
      case 'result':
      case 'step_complete': {
        if (typeof event.cost === 'number' && event.cost > 0) {
          const tier = classifyModel(
            typeof event.payload?.model === 'string' ? (event.payload.model as string) : undefined,
          );
          tokenSpend[tier] += event.cost;
        }
        break;
      }
    }
  }

  return {
    sampleSize: scoped.length,
    epic: stats(epicDurations),
    story: stats(storyDurations),
    tokenSpend,
    remediation: {
      epicsWithRemediations: epicsWithRemediation.size,
      epicsTotal: epicJobs.size,
      rate: epicJobs.size === 0 ? 0 : epicsWithRemediation.size / epicJobs.size,
    },
    blockerTaxonomy,
  };
}
