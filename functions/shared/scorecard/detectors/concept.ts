// Plan Retrospect — CONCEPT-stage deterministic detector (rubric §0.6 / §2)
//
// Scores the `[DET]` concept criteria directly from the DetectorContext:
//   C-R2  routing latency & discipline  (route job durationMs + tool_use count)
//   C-D4  citable structure              (<kind>.sections.json H2 ids)
//   C-D5  generation efficiency          (per-gen-job durationMs vs rigor budget)
//   C-P3  decomposition sanity           (epic/story tree wave widths)
//   C-P4  no dangling references          (validateReferenceSections danglingCount)
//   C-P5  plan not emitted ungrounded     (pm-plan PRIOR_ARTIFACTS payload bytes)
//   C-G2  approval-mode correctness        (conceptInteraction + status transitions)
//   C-G3  chain visible & read-only        (plan rows visible post-dev-start)
//
// Honesty guard (spec §4a): several concept criteria need concept *artifacts*
// (`<kind>.sections.json`, the pm-plan prompt payload, per-job status histories)
// that are NOT in the Lambda's DetectorContext. Those slices are emitted with
// verdict '⚪', score null, and a `[needs-instrumentation: …]` note. We NEVER
// fabricate a value to avoid '⚪' — that is the credibility of the feature.
//
// The concept route/gen jobs are flagged `conceptAutopilotGen: true` on the job
// row (NOT a `jobType`); the route job is FK'd as `plan.conceptRouteJobId` and
// the per-kind generator jobs as `plan.conceptArtifactJobIds`. We correlate
// their *events* (which DO ride in `ctx.events`, keyed by `jobId`) to recover
// `durationMs` and `tool_use` counts without reading any job row directly.

import type { DetectorContext, ScorecardSlice, EvidenceRef, Verdict, FixRef } from '../types';
import { CRITERIA_META } from '../criteria-meta';
import { mapIeToFixes } from '../ie-to-f-map';
import type { AgentEvent } from '../../types/agent-orchestrator';

// ── slice helpers ─────────────────────────────────────────────────────────────

function meta(criterionId: string) {
  return CRITERIA_META[criterionId];
}

/** Build a scored slice from a resolved verdict/value (deterministic path). */
function scored(
  criterionId: string,
  score: ScorecardSlice['score'],
  verdict: Verdict,
  value: number | string,
  evidence: EvidenceRef,
  note?: string,
): ScorecardSlice {
  const m = meta(criterionId);
  return {
    criterionId,
    stage: m.stage,
    score,
    verdict,
    value,
    evidence,
    ...(note ? { note } : {}),
    ieIds: [...m.ieLink],
    fixIds: m.ieLink.flatMap((ie) => ieFixes(ie)),
    engine: 'deterministic',
  };
}

/**
 * A '⚪' needs-instrumentation slice (excluded from the rollup denominator). The
 * evidence ref still points at where the value *would* live so the UI can show
 * the operator what to wire up.
 */
function needsInstrumentation(
  criterionId: string,
  evidence: EvidenceRef,
  missing: string,
  value: string = 'n/a',
): ScorecardSlice {
  const m = meta(criterionId);
  return {
    criterionId,
    stage: m.stage,
    score: null,
    verdict: '⚪',
    value,
    evidence,
    note: `[needs-instrumentation: ${missing}]`,
    ieIds: [...m.ieLink],
    fixIds: m.ieLink.flatMap((ie) => ieFixes(ie)),
    engine: 'deterministic',
  };
}

/** Resolve fixes for an IE via the authoritative IE→F map (fresh refs). */
function ieFixes(ieId: string): FixRef[] {
  return mapIeToFixes(ieId);
}

// ── event correlation ─────────────────────────────────────────────────────────

/** All events belonging to one job id (empty if none collected). */
function eventsForJob(events: AgentEvent[], jobId: string | undefined | null): AgentEvent[] {
  if (!jobId) return [];
  return events.filter((e) => e.jobId === jobId);
}

