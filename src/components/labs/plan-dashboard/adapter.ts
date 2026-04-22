/**
 * Adapter: maps Futurator-Admin domain objects (PlanWithEpics + AgentJob)
 * onto the prototype's dashboard shape (Plan → Epic → Wave → Story).
 *
 * Pure — no React, no network — so it's trivially unit-testable.
 *
 * Design notes:
 * - Our EpicStory has no `sp` (story points) or `plannedSec`. Both are
 *   synthesized here (sp=1, plannedSec=DEFAULT_PLANNED_SEC=180). Adjust by
 *   overriding `opts.plannedSecPerStory` or passing a per-story override.
 * - `actualSec` comes from the linked AgentJob's createdAt → updatedAt span
 *   when the job is COMPLETED/FAILED. While RUNNING we expose elapsed time
 *   so the hierarchy view can show `5m 23s…`.
 * - `progress` is mapped from StoryStatus (no granular progress in our model).
 * - `cost` / `tokens` come from the job's totalCost + stepResults token sums.
 */

import type { PlanWithEpics } from '@/hooks/use-plans';
import type { AgentJob } from '@/types/agent-orchestrator';
import type { EpicStory, EpicWorkflow, StoryStatus } from '@/types/epic-workflow';

export const DEFAULT_PLANNED_SEC = 180; // 3 min per story (your decision)
export const WAVE_GAP_SEC = 2; // gap between sequential waves inside an epic
export const EPIC_GAP_SEC = 4; // gap between epics on the plan timeline

export interface DashboardStory {
  id: string; // EpicStory.storyId
  label: string; // EpicStory.title
  desc: string; // EpicStory.description
  status: StoryStatus;
  sp: number; // synthesized (default 1)
  progress: number; // 0–100, derived from status
  plannedSec: number; // synthesized (default 180)
  /**
   * Actual elapsed seconds so far:
   * - `done`/`failed` → real duration (updatedAt − createdAt)
   * - `running`/`in_review`/`fixing` → live elapsed (now − createdAt)
   * - else → null
   */
  actualSec: number | null;
  /** Wall-clock start time (ISO) when job exists; else null. */
  startedAtIso: string | null;
  /** Wall-clock finish time (ISO) when job is done; else null. */
  finishedAtIso: string | null;
  cost: number; // USD
  tokens: number;
  agent: string | null; // model name (plan/epic default)
  touchPoints: string[];
  criteria: { text: string; done: boolean }[];
  jobId: string | null;
  /** Phase D.3: retry ladder state from linked AgentJob (0 when fresh). */
  retryAttempt: number;
  /** Phase D.3: max retries configured on the daemon (currently 3). */
  maxRetries: number;
  epicId: string;
  epicLabel: string; // "E1", "E2" — 1-indexed display
  wave: number; // wave number within the epic
  waveId: string; // synthetic id — `${epicId}-W${wave}`
  waveLabel: string; // "Wave 0" / "Wave 1"
}

export interface DashboardWave {
  id: string; // `${epicId}-W${wave}`
  label: string;
  waveIndex: number;
  stories: DashboardStory[];
}

export interface DashboardEpic {
  id: string;
  epicIdRaw: string; // real EpicWorkflow.epicId
  label: string; // "E1", "E2" — 1-indexed
  title: string; // EpicWorkflow.title
  goal: string; // EpicWorkflow.description
  status: EpicWorkflow['status'];
  planWave: number; // EpicWorkflow.epicWave ?? 0
  dependsOn: string[]; // real epic ids (for deps graph)
  dependsOnLabels: string[]; // resolved display labels ("E1")
  waves: DashboardWave[];
}

export interface DashboardPlan {
  id: string;
  name: string;
  intent: string;
  path: string;
  status: PlanWithEpics['status'];
  totalCost: number; // plan.totalCostUsd
  startedAtIso: string | null;
  epics: DashboardEpic[];
}

export interface AdapterOptions {
  plannedSecPerStory?: number;
  /** Now in ms — injectable for tests. Defaults to Date.now(). */
  now?: number;
}

// ── Status → progress map ────────────────────────────────────────────

const STATUS_PROGRESS: Record<StoryStatus, number> = {
  pending: 0,
  queued: 0,
  running: 50,
  in_review: 92,
  fixing: 40,
  done: 100,
  failed: 100,
  blocked: 30,
  skipped: 0,
};

export function progressFor(status: StoryStatus): number {
  return STATUS_PROGRESS[status] ?? 0;
}

// ── Job → metrics ────────────────────────────────────────────────────

