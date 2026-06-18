import { describe, it, expect } from 'vitest';
import type { RealityCheck, ScorecardSlice, StageId, Verdict } from '@/types/scorecard';
import {
  reportedNumber,
  forensicWallMs,
  reconcile,
  buildReportMarkdown,
  buildReconciliationMarkdown,
  buildAuditBundle,
  type ForensicLike,
} from './retrospect-export';

function slice(
  criterionId: string,
  stage: StageId,
  verdict: Verdict,
  value: number | string,
  extra: Partial<ScorecardSlice> = {},
): ScorecardSlice {
  return {
    criterionId,
    stage,
    score: verdict === '⚪' ? null : verdict === '🔴' ? 0 : verdict === '🟡' ? 2 : 4,
    verdict,
    value,
    evidence: { kind: 'forensic', ref: 'x' },
    ieIds: [],
    fixIds: [],
    engine: 'deterministic',
    ...extra,
  };
}

const RC: RealityCheck = {
  planId: 'plan_test_1',
  pipelineHealth: 0.4485,
  gradeBand: 'D',
  rubricVersion: 'v1.0-draft',
  confidence: 'unreconciled',
  analyzedStages: ['development', 'overview'],
  topRegressions: ['SK2 activation regressed'],
  topWins: ['OV5 count integrity held'],
  actions: [
    {
      redCriterion: 'D-TA2',
      ieIds: ['IE7'],
      fixIds: [{ id: 'F7', kind: 'F', status: 'open' }],
      status: 'open',
    },
  ],
  slices: [
    // forensic-derived
    slice('D-TA2', 'development', '🔴', 1.301), // test-author/dev = 1301/1000
    slice('D-CC3', 'development', '🟡', 0.16), //  compile/total = 160/1000
    slice('D-WS1', 'development', '🔴', 1.157), // total/wall = 1157/1000
    slice('SK2', 'development', '🔴', 0.0222), // 1/45
    slice('D-MG4', 'development', '🔴', 136365), // needs waveCount → UNVERIFIABLE
    // attribution (value == byCategory.fix.totalMs)
    slice('OV10', 'overview', '🟢', 105647),
    // plan-derived
    slice('OV1', 'overview', '🔴', 20.1),
    slice('OV3', 'overview', '🔴', '≥$1.57'),
    // needs-instrumentation
    slice('Q-C6', 'qa', '⚪', 'n/a', { note: '[needs-instrumentation: no executed visual tests]' }),
  ],
};

const FORENSIC: ForensicLike = {
  schemaVersion: 'timer-intel-v1.0',
  aggregate: {
    totalMs: 1000,
    byCategory: {
      dev: { totalMs: 1000, count: 5 },
      'test-author': { totalMs: 1301, count: 3 },
      compile: { totalMs: 160, count: 4 },
      'vqa-gate': { totalMs: 47, count: 1 },
      'merge-gate': { totalMs: 272730, count: 2 },
      fix: { totalMs: 105647, count: 20 },
    },
  },
  skills: { totalSkillToolUseEvents: 1, sessionsReportingAvailability: 45, hasSkillTool: true },
  // wall span 864ms → D-WS1 = totalMs(1000) ÷ wall(864) = 1.157
  events: [{ timestamp: '2026-06-18T00:00:00.000Z' }, { timestamp: '2026-06-18T00:00:00.864Z' }],
};

describe('reportedNumber', () => {
  it('passes through numbers', () => expect(reportedNumber(1.301)).toBe(1.301));
  it('extracts from lower-bound strings', () => expect(reportedNumber('≥$1.57')).toBe(1.57));
  it('extracts from ≥0.71', () => expect(reportedNumber('≥0.71')).toBe(0.71));
  it('returns null for non-numeric', () => expect(reportedNumber('n/a')).toBeNull());
});