/**
 * Recover a job's end-to-end `durationMs` from its events. Prefer a terminal
 * `result`/`step_complete` event's own `durationMs`; fall back to the observed
 * timestamp span of the job's events. Returns null when the job has no events.
 */
function jobDurationMs(jobEvents: AgentEvent[]): number | null {
  if (jobEvents.length === 0) return null;
  const terminal = [...jobEvents]
    .reverse()
    .find(
      (e) =>
        (e.eventType === 'result' || e.eventType === 'step_complete') &&
        typeof e.durationMs === 'number',
    );
  if (terminal && typeof terminal.durationMs === 'number') return terminal.durationMs;
  const ts = jobEvents.map((e) => Date.parse(e.timestamp)).filter((n) => Number.isFinite(n));
  if (ts.length === 0) return null;
  return Math.max(...ts) - Math.min(...ts);
}

/** Count `tool_use` events for a job. */
function toolUseCount(jobEvents: AgentEvent[]): number {
  return jobEvents.filter((e) => e.eventType === 'tool_use').length;
}

// ── C-R2 — routing latency & discipline ───────────────────────────────────────
// §0.6: route job `durationMs`; route-job `tool_use` count.
// 🟢 durationMs≤60000 ∧ toolUseCount≤8 ; 🟡 durationMs≤180000 ; 🔴 >180000
function scoreC_R2(ctx: DetectorContext): ScorecardSlice {
  const routeJobId = ctx.plan.conceptRouteJobId;
  const evidence: EvidenceRef = {
    kind: 'ddb',
    ref: routeJobId ? `events#jobId=${routeJobId}` : 'plan.conceptRouteJobId',
  };

  // prototype plans bypass the Concept Router entirely (no route job) → N/A.
  if (!routeJobId) {
    return needsInstrumentation(
      'C-R2',
      evidence,
      'no conceptRouteJobId on plan (Router bypassed for prototype/legacy) — no route job to score',
    );
  }
  const jobEvents = eventsForJob(ctx.events, routeJobId);
  const dur = jobDurationMs(jobEvents);
  if (dur === null) {
    return needsInstrumentation(
      'C-R2',
      evidence,
      `route job ${routeJobId} events not present in collected events — cannot read durationMs/tool_use`,
    );
  }
  const tools = toolUseCount(jobEvents);

  let verdict: Verdict;
  let score: ScorecardSlice['score'];
  if (dur <= 60_000 && tools <= 8) {
    verdict = '🟢';
    score = 4;
  } else if (dur <= 180_000) {
    verdict = '🟡';
    score = 2;
  } else {
    verdict = '🔴';
    score = 0;
  }
  return scored(
    'C-R2',
    score,
    verdict,
    dur,
    evidence,
    `routeDurationMs=${dur}, toolUseCount=${tools}`,
  );
}

// ── C-D4 — citable structure (stable section ids) ─────────────────────────────
// §0.6: `<kind>.sections.json` H2 entries — 4=stable id for every H2; 0=≥1 missing.
// sections.json is a concept *artifact* (repo/S3), NOT in the DetectorContext.
function scoreC_D4(ctx: DetectorContext): ScorecardSlice {
  void ctx;
  return needsInstrumentation(
    'C-D4',
    { kind: 'artifact', ref: 'concept/<kind>.sections.json#h2[].id' },
    'sections.json artifacts are not loaded into DetectorContext (no S3 read of concept/<kind>.sections.json)',
  );
}

// ── C-D5 — generation efficiency (per-gen-job duration vs rigor budget) ────────
// §0.6: per-gen-job `durationMs`/cost vs rigor budget. 🟢 ≤budget; 🔴 >2×budget.
//
// Provisional rigor budget (ms) per gen-job. v0 calibration — single-run, NOT
// cross-validated (spec §4a calibration caveat). Labeled provisional in the note.
const GEN_RIGOR_BUDGET_MS: Record<string, number> = {
  prototype: 120_000,
  mvp: 240_000,
  production: 420_000,
};

