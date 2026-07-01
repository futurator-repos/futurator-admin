// quality-gate.mjs — deterministic PASS/CONCERNS/FAIL/WAIVED verdict (TDD blueprint §7).
//
// MJS mirror of `functions/shared/services/quality-gate.ts`. Kept byte-identical
// in behavior via the parity test (see role-policy.ts ↔ role-policy.mjs). Ports
// BMAD TEA's prose gate model into a pure function fed by our bound-AC pass rates
// + coverage + NFR/security signals. No LLM.

export const QUALITY_THRESHOLDS = Object.freeze({
  cov: { p0: 100, p1Fail: 80, p1Concern: 90, overall: 80 },
  pass: { p0: 100, p1Fail: 90, p1Concern: 95, overallFail: 85, overallConcern: 90 },
});

const NON_WAIVABLE = Object.freeze(
  new Set(['p0_coverage', 'p0_pass', 'security_issue', 'critical_nfr_fail']),
);

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isCompleteWaiver(w) {
  return Boolean(w && w.approver && w.justification && w.mitigation && w.evidence);
}

/**
 * @param {{
 *   coverage?: {p0?:number,p1?:number,overall?:number},
 *   pass?: {p0?:number,p1?:number,overall?:number},
 *   criticalNfrFail?: boolean, nonCriticalNfrFail?: boolean,
 *   securityIssues?: number, minorQualityIssues?: boolean,
 *   waiver?: {approver:string,justification:string,mitigation:string,evidence:string},
 * }} input
 * @returns {{ verdict:'PASS'|'CONCERNS'|'FAIL'|'WAIVED', blocks:boolean, reasons:string[], notes:string[] }}
 */
export function evaluateQualityGate(input = {}) {
  const cov = { p0: num(input.coverage?.p0), p1: num(input.coverage?.p1), overall: num(input.coverage?.overall) };
  const pass = { p0: num(input.pass?.p0), p1: num(input.pass?.p1), overall: num(input.pass?.overall) };
  const T = QUALITY_THRESHOLDS;

  const fail = [];
  const concern = [];

  if (cov.p0 < T.cov.p0) fail.push(['p0_coverage', `P0 coverage ${cov.p0}% < ${T.cov.p0}%`]);
  if (pass.p0 < T.pass.p0) fail.push(['p0_pass', `P0 pass-rate ${pass.p0}% < ${T.pass.p0}%`]);
  if (cov.p1 < T.cov.p1Fail) fail.push(['p1_coverage', `P1 coverage ${cov.p1}% < ${T.cov.p1Fail}%`]);
  if (pass.p1 < T.pass.p1Fail) fail.push(['p1_pass', `P1 pass-rate ${pass.p1}% < ${T.pass.p1Fail}%`]);
  if (cov.overall < T.cov.overall) fail.push(['overall_coverage', `Overall coverage ${cov.overall}% < ${T.cov.overall}%`]);
  if (pass.overall < T.pass.overallFail) fail.push(['overall_pass', `Overall pass-rate ${pass.overall}% < ${T.pass.overallFail}%`]);
  if (input.criticalNfrFail) fail.push(['critical_nfr_fail', 'A critical NFR failed its audit']);
  if (num(input.securityIssues) > 0) fail.push(['security_issue', `${num(input.securityIssues)} open security issue(s)`]);

  if (cov.p1 >= T.cov.p1Fail && cov.p1 < T.cov.p1Concern)
    concern.push(['p1_coverage_low', `P1 coverage ${cov.p1}% in ${T.cov.p1Fail}–${T.cov.p1Concern - 1}%`]);
  if (pass.p1 >= T.pass.p1Fail && pass.p1 < T.pass.p1Concern)
    concern.push(['p1_pass_low', `P1 pass-rate ${pass.p1}% in ${T.pass.p1Fail}–${T.pass.p1Concern - 1}%`]);
  if (pass.overall >= T.pass.overallFail && pass.overall < T.pass.overallConcern)
    concern.push(['overall_pass_low', `Overall pass-rate ${pass.overall}% in ${T.pass.overallFail}–${T.pass.overallConcern - 1}%`]);
  if (input.nonCriticalNfrFail) concern.push(['non_critical_nfr_fail', 'A non-critical NFR failed']);
  if (input.minorQualityIssues) concern.push(['minor_quality', 'Minor quality issues flagged in review']);

  if (fail.length > 0) {
    const allWaivable = fail.every(([code]) => !NON_WAIVABLE.has(code));
    if (allWaivable && isCompleteWaiver(input.waiver)) {
      return {
        verdict: 'WAIVED',
        blocks: false,
        reasons: fail.map(([code]) => code),
        notes: [...fail.map(([, n]) => n), `WAIVED by ${input.waiver.approver}: ${input.waiver.justification}`],
      };
    }
    return { verdict: 'FAIL', blocks: true, reasons: fail.map(([c]) => c), notes: fail.map(([, n]) => n) };
  }

  if (concern.length > 0) {
    return { verdict: 'CONCERNS', blocks: false, reasons: concern.map(([c]) => c), notes: concern.map(([, n]) => n) };
  }

  return { verdict: 'PASS', blocks: false, reasons: [], notes: [] };
}
