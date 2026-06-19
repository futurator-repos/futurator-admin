// Plan Retrospect — QA stage deterministic detectors (rubric §0.6 / §4).
//
// Implements the `[DET]` QA criteria that score from data already available to
// the API Lambda (the parsed qa-report + agent-spend rows + the plan row):
//
//   Q-C5  qa-job cost vs rigor budget       (honesty-guarded — rubric §0.5/§0.6)
//   Q-C6  evidence-capture integrity        (SCREENSHOTS_CAPTURED ratio + byte-diversity → IE14/F12)
//   Q-C7  honest verdict under broken evidence (errored vs blocking-fail → IE15/F12)
//   Q-C9  stage isolation                   (devserver restart / overlapping windows → IE13/F11)
//
// Honesty is a feature (spec §4a honesty guard): where the evidence is log-only
// (the daemon devserver.log, the F12 evidence-integrity.json sidecar) and is NOT
// surfaced into the DetectorContext, the slice is emitted with verdict '⚪' and a
// `[needs-instrumentation: …]` note rather than a fabricated value. The slice is
// then excluded from the rollup denominator (rubric §0.4).
//
// Sources:
//   - rubric §0.6 rows Q-C5/Q-C6/Q-C7/Q-C9 (evidenceField + thresholdExpr)
//   - rubric §4 (QA stage tables, pacman3 calibration: 6 fail / 4 uncertain on a
//     correct app — Q-C6/Q-C7/Q-C9 all 0)
//   - plan-retrospect-spec §4a (honesty guard) / §4d (ScorecardSlice)
//   - qa-report-aggregator.ts (VqaRollup: results[], costUsd, errored, contract)
//   - visual-qa-pipeline.ts (evidence-integrity.json + SCREENSHOTS_CAPTURED — the
//     F12 sidecar; log-only today → drives the ⚪ branches)

import type { DetectorContext, ScorecardSlice, EvidenceRef, Verdict, FixRef } from '../types';
import type { QaReport, VqaTestResult } from '../../types/qa-report';
import { CRITERIA_META } from '../criteria-meta';
import { mapIeToFixes } from '../ie-to-f-map';
import { COST_CEILING_BY_RIGOR } from '../../services/cost-ceiling-defaults';
import type { PlanRigor } from '../../types/plan';

// ── slice helper ─────────────────────────────────────────────────────────────

/**
 * Build a ScorecardSlice for a QA criterion, pulling its stage from
 * CRITERIA_META so the rollup weighting/cap logic agrees with the index.
 */
function qaSlice(
  criterionId: string,
  args: {
    score: ScorecardSlice['score'];
    verdict: Verdict;
    value: number | string;
    evidence: EvidenceRef;
    note?: string;
    ieIds?: string[];
    fixIds?: FixRef[];
    confidence?: 'reconciled' | 'unreconciled';
  },
): ScorecardSlice {
  const meta = CRITERIA_META[criterionId];
  return {
    criterionId,
    stage: meta.stage,
    score: args.score,
    verdict: args.verdict,
    value: args.value,
    evidence: args.evidence,
    note: args.note,
    ieIds: args.ieIds ?? [],
    fixIds: args.fixIds ?? [],
    confidence: args.confidence,
    engine: 'deterministic',
  };
}

/** A `⚪` needs-instrumentation slice — scored null, excluded from the rollup. */
function needsInstrumentation(
  criterionId: string,
  missing: string,
  evidence: EvidenceRef,
  extra?: { ieIds?: string[]; fixIds?: FixRef[] },
): ScorecardSlice {
  return qaSlice(criterionId, {
    score: null,
    verdict: '⚪',
    value: 'n/a',
    evidence,
    note: `[needs-instrumentation: ${missing}]`,
    ieIds: extra?.ieIds,
    fixIds: extra?.fixIds,
  });
}

// ── input access ─────────────────────────────────────────────────────────────

/**
 * The qa-report comes into the DetectorContext as `unknown` (the scorer wires it
 * from `buildQaReport`). Narrow it without trusting the shape blindly — a missing
 * report drives the ⚪ branches, never a throw.
 */
function asQaReport(raw: unknown): QaReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<QaReport>;
  // `vqa` is the only block these detectors read; require it to be an object.
  if (!r.vqa || typeof r.vqa !== 'object') return null;
  return r as QaReport;
}

/** Sum the plan's agent-spend rows (the daemon's walltime-derived cost). */
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
 * Honesty guard (spec §4a): cost-derived criteria report a falsely-precise
 * number ONLY when spend reconciles against `plan.totalCostUsd` within ±15%.
 * Returns `reconciled` when both costs are known and the delta is within band;
 * `unreconciled` otherwise (the retry-orphan gap → spend rows undercount).
 */