function scoreC_D5(ctx: DetectorContext): ScorecardSlice {
  const jobMap = ctx.plan.conceptArtifactJobIds;
  const evidence: EvidenceRef = {
    kind: 'ddb',
    ref: 'plan.conceptArtifactJobIds → events#durationMs',
  };
  if (!jobMap || Object.keys(jobMap).length === 0) {
    return needsInstrumentation(
      'C-D5',
      evidence,
      'no conceptArtifactJobIds on plan (no concept generator jobs) — nothing to score',
    );
  }
  // Resolve each gen-job's duration from its events.
  const durations: Array<{ kind: string; jobId: string; durationMs: number }> = [];
  let anyMissing = false;
  for (const [kind, jobId] of Object.entries(jobMap)) {
    if (!jobId) continue;
    const dur = jobDurationMs(eventsForJob(ctx.events, jobId));
    if (dur === null) {
      anyMissing = true;
      continue;
    }
    durations.push({ kind, jobId, durationMs: dur });
  }
  if (durations.length === 0) {
    return needsInstrumentation(
      'C-D5',
      evidence,
      'concept generator job events not present in collected events — cannot read per-gen-job durationMs',
    );
  }

  const rigor = ctx.plan.rigor ?? 'mvp';
  const budget = GEN_RIGOR_BUDGET_MS[rigor] ?? GEN_RIGOR_BUDGET_MS.mvp;
  const worst = durations.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));

  let verdict: Verdict;
  let score: ScorecardSlice['score'];
  if (worst.durationMs <= budget) {
    verdict = '🟢';
    score = 4;
  } else if (worst.durationMs <= 2 * budget) {
    verdict = '🟡';
    score = 2;
  } else {
    verdict = '🔴';
    score = 0;
  }
  const note =
    `worst gen-job ${worst.kind}=${worst.durationMs}ms vs rigorBudget(${rigor})=${budget}ms` +
    (anyMissing ? ' [partial: some gen-job events absent]' : '') +
    ' [provisional v0 budget — single-run calibration, not cross-validated]';
  return scored('C-D5', score, verdict, worst.durationMs, evidence, note);
}

// ── C-P3 — decomposition sanity (epic/story tree wave widths) ─────────────────
// §0.6: epic/story tree shape (waves, stories/wave).
// 4 = ≥1 wave with width≥2 where stories independent; 1 = all waves width==1.
function scoreC_P3(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'ddb', ref: 'epics[].stories[].wave' };

  // Build wave→count across the whole plan. A story's wave is the parallel
  // bucket the planner computed; width = number of stories in a wave.
  const waveWidths = new Map<string, number>();
  let storyCount = 0;
  for (const epic of ctx.epics) {
    for (const story of epic.stories ?? []) {
      storyCount += 1;
      // Key per epic+wave: waves are epic-local (0-indexed per epic).
      const key = `${epic.epicId}#${story.wave ?? 0}`;
      waveWidths.set(key, (waveWidths.get(key) ?? 0) + 1);
    }
  }

  if (storyCount === 0) {
    return needsInstrumentation(
      'C-P3',
      evidence,
      'no stories on resolved epics — cannot assess decomposition shape',
    );
  }

  const widths = [...waveWidths.values()];
  const maxWidth = Math.max(...widths);
  const hasParallel = maxWidth >= 2;

  // Single-story plans can't decompose into parallel waves — not a defect.
  let verdict: Verdict;
  let score: ScorecardSlice['score'];
  if (hasParallel) {
    verdict = '🟢';
    score = 4;
  } else if (storyCount === 1) {
    // trivially serial; treat as acceptable (not a planning failure)
    verdict = '🟢';
    score = 4;
  } else {
    // every wave is width==1 despite multiple stories → serialized plan.
    verdict = '🟡';
    score = 1;
  }
  return scored(
    'C-P3',
    score,
    verdict,
    maxWidth,
    evidence,
    `${storyCount} stories across ${waveWidths.size} waves; maxWaveWidth=${maxWidth}`,
  );
}

