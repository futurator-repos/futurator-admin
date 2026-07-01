import { describe, it, expect } from 'vitest';
import { evaluateQualityGate, QUALITY_THRESHOLDS } from '../quality-gate';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — the daemon mirror is untyped .mjs; imported for the parity check.
import { evaluateQualityGate as evaluateMjs } from '../../../../daemon/lib/quality-gate.mjs';

// A green story: full P0/P1 coverage + pass, no NFR/security issues.
const GREEN = {
  coverage: { p0: 100, p1: 95, overall: 90 },
  pass: { p0: 100, p1: 100, overall: 95 },
};

describe('quality-gate verdicts', () => {
  it('PASS when all thresholds met', () => {
    const r = evaluateQualityGate(GREEN);
    expect(r.verdict).toBe('PASS');
    expect(r.blocks).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('FAIL on a P0 coverage gap (hard blocker)', () => {
    const r = evaluateQualityGate({ ...GREEN, coverage: { p0: 99, p1: 95, overall: 90 } });
    expect(r.verdict).toBe('FAIL');
    expect(r.blocks).toBe(true);
    expect(r.reasons).toContain('p0_coverage');
  });

  it('FAIL on any open security issue', () => {
    const r = evaluateQualityGate({ ...GREEN, securityIssues: 1 });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toContain('security_issue');
  });

  it('CONCERNS when P1 coverage is in the 80–89 band', () => {
    const r = evaluateQualityGate({ ...GREEN, coverage: { p0: 100, p1: 85, overall: 90 } });
    expect(r.verdict).toBe('CONCERNS');
    expect(r.blocks).toBe(false);
    expect(r.reasons).toContain('p1_coverage_low');
  });

  it('CONCERNS on a non-critical NFR fail', () => {
    const r = evaluateQualityGate({ ...GREEN, nonCriticalNfrFail: true });
    expect(r.verdict).toBe('CONCERNS');
  });

  it('WAIVED downgrades a waivable FAIL (overall coverage) with a complete waiver', () => {
    const waiver = {
      approver: 'ric',
      justification: 'legacy module',
      mitigation: 'ticket X',
      evidence: 'link',
    };
    const r = evaluateQualityGate({ ...GREEN, coverage: { p0: 100, p1: 95, overall: 75 }, waiver });
    expect(r.verdict).toBe('WAIVED');
    expect(r.blocks).toBe(false);
  });

  it('does NOT waive a P0 gap even with a complete waiver', () => {
    const waiver = { approver: 'ric', justification: 'x', mitigation: 'y', evidence: 'z' };
    const r = evaluateQualityGate({ ...GREEN, pass: { p0: 50, p1: 100, overall: 95 }, waiver });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toContain('p0_pass');
  });

  it('does NOT waive with an incomplete waiver', () => {
    const waiver = { approver: 'ric', justification: '', mitigation: 'y', evidence: 'z' } as never;
    const r = evaluateQualityGate({ ...GREEN, coverage: { p0: 100, p1: 95, overall: 75 }, waiver });
    expect(r.verdict).toBe('FAIL');
  });

  it('exposes the ported BMAD thresholds', () => {
    expect(QUALITY_THRESHOLDS.cov.p0).toBe(100);
    expect(QUALITY_THRESHOLDS.pass.overallFail).toBe(85);
  });
});

describe('quality-gate parity (TS ↔ MJS)', () => {
  const cases = [
    GREEN,
    { coverage: { p0: 99, p1: 95, overall: 90 }, pass: { p0: 100, p1: 100, overall: 95 } },
    { coverage: { p0: 100, p1: 85, overall: 90 }, pass: { p0: 100, p1: 92, overall: 87 } },
    { ...GREEN, securityIssues: 2 },
    { ...GREEN, criticalNfrFail: true },
    { ...GREEN, nonCriticalNfrFail: true, minorQualityIssues: true },
    { coverage: {}, pass: {} },
    {
      coverage: { p0: 100, p1: 95, overall: 70 },
      pass: { p0: 100, p1: 100, overall: 95 },
      waiver: { approver: 'a', justification: 'b', mitigation: 'c', evidence: 'd' },
    },
  ];
  it.each(cases)('produces identical verdicts for %j', (input) => {
    expect(evaluateMjs(input)).toEqual(evaluateQualityGate(input));
  });
});
