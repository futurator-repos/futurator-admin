// Timer Intelligence — Forensic payload builder (Story 1.8.3)
//
// Exports:
//   buildNarrative(plan, slices, aggregate, cohort?)  → string (5-sentence summary)
//   buildForensicPayload(planId)                      → Promise<ForensicPayload>
//
// Design principles:
//   - No LLM calls. Everything is computed deterministically from the data.
//   - buildForensicPayload assembles the full payload; the route is a thin wrapper.
//   - cohort may be null (returned when /api/timing/cohort responds 404).
//
// Story 1.8.6 note: the cohort data here is fetched inline by calling the same
// logic as GET /api/timing/cohort. Once Story 1.8.6 ships the cron-aggregated
// TimingSummary table, the cohort fetch here should switch to that table query
// for speed (no inline scan of all plans/apps). The `buildNarrative` and
// `ForensicPayload` shape do not change.

import type { Plan } from '../types/plan';
import type { AgentEvent } from '../types/agent-orchestrator';
import type { AggregationResult } from './aggregator';
import type { TimerSlice, TimerCategory } from './types';
import { sliceForPlan } from './slicer';
import { aggregateByCategory } from './aggregator';
import { getPlanById } from '../repositories/plan-repository';
import { getEpicById } from '../repositories/epic-workflow-repository';
import { getEventsAfter } from '../repositories/agent-events-repository';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Cohort baseline shape — same as the 200 body from GET /api/timing/cohort.
 * Null when the cohort has fewer than 5 samples (404 from that endpoint).
 */
export interface CohortBaseline {
  samples: number;
  medianMs: number;
  p90Ms: number;
  byCategory: Record<TimerCategory, { medianMs: number; p90Ms: number }>;
}

/**
 * Full forensic export payload. Shaped for paste-into-Claude analysis.
 * schemaVersion is a stable discriminator so downstream tooling can detect
 * breaking changes.
 */
/**
 * Epic 7 (2026-05-20) — per-plan skill activity rollup. Derived from
 * `skill_activated` + `tool_use` events in the plan's job events.
 */
export interface ForensicSkillsBlock {
  /** Distinct skills activated across the entire plan (post-Epic-4). */
  activatedSkills: Array<{ skill: string; source: string; activationCount: number }>;
  /** Per-job stats — useful for diagnosing "which agent invocation actually used the skill". */
  perJob: Array<{
    jobId: string;
    skillActivationCount: number;
    distinctSkills: number;
  }>;
  /** Total `Skill` tool_use events observed. Useful for cohort baselines. */
  totalSkillToolUseEvents: number;
  /**
   * SKILL-SCOUT activity rollup (Epic 3): how many SCOUT runs fired, what
   * triggers, what dispositions. Sourced from `step.skill-scout.*` events.
   */
  skillScoutRuns: Array<{
    jobId: string;
    trigger: string;
    proposalCount: number;
    durationMs: number;
  }>;
}

