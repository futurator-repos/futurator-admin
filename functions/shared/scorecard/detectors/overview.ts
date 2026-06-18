// Plan Retrospect — OVERVIEW (cross-cutting) deterministic detector
// (rubric §0.6 / §7 OV-table, spec §4a).
//
// Scores the `[DET]` overview criteria directly from the DetectorContext:
//   OV1  build-phase wall per story   (buildWall = reviewAt − startedAt ÷ doneStories)
//   OV2  cost vs ceiling              (totalCostUsd ÷ costCeilingUsd, honesty-guarded)
//   OV3  cost per story               (totalCostUsd ÷ doneStories, honesty-guarded)
//   OV4  forensic cost completeness   (agent-spend reconciliation deltaPct — F3 surface)
//   OV5  count integrity              (doneStories − totalStories; fix-forward via origin)
//   OV6  log retention across retries (orphaned job logs — ⚪ needs-instrumentation: F2)
//   OV7  per-session boilerplate      (availableSkillCount vs activatedSkills — secondary)
//   OV8  learning loop closed         (reflector written>0; ⚪ if rows not provided)
//   OV10 stage-time attribution       (byCategory sanity — a real category logging ~0ms)
//   OV11 agent-spawn precondition     (MCP-config spawn — daemon step_error; ⚪/log, 0 caps pipeline)
//
// OV9 is `[LLM]` (reflector signal quality) — owned by the Assessor, not here.
//
// Honesty guard (spec §4a): cost is NOT on AgentEvents — it is the daemon's
// walltime-derived agent-spend rows. OV4 reconciles Σ(agent-spend) against
// `plan.totalCostUsd`; when it does NOT reconcile (|deltaPct|>0.05 ∨ null), the
// cost-derived criteria OV2/OV3 are emitted with `value:"<lower-bound>"` +
// `confidence:"unreconciled"` rather than a falsely-precise number. We NEVER
// fabricate a value to avoid '⚪' — that is the credibility of the feature.

import type { DetectorContext, ScorecardSlice, EvidenceRef, Verdict, FixRef } from '../types';
import { CRITERIA_META } from '../criteria-meta';
import { mapIeToFixes } from '../ie-to-f-map';
import type { CategorySummary } from '../../timer/aggregator';
import type { AgentEvent } from '../../types/agent-orchestrator';

// ── slice helpers ─────────────────────────────────────────────────────────────

function meta(criterionId: string) {
  return CRITERIA_META[criterionId];
}

/** Resolve fixes for an IE via the authoritative IE→F map (fresh refs). */
function ieFixes(ieId: string): FixRef[] {
  return mapIeToFixes(ieId);
}

/**
 * Build a scored slice. By default the criterion's IE/fix links are attached;
 * a 🟢 verdict carries NO ieIds/fixIds (the IE is the *defect*, not the
 * criterion — matches the SK/concept detector convention).
 */
function scored(
  criterionId: string,
  score: ScorecardSlice['score'],
  verdict: Verdict,
  value: number | string,
  evidence: EvidenceRef,
  note?: string,
  extra?: Partial<ScorecardSlice>,
): ScorecardSlice {
  const m = meta(criterionId);
  const linkDefect = verdict !== '🟢';
  return {
    criterionId,
    stage: m.stage,
    score,
    verdict,
    value,
    evidence,
    ...(note ? { note } : {}),
    ieIds: linkDefect ? [...m.ieLink] : [],
    fixIds: linkDefect ? m.ieLink.flatMap((ie) => ieFixes(ie)) : [],
    engine: 'deterministic',
    ...extra,
  };
}

/**
 * A '⚪' needs-instrumentation slice (score null, excluded from the rollup
 * denominator). The evidence ref still points at where the value *would* live so
 * the UI can show the operator what to wire up. IE/fix links are preserved so
 * the operator still sees the addressed inefficiency even while it's dark.
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

// ── cost reconciliation (the §4a honesty-guard source) ────────────────────────

/**
 * Sum the plan's agent-spend rows (the daemon's walltime-derived cost). Returns
 * null when no rows carry a finite `costUsd` (spend table not provided / empty)
 * — drives OV4's '⚪' and the cost criteria's `unreconciled` flag.
 */
