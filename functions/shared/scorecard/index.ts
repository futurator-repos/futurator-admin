// Plan Retrospect — deterministic scorer entrypoint (spec §4a)
//
// `scoreDeterministic(planId, opts?)` assembles the DetectorContext, runs all
// eight stage detectors, and returns the flat + per-stage ScorecardSlice[].
//
// Design (spec §4a "reuse note" / reviewer fix #8):
//   - The cheap, always-available context (plan / epics / events / slices /
//     aggregate / skills) is built from the forensic PRIMITIVES directly —
//     `sliceForPlan` + `aggregateByCategory` + `collectRawEvents` (re-derived
//     here) + `buildSkillsBlock` — avoiding the cohort I/O that full
//     `buildForensicPayload(planId, cohortFetcher)` would force.
//   - The I/O-heavy OPTIONAL inputs (knowledge `_graph` reports, qa/deploy
//     reports, reflections, agent-spend rows) are supplied by INJECTED async
//     fetchers in `opts`. The Lambda passes the real S3/DDB readers; tests pass
//     stubs. When a fetcher is absent or throws, that input stays UNDEFINED and
//     the relevant detector emits a `⚪` `[needs-instrumentation: …]` slice — we
//     NEVER fabricate (honesty guard, spec §4a).
//
// Cost honesty (spec §4a SQ4): cost is NOT on events. OV4 reconciliation is
// sourced from agent-spend rows (`opts.fetchAgentSpendRows`) inside the overview
// detector; when those rows are absent OV4 goes `⚪` and the cost-derived
// criteria fall to `confidence:'unreconciled'` — both handled in
// `detectors/overview.ts`, not here. This module only wires the rows through.

import type { Plan } from '../types/plan';
import type { EpicWorkflow } from '../types/epic-workflow';
import type { AgentEvent } from '../types/agent-orchestrator';
import { getPlanById } from '../repositories/plan-repository';
import { getEpicById } from '../repositories/epic-workflow-repository';
import { getEventsAfter } from '../repositories/agent-events-repository';
import { getJobById } from '../repositories/agent-jobs-repository';
import { sliceForPlan } from '../timer/slicer';
import { aggregateByCategory } from '../timer/aggregator';
import { buildSkillsBlock } from '../timer/forensic-builder';

import type {
  DetectorContext,
  ScorecardSlice,
  StageId,
  GraphReports,
  AgentSpendRow,
  ByCat,
} from './types';
import { scoreConcept } from './detectors/concept';
import { scoreDevelopment } from './detectors/development';
import { scoreSkills } from './detectors/skills';
import { scoreKnowledgeGraph } from './detectors/knowledge-graph';
import { scoreQa } from './detectors/qa';
import { scoreDeployment } from './detectors/deployment';
import { scorePublish } from './detectors/publish';
import { scoreOverview } from './detectors/overview';

/**
 * Injected, environment-specific readers for the optional inputs. Each is
 * OPTIONAL: omit one and its detector(s) emit `⚪`. Each may reject — the
 * scorer swallows the rejection and degrades to the absent-input path (so a
 * partial S3 outage scores everything it still can rather than throwing).
 *
 * The Lambda wires these to the real S3 `GetObject` (knowledge `_graph`),
 * the qa/deploy report aggregators, `reflections-repository`, and a
 * plan-scoped agent-spend read. Tests inject deterministic stubs.
 */
export interface ScoreDeterministicOpts {
  /** Parsed `knowledge/_graph/` reports (orphans/dead-code/snapshot/ast-facts). */
  fetchGraphReports?: (plan: Plan) => Promise<GraphReports | undefined>;
  /** The plan-wide QA report (qa-report-aggregator output). */
  fetchQaReport?: (plan: Plan, epics: EpicWorkflow[]) => Promise<unknown>;
  /** The plan-wide deploy report (deploy-report-aggregator output). */
  fetchDeployReport?: (plan: Plan, epics: EpicWorkflow[]) => Promise<unknown>;
  /** Reflection rows (OV8/OV9) — `reflections-repository.listReflections`. */
  fetchReflections?: (plan: Plan) => Promise<unknown>;
  /** Plan-scoped agent-spend rows (OV4 cost reconciliation, spec §4a SQ4). */
  fetchAgentSpendRows?: (plan: Plan) => Promise<AgentSpendRow[]>;
}