export interface ForensicPayload {
  schemaVersion: 'timer-intel-v1.0';
  plan: Plan;
  events: AgentEvent[];
  slices: TimerSlice[];
  aggregate: AggregationResult;
  cohort: CohortBaseline | null;
  narrative: string;
  /** Epic 7 — null only when zero skill events observed (e.g. pre-Epic-4 plans). */
  skills: ForensicSkillsBlock | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format milliseconds as "Xm Ys" (e.g. "12m 32s"). */
function fmtMs(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Format a percentage, e.g. 0.381 → "38%". */
function fmtPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Find the category with the highest totalMs from the aggregate.
 * Returns null only when the aggregate is totally empty (totalMs === 0).
 */
function largestCategory(aggregate: AggregationResult): { cat: TimerCategory; ms: number } | null {
  let best: { cat: TimerCategory; ms: number } | null = null;

  for (const [cat, summary] of Object.entries(aggregate.byCategory) as Array<
    [TimerCategory, { totalMs: number; count: number }]
  >) {
    if (summary.totalMs > (best?.ms ?? -1)) {
      best = { cat, ms: summary.totalMs };
    }
  }

  return best;
}

/**
 * Find the smallest nonzero category (excluding 'unattributed' which is a
 * honesty bucket, not a meaningful work category).
 */
function smallestMeaningfulCategory(
  aggregate: AggregationResult,
): { cat: TimerCategory; ms: number } | null {
  let best: { cat: TimerCategory; ms: number } | null = null;

  for (const [cat, summary] of Object.entries(aggregate.byCategory) as Array<
    [TimerCategory, { totalMs: number; count: number }]
  >) {
    if (cat === 'unattributed') continue;
    if (summary.totalMs <= 0) continue;
    if (best === null || summary.totalMs < best.ms) {
      best = { cat, ms: summary.totalMs };
    }
  }

  return best;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the 5-sentence timing narrative.
 *
 * Sentence 1: Total duration.
 * Sentence 2: Largest category (name, percentage, duration).
 * Sentence 3: Smallest meaningful nonzero category.
 * Sentence 4: Outlier analysis vs cohort (or "no cohort yet").
 * Sentence 5: Actionable hint based on largest-category vs cohort ratio.
 *
 * Degenerate case (0 slices / totalMs=0): all sentences use "N/A" or
 * safe fallbacks so the function never throws.
 */
export function buildNarrative(
  _plan: Plan,
  _slices: TimerSlice[],
  aggregate: AggregationResult,
  cohort?: CohortBaseline | null,
): string {
  const totalMs = aggregate.totalMs;

  // ── Sentence 1 — total duration ───────────────────────────────────────────
  const s1 =
    totalMs === 0
      ? 'Total attributed time: 0s (no events recorded).'
      : `Total attributed time: ${fmtMs(totalMs)}.`;

  // ── Sentence 2 — largest category ────────────────────────────────────────
  const largest = largestCategory(aggregate);
  let s2: string;
  if (!largest || totalMs === 0) {
    s2 = 'No category data available.';
  } else {
    const pct = fmtPct(largest.ms / totalMs);
    s2 = `Largest category: ${largest.cat} (${pct}, ${fmtMs(largest.ms)}).`;
  }

  // ── Sentence 3 — smallest meaningful category ─────────────────────────────
  const smallest = smallestMeaningfulCategory(aggregate);
  let s3: string;
  if (!smallest || smallest.cat === largest?.cat) {
    // Only one nonzero category or none at all
    s3 = 'Only one category recorded; no other meaningful breakdown available.';
  } else {
    const pct = fmtPct(smallest.ms / totalMs);
    s3 = `Smallest meaningful category: ${smallest.cat} (${pct}, ${fmtMs(smallest.ms)}).`;
  }

  // ── Sentence 4 — cohort comparison ───────────────────────────────────────
  let s4: string;
  let largestCatRatioVsCohort: number | null = null;

  if (!cohort) {
    s4 = 'No cohort baseline yet (need 5+ similar plans).';
  } else {
    // Compare total duration vs cohort median
    const totalRatio = cohort.medianMs > 0 ? totalMs / cohort.medianMs : null;
    if (totalRatio === null || cohort.medianMs === 0) {
      s4 = `Cohort has ${cohort.samples} sample(s) but median is zero — comparison unavailable.`;
    } else {
      // Also check if largest category is an outlier vs its cohort bucket
      if (largest) {
        const catCohort = cohort.byCategory[largest.cat];
        if (catCohort && catCohort.medianMs > 0) {
          largestCatRatioVsCohort = largest.ms / catCohort.medianMs;
          if (largestCatRatioVsCohort >= 2.0) {
            s4 = `Outlier vs cohort: ${largest.cat} at ${largestCatRatioVsCohort.toFixed(1)}× cohort median (cohort ${fmtMs(catCohort.medianMs)}, this plan ${fmtMs(largest.ms)}).`;
          } else {
            const totalRatioFixed = totalRatio.toFixed(1);
            s4 = `Plan total is ${totalRatioFixed}× cohort median (cohort ${fmtMs(cohort.medianMs)}, this plan ${fmtMs(totalMs)}).`;
          }
        } else {
          s4 = `Plan total is ${totalRatio.toFixed(1)}× cohort median (cohort ${fmtMs(cohort.medianMs)}).`;
        }
      } else {
        s4 = `Plan total is ${totalRatio.toFixed(1)}× cohort median.`;
      }
    }
  }

  // ── Sentence 5 — actionable hint ─────────────────────────────────────────
  let s5: string;
  if (!cohort || !largest) {
    s5 = 'Collect more plans to unlock cohort-based recommendations.';
  } else if (largestCatRatioVsCohort !== null && largestCatRatioVsCohort >= 2.0) {
    // Category-specific hints
    if (largest.cat === 'review') {
      s5 = `Review may be looping — consider tightening the reviewer prompt or reducing review iterations.`;
    } else if (largest.cat === 'fix') {
      s5 = `Remediation time is elevated — check for recurring test failures or dependency issues.`;
    } else if (largest.cat === 'human-wait') {
      s5 = `High human-wait time — unblocking sooner will compress overall plan duration.`;
    } else if (largest.cat === 'compile') {
      s5 = `Orchestration overhead is high — consider splitting this plan into smaller epics.`;
    } else if (largest.cat === 'machine-wait') {
      s5 = `Machine-wait is elevated — the daemon may be starved; check concurrency slot availability.`;
    } else {
      s5 = `${largest.cat} time is ${largestCatRatioVsCohort.toFixed(1)}× cohort median — investigate what's different in this plan.`;
    }
  } else {
    s5 = 'All categories are within expected cohort ranges — no action needed.';
  }

  return [s1, s2, s3, s4, s5].join(' ');
}

// ── Internal helpers for buildForensicPayload ────────────────────────────────

/**
 * Collect all raw AgentEvent rows across every job in a plan.
 * Mirrors the job-discovery logic in sliceForPlan (slicer.ts).
 */
async function collectRawEvents(plan: Plan): Promise<AgentEvent[]> {
  const jobIds = new Set<string>();

  for (const epicId of plan.epicIds ?? []) {
    const epic = await getEpicById(epicId);
    if (!epic) continue;
    if (epic.orchestratorJobId) jobIds.add(epic.orchestratorJobId);
    for (const story of epic.stories ?? []) {
      if (story.jobId) jobIds.add(story.jobId);
    }
  }

  const PAGE_SIZE = 200;
  // DDB rejects empty strings for key-attribute comparisons; '000000' is
  // lexicographically less than every real eventSeq ('000001'+). See slicer.ts
  // SEQ_START — same fix applies here (2026-05-04 timer-intel debug).
  const SEQ_START = '000000';

  const allEvents: AgentEvent[] = [];

  await Promise.all(
    Array.from(jobIds).map(async (jobId) => {
      let cursor = SEQ_START;
      for (;;) {
        const { events, lastSeq } = await getEventsAfter(jobId, cursor, PAGE_SIZE);
        allEvents.push(...events);
        if (events.length < PAGE_SIZE) break;
        cursor = lastSeq;
      }
    }),
  );

  // Sort by timestamp then eventSeq for a readable forensic stream.
  allEvents.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    return a.eventSeq.localeCompare(b.eventSeq);
  });

  return allEvents;
}

/**
 * Assemble the full forensic JSON payload for a plan.
 *
 * Returns null when the plan does not exist (route converts to 404).
 *
 * The `cohort` field is null when there are fewer than 5 matching plans —
 * the calling route must not throw in that case (per AC).
 *
 * NOTE (Story 1.8.6): cohort is computed inline here (scan of apps + plans).
 * Once the cron-aggregated TimingSummary table ships, replace the inline
 * cohort logic with a targeted DDB Get on that table.
 */
/**
 * Epic 7 (2026-05-20) — derive the skills block from the plan's raw events.
 *
 * Reads `skill_activated` events (Epic 4) for per-skill counts, and
 * `step.skill-scout.<trigger>` events (Epic 3) for SCOUT run stats.
 * Returns `null` when no skill-related events are observed (pre-Epic-3/4
 * plans, or plans that ran before the daemon shipped the relevant hooks).
 *
 * Pure — no I/O. Drop-in derivation from the events array the forensic
 * builder already collects.
 */
export function buildSkillsBlock(events: AgentEvent[]): ForensicSkillsBlock | null {
  if (events.length === 0) return null;

  // 1. Skill activations (Epic 4). Per-skill counts + per-job rollup.
  const perSkill = new Map<string, { skill: string; source: string; count: number }>();
  const perJob = new Map<
    string,
    { jobId: string; activationCount: number; distinct: Set<string> }
  >();
  let totalSkillToolUseEvents = 0;

  for (const ev of events) {
    if (ev.eventType === 'tool_use' && ev.toolName === 'Skill') {
      totalSkillToolUseEvents += 1;
    }
    // `skill_activated` is a synthetic event emitted by the daemon's
    // recordSkillActivation success path (Epic 4). It carries payload
    // shape { skill, source, totalLoaded } encoded in the AgentEvent's
    // payload field — but the daemon's pushEvent flattens into top-level
    // fields, so we read from `payload` (epic-dev path) AND from
    // top-level fields (legacy path) defensively.
    const isActivation = (ev.eventType as string) === 'skill_activated';
    if (!isActivation) continue;

    const payload = ev.payload as { skill?: string; source?: string } | undefined;
    const skill = payload?.skill;
    const source = payload?.source ?? 'unknown';
    if (typeof skill !== 'string' || skill.length === 0) continue;

    const key = `${skill}@${source}`;
    const existing = perSkill.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      perSkill.set(key, { skill, source, count: 1 });
    }

    let job = perJob.get(ev.jobId);
    if (!job) {
      job = { jobId: ev.jobId, activationCount: 0, distinct: new Set() };
      perJob.set(ev.jobId, job);
    }
    job.activationCount += 1;
    job.distinct.add(key);
  }