function sumAgentSpend(ctx: DetectorContext): number | null {
  const rows = ctx.agentSpendRows;
  if (!rows || rows.length === 0) return null;
  let sum = 0;
  let any = false;
  for (const row of rows) {
    if (typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)) {
      sum += row.costUsd;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * The reconciliation result OV4 scores and OV2/OV3 read for their honesty flag.
 * `deltaPct = |planTotalCostUsd − Σ agent-spend| ÷ planTotalCostUsd`. `null`
 * when either side is unknown (no spend rows / no plan cost) — OV4 then '⚪'-or-🔴
 * per its own rule, and the cost criteria fall to `unreconciled`.
 */
interface CostReconciliation {
  spend: number | null;
  planTotal: number | null;
  deltaPct: number | null;
  reconciled: boolean;
}

function reconcileCost(ctx: DetectorContext): CostReconciliation {
  const spend = sumAgentSpend(ctx);
  const planTotal =
    typeof ctx.plan.totalCostUsd === 'number' && Number.isFinite(ctx.plan.totalCostUsd)
      ? ctx.plan.totalCostUsd
      : null;
  if (spend === null || planTotal === null || planTotal <= 0) {
    return { spend, planTotal, deltaPct: null, reconciled: false };
  }
  const deltaPct = Math.abs(planTotal - spend) / planTotal;
  // OV4 green band is |deltaPct| ≤ 0.05 (rubric §0.6). Cost is "reconciled" for
  // the honesty guard at the same 0.05 threshold the rubric pins for OV4 green.
  return { spend, planTotal, deltaPct, reconciled: deltaPct <= 0.05 };
}

/** USD rounded to cents for display. */
function usd(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── OV1 — build-phase wall per story ──────────────────────────────────────────
// §0.6: `buildWall ÷ plan.doneStories` (buildWall = reviewAt − startedAt, §0.9).
// 🟢 ≤8min/story; 🟡 8–15; 🔴 >15 (rigor-scale, §11 Q1).
const OV1_GREEN_MIN = 8;
const OV1_YELLOW_MIN = 15;

function scoreOV1(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'ddb', ref: 'plan.(reviewAt−startedAt) ÷ doneStories' };
  const { startedAt, reviewAt, doneStories } = ctx.plan;

  if (!startedAt || !reviewAt) {
    return needsInstrumentation(
      'OV1',
      evidence,
      'plan.startedAt / plan.reviewAt not both set — build-phase wall (buildWall) cannot be computed (plan never reached review, or legacy plan)',
    );
  }
  const buildWallMs = Date.parse(reviewAt) - Date.parse(startedAt);
  if (!Number.isFinite(buildWallMs) || buildWallMs <= 0) {
    return needsInstrumentation(
      'OV1',
      evidence,
      `buildWall non-positive/unparseable (startedAt=${startedAt}, reviewAt=${reviewAt})`,
    );
  }
  if (!doneStories || doneStories <= 0) {
    return needsInstrumentation(
      'OV1',
      evidence,
      'plan.doneStories is 0 — no completed stories to amortize build wall over',
    );
  }

  const minPerStory = buildWallMs / 60_000 / doneStories;
  let verdict: Verdict;
  let score: ScorecardSlice['score'];
  if (minPerStory <= OV1_GREEN_MIN) {
    verdict = '🟢';
    score = 4;
  } else if (minPerStory <= OV1_YELLOW_MIN) {
    verdict = '🟡';
    score = 2;
  } else {
    verdict = '🔴';
    score = 0;
  }
  return scored(
    'OV1',
    score,
    verdict,
    Math.round(minPerStory * 10) / 10,
    evidence,
    `buildWall=${Math.round(buildWallMs / 60_000)}min ÷ ${doneStories} done = ${minPerStory.toFixed(1)}min/story [provisional v0 rigor budget — single-run calibration]`,
  );
}

// ── OV2 — cost vs ceiling (honesty-guarded) ───────────────────────────────────
// §0.6: `plan.totalCostUsd ÷ plan.costCeilingUsd`. 🟢 ≤1.0; 🟡 1.0–1.1; 🔴 >1.1.
function scoreOV2(ctx: DetectorContext, recon: CostReconciliation): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'ddb', ref: 'plan.totalCostUsd ÷ plan.costCeilingUsd' };
  const { totalCostUsd, costCeilingUsd } = ctx.plan;

  if (typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd)) {
    return needsInstrumentation(
      'OV2',
      evidence,
      'plan.totalCostUsd absent — no cost rollup to score',
    );
  }
  if (typeof costCeilingUsd !== 'number' || costCeilingUsd <= 0) {
    // Legacy plans run with no ceiling enforcement (plan.ts back-compat note) —
    // there is no budget to overrun, so this isn't a defect; it's unmeasurable.
    return needsInstrumentation(
      'OV2',
      evidence,
      'plan.costCeilingUsd absent (no ceiling enforced — legacy/back-compat plan) — no budget to score overrun against',
    );
  }

  const ratio = totalCostUsd / costCeilingUsd;
  let verdict: Verdict;
  let score: ScorecardSlice['score'];
  if (ratio <= 1.0) {
    verdict = '🟢';
    score = 4;
  } else if (ratio <= 1.1) {
    verdict = '🟡';
    score = 2;
  } else {
    verdict = '🔴';
    score = 0;
  }

  // Honesty guard: when absolute cost did NOT reconcile (OV4 gap), totalCostUsd
  // is a lower bound (orphaned/superseded spend undercounts), so the ratio is a
  // lower bound too — flag confidence and report a lower-bound value.
  if (!recon.reconciled) {
    return scored(
      'OV2',
      score,
      verdict,
      `≥${Math.round(ratio * 100) / 100} (lower-bound)`,
      evidence,
      `cost/ceiling ratio is a LOWER BOUND — absolute cost unreconciled (OV4 deltaPct=${recon.deltaPct === null ? 'null' : recon.deltaPct.toFixed(3)}); orphaned/superseded spend undercounts totalCostUsd`,
      { confidence: 'unreconciled' },
    );
  }
  return scored(
    'OV2',
    score,
    verdict,
    Math.round(ratio * 100) / 100,
    evidence,
    `$${usd(totalCostUsd)} ÷ $${usd(costCeilingUsd)} = ${ratio.toFixed(2)}× ceiling`,
    { confidence: 'reconciled' },
  );
}