/**
 * The deterministic scorer's result. `slices` is the flat union across all
 * stages; `byStage` is the same slices grouped (the composer / repository
 * persist one DDB row per stage, §5). `plan`/`epics` ride along so the caller
 * (the composer / route) doesn't re-fetch them.
 */
export interface DeterministicResult {
  planId: string;
  plan: Plan;
  epics: EpicWorkflow[];
  /** Every detector slice, flat. */
  slices: ScorecardSlice[];
  /** The same slices grouped by rubric stage. */
  byStage: Record<StageId, ScorecardSlice[]>;
  /** The built DetectorContext — passed to `composeRealityCheck` by the route. */
  ctx: DetectorContext;
}

/**
 * Resolve EVERY jobId belonging to a plan: the concept route + artifact jobs,
 * each epic's orchestrator + story + wave-build jobs, and the retry-union chain
 * (superseded attempts). Exported so the agent-spend fetcher (OV4) joins spend
 * against the SAME job set the scorer reads events from — otherwise the two
 * disagree (orphaned/superseded spend is exactly the gap OV4 must catch).
 *
 * The concept jobs are seeded here (A3, 2026-06-18): they exist in DDB but were
 * previously omitted, leaving C-R2/C-D5 blind for no reason.
 */
export async function resolvePlanJobIds(plan: Plan, epics: EpicWorkflow[]): Promise<Set<string>> {
  const jobIds = new Set<string>();

  // Concept stage jobs live on the plan row (route + per-artifact generators).
  if (plan.conceptRouteJobId) jobIds.add(plan.conceptRouteJobId);
  for (const jid of Object.values(plan.conceptArtifactJobIds ?? {})) {
    if (jid) jobIds.add(jid);
  }

  for (const epic of epics) {
    if (epic.orchestratorJobId) jobIds.add(epic.orchestratorJobId);
    for (const story of epic.stories ?? []) {
      if (story.jobId) jobIds.add(story.jobId);
    }
    for (const buildJobId of Object.values(epic.waveBuildJobs ?? {})) {
      if (buildJobId) jobIds.add(buildJobId);
    }
  }

  // Retry-union: a retry creates a NEW job with retryOf=originalJobId; walk the
  // chain backward so superseded attempts' events (and their orphaned spend)
  // are included. Matches forensic-builder.collectRawEvents (F3, 2026-06-18).
  for (const jobId of Array.from(jobIds)) {
    let cursor = jobId;
    const seen = new Set<string>([jobId]);
    for (;;) {
      const job = await getJobById(cursor);
      const prior = job?.retryOf;
      if (!prior || seen.has(prior)) break;
      seen.add(prior);
      jobIds.add(prior);
      cursor = prior;
    }
  }

  return jobIds;
}

/**
 * Re-derive the plan's raw events across every job (concept + orchestrator +
 * story + wave-build + retry-union), mirroring `collectRawEvents` in
 * forensic-builder. We re-implement it here (rather than calling
 * `buildForensicPayload`) so the scorer avoids the cohort fetch (spec §4a).
 */
async function collectPlanEvents(plan: Plan, epics: EpicWorkflow[]): Promise<AgentEvent[]> {
  const jobIds = await resolvePlanJobIds(plan, epics);

  const PAGE_SIZE = 200;
  const SEQ_START = '000000'; // DDB rejects '' for key comparisons; see slicer.ts
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

  allEvents.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    return a.eventSeq.localeCompare(b.eventSeq);
  });
  return allEvents;
}