// ── C-P4 — no dangling references ──────────────────────────────────────────────
// §0.6: `validateReferenceSections` result — 4=danglingCount==0; 0=≥1.
// That validator runs at plan-build time over story `references[]` against the
// concept docs' section ids; its result is not surfaced in the DetectorContext.
function scoreC_P4(ctx: DetectorContext): ScorecardSlice {
  void ctx;
  return needsInstrumentation(
    'C-P4',
    { kind: 'artifact', ref: 'validateReferenceSections#danglingCount' },
    'validateReferenceSections result is not in DetectorContext (concept-doc section-id resolution not run/loaded by the scorer)',
  );
}

// ── C-P5 — plan not emitted ungrounded (PRIOR_ARTIFACTS payload bytes) ─────────
// §0.6: pm-plan prompt `PRIOR_ARTIFACTS` payload bytes — 🔴 if priorArtifactsBytes==0.
// The pm-plan prompt variables are a transient assembly input, not persisted on
// the plan/epic rows nor in events → not available to the Lambda scorer.
function scoreC_P5(ctx: DetectorContext): ScorecardSlice {
  void ctx;
  return needsInstrumentation(
    'C-P5',
    { kind: 'log', ref: 'pm-plan.prompt#PRIOR_ARTIFACTS.bytes' },
    'pm-plan prompt PRIOR_ARTIFACTS payload bytes are not persisted (prompt-assembly var, not on plan/epic rows or events)',
  );
}

// ── C-G2 — approval-mode correctness ──────────────────────────────────────────
// §0.6: `conceptInteraction`; status transitions — 4=mode honored (YOLO
// auto-approve / interactive pause); 0=stalls on dead job.
// `plan.conceptInteraction` IS available, but verifying "honored vs stalled on a
// dead job" requires the concept job *status transition history*, which is not
// carried in the DetectorContext (events here are content events, not the job
// FSM transitions). We cannot decide honored-vs-stalled deterministically → ⚪.
function scoreC_G2(ctx: DetectorContext): ScorecardSlice {
  const mode = ctx.plan.conceptInteraction ?? '(default)';
  return needsInstrumentation(
    'C-G2',
    { kind: 'ddb', ref: 'concept-job#statusTransitions' },
    `conceptInteraction=${mode} is known, but concept-job status-transition history (honored vs stalled-on-dead-job) is not in DetectorContext`,
    String(mode),
  );
}

// ── C-G3 — chain visible & read-only after dev starts ─────────────────────────
// §0.6: plan rows visible post-dev-start — 4=full chain preserved read-only;
// 0=chain rows disappear. This is a UI/runtime read-side property; the scorer
// cannot observe whether the dashboard preserved the chain → ⚪.
function scoreC_G3(ctx: DetectorContext): ScorecardSlice {
  void ctx;
  return needsInstrumentation(
    'C-G3',
    { kind: 'ddb', ref: 'plan-dashboard#chainVisibility' },
    'post-dev-start chain visibility is a UI/runtime read-side property, not observable from the Lambda DetectorContext',
  );
}

// ── entrypoint ────────────────────────────────────────────────────────────────

/**
 * Score the deterministic CONCEPT-stage criteria. Returns one ScorecardSlice
 * per `[DET]` concept criterion (`engine: 'deterministic'`). Criteria whose
 * evidence isn't in the DetectorContext are emitted as '⚪'
 * needs-instrumentation slices (excluded from the rollup denominator).
 */
export function scoreConcept(ctx: DetectorContext): ScorecardSlice[] {
  return [
    scoreC_R2(ctx),
    scoreC_D4(ctx),
    scoreC_D5(ctx),
    scoreC_P3(ctx),
    scoreC_P4(ctx),
    scoreC_P5(ctx),
    scoreC_G2(ctx),
    scoreC_G3(ctx),
  ];
}