// ── OV3 — cost per story (honesty-guarded) ────────────────────────────────────
// §0.6: `plan.totalCostUsd ÷ plan.doneStories`. 🟢 ≤$1.0; 🟡 $1–$1.5; 🔴 >$1.5.
const OV3_GREEN_USD = 1.0;
const OV3_YELLOW_USD = 1.5;

function scoreOV3(ctx: DetectorContext, recon: CostReconciliation): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'ddb', ref: 'plan.totalCostUsd ÷ plan.doneStories' };
  const { totalCostUsd, doneStories } = ctx.plan;

  if (typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd)) {
    return needsInstrumentation(
      'OV3',
      evidence,
      'plan.totalCostUsd absent — no cost rollup to score',
    );
  }
  if (!doneStories || doneStories <= 0) {
    return needsInstrumentation(
      'OV3',
      evidence,
      'plan.doneStories is 0 — no completed stories to amortize cost over',
    );
  }

  const perStory = totalCostUsd / doneStories;
  let verdict: Verdict;
  let score: ScorecardSlice['score'];
  if (perStory <= OV3_GREEN_USD) {
    verdict = '🟢';
    score = 4;
  } else if (perStory <= OV3_YELLOW_USD) {
    verdict = '🟡';
    score = 2;
  } else {
    verdict = '🔴';
    score = 0;
  }

  if (!recon.reconciled) {
    return scored(
      'OV3',
      score,
      verdict,
      `≥$${usd(perStory)} (lower-bound)`,
      evidence,
      `cost/story is a LOWER BOUND — absolute cost unreconciled (OV4 deltaPct=${recon.deltaPct === null ? 'null' : recon.deltaPct.toFixed(3)}) [provisional v0 budget — single-run calibration]`,
      { confidence: 'unreconciled' },
    );
  }
  return scored(
    'OV3',
    score,
    verdict,
    usd(perStory),
    evidence,
    `$${usd(totalCostUsd)} ÷ ${doneStories} done = $${usd(perStory)}/story [provisional v0 budget — single-run calibration]`,
    { confidence: 'reconciled' },
  );
}