function costConfidence(ctx: DetectorContext): {
  confidence: 'reconciled' | 'unreconciled';
  deltaPct: number | null;
} {
  const spend = sumAgentSpend(ctx);
  const planTotal = ctx.plan.totalCostUsd;
  if (spend === null || typeof planTotal !== 'number' || planTotal <= 0) {
    return { confidence: 'unreconciled', deltaPct: null };
  }
  const deltaPct = Math.abs(planTotal - spend) / planTotal;
  return { confidence: deltaPct <= 0.15 ? 'reconciled' : 'unreconciled', deltaPct };
}

// ── Q-C5 — qa-job cost vs rigor budget (honesty-guarded) ─────────────────────
//
// rubric §0.6: evidenceField = "forensic qa-job `cost` vs rigor budget"; thresh =
// "🟢 within budget; 🔴 >2×budget (`unreconciled` if cost gap)".
//
// Budget: the QA run's contract carries the classifier's `estimatedCostUsd`
// (the per-rigor-capped projection). When that is absent we fall back to a small
// fraction of the rigor cost-ceiling as the QA-portion budget. Actual: the run's
// `vqa.costUsd`. When the absolute cost does not reconcile (OV4 gap), we do NOT
// emit a falsely-precise score — we mark `unreconciled` and report the lower
// bound (spec §4a). We still emit a verdict so the QA stage isn't dark, but flag
// the confidence so the UI renders the caveat chip.
function scoreQc5(ctx: DetectorContext, report: QaReport | null): ScorecardSlice {
  const id = 'Q-C5';
  const evidence: EvidenceRef = { kind: 'report', ref: 'qa-report.vqa.costUsd' };

  const actual = report?.vqa.costUsd;
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    // No QA run cost recorded (QA skipped / prototype / not-run). Not a defect —
    // there's nothing to score against a budget.
    return needsInstrumentation(
      id,
      'no QA-run cost on the qa-report (vqa.costUsd absent — QA skipped or not-run)',
      evidence,
    );
  }

  const rigor: PlanRigor = ctx.plan.rigor ?? 'mvp';
  // Budget = the contract's classifier estimate when present; else a conservative
  // QA-share of the rigor ceiling (the QA stage shouldn't consume the whole plan
  // budget — 25% is the §6.2 working assumption, stated explicitly here).
  const QA_SHARE_OF_CEILING = 0.25;
  const contractEstimate = report?.vqa.contract?.estimatedCostUsd;
  const budget =
    typeof contractEstimate === 'number' && contractEstimate > 0
      ? contractEstimate
      : COST_CEILING_BY_RIGOR[rigor] * QA_SHARE_OF_CEILING;

  const ratio = budget > 0 ? actual / budget : Infinity;
  // 🟢 within budget; 🟡 over but ≤2×; 🔴 >2× (architect-style blowup).
  let score: ScorecardSlice['score'];
  let verdict: Verdict;
  if (ratio <= 1) {
    score = 4;
    verdict = '🟢';
  } else if (ratio <= 2) {
    score = 2;
    verdict = '🟡';
  } else {
    score = 0;
    verdict = '🔴';
  }

  const { confidence } = costConfidence(ctx);
  // §4a honesty guard: when cost doesn't reconcile, report the lower bound and
  // flag it `unreconciled` rather than a falsely-precise number.
  const value =
    confidence === 'unreconciled'
      ? `≥$${actual.toFixed(4)} vs ~$${budget.toFixed(4)} budget (lower-bound)`
      : Number(ratio.toFixed(3));

  return qaSlice(id, {
    score,
    verdict,
    value,
    evidence,
    confidence,
    note:
      confidence === 'unreconciled'
        ? 'cost gap: plan spend did not reconcile within ±15% — QA cost is a lower bound (spec §4a honesty guard)'
        : `QA run $${actual.toFixed(4)} vs $${budget.toFixed(4)} ${rigor} budget`,
  });
}