  // 2. SKILL-SCOUT runs (Epic 3). `step.skill-scout.<trigger>` is the
  // forensic event shape from buildForensicEvent in skill-scout-runner.mjs.
  const scoutRuns: ForensicSkillsBlock['skillScoutRuns'] = [];
  for (const ev of events) {
    if (typeof ev.eventType === 'string' && ev.eventType.startsWith('step.skill-scout.')) {
      const payload = ev.payload as
        | { trigger?: string; proposalCount?: number; durationMs?: number }
        | undefined;
      scoutRuns.push({
        jobId: ev.jobId,
        trigger: payload?.trigger ?? ev.eventType.replace('step.skill-scout.', ''),
        proposalCount: payload?.proposalCount ?? 0,
        durationMs: payload?.durationMs ?? 0,
      });
    }
  }

  if (perSkill.size === 0 && scoutRuns.length === 0 && totalSkillToolUseEvents === 0) {
    return null;
  }

  // 3. Compose. Sort activatedSkills by count descending so the highest-
  // activated skill is first in the block.
  const activatedSkills = Array.from(perSkill.values())
    .sort((a, b) => b.count - a.count)
    .map((entry) => ({
      skill: entry.skill,
      source: entry.source,
      activationCount: entry.count,
    }));

  return {
    activatedSkills,
    perJob: Array.from(perJob.values()).map((j) => ({
      jobId: j.jobId,
      skillActivationCount: j.activationCount,
      distinctSkills: j.distinct.size,
    })),
    totalSkillToolUseEvents,
    skillScoutRuns: scoutRuns,
  };
}