// ── OV4 — forensic cost completeness (retry-walk reconciliation; F3) ──────────
// §0.6: `forensic.costReconciliation.deltaPct`. 🟢 |deltaPct|≤0.05; 🟡 0.05–0.15;
// 🔴 >0.15 ∨ null. The forensic object isn't on the DetectorContext, so we
// reconcile the same two quantities the F3 field reconciles — Σ(agent-spend
// rows, the walltime-derived cost) vs `plan.totalCostUsd` (spec §4a: cost is on
// the agent-spend table, NOT on events). Absent spend rows → '⚪' (can't read
// the reconciliation), NOT a fabricated 🔴.
function scoreOV4(ctx: DetectorContext, recon: CostReconciliation): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'forensic', ref: 'costReconciliation.deltaPct' };

  if (recon.spend === null) {
    return needsInstrumentation(
      'OV4',
      { kind: 'ddb', ref: 'agent-spend#planId=' + ctx.planId },
      'no agent-spend rows provided to the scorer — cannot read Σ(walltime-derived cost) to reconcile against plan.totalCostUsd (forensic.costReconciliation not in DetectorContext)',
    );
  }
  if (recon.planTotal === null) {
    return needsInstrumentation(
      'OV4',
      evidence,
      'plan.totalCostUsd absent/zero — reconciliation denominator undefined',
    );
  }

  const delta = recon.deltaPct as number;
  const { ieIds, fixIds } = {
    ieIds: [...meta('OV4').ieLink],
    fixIds: meta('OV4').ieLink.flatMap(ieFixes),
  };
  let verdict: Verdict;
  let score: ScorecardSlice['score'];
  if (delta <= 0.05) {
    verdict = '🟢';
    score = 4;
  } else if (delta <= 0.15) {
    verdict = '🟡';
    score = 2;
  } else {
    verdict = '🔴';
    score = 0;
  }
  return {
    criterionId: 'OV4',
    stage: 'overview',
    score,
    verdict,
    value: Math.round(delta * 1000) / 1000,
    evidence,
    note: `Σ(agent-spend)=$${usd(recon.spend)} vs plan.totalCostUsd=$${usd(recon.planTotal)} → |deltaPct|=${delta.toFixed(3)} (residual: per-category slice attribution still keys off current jobs — F3 note)`,
    // IE3→F3(shipped); attach the link even on 🟢 so the operator sees the
    // shipped reconciliation source (OV4 is the F3 surface, §0.6).
    ieIds,
    fixIds,
    engine: 'deterministic',
  };
}

// ── OV5 — count integrity (doneStories ≤ totalStories) ────────────────────────
// §0.6: `plan.doneStories − plan.totalStories` (fix-forward via origin=='wave-vqa-fix').
// 🟢 ≤0 & consistent; 🔴 `done>total`. Fix-forward: wave-vqa-fix stories are
// legitimately added to the plan during the run, so the right denominator
// includes them — a `done>total` then signals a real counter drift (IE4), not a
// fix-forward artifact.
function scoreOV5(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'ddb', ref: 'plan.doneStories − plan.totalStories' };
  const { doneStories, totalStories } = ctx.plan;

  if (typeof doneStories !== 'number' || typeof totalStories !== 'number') {
    return needsInstrumentation(
      'OV5',
      evidence,
      'plan.doneStories / plan.totalStories not both numeric — cannot check count integrity',
    );
  }

  // Count fix-forward stories minted by the wave gate (origin === 'wave-vqa-fix').
  let fixForwardCount = 0;
  for (const epic of ctx.epics) {
    for (const story of epic.stories ?? []) {
      if (story.origin === 'wave-vqa-fix') fixForwardCount += 1;
    }
  }

  const delta = doneStories - totalStories;
  if (delta > 0) {
    // done > total — a genuine counter drift even accounting for fix-forward
    // (those stories are already in totalStories once minted). IE4 → F4.
    return scored(
      'OV5',
      0,
      '🔴',
      delta,
      evidence,
      `doneStories(${doneStories}) > totalStories(${totalStories}) by ${delta} — counter drift (IE4); ${fixForwardCount} wave-vqa-fix story(ies) observed (fix-forward accounting does not explain done>total)`,
    );
  }
  return scored(
    'OV5',
    4,
    '🟢',
    delta,
    evidence,
    `doneStories(${doneStories}) ≤ totalStories(${totalStories}); ${fixForwardCount} wave-vqa-fix fix-forward story(ies)`,
  );
}