// ── Q-C6 — evidence-capture integrity ────────────────────────────────────────
//
// rubric §0.6: evidenceField = "`SCREENSHOTS_CAPTURED n/m`; S3 per-test file
// count; image byte-diversity (md5/size)"; thresh = "🟢 capturedRatio≥0.95 ∧
// distinct; 🔴 <0.50 ∨ all-identical". IE14 / F12.
//
// The authoritative source is the F12 evidence-integrity.json sidecar
// (`{captured, authored, ratio, tests:{[id]:{ok,size,hash,identical}}}`), which
// carries the byte-diversity (sha1) signal. That sidecar is written to the
// daemon's tmp results dir and emitted to the daemon log as `EVIDENCE_INTEGRITY`
// / `SCREENSHOTS_CAPTURED` — it is NOT surfaced into the DetectorContext today.
//
// What IS available from the qa-report is the per-test result list with each
// test's `status` + `screenshotUrl`. We derive a usable-frame proxy from it:
// a frame is "usable" when the test produced a verdict other than `errored` and
// (when present) carries a screenshotUrl. Byte-diversity (the "all-identical"
// red) genuinely requires the sidecar hashes → that half stays ⚪.
function scoreQc6(ctx: DetectorContext, report: QaReport | null): ScorecardSlice {
  const id = 'Q-C6';
  const ieIds = CRITERIA_META[id].ieLink; // ['IE14']
  const fixIds = mapIeToFixes('IE14'); // F12 (open)
  // STUCK_CAPTURE wiring (2026-06-19) — authoritative path: the qa-prepare
  // evidence-integrity summary (sidecar → qa-report.vqa.evidenceIntegrity) now
  // carries the byte-diversity signal. This closes the [needs-instrumentation]
  // gap: we can red an all-identical / wrong-surface capture (pacman2), not just
  // a missing one. Full red = the capture gate failed, OR <50% usable, OR frames
  // are stuck (most share one content hash).
  const ei = report?.vqa.evidenceIntegrity;
  if (ei) {
    const eiEvidence: EvidenceRef = { kind: 'report', ref: 'qa-report.vqa.evidenceIntegrity' };
    let score: ScorecardSlice['score'];
    let verdict: Verdict;
    if (ei.integrityFailed || ei.ratio < 0.5 || ei.stuckCapture) {
      score = 0;
      verdict = '🔴';
    } else if (ei.ratio >= 0.95) {
      score = 4;
      verdict = '🟢';
    } else {
      score = 2;
      verdict = '🟡';
    }
    const diversity = ei.stuckCapture
      ? `STUCK: ${Math.round((ei.dominantRatio ?? 0) * 100)}% of frames identical (wrong/idle surface — not a real capture)`
      : `distinct frames=${ei.distinctHashes ?? '?'}`;
    return qaSlice(id, {
      score,
      verdict,
      value: Number(ei.ratio.toFixed(3)),
      evidence: eiEvidence,
      ieIds,
      fixIds,
      note: `${ei.captured}/${ei.authored} usable frames (ratio=${ei.ratio.toFixed(2)}); ${diversity}`,
    });
  }

  const evidence: EvidenceRef = { kind: 'report', ref: 'qa-report.vqa.results[].status' };

  const results: VqaTestResult[] = report?.vqa.results ?? [];
  // Only count tests that actually ran under a completed QA run — pending tests
  // (no run landed) aren't a capture failure.
  const ran = results.filter((r) => r.status !== 'pending');
  if (ran.length === 0) {
    return needsInstrumentation(
      id,
      'no executed visual tests on the qa-report (vqa.results empty / all pending — QA did not capture frames)',
      evidence,
      { ieIds, fixIds },
    );
  }

  // Usable-frame proxy: `errored` = judge saw a missing/blank/404 frame (the
  // pipeline stamps `errored` with rationale "evidence missing"). Everything
  // else (pass/fail/uncertain/skipped-budget) had a judgeable frame.
  const errored = ran.filter((r) => r.status === 'errored').length;
  const usable = ran.length - errored;
  const capturedRatio = usable / ran.length;

  // 🟢 ≥0.95; 🔴 <0.50; 🟡 between. NOTE: the byte-diversity ("all-identical")
  // half of the red rule is NOT evaluable here (needs the sidecar sha1 hashes) —
  // surfaced in the note so the verdict isn't read as a full Q-C6 pass.
  let score: ScorecardSlice['score'];
  let verdict: Verdict;
  if (capturedRatio >= 0.95) {
    score = 4;
    verdict = '🟢';
  } else if (capturedRatio >= 0.5) {
    score = 2;
    verdict = '🟡';
  } else {
    score = 0;
    verdict = '🔴';
  }

  return qaSlice(id, {
    score,
    verdict,
    value: Number(capturedRatio.toFixed(3)),
    evidence,
    ieIds,
    fixIds,
    note:
      `capturedRatio ${usable}/${ran.length} usable frames (errored=${errored})` +
      ' — byte-diversity (all-identical) not evaluated [needs-instrumentation: evidence-integrity.json sidecar (F12) not surfaced to the Lambda; sha1 byte-diversity unavailable]',
  });
}

// ── Q-C7 — honest verdict under broken evidence ──────────────────────────────
//
// rubric §0.6: evidenceField = "qa-report `overall` rule vs per-test rationale +
// file existence/size"; thresh = "4=missing/404/blank/<2KB frame → `errored`→
// retry, never blocking `fail`; 0=missing frame → blocking FAIL". IE15 / F12.
//
// The honest behaviour (post-F12) is: a broken-evidence test resolves to
// `errored` (which routes to retry / operator) and NEVER to a blocking `fail`.
// The dishonest behaviour (pacman3 / IE15) was: a missing frame scored a
// blocking FAIL, burying a correct app. We detect the dishonest class by looking
// for FAIL tests whose rationale signals broken evidence (missing/404/blank).
const BROKEN_EVIDENCE_RE =
  /\b(missing|not\s+captured|404|blank|empty|no\s+screenshot|evidence\s+missing|<\s*2\s*kb|read[- ]error|unresolvable)\b/i;