export async function buildForensicPayload(
  planId: string,
  cohortFetcher: (
    templateType: string,
    planKind: string,
    epicCount: number,
  ) => Promise<CohortBaseline | null>,
): Promise<ForensicPayload | null> {
  const plan = await getPlanById(planId);
  if (!plan) return null;

  const [slices, events] = await Promise.all([sliceForPlan(planId), collectRawEvents(plan)]);

  const aggregate = aggregateByCategory(slices);

  // Attempt to fetch cohort baseline. Null = insufficient samples (404).
  // We only have planKind and epicCount from the plan. templateType requires
  // App.boilerplateType which doesn't exist until Story 1.3.3 ships.
  // For Phase 1 we fall back to 'nextjs' as the default boilerplate type.
  // TODO(1.3.3): read from App.boilerplateType once that field exists.
  const templateType = 'nextjs';
  const planKind = plan.kind ?? 'initial';
  const epicCount = (plan.epicIds ?? []).length;

  let cohort: CohortBaseline | null = null;
  try {
    cohort = await cohortFetcher(templateType, planKind, epicCount);
  } catch {
    // Cohort fetch failed — degrade gracefully to null (no baseline yet).
    cohort = null;
  }

  const narrative = buildNarrative(plan, slices, aggregate, cohort);

  // Epic 7 (2026-05-20) — skills block. Pure derivation from events;
  // null when the plan ran before Epic 3/4 hooks shipped.
  const skills = buildSkillsBlock(events);

  return {
    schemaVersion: 'timer-intel-v1.0',
    plan,
    events,
    slices,
    aggregate,
    cohort,
    narrative,
    skills,
  };
}
