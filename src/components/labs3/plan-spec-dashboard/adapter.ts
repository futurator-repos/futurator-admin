/**
 * Labs3 adapter — maps the pipeline-3 StoryNode graph (flat StoryNodeRow[])
 * onto the shapes the dashboard + views consume.
 *
 * Pure — no React, no network — so it's trivially unit-testable, exactly like
 * the legacy adapter.
 *
 * Unlike legacy (Plan → Epic → Wave → Story, with synthesized timings), the
 * SDD model is a flat list of StoryNodes carrying their own topology
 * (cohortBatch = topological level) and dependency edges (depends_on). This
 * adapter groups them two ways — by topological batch (the pipeline strip /
 * dependency-graph x-axis) and by epic cohort (the Stories hierarchy) — and
 * rolls up state counts + completion.
 *
 * The pure formatters (fmtSec/fmtCost/fmtTokens/fmtClock) and the job metric
 * helpers (jobCost/jobTokens/jobElapsedSec) are exported from here so the B3–B7
 * views NEVER import from the legacy labs adapter — Labs3 is a clean sibling.
 */

import type { StoryNodeRow, StoryNodeState } from '@/types/plan-spec';
import type { AgentJob } from '@/types/agent-orchestrator';

// Re-export the pure formatters from the legacy adapter so Labs3 views have a
// single import surface and never reach into the legacy module directly.
export { fmtSec, fmtCost, fmtTokens, fmtClock } from '@/components/labs/plan-dashboard/adapter';

// Re-export the uniform view-props contract (canonically defined in constants
// so it stays free of model-building code) for callers importing from adapter.
export type { Labs3ViewProps } from './constants';

// ── Story graph model ────────────────────────────────────────────────

export interface StoryBatchGroup {
  cohortBatch: number;
  stories: StoryNodeRow[];
}

export interface StoryEpicGroup {
  epicId: string;
  epicTitle: string;
  stories: StoryNodeRow[];
}

export interface StoryGraphModel {
  /** Stories grouped by topological level, ascending. */
  byBatch: StoryBatchGroup[];
  /** Stories grouped by epic cohort, in first-seen order. */
  byEpic: StoryEpicGroup[];
  /** Count of stories in each state (every state key present, zero-filled). */
  stateCounts: Record<StoryNodeState, number>;
  /** The ready-frontier: stories whose depends_on are all satisfied. */
  frontier: StoryNodeRow[];
  total: number;
  done: number;
  /** 0–100, rounded. */
  pct: number;
  // ── Time intelligence (rolled up from the per-story write-back) ──────────
  /** Σ costUsd across stories that have run. */
  costUsd: number;
  /** Σ durationMs (agent wall-clock) across stories that have run. */
  durationMs: number;
  /** Σ input + output tokens across stories that have run. */
  tokens: number;
  /** The single slowest story's durationMs (the timing tail). */
  slowestMs: number;
}

const ALL_STATES: StoryNodeState[] = [
  'blocked',
  'ready',
  'claimed',
  'developing',
  'merging',
  'verifying',
  'done',
  'failed',
];

function emptyStateCounts(): Record<StoryNodeState, number> {
  return ALL_STATES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<StoryNodeState, number>,
  );
}

/**
 * Build the grouped + rolled-up model from a flat StoryNodeRow snapshot.
 * Stable ordering: batches ascending by cohortBatch; epics in first-seen
 * order; stories within a group keep their incoming array order.
 */
export function buildStoryGraphModel(rows: StoryNodeRow[]): StoryGraphModel {
  const batchMap = new Map<number, StoryNodeRow[]>();
  const epicMap = new Map<string, StoryEpicGroup>();
  const stateCounts = emptyStateCounts();
  let done = 0;

  for (const row of rows) {
    // by batch
    const batch = row.cohortBatch ?? 0;
    if (!batchMap.has(batch)) batchMap.set(batch, []);
    batchMap.get(batch)!.push(row);

    // by epic
    const epicId = row.cohort?.epicId ?? '—';
    let group = epicMap.get(epicId);
    if (!group) {
      group = {
        epicId,
        epicTitle: row.cohort?.epicTitle ?? epicId,
        stories: [],
      };
      epicMap.set(epicId, group);
    }
    group.stories.push(row);

    // state counts
    if (stateCounts[row.state] !== undefined) stateCounts[row.state] += 1;
    if (row.state === 'done') done += 1;
  }

  const byBatch: StoryBatchGroup[] = [...batchMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cohortBatch, stories]) => ({ cohortBatch, stories }));

  const byEpic: StoryEpicGroup[] = [...epicMap.values()];

  const total = rows.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const frontier = rows.filter((r) => r.state === 'ready');

  const costUsd = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const durationMs = rows.reduce((a, r) => a + (r.durationMs ?? 0), 0);
  const tokens = rows.reduce((a, r) => a + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0);
  const slowestMs = rows.reduce((a, r) => Math.max(a, r.durationMs ?? 0), 0);

  return {
    byBatch,
    byEpic,
    stateCounts,
    frontier,
    total,
    done,
    pct,
    costUsd,
    durationMs,
    tokens,
    slowestMs,
  };
}

/** Job ids for every story that has been dispatched (story-dev AgentJobs). */
export function storyJobIds(rows: StoryNodeRow[]): string[] {
  return rows.filter((r) => r.jobId).map((r) => r.jobId!);
}

// ── Job metric helpers ───────────────────────────────────────────────
//
// Labs3 stories bind directly to a single story-dev AgentJob (no wave/epic
// rollup), so these are simpler than the legacy versions and key off the job's
// own status rather than a synthesized StoryStatus.

const TERMINAL_JOB_STATUSES: ReadonlySet<AgentJob['status']> = new Set<AgentJob['status']>([
  'COMPLETED',
  'FAILED',
  'COMPLETE_WITH_BLOCKED_STORIES',
  'STALE',
  'COMPLETED_VIA_SALVAGE',
  'COMPLETED_VIA_TALK',
  'MANUALLY_SKIPPED',
]);

export function jobCost(job: AgentJob | undefined): number {
  if (!job) return 0;
  if (typeof job.totalCost === 'number') return job.totalCost;
  return (job.stepResults ?? []).reduce((a, s) => a + (s.cost ?? 0), 0);
}

export function jobTokens(job: AgentJob | undefined): number {
  if (!job) return 0;
  return (job.stepResults ?? []).reduce(
    (a, s) => a + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
    0,
  );
}

/**
 * Elapsed seconds for a story-dev job:
 *   - terminal status → real duration (updatedAt − createdAt)
 *   - running         → live elapsed (now − createdAt)
 *   - else            → null
 */
export function jobElapsedSec(
  job: AgentJob | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!job) return null;
  const createdMs = Date.parse(job.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    const endMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(endMs)) return null;
    return Math.max(0, (endMs - createdMs) / 1000);
  }
  if (job.status === 'RUNNING') {
    return Math.max(0, (nowMs - createdMs) / 1000);
  }
  return null;
}
