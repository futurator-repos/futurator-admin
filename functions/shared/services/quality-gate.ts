// quality-gate — the deterministic story/plan quality verdict (TDD blueprint §7).
//
// Ports BMAD TEA's PASS / CONCERNS / FAIL / WAIVED model — which in BMAD is only
// PROSE guidance (`bmad/bmm/workflows/testarch/trace/instructions.md`) — into an
// actual pure function fed by the traceability + coverage + CI numbers we already
// compute (bound-AC pass rates, coverage %, NFR/security signals). No LLM.
//
// Mirror: `daemon/lib/quality-gate.mjs` (parity-tested, like role-policy).
//
// The verdict rule (percentages are 0..100):
//   FAIL     — any hard blocker: P0 cov <100 | P0 pass <100 | P1 cov <80 |
//              P1 pass <90 | overall cov <80 | overall pass <85 | a critical NFR
//              fail | any security issue.
//   CONCERNS — ship-with-follow-up: P1 cov 80–89 | P1 pass 90–94 |
//              overall pass 85–89 | a non-critical NFR fail | minor quality issue.
//   PASS     — none of the above.
//   WAIVED   — a would-be FAIL whose reasons are ALL waivable (never P0, never
//              critical security, never critical NFR) AND a complete waiver is
//              attached. Downgrades FAIL→WAIVED (non-blocking).

export type QualityVerdict = 'PASS' | 'CONCERNS' | 'FAIL' | 'WAIVED';

/** Percentages are 0..100. Missing sub-scores default to 0 (treated as a gap). */
export interface QualityScore {
  p0: number;
  p1: number;
  overall: number;
}

export interface QualityGateInput {
  /** AC coverage % by priority band (fraction of ACs with a passing bound test). */
  coverage: Partial<QualityScore>;
  /** Test pass-rate % by priority band. */
  pass: Partial<QualityScore>;
  /** A critical NFR (security/perf/reliability marked critical) failed its audit. */
  criticalNfrFail?: boolean;
  /** A non-critical NFR failed (CONCERNS, not a blocker). */
  nonCriticalNfrFail?: boolean;
  /** Count of open security findings (any >0 is a hard blocker). */
  securityIssues?: number;
  /** Reviewer/lint minor quality flags (CONCERNS, not a blocker). */
  minorQualityIssues?: boolean;
  /** A complete waiver can downgrade a *waivable* FAIL to WAIVED. */
  waiver?: QualityWaiver;
}

export interface QualityWaiver {
  approver: string;
  justification: string;
  mitigation: string;
  evidence: string;
}

export interface QualityGateResult {
  verdict: QualityVerdict;
  /** True iff the story/plan must not proceed (verdict === 'FAIL'). */
  blocks: boolean;
  /** Machine-readable reason codes (stable, snake_case) for the scheduler. */
  reasons: string[];
  /** Human-readable notes paralleling `reasons`. */
  notes: string[];
}

// Thresholds — the single source of truth (ported from BMAD's prose matrix).
export const QUALITY_THRESHOLDS = Object.freeze({
  cov: { p0: 100, p1Fail: 80, p1Concern: 90, overall: 80 },
  pass: { p0: 100, p1Fail: 90, p1Concern: 95, overallFail: 85, overallConcern: 90 },
});

/** Reason codes that a waiver may NEVER downgrade (P0, critical security/NFR). */
const NON_WAIVABLE = Object.freeze(
  new Set(['p0_coverage', 'p0_pass', 'security_issue', 'critical_nfr_fail']),
);