// ── OV6 — log retention across retries (orphaned job logs) ────────────────────
// §0.6: jobs in agent-events vs jobs referenced by `story.jobId ∪ retryOf-chain`
// — `[needs-instrumentation: F2]` for `priorJobIds` materialization. 🟢 all
// reachable; 🔴 ≥1 orphaned job log. The authoritative reachability set requires
// `priorJobIds[]` (gated on the unshipped F2); until then we read the retryOf
// chain as an interim witness but cannot assert completeness → honest '⚪'.
function scoreOV6(ctx: DetectorContext): ScorecardSlice {
  // Interim witness: which job ids appear in events vs which are referenced by a
  // story.jobId. We surface the count in the note but do NOT score — the
  // orphan-completeness claim is gated on F2's priorJobIds materialization.
  const jobIdsInEvents = new Set<string>();
  for (const e of ctx.events) if (e.jobId) jobIdsInEvents.add(e.jobId);

  const referencedJobIds = new Set<string>();
  for (const epic of ctx.epics) {
    for (const story of epic.stories ?? []) {
      if (story.jobId) referencedJobIds.add(story.jobId);
    }
  }
  const unreferenced = [...jobIdsInEvents].filter((id) => !referencedJobIds.has(id)).length;

  return needsInstrumentation(
    'OV6',
    { kind: 'ddb', ref: 'jobs(agent-events) vs story.jobId ∪ retryOf-chain' },
    `F2 — orphaned-log reachability needs priorJobIds[] materialization (not yet written; gated on F2). Interim: ${jobIdsInEvents.size} job(s) in events, ${unreferenced} not referenced by any story.jobId — cannot assert orphan-completeness without the retryOf/priorJobIds union`,
    String(unreferenced),
  );
}

// ── OV7 — per-session boilerplate overhead (skills catalog injected vs used) ──
// §0.6: `sk.availableSkillCount` vs `sk.activatedSkills.length`. 🟢 catalog
// scoped to need; 🔴 large unused catalog × every session. SECONDARY signal
// (§12 #4: the primary lever is SK2/SK3 activation+relevance, NOT prune) — so a
// breach scores 🟡, never the catastrophic 🔴 that would over-anchor on one run.
const OV7_LARGE_CATALOG = 40;
const OV7_LOW_ACTIVATION_FRAC = 0.1;

function scoreOV7(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = {
    kind: 'forensic',
    ref: 'skills.availableSkillCount/activatedSkills',
  };
  const sk = ctx.skills;
  if (!sk) {
    return needsInstrumentation(
      'OV7',
      evidence,
      'forensic.skills is null — no skills_available/skill_activated events observed (pre-Epic-4 plan)',
    );
  }
  const available = sk.availableSkillCount ?? 0;
  const activated = sk.activatedSkills.length;

  if (available === 0) {
    return needsInstrumentation(
      'OV7',
      evidence,
      'no session reported availableSkillCount (skills_available probe absent) — catalog size unknown',
    );
  }

  const activationFrac = activated / available;
  // Large unused catalog injected every session = wasted per-session boilerplate.
  if (available >= OV7_LARGE_CATALOG && activationFrac <= OV7_LOW_ACTIVATION_FRAC) {
    return scored(
      'OV7',
      2,
      '🟡',
      activated,
      evidence,
      `large catalog (${available} skills) with low activation (${activated} used, ${Math.round(activationFrac * 100)}%) injected per session — SECONDARY D2 cost signal; primary lever is SK2/SK3 activation+relevance, not prune (§12 #4)`,
    );
  }
  return scored(
    'OV7',
    4,
    '🟢',
    activated,
    evidence,
    `${available} available / ${activated} activated (${Math.round(activationFrac * 100)}%) — catalog overhead not the dominant cost`,
  );
}