describe('forensicWallMs', () => {
  it('is max−min event timestamp', () => expect(forensicWallMs(FORENSIC)).toBe(864));
  it('is null with <2 events', () =>
    expect(forensicWallMs({ ...FORENSIC, events: [] })).toBeNull());
});

describe('reconcile', () => {
  const r = reconcile(RC, FORENSIC, '2026-06-18T12:00:00.000Z');
  const byId = (id: string) => r.rows.find((x) => x.criterionId === id)!;

  it('MATCHes forensic-derived ratios that agree', () => {
    expect(byId('D-TA2').verdict).toBe('MATCH'); // 1301/1000 = 1.301
    expect(byId('D-CC3').verdict).toBe('MATCH'); // 160/1000 = 0.16
    expect(byId('D-WS1').verdict).toBe('MATCH'); // total/wall = 1000/864 = 1.157
  });

  it('MATCHes SK2 activation', () => {
    expect(byId('SK2').verdict).toBe('MATCH');
    expect(byId('SK2').recomputed).toBeCloseTo(1 / 45, 5);
  });

  it('MATCHes OV10 against byCategory.fix.totalMs (not aggregate.totalMs)', () => {
    expect(byId('OV10').verdict).toBe('MATCH');
    expect(byId('OV10').recomputed).toBe(105647);
  });

  it('marks plan-derived criteria UNVERIFIABLE from forensic', () => {
    expect(byId('OV1').verdict).toBe('UNVERIFIABLE');
    expect(byId('OV3').verdict).toBe('UNVERIFIABLE');
  });

  it('marks D-MG4 UNVERIFIABLE (waveCount not in forensic) but surfaces merge-gate ms', () => {
    expect(byId('D-MG4').verdict).toBe('UNVERIFIABLE');
    expect(byId('D-MG4').detail).toContain('272730');
  });

  it('flags a real MISMATCH when the stored value disagrees with forensics', () => {
    const tampered: RealityCheck = {
      ...RC,
      slices: RC.slices.map((s) => (s.criterionId === 'D-CC3' ? { ...s, value: 0.99 } : s)),
    };
    const rr = reconcile(tampered, FORENSIC);
    expect(rr.rows.find((x) => x.criterionId === 'D-CC3')!.verdict).toBe('MISMATCH');
    expect(rr.summary.mismatch).toBe(1);
  });

  it('summary counts add up', () => {
    expect(r.summary.match + r.summary.mismatch + r.summary.unverifiable).toBe(r.summary.total);
    expect(r.summary.total).toBe(r.rows.length);
  });
});

describe('buildReportMarkdown', () => {
  const md = buildReportMarkdown(RC, '2026-06-18T12:00:00.000Z');
  it('shows grade, health, and the blind-coverage caveat', () => {
    expect(md).toContain('Grade:** D');
    expect(md).toContain('45%');
    expect(md).toMatch(/blind \(⚪ needs-instrumentation\)/);
  });
  it('surfaces the unreconciled cost caveat', () => expect(md).toContain('unreconciled'));
  it('renders a row per criterion', () => {
    expect(md).toContain('D-TA2');
    expect(md).toContain('Q-C6');
  });
});

describe('buildReconciliationMarkdown + buildAuditBundle', () => {
  it('renders the reconciliation table with a summary line', () => {
    const md = buildReconciliationMarkdown(reconcile(RC, FORENSIC), 'plan_test_1');
    expect(md).toContain('MATCH');
    expect(md).toContain('| Criterion |');
  });
  it('bundles report + forensic + reconciliation', () => {
    const b = buildAuditBundle(RC, FORENSIC, '2026-06-18T12:00:00.000Z');
    expect(b.kind).toBe('plan-retrospect-audit-bundle');
    expect(b.report.planId).toBe('plan_test_1');
    expect('rows' in b.reconciliation).toBe(true);
  });
  it('records absence when forensic is unavailable', () => {
    const b = buildAuditBundle(RC, null);
    expect('error' in b.forensic).toBe(true);
    expect('error' in b.reconciliation).toBe(true);
  });
});