/** Resolve every epic row for a plan (skipping any that no longer exist). */
export async function resolveEpics(plan: Plan): Promise<EpicWorkflow[]> {
  const epics: EpicWorkflow[] = [];
  for (const epicId of plan.epicIds ?? []) {
    const epic = await getEpicById(epicId);
    if (epic) epics.push(epic);
  }
  return epics;
}

/**
 * Run an injected optional fetcher, degrading any rejection to `undefined` so
 * the absent-input (⚪) path is taken rather than throwing the whole scorer.
 */
async function tryFetch<T>(fn: (() => Promise<T>) | undefined): Promise<T | undefined> {
  if (!fn) return undefined;
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** The eight stage detectors, in stable order. */
const DETECTORS: Array<(ctx: DetectorContext) => ScorecardSlice[]> = [
  scoreConcept,
  scoreDevelopment,
  scoreSkills,
  scoreKnowledgeGraph,
  scoreQa,
  scoreDeployment,
  scorePublish,
  scoreOverview,
];

const EMPTY_BY_STAGE = (): Record<StageId, ScorecardSlice[]> => ({
  concept: [],
  development: [],
  qa: [],
  deployment: [],
  publish: [],
  overview: [],
});

/**
 * Deterministic scorer entrypoint (spec §4a). Builds the DetectorContext for
 * `planId`, runs all eight detectors, returns the flat + grouped slices.
 *
 * Throws `Plan not found` only when the plan row itself is missing (the route
 * converts to 404). Every other absent input degrades to `⚪`, never a throw.
 *
 * NOTE: never hardcodes a planId — `planId` is the sole subject. Detectors read
 * fields off the resolved context, never plan names.
 */
export async function scoreDeterministic(
  planId: string,
  opts: ScoreDeterministicOpts = {},
): Promise<DeterministicResult> {
  const plan = await getPlanById(planId);
  if (!plan) {
    throw new Error(`Plan not found: ${planId}`);
  }

  const epics = await resolveEpics(plan);

  // Cheap primitives path (no cohort I/O). slices/events in parallel.
  const [slices, events] = await Promise.all([
    sliceForPlan(planId),
    collectPlanEvents(plan, epics),
  ]);
  const aggregate = aggregateByCategory(slices);
  const skills = buildSkillsBlock(events);

  // Injected optional inputs (each degrades to undefined → ⚪ on absence/throw).
  const [graphReports, qaReport, deployReport, reflections, agentSpendRows] = await Promise.all([
    tryFetch(opts.fetchGraphReports ? () => opts.fetchGraphReports!(plan) : undefined),
    tryFetch(opts.fetchQaReport ? () => opts.fetchQaReport!(plan, epics) : undefined),
    tryFetch(opts.fetchDeployReport ? () => opts.fetchDeployReport!(plan, epics) : undefined),
    tryFetch(opts.fetchReflections ? () => opts.fetchReflections!(plan) : undefined),
    tryFetch(opts.fetchAgentSpendRows ? () => opts.fetchAgentSpendRows!(plan) : undefined),
  ]);

  const byCat: ByCat = (cat: string) =>
    aggregate.byCategory[cat as keyof typeof aggregate.byCategory] ?? { totalMs: 0, count: 0 };

  const ctx: DetectorContext = {
    planId,
    plan,
    epics,
    events,
    slices,
    aggregate,
    skills,
    // Phase 1 deterministic path skips cohort I/O (spec §4a). cohort is honest
    // only when grouped by pipeline version (Phase 3) — null until then.
    cohort: null,
    byCat,
    graphReports,
    qaReport,
    deployReport,
    reflections,
    agentSpendRows,
  };

  const all: ScorecardSlice[] = [];
  for (const detect of DETECTORS) {
    all.push(...detect(ctx));
  }

  const byStage = EMPTY_BY_STAGE();
  for (const slice of all) {
    byStage[slice.stage].push(slice);
  }

  return { planId, plan, epics, slices: all, byStage, ctx };
}
