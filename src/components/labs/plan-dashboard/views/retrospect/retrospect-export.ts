/**
 * Plan Retrospect — export & reconciliation (operator audit trail).
 *
 * Three artefacts, all built from data already in memory (no new fetch except
 * the raw forensic payload, which the caller supplies):
 *
 *   1. buildReportMarkdown(rc)            — the human-readable Reality Check.
 *   2. reconcile(rc, forensic)            — RE-DERIVES every forensic-backed
 *                                            criterion from the raw forensic
 *                                            aggregate and marks MATCH /
 *                                            MISMATCH / UNVERIFIABLE. This is the
 *                                            "does the rubric tell the truth
 *                                            about the forensics" check.
 *   3. buildAuditBundle(rc, forensic)     — { report, forensic, reconciliation }
 *                                            as one JSON the operator can diff,
 *                                            archive, or hand to another agent.
 *
 * Pure module: NO React, NO network. Everything here is unit-testable. The
 * component (retrospect-view.tsx) does the fetch + the Blob download.
 *
 * Why a reconciliation layer at all: the scorecard stores the *computed* value
 * of each criterion (e.g. D-TA2 = 1.301). The forensic export carries the *raw*
 * inputs (aggregate.byCategory.test-author.totalMs ÷ dev.totalMs). If the two
 * disagree, EITHER the detector math drifted OR the forensic snapshot the report
 * was scored against differs from the current one — both are bugs the operator
 * must see. A green "MATCH" column is the evidence that the pipeline is grading
 * itself honestly.
 */

import type { RealityCheck, ScorecardSlice, StageId, Verdict } from '@/types/scorecard';

/** The subset of the forensic payload (`GET /plans/:id/timing/forensic`) we read. */
export interface ForensicLike {
  schemaVersion?: string;
  aggregate: {
    totalMs: number;
    byCategory: Record<string, { totalMs: number; count: number }>;
  };
  skills?: {
    totalSkillToolUseEvents?: number;
    sessionsReportingAvailability?: number;
    sessionsReportingZeroSkills?: number;
    hasSkillTool?: boolean;
    availableSkillCount?: number;
    activatedSkills?: unknown[];
  } | null;
  events?: { timestamp: string }[];
  narrative?: string;
  costReconciliation?: {
    eventCostSum?: number;
    planTotalCostUsd?: number;
    deltaPct?: number | null;
    note?: string;
  };
}

export const STAGE_ORDER: StageId[] = [
  'concept',
  'development',
  'qa',
  'deployment',
  'publish',
  'overview',
];

const STAGE_TITLE: Record<StageId, string> = {
  concept: 'Concept',
  development: 'Development',
  qa: 'QA Review',
  deployment: 'Deployment',
  publish: 'Publish',
  overview: 'Overview — cross-cutting',
};

// ── helpers ─────────────────────────────────────────────────────────────────