function num(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isCompleteWaiver(w: QualityWaiver | undefined): w is QualityWaiver {
  return Boolean(w && w.approver && w.justification && w.mitigation && w.evidence);
}

export function evaluateQualityGate(input: QualityGateInput): QualityGateResult {
  const cov = {
    p0: num(input.coverage?.p0),
    p1: num(input.coverage?.p1),
    overall: num(input.coverage?.overall),
  };
  const pass = {
    p0: num(input.pass?.p0),
    p1: num(input.pass?.p1),
    overall: num(input.pass?.overall),
  };
  const T = QUALITY_THRESHOLDS;

  const fail: Array<[string, string]> = [];
  const concern: Array<[string, string]> = [];

  // ── Hard blockers (FAIL) ──
  if (cov.p0 < T.cov.p0) fail.push(['p0_coverage', `P0 coverage ${cov.p0}% < ${T.cov.p0}%`]);
  if (pass.p0 < T.pass.p0) fail.push(['p0_pass', `P0 pass-rate ${pass.p0}% < ${T.pass.p0}%`]);
  if (cov.p1 < T.cov.p1Fail)
    fail.push(['p1_coverage', `P1 coverage ${cov.p1}% < ${T.cov.p1Fail}%`]);
  if (pass.p1 < T.pass.p1Fail)
    fail.push(['p1_pass', `P1 pass-rate ${pass.p1}% < ${T.pass.p1Fail}%`]);
  if (cov.overall < T.cov.overall)
    fail.push(['overall_coverage', `Overall coverage ${cov.overall}% < ${T.cov.overall}%`]);
  if (pass.overall < T.pass.overallFail)
    fail.push(['overall_pass', `Overall pass-rate ${pass.overall}% < ${T.pass.overallFail}%`]);
  if (input.criticalNfrFail) fail.push(['critical_nfr_fail', 'A critical NFR failed its audit']);
  if (num(input.securityIssues) > 0)
    fail.push(['security_issue', `${num(input.securityIssues)} open security issue(s)`]);

  // ── Soft findings (CONCERNS) — only meaningful when not already FAILing that band ──
  if (cov.p1 >= T.cov.p1Fail && cov.p1 < T.cov.p1Concern)
    concern.push([
      'p1_coverage_low',
      `P1 coverage ${cov.p1}% in ${T.cov.p1Fail}–${T.cov.p1Concern - 1}%`,
    ]);
  if (pass.p1 >= T.pass.p1Fail && pass.p1 < T.pass.p1Concern)
    concern.push([
      'p1_pass_low',
      `P1 pass-rate ${pass.p1}% in ${T.pass.p1Fail}–${T.pass.p1Concern - 1}%`,
    ]);
  if (pass.overall >= T.pass.overallFail && pass.overall < T.pass.overallConcern)
    concern.push([
      'overall_pass_low',
      `Overall pass-rate ${pass.overall}% in ${T.pass.overallFail}–${T.pass.overallConcern - 1}%`,
    ]);
  if (input.nonCriticalNfrFail)
    concern.push(['non_critical_nfr_fail', 'A non-critical NFR failed']);
  if (input.minorQualityIssues)
    concern.push(['minor_quality', 'Minor quality issues flagged in review']);

  if (fail.length > 0) {
    // Waiver can downgrade ONLY if every fail reason is waivable AND the waiver is complete.
    const allWaivable = fail.every(([code]) => !NON_WAIVABLE.has(code));
    if (allWaivable && isCompleteWaiver(input.waiver)) {
      return {
        verdict: 'WAIVED',
        blocks: false,
        reasons: fail.map(([code]) => code),
        notes: [
          ...fail.map(([, n]) => n),
          `WAIVED by ${input.waiver.approver}: ${input.waiver.justification}`,
        ],
      };
    }
    return {
      verdict: 'FAIL',
      blocks: true,
      reasons: fail.map(([c]) => c),
      notes: fail.map(([, n]) => n),
    };
  }

  if (concern.length > 0) {
    return {
      verdict: 'CONCERNS',
      blocks: false,
      reasons: concern.map(([c]) => c),
      notes: concern.map(([, n]) => n),
    };
  }

  return { verdict: 'PASS', blocks: false, reasons: [], notes: [] };
}