function scoreQc7(ctx: DetectorContext, report: QaReport | null): ScorecardSlice {
  const id = 'Q-C7';
  const ieIds = CRITERIA_META[id].ieLink; // ['IE15']
  const fixIds = mapIeToFixes('IE15'); // F12 (open)
  const evidence: EvidenceRef = {
    kind: 'report',
    ref: 'qa-report.vqa.results[].{status,rationale}',
  };

  const results: VqaTestResult[] = report?.vqa.results ?? [];
  const ran = results.filter((r) => r.status !== 'pending');
  if (ran.length === 0) {
    return needsInstrumentation(
      id,
      'no executed visual tests on the qa-report — cannot evaluate verdict-honesty under broken evidence',
      evidence,
      { ieIds, fixIds },
    );
  }

  // The dishonest class (IE15): a test that FAILED (blocking) on broken evidence
  // that should have been `errored`→retry. A correctly-honest run has ZERO of
  // these — broken evidence shows up as `errored`, not `fail`.
  const dishonestFails = ran.filter(
    (r) =>
      r.status === 'fail' && BROKEN_EVIDENCE_RE.test(`${r.rationale ?? ''} ${r.observed ?? ''}`),
  );
  const erroredCount = ran.filter((r) => r.status === 'errored').length;

  let score: ScorecardSlice['score'];
  let verdict: Verdict;
  if (dishonestFails.length === 0) {
    // No broken-evidence test was scored as a blocking fail → honest. 4.
    score = 4;
    verdict = '🟢';
  } else {
    // Any missing/blank frame that blocked as a FAIL is the IE15 defect → 0.
    score = 0;
    verdict = '🔴';
  }

  return qaSlice(id, {
    score,
    verdict,
    value: dishonestFails.length,
    evidence,
    ieIds,
    fixIds,
    note:
      dishonestFails.length === 0
        ? `honest: ${erroredCount} broken-evidence test(s) routed to errored, 0 scored as blocking FAIL`
        : `${dishonestFails.length} broken-evidence test(s) scored as blocking FAIL (should be errored→retry) — IE15 [${dishonestFails
            .map((r) => r.testId)
            .join(', ')}]`,
  });
}

// ── Q-C9 — stage isolation (devserver restart / overlapping windows) ─────────
//
// rubric §0.6: evidenceField = "devserver.log `Found a change…/Restarting`;
// overlapping job windows on same `workingDir`"; thresh = "4=isolated checkout/
// URL, no concurrent writer; 0=concurrent stage restarts server mid-capture".
// IE13 / F11. Shared evidence with DP-I1 (rubric §13 de-dup #9 — counted once,
// attributed to both stages).
//
// The `Found a change… / Restarting` signal lives ONLY in the daemon
// devserver.log (`/var/log` on EC2) — not surfaced into the DetectorContext.
// The overlapping-job-window half CAN be derived deterministically from the
// jobs the scorer already collected (QA job window vs deploy job window on the
// same workingDir), but that requires per-job timing windows which are not on
// the DetectorContext today (only the unioned event stream). Per the honesty
// guard, this is emitted ⚪ until that window data (or the devserver.log parse)
// is instrumented. NEVER fabricate a "no concurrent writer" pass — absence of
// evidence is not evidence of isolation.
function scoreQc9(ctx: DetectorContext): ScorecardSlice {
  const id = 'Q-C9';
  const ieIds = CRITERIA_META[id].ieLink; // ['IE13']
  const fixIds = mapIeToFixes('IE13'); // F11 (open)
  const evidence: EvidenceRef = { kind: 'log', ref: 'devserver.log#Restarting' };
  return needsInstrumentation(
    id,
    "devserver.log 'Found a change…/Restarting' is log-only (daemon /var/log, not in DetectorContext) and per-job time windows on the shared workingDir are not exposed — cannot confirm stage isolation without fabricating a pass",
    evidence,
    { ieIds, fixIds },
  );
}

// ── entrypoint ───────────────────────────────────────────────────────────────

/**
 * Score the deterministic QA criteria (Q-C5/Q-C6/Q-C7/Q-C9). Returns one slice
 * per criterion; criteria whose evidence is log-only / unavailable are emitted
 * as '⚪' (excluded from the rollup) rather than fabricated.
 */
export function scoreQa(ctx: DetectorContext): ScorecardSlice[] {
  const report = asQaReport(ctx.qaReport);
  return [scoreQc5(ctx, report), scoreQc6(ctx, report), scoreQc7(ctx, report), scoreQc9(ctx)];
}