/** Escape a value for a Markdown table cell. */
function cell(v: unknown): string {
  return String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** Parse the numeric core out of a reported value (`1.301`, `"≥0.71"`, `"≥$1.57"`). */
export function reportedNumber(value: number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = String(value).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function cat(f: ForensicLike, name: string): number {
  return f.aggregate?.byCategory?.[name]?.totalMs ?? 0;
}

/** wall-clock span = max(event.ts) − min(event.ts), the D-WS1 denominator. */
export function forensicWallMs(f: ForensicLike): number | null {
  if (!f.events || f.events.length < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const e of f.events) {
    const t = Date.parse(e.timestamp);
    if (!Number.isNaN(t)) {
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  return max > min ? max - min : null;
}

/** Numeric agreement within max(absTol, relTol·|expected|). Default 2% / 0.01. */
function near(a: number, b: number, relTol = 0.02, absTol = 0.01): boolean {
  return Math.abs(a - b) <= Math.max(absTol, Math.abs(b) * relTol);
}

// ── reconciliation ──────────────────────────────────────────────────────────

export type ReconcileVerdict = 'MATCH' | 'MISMATCH' | 'UNVERIFIABLE';

export interface ReconcileRow {
  criterionId: string;
  stage: StageId;
  /** As stored on the scorecard slice. */
  reported: number | string;
  /** Re-derived from the raw forensic payload (null when not derivable here). */
  recomputed: number | null;
  verdict: ReconcileVerdict;
  /** The exact derivation used (the criterion's evidence formula). */
  formula: string;
  /** Why UNVERIFIABLE, or the delta on MISMATCH. */
  detail: string;
}

export interface ReconciliationResult {
  rows: ReconcileRow[];
  summary: { match: number; mismatch: number; unverifiable: number; total: number };
  /** Forensic provenance so a reader knows what was re-derived against. */
  forensicSchema?: string;
  generatedAt: string;
}

/**
 * For each forensic-backed criterion present on the scorecard, re-derive its
 * value from the raw forensic aggregate and compare. Plan-derived (OV1/2/3/5)
 * and unwired-source criteria (qa/deploy/spend) are marked UNVERIFIABLE *from
 * the forensic payload* with the reason — they're auditable elsewhere.
 */
export function reconcile(
  rc: RealityCheck,
  forensic: ForensicLike,
  generatedAt = new Date().toISOString(),
): ReconciliationResult {
  const bySlice = new Map<string, ScorecardSlice>();
  for (const s of rc.slices) bySlice.set(s.criterionId, s);

  const rows: ReconcileRow[] = [];

  /** Recompute a ratio criterion if both inputs are present. */
  const ratio = (
    id: string,
    formula: string,
    numeratorMs: number,
    denomMs: number | null,
  ): void => {
    const slice = bySlice.get(id);
    if (!slice) return;
    if (denomMs == null || denomMs === 0) {
      rows.push({
        criterionId: id,
        stage: slice.stage,
        reported: slice.value,
        recomputed: null,
        verdict: 'UNVERIFIABLE',
        formula,
        detail: 'denominator is zero / not present in forensic payload',
      });
      return;
    }
    const recomputed = numeratorMs / denomMs;
    const rep = reportedNumber(slice.value);
    if (rep == null) {
      rows.push({
        criterionId: id,
        stage: slice.stage,
        reported: slice.value,
        recomputed,
        verdict: 'UNVERIFIABLE',
        formula,
        detail: `reported value "${slice.value}" is non-numeric`,
      });
      return;
    }
    const ok = near(recomputed, rep);
    rows.push({
      criterionId: id,
      stage: slice.stage,
      reported: slice.value,
      recomputed,
      verdict: ok ? 'MATCH' : 'MISMATCH',
      formula,
      detail: ok
        ? `Δ ${Math.abs(recomputed - rep).toExponential(2)}`
        : `reported ${rep} vs recomputed ${recomputed.toFixed(4)} (Δ ${(recomputed - rep).toFixed(4)})`,
    });
  };

  const tot = forensic.aggregate?.totalMs ?? 0;

  // Development — pure forensic ratios (numerator & denominator both in aggregate).
  ratio(
    'D-TA2',
    'byCategory.test-author.totalMs ÷ byCategory.dev.totalMs',
    cat(forensic, 'test-author'),
    cat(forensic, 'dev') || null,
  );
  ratio(
    'D-CC3',
    'byCategory.compile.totalMs ÷ aggregate.totalMs',
    cat(forensic, 'compile'),
    tot || null,
  );
  ratio(
    'D-VQ5',
    'byCategory.vqa-gate.totalMs ÷ aggregate.totalMs',
    cat(forensic, 'vqa-gate'),
    tot || null,
  );
  ratio(
    'D-WS1',
    'aggregate.totalMs ÷ wallMs(max−min event.timestamp)',
    tot,
    forensicWallMs(forensic),
  );

  // Skills — from the forensic skills block.
  const sk = forensic.skills ?? null;
  reconcileSkills(rc, sk, rows, bySlice);

  // D-MG4 needs waveCount (epics.waveBuildJobs) which is NOT in the forensic
  // payload — surface the numerator so the operator can eyeball it, but mark
  // it unverifiable from forensic alone.
  pushUnverifiable(
    rows,
    bySlice,
    'D-MG4',
    'byCategory.merge-gate.totalMs ÷ waveCount(epics.waveBuildJobs)',
    `merge-gate.totalMs=${cat(forensic, 'merge-gate')}; waveCount lives on epics, not the forensic payload`,
  );

  // OV10's reported value is byCategory.fix.totalMs (it reds only when a real
  // work category logs ~0ms). Verify against the fix-category total, NOT the
  // grand total.
  pushOv10(rows, bySlice, cat(forensic, 'fix'));

  // Plan-derived & unwired-source criteria: explicitly out of forensic scope.
  for (const id of ['OV1', 'OV2', 'OV3', 'OV5']) {
    pushUnverifiable(
      rows,
      bySlice,
      id,
      'derived from the plan row (startedAt/reviewAt/cost/story counts)',
      'verify against the futurator-plans row, not the forensic payload',
    );
  }

  const summary = rows.reduce(
    (acc, r) => {
      if (r.verdict === 'MATCH') acc.match += 1;
      else if (r.verdict === 'MISMATCH') acc.mismatch += 1;
      else acc.unverifiable += 1;
      acc.total += 1;
      return acc;
    },
    { match: 0, mismatch: 0, unverifiable: 0, total: 0 },
  );

  return { rows, summary, forensicSchema: forensic.schemaVersion, generatedAt };
}

function reconcileSkills(
  _rc: RealityCheck,
  sk: ForensicLike['skills'],
  rows: ReconcileRow[],
  bySlice: Map<string, ScorecardSlice>,
): void {
  const sk2 = bySlice.get('SK2');
  if (sk2) {
    const sessions = sk?.sessionsReportingAvailability ?? 0;
    if (!sk || sessions === 0) {
      rows.push({
        criterionId: 'SK2',
        stage: sk2.stage,
        reported: sk2.value,
        recomputed: null,
        verdict: 'UNVERIFIABLE',
        formula: 'skills.totalSkillToolUseEvents ÷ skills.sessionsReportingAvailability',
        detail: 'forensic skills block absent or zero sessions',
      });
    } else {
      const recomputed = (sk.totalSkillToolUseEvents ?? 0) / sessions;
      const rep = reportedNumber(sk2.value);
      const ok = rep != null && near(recomputed, rep, 0.03, 0.002);
      rows.push({
        criterionId: 'SK2',
        stage: sk2.stage,
        reported: sk2.value,
        recomputed,
        verdict: rep == null ? 'UNVERIFIABLE' : ok ? 'MATCH' : 'MISMATCH',
        formula: 'skills.totalSkillToolUseEvents ÷ skills.sessionsReportingAvailability',
        detail: ok ? 'within tolerance' : `reported ${rep} vs recomputed ${recomputed.toFixed(4)}`,
      });
    }
  }
}

function pushOv10(rows: ReconcileRow[], bySlice: Map<string, ScorecardSlice>, fixMs: number): void {
  const ov10 = bySlice.get('OV10');
  if (!ov10) return;
  const rep = reportedNumber(ov10.value);
  const ok = rep != null && near(rep, fixMs, 0.001, 1);
  rows.push({
    criterionId: 'OV10',
    stage: ov10.stage,
    reported: ov10.value,
    recomputed: fixMs,
    verdict: rep == null ? 'UNVERIFIABLE' : ok ? 'MATCH' : 'MISMATCH',
    formula: 'value == byCategory.fix.totalMs (attribution: a real category must not log ~0ms)',
    detail: ok
      ? 'fix-category total matches'
      : `reported ${rep} vs byCategory.fix.totalMs ${fixMs}`,
  });
}

function pushUnverifiable(
  rows: ReconcileRow[],
  bySlice: Map<string, ScorecardSlice>,
  id: string,
  formula: string,
  reason: string,
): void {
  const slice = bySlice.get(id);
  if (!slice) return;
  rows.push({
    criterionId: id,
    stage: slice.stage,
    reported: slice.value,
    recomputed: null,
    verdict: 'UNVERIFIABLE',
    formula,
    detail: reason,
  });
}

// ── markdown report ─────────────────────────────────────────────────────────

const VERDICT_WORD: Record<Verdict, string> = {
  '🟢': 'pass',
  '🟡': 'warn',
  '🔴': 'fail',
  '⚪': 'n/a (needs instrumentation)',
};

function countVerdicts(slices: ScorecardSlice[]): Record<Verdict, number> {
  const c: Record<Verdict, number> = { '🟢': 0, '🟡': 0, '🔴': 0, '⚪': 0 };
  for (const s of slices) c[s.verdict] += 1;
  return c;
}

/** The full operator-facing Reality Check as Markdown. */
export function buildReportMarkdown(
  rc: RealityCheck,
  generatedAt = new Date().toISOString(),
): string {
  const L: string[] = [];
  const pct = rc.pipelineHealth != null ? `${Math.round(rc.pipelineHealth * 100)}%` : '—';
  const scored = rc.slices.filter((s) => s.verdict !== '⚪').length;
  const blind = rc.slices.length - scored;

  L.push(`# Plan Retrospect — Reality Check`);
  L.push('');
  L.push(`- **Plan:** \`${rc.planId}\``);
  L.push(`- **Grade:** ${rc.gradeBand ?? '—'} · **pipeline health:** ${pct}`);
  L.push(`- **Rubric:** ${rc.rubricVersion}`);
  if (rc.confidence === 'unreconciled') {
    L.push(
      `- **⚠ Cost confidence:** \`unreconciled\` — cost criteria are LOWER BOUNDS (F2/F3 open).`,
    );
  }
  L.push(
    `- **Coverage:** ${scored} criteria scored, **${blind} blind (⚪ needs-instrumentation)** — the grade is computed only from the ${scored} scored criteria.`,
  );
  L.push(`- **Generated:** ${generatedAt}`);
  L.push('');
  L.push(
    `> Reading note: ⚪ means the detector could not *see* the evidence (data source not wired / log-only / artifact not loaded) — NOT that the stage failed. Numeric thresholds are tagged \`v0 (unvalidated)\`: calibrated from a single run, not yet cross-validated.`,
  );
  L.push('');

  for (const stage of STAGE_ORDER) {
    const slices = rc.slices.filter((s) => s.stage === stage);
    if (slices.length === 0) continue;
    const c = countVerdicts(slices);
    L.push(`## ${STAGE_TITLE[stage]}`);
    L.push('');
    L.push(`🔴 ${c['🔴']} · 🟡 ${c['🟡']} · 🟢 ${c['🟢']} · ⚪ ${c['⚪']}`);
    L.push('');
    L.push(`| Criterion | Verdict | Value | Score | IEs | Fixes | Evidence / note |`);
    L.push(`|---|---|---|---|---|---|---|`);
    for (const s of slices) {
      const fixes = s.fixIds
        .map((f) => `${f.id}${f.status === 'shipped' || f.status === 'verified' ? '✓' : '·open'}`)
        .join(' ');
      const note = s.note ? s.note : `${s.evidence.kind}:${s.evidence.ref}`;
      L.push(
        `| ${cell(s.criterionId)} | ${s.verdict} ${VERDICT_WORD[s.verdict]} | ${cell(s.value)} | ${s.score ?? '—'} | ${cell(s.ieIds.join(' '))} | ${cell(fixes)} | ${cell(note)} |`,
      );
    }
    L.push('');
  }

  if (rc.topRegressions.length || rc.topWins.length) {
    L.push(`## vs v0/pacman3 baseline`);
    L.push('');
    for (const r of rc.topRegressions) L.push(`- 🔻 ${cell(r)}`);
    for (const w of rc.topWins) L.push(`- 🔼 ${cell(w)}`);
    L.push('');
  }

  if (rc.actions.length) {
    L.push(`## Improvement actions (every 🔴/🟡 → a fix to ship)`);
    L.push('');
    L.push(`| Criterion | Fixes | Draft finding | Pushed |`);
    L.push(`|---|---|---|---|`);
    for (const a of rc.actions) {
      const fixes = a.fixIds.map((f) => `${f.id} (${f.status})`).join(' ');
      L.push(
        `| ${cell(a.redCriterion)} | ${cell(fixes)} | ${cell(a.draftFinding ?? '')} | ${cell(a.status === 'pushed' ? (a.target ?? 'yes') : '')} |`,
      );
    }
    L.push('');
  }

  return L.join('\n');
}

/** Render the reconciliation result as a readable Markdown table. */
export function buildReconciliationMarkdown(r: ReconciliationResult, planId: string): string {
  const L: string[] = [];
  L.push(`# Forensic reconciliation — \`${planId}\``);
  L.push('');
  L.push(
    `Re-derives each forensic-backed criterion from the RAW forensic payload and compares to the stored scorecard value. A clean \`MATCH\` column is the evidence that the rubric grades the forensics honestly.`,
  );
  L.push('');
  L.push(
    `**${r.summary.match} MATCH · ${r.summary.mismatch} MISMATCH · ${r.summary.unverifiable} UNVERIFIABLE (from forensic alone)** · forensic schema \`${r.forensicSchema ?? '?'}\` · ${r.generatedAt}`,
  );
  L.push('');
  if (r.summary.mismatch > 0) {
    L.push(
      `> ⚠ ${r.summary.mismatch} criteria DISAGREE with the raw forensics — investigate before trusting those scores.`,
    );
    L.push('');
  }
  L.push(`| Criterion | Verdict | Reported | Recomputed | Formula | Detail |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const row of r.rows) {
    const mark = row.verdict === 'MATCH' ? '✅' : row.verdict === 'MISMATCH' ? '❌' : '⚪';
    L.push(
      `| ${cell(row.criterionId)} | ${mark} ${row.verdict} | ${cell(row.reported)} | ${cell(row.recomputed != null ? row.recomputed.toFixed(4) : '—')} | ${cell(row.formula)} | ${cell(row.detail)} |`,
    );
  }
  L.push('');
  return L.join('\n');
}

// ── bundle ──────────────────────────────────────────────────────────────────

export interface AuditBundle {
  kind: 'plan-retrospect-audit-bundle';
  version: 1;
  generatedAt: string;
  planId: string;
  report: RealityCheck;
  forensic: ForensicLike | { error: string };
  reconciliation: ReconciliationResult | { error: string };
}

/**
 * Everything in one JSON: the stored Reality Check, the raw forensic payload it
 * should reconcile against, and the computed reconciliation. Designed to be
 * diffed across runs or handed to another agent for deeper analysis.
 */
export function buildAuditBundle(
  rc: RealityCheck,
  forensic: ForensicLike | null,
  generatedAt = new Date().toISOString(),
): AuditBundle {
  return {
    kind: 'plan-retrospect-audit-bundle',
    version: 1,
    generatedAt,
    planId: rc.planId,
    report: rc,
    forensic: forensic ?? { error: 'forensic payload unavailable' },
    reconciliation: forensic
      ? reconcile(rc, forensic, generatedAt)
      : { error: 'forensic payload unavailable — cannot reconcile' },
  };
}