// ── OV8 — learning loop closed (reflector fired AND written AND surfaced) ──────
// §0.6: daemon `reflector … written=n`; `inbox/reflections.md` non-empty.
// 🟢 `written>0` & visible; 🔴 `written==0` / IAM-blocked. We read the written
// count from ctx.reflections (the reflection rows). The daemon `written=n` log
// line is NOT in the DetectorContext, so when rows are absent we emit '⚪'
// (cannot distinguish "no rows written" from "rows not provided to scorer")
// rather than a fabricated 🔴.
function scoreOV8(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'ddb', ref: 'reflections#planId (written count)' };
  const reflections = ctx.reflections;

  if (!Array.isArray(reflections)) {
    return needsInstrumentation(
      'OV8',
      evidence,
      'reflector rows not provided to the scorer — cannot read written>0; the daemon `reflector … written=n` log line is not in DetectorContext (OV8/F5 IAM-blocked write-loss is the defect this would surface)',
    );
  }

  const written = reflections.length;
  if (written === 0) {
    return scored(
      'OV8',
      0,
      '🔴',
      0,
      evidence,
      'reflector wrote 0 proposals this plan — learning loop did not close (write-loss / IAM-blocked, IE5→F5)',
    );
  }
  return scored(
    'OV8',
    4,
    '🟢',
    written,
    evidence,
    `reflector wrote ${written} proposal(s) — learning loop closed and surfaced to the inbox`,
  );
}

// ── OV10 — stage-time attribution correctness ─────────────────────────────────
// §0.6: `aggregate.byCategory` sanity — 🔴 if a real category logs ~0ms while
// that work happened (e.g. `fix`=0.2s while fixes happened). We cross-reference
// observable proxies for "work happened": a wave-vqa-fix story implies `fix`
// work; a non-empty `qaContractStatus`/qaJobId implies `qa`/`vqa-gate` work.
// When a category logs ~0ms despite its proxy firing, attribution is broken.
const NEAR_ZERO_MS = 1_000; // ≤1s for a whole-plan category = "logged ~0".

function scoreOV10(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'forensic', ref: 'aggregate.byCategory' };

  // Proxies: did this kind of work demonstrably happen?
  let fixWorkHappened = false;
  for (const epic of ctx.epics) {
    for (const story of epic.stories ?? []) {
      if (story.origin === 'wave-vqa-fix') fixWorkHappened = true;
    }
  }
  const qaWorkHappened = Boolean(ctx.plan.qaJobId || ctx.plan.qaContractStatus);

  const cat = (c: string): CategorySummary => ctx.byCat(c);
  const suspicions: string[] = [];
  if (fixWorkHappened && cat('fix').totalMs <= NEAR_ZERO_MS) {
    suspicions.push(`fix=${cat('fix').totalMs}ms while ≥1 wave-vqa-fix story exists`);
  }
  if (
    qaWorkHappened &&
    cat('qa').totalMs <= NEAR_ZERO_MS &&
    cat('vqa-gate').totalMs <= NEAR_ZERO_MS
  ) {
    // NB: qa runs AFTER reviewAt; a qa=0ms build-phase slice is an OV4/IE2
    // forensic-completeness artifact (rubric §4 correction), not necessarily an
    // attribution bug. We note it but do not treat it as the OV10 defect.
    suspicions.push(
      `qa/vqa-gate≈0ms despite qaJobId/contract set — likely the build-phase-slice-window artifact (§4), cross-check qaJobId before treating as misattribution`,
    );
  }

  // The hard OV10 red is the `fix`≈0 case (clear-cut: fixes happened, category
  // empty). The qa note is advisory (known artifact), not a red on its own.
  if (fixWorkHappened && cat('fix').totalMs <= NEAR_ZERO_MS) {
    return scored(
      'OV10',
      0,
      '🔴',
      cat('fix').totalMs,
      evidence,
      `stage-time misattribution: ${suspicions.join('; ')}`,
    );
  }

  // No clear-cut misattribution proxy fired. If we had NO proxies at all we
  // can't really assert correctness — but byCategory sanity is a weak, always-
  // available check, so score 🟢 with the advisory note when present.
  return scored(
    'OV10',
    4,
    '🟢',
    cat('fix').totalMs,
    evidence,
    suspicions.length > 0
      ? `byCategory plausible; advisory: ${suspicions.join('; ')}`
      : 'byCategory attribution plausible (no real-work category logging ~0ms)',
  );
}