function jobCost(job: AgentJob | undefined): number {
  if (!job) return 0;
  if (typeof job.totalCost === 'number') return job.totalCost;
  const fromSteps = (job.stepResults ?? []).reduce((a, s) => a + (s.cost ?? 0), 0);
  return fromSteps;
}

function jobTokens(job: AgentJob | undefined): number {
  if (!job) return 0;
  return (job.stepResults ?? []).reduce(
    (a, s) => a + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
    0,
  );
}

function jobElapsedSec(
  job: AgentJob | undefined,
  status: StoryStatus,
  nowMs: number,
): number | null {
  if (!job) return null;
  const createdMs = Date.parse(job.createdAt);
  if (!Number.isFinite(createdMs)) return null;

  if (
    status === 'done' ||
    status === 'failed' ||
    job.status === 'COMPLETED' ||
    job.status === 'FAILED'
  ) {
    const endMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(endMs)) return null;
    return Math.max(0, (endMs - createdMs) / 1000);
  }
  if (status === 'running' || status === 'in_review' || status === 'fixing') {
    return Math.max(0, (nowMs - createdMs) / 1000);
  }
  return null;
}

// ── Main build function ──────────────────────────────────────────────

export function buildDashboardPlan(
  plan: PlanWithEpics,
  jobsById: Record<string, AgentJob>,
  opts: AdapterOptions = {},
): DashboardPlan {
  const plannedDefault = opts.plannedSecPerStory ?? DEFAULT_PLANNED_SEC;
  const nowMs = opts.now ?? Date.now();

  const epics = plan.epics ?? [];
  // Build label lookup so dependsOn ids resolve to "E1/E2" for display.
  const labelById = new Map<string, string>();
  epics.forEach((e, idx) => labelById.set(e.epicId, `E${idx + 1}`));

  const dashboardEpics: DashboardEpic[] = epics.map((epic, epicIdx) => {
    const epicLabel = `E${epicIdx + 1}`;
    const agentDefault = epic.devModel || plan.devModel || null;

    // Group stories by wave. Stories without a `wave` are placed in wave 0.
    const byWave = new Map<number, EpicStory[]>();
    for (const s of epic.stories) {
      const w = s.wave ?? 0;
      if (!byWave.has(w)) byWave.set(w, []);
      byWave.get(w)!.push(s);
    }
    const waveNumbers = [...byWave.keys()].sort((a, b) => a - b);

    const waves: DashboardWave[] = waveNumbers.map((wn) => {
      const waveId = `${epic.epicId}-W${wn}`;
      const waveLabel = `Wave ${wn}`;
      const stories = (byWave.get(wn) ?? []).map<DashboardStory>((s) => {
        const job = s.jobId ? jobsById[s.jobId] : undefined;
        const actualSec = jobElapsedSec(job, s.status, nowMs);
        const cost = jobCost(job);
        const tokens = jobTokens(job);

        return {
          id: s.storyId,
          label: s.title,
          desc: s.description,
          status: s.status,
          sp: 1,
          progress: progressFor(s.status),
          plannedSec: plannedDefault,
          actualSec,
          startedAtIso: job?.createdAt ?? null,
          finishedAtIso:
            job && (job.status === 'COMPLETED' || job.status === 'FAILED') ? job.updatedAt : null,
          cost,
          tokens,
          agent: agentDefault,
          touchPoints: s.touchPoints ?? [],
          criteria: (s.criteria ?? []).map((c) => ({
            text: c.text,
            done: s.status === 'done' || s.status === 'in_review',
          })),
          jobId: s.jobId ?? null,
          retryAttempt: job?.retryAttempt ?? 0,
          maxRetries: 3,
          epicId: epic.epicId,
          epicLabel,
          wave: wn,
          waveId,
          waveLabel,
        };
      });

      return { id: waveId, label: waveLabel, waveIndex: wn, stories };
    });

    return {
      id: epic.epicId,
      epicIdRaw: epic.epicId,
      label: epicLabel,
      title: epic.title,
      goal: epic.description,
      status: epic.status,
      planWave: epic.epicWave ?? 0,
      dependsOn: epic.dependsOnEpics ?? [],
      dependsOnLabels: (epic.dependsOnEpics ?? []).map((id) => labelById.get(id) ?? id),
      waves,
    };
  });

  return {
    id: plan.planId,
    name: plan.displayName || plan.name,
    intent: plan.intent,
    path: plan.workingDir,
    status: plan.status,
    totalCost: plan.totalCostUsd,
    startedAtIso: plan.startedAt ?? null,
    epics: dashboardEpics,
  };
}

// ── Flatten for Kanban ───────────────────────────────────────────────

export function flattenStories(plan: DashboardPlan): DashboardStory[] {
  return plan.epics.flatMap((e) => e.waves.flatMap((w) => w.stories));
}

// ── Aggregation (port of helpers.jsx) ────────────────────────────────
// Rules (per IMPLEMENTATION.md §3.3):
//   - Wave time      = max(story.plannedSec)     (parallel)
//   - Wave actual    = max(story elapsed)
//   - Epic time      = sum(wave.plannedSec)      (sequential waves)
//   - Plan time      = sum(epic.plannedSec)
//   - Cost / tokens  = sum all the way up
//   - Progress       = story-count-weighted average

export interface Aggregate {
  planned: number;
  actual: number;
  cost: number;
  tokens: number;
  done: number;
  running: number;
  total: number;
  progress: number; // 0–100
}

const ACTIVE_STATUSES: StoryStatus[] = ['running', 'in_review', 'fixing'];

function storyElapsedForAgg(s: DashboardStory): number {
  if (s.status === 'done') return s.actualSec ?? s.plannedSec;
  if (ACTIVE_STATUSES.includes(s.status)) {
    return (s.plannedSec * s.progress) / 100;
  }
  return 0;
}

export function aggregateWave(wave: DashboardWave): Aggregate {
  const ss = wave.stories;
  if (ss.length === 0) {
    return {
      planned: 0,
      actual: 0,
      cost: 0,
      tokens: 0,
      done: 0,
      running: 0,
      total: 0,
      progress: 0,
    };
  }
  const planned = Math.max(0, ...ss.map((s) => s.plannedSec));
  const actual = Math.max(0, ...ss.map(storyElapsedForAgg));
  const cost = ss.reduce((a, s) => a + s.cost, 0);
  const tokens = ss.reduce((a, s) => a + s.tokens, 0);
  const done = ss.filter((s) => s.status === 'done').length;
  const running = ss.filter((s) => ACTIVE_STATUSES.includes(s.status)).length;
  const progress =
    ss.reduce((a, s) => {
      if (s.status === 'done') return a + 100;
      if (ACTIVE_STATUSES.includes(s.status)) return a + s.progress;
      return a;
    }, 0) / ss.length;
  return { planned, actual, cost, tokens, done, running, total: ss.length, progress };
}

export function aggregateEpic(epic: DashboardEpic): Aggregate {
  const waveAggs = epic.waves.map(aggregateWave);
  const total = waveAggs.reduce((a, w) => a + w.total, 0);
  return {
    planned: waveAggs.reduce((a, w) => a + w.planned, 0),
    actual: waveAggs.reduce((a, w) => a + w.actual, 0),
    cost: waveAggs.reduce((a, w) => a + w.cost, 0),
    tokens: waveAggs.reduce((a, w) => a + w.tokens, 0),
    done: waveAggs.reduce((a, w) => a + w.done, 0),
    running: waveAggs.reduce((a, w) => a + w.running, 0),
    total,
    progress: total === 0 ? 0 : waveAggs.reduce((a, w) => a + w.progress * w.total, 0) / total,
  };
}

export function aggregatePlan(plan: DashboardPlan): Aggregate {
  const epicAggs = plan.epics.map(aggregateEpic);
  const total = epicAggs.reduce((a, e) => a + e.total, 0);
  return {
    planned: epicAggs.reduce((a, e) => a + e.planned, 0),
    actual: epicAggs.reduce((a, e) => a + e.actual, 0),
    cost: epicAggs.reduce((a, e) => a + e.cost, 0),
    tokens: epicAggs.reduce((a, e) => a + e.tokens, 0),
    done: epicAggs.reduce((a, e) => a + e.done, 0),
    running: epicAggs.reduce((a, e) => a + e.running, 0),
    total,
    progress: total === 0 ? 0 : epicAggs.reduce((a, e) => a + e.progress * e.total, 0) / total,
  };
}

// ── Formatters (shared with views) ───────────────────────────────────

export function fmtSec(s: number | null | undefined): string {
  if (s == null) return '—';
  const safe = Math.max(0, s);
  const m = Math.floor(safe / 60);
  const sc = Math.floor(safe % 60);
  return m > 0 ? `${m}m ${sc}s` : `${sc}s`;
}

export function fmtClock(s: number): string {
  const safe = Math.max(0, s);
  const m = Math.floor(safe / 60);
  const sc = Math.floor(safe % 60);
  return `${m}:${sc < 10 ? '0' : ''}${sc}`;
}

export function fmtCost(c: number | null | undefined): string {
  return `$${(c ?? 0).toFixed(2)}`;
}

export function fmtTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v === 0) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'k';
  return String(v);
}