// ── OV11 — agent-spawn precondition integrity (forces F at 0, §0.4) ───────────
// §0.6: daemon `step_error` "MCP config file not found"; `mcp-config.mjs`
// existsSync/mkdirSync guard; `MYCELIUM_MCP` flag. 🟢 spawn preconditions
// satisfied/self-healing; 0 = any agent job dies at spawn for a missing injected
// prereq → forces F (§0.4). We can DETECT the failure signature from the events:
// a `step_error` whose message mentions "MCP config". If such an event exists,
// an agent died at spawn → score 0 (forces F). If NO such signature exists we
// CANNOT prove preconditions were satisfied vs. the run simply not logging the
// step — so absent the signature we still score 🟢 IF agent jobs demonstrably
// ran (events present), else '⚪'. This avoids both a fabricated green and a
// missed forced-F.
function scoreOV11(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = {
    kind: 'log',
    ref: "events#eventType=step_error contains 'MCP config'",
  };

  // Scan events for the spawn-precondition failure signature.
  const spawnFailure = ctx.events.find((e) => {
    if (e.eventType !== 'step_error') return false;
    const msg = extractMessage(e).toLowerCase();
    return (
      msg.includes('mcp config') ||
      (msg.includes('mcp') && msg.includes('not found')) ||
      msg.includes('config file not found')
    );
  });

  if (spawnFailure) {
    const { ieIds, fixIds } = {
      ieIds: [...meta('OV11').ieLink],
      fixIds: meta('OV11').ieLink.flatMap(ieFixes),
    };
    return {
      criterionId: 'OV11',
      stage: 'overview',
      score: 0,
      verdict: '🔴',
      value: 'spawn-precondition failure',
      evidence: {
        kind: 'log',
        ref: spawnFailure.jobId ? `events#jobId=${spawnFailure.jobId}#step_error` : evidence.ref,
      },
      note: `an agent job died at spawn for a missing injected prereq (MCP config) — forces overall F (§0.4); MYCELIUM_MCP / mcp-config.mjs existsSync/mkdirSync guard (IE23→F23)`,
      ieIds,
      fixIds,
      engine: 'deterministic',
    };
  }

  // No failure signature. Did agent jobs demonstrably spawn? (events exist).
  if (ctx.events.length === 0) {
    return needsInstrumentation(
      'OV11',
      evidence,
      'no events collected — cannot observe spawn-precondition `step_error` signatures (and cannot confirm any agent spawned); MCP-config guard state is daemon-log-only',
    );
  }
  return scored(
    'OV11',
    4,
    '🟢',
    'no spawn-precondition failure',
    evidence,
    'no MCP-config spawn `step_error` observed across the plan’s events — agent jobs spawned with their injected prerequisites present',
  );
}

/**
 * Best-effort message text for an agent event — concatenates the real text-
 * bearing fields on AgentEvent (`errorMessage`, `errorStack`, `text`,
 * `toolOutput`, and any string-ish `payload` entries) so the spawn-precondition
 * signature match works regardless of which field the daemon used.
 */
function extractMessage(e: AgentEvent): string {
  const parts: string[] = [];
  if (typeof e.errorMessage === 'string') parts.push(e.errorMessage);
  if (typeof e.errorStack === 'string') parts.push(e.errorStack);
  if (typeof e.text === 'string') parts.push(e.text);
  if (typeof e.toolOutput === 'string') parts.push(e.toolOutput);
  if (e.payload) {
    for (const v of Object.values(e.payload)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join(' ');
}

// ── entrypoint ────────────────────────────────────────────────────────────────

/**
 * Score the deterministic OVERVIEW (cross-cutting) criteria. Returns one
 * ScorecardSlice per `[DET]` overview criterion (`engine: 'deterministic'`), in
 * stable id order. OV9 is `[LLM]` (the Assessor) and is NOT emitted here.
 *
 * Criteria whose evidence isn't in the DetectorContext are emitted as '⚪'
 * needs-instrumentation slices (excluded from the rollup denominator) — never
 * fabricated. The cost-derived OV2/OV3 carry the §4a honesty-guard
 * `confidence` flag, computed once from the OV4 reconciliation.
 */
export function scoreOverview(ctx: DetectorContext): ScorecardSlice[] {
  const recon = reconcileCost(ctx);
  return [
    scoreOV1(ctx),
    scoreOV2(ctx, recon),
    scoreOV3(ctx, recon),
    scoreOV4(ctx, recon),
    scoreOV5(ctx),
    scoreOV6(ctx),
    scoreOV7(ctx),
    scoreOV8(ctx),
    scoreOV10(ctx),
    scoreOV11(ctx),
  ];
}
