// Tests for detectors/qa.ts — the deterministic QA criteria (rubric §4 / §0.6).
//
// Asserts the four detectors score from a synthetic DetectorContext per the
// §0.6 thresholds, that the honesty guard degrades cost criteria to
// `unreconciled`, and that log-only evidence (Q-C9, byte-diversity) yields '⚪'
// needs-instrumentation slices rather than fabricated values.

import { describe, it, expect } from 'vitest';
import { scoreQa } from '../qa';
import type { DetectorContext, ScorecardSlice, AgentSpendRow } from '../../types';
import type { Plan, PlanRigor } from '../../../types/plan';
import type { QaReport, VqaTestResult } from '../../../types/qa-report';

// ── synthetic context ────────────────────────────────────────────────────────

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan-1',
    totalCostUsd: 4,
    rigor: 'mvp' as PlanRigor,
    ...over,
  } as Plan;
}

function vqaResult(
  over: Partial<VqaTestResult> & Pick<VqaTestResult, 'testId' | 'status'>,
): VqaTestResult {
  return {
    storyId: 's1',
    epicId: 'e1',
    passed: over.status === 'pass',
    ...over,
  } as VqaTestResult;
}

function makeQaReport(vqaOver: Partial<QaReport['vqa']> = {}): QaReport {
  return {
    planId: 'plan-1',
    vqa: {
      verdict: 'pass',
      total: 0,
      pass: 0,
      fail: 0,
      pending: 0,
      thumbnails: [],
      failures: [],
      executeStatus: 'done',
      ...vqaOver,
    },
  } as QaReport;
}

function makeCtx(over: Partial<DetectorContext> = {}): DetectorContext {
  return {
    planId: 'plan-1',
    plan: makePlan(),
    epics: [],
    events: [],
    slices: [],
    aggregate: { byCategory: {}, totalMs: 0 } as DetectorContext['aggregate'],
    skills: null,
    cohort: null,
    byCat: () => ({ totalMs: 0, count: 0 }) as ReturnType<DetectorContext['byCat']>,
    ...over,
  } as DetectorContext;
}

function byId(slices: ScorecardSlice[], id: string): ScorecardSlice {
  const s = slices.find((x) => x.criterionId === id);
  if (!s) throw new Error(`missing slice ${id}`);
  return s;
}

// ── Q-C5 ─────────────────────────────────────────────────────────────────────

describe('Q-C5 — qa cost vs rigor budget (honesty-guarded)', () => {
  it('scores 🟢 within budget when spend reconciles', () => {
    const spend: AgentSpendRow[] = [{ costUsd: 4 }]; // == plan.totalCostUsd → reconciled
    const ctx = makeCtx({
      agentSpendRows: spend,
      qaReport: makeQaReport({
        costUsd: 1,
        contract: { estimatedCostUsd: 2 } as QaReport['vqa']['contract'],
      }),
    });
    const qc5 = byId(scoreQa(ctx), 'Q-C5');
    expect(qc5.verdict).toBe('🟢');
    expect(qc5.score).toBe(4);
    expect(qc5.confidence).toBe('reconciled');
  });

  it('scores 🔴 when actual >2× budget', () => {
    const ctx = makeCtx({
      agentSpendRows: [{ costUsd: 4 }],
      qaReport: makeQaReport({
        costUsd: 5,
        contract: { estimatedCostUsd: 2 } as QaReport['vqa']['contract'],
      }),
    });
    const qc5 = byId(scoreQa(ctx), 'Q-C5');
    expect(qc5.verdict).toBe('🔴');
    expect(qc5.score).toBe(0);
  });

  it('flags unreconciled (lower-bound) when spend does not reconcile', () => {
    // spend 1 vs plan 4 → |3|/4 = 0.75 > 0.15 → unreconciled.
    const ctx = makeCtx({
      agentSpendRows: [{ costUsd: 1 }],
      qaReport: makeQaReport({
        costUsd: 1,
        contract: { estimatedCostUsd: 2 } as QaReport['vqa']['contract'],
      }),
    });
    const qc5 = byId(scoreQa(ctx), 'Q-C5');
    expect(qc5.confidence).toBe('unreconciled');
    expect(String(qc5.value)).toContain('lower-bound');
  });

  it('is ⚪ when there is no QA-run cost', () => {
    const ctx = makeCtx({ qaReport: makeQaReport({}) });
    const qc5 = byId(scoreQa(ctx), 'Q-C5');
    expect(qc5.verdict).toBe('⚪');
    expect(qc5.score).toBeNull();
    expect(qc5.note).toContain('needs-instrumentation');
  });
});

// ── Q-C6 ─────────────────────────────────────────────────────────────────────

describe('Q-C6 — evidence-capture integrity', () => {
  it('🟢 when capturedRatio ≥ 0.95', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      vqaResult({ testId: `t${i}`, status: 'pass' }),
    );
    const ctx = makeCtx({ qaReport: makeQaReport({ results }) });
    const qc6 = byId(scoreQa(ctx), 'Q-C6');
    expect(qc6.verdict).toBe('🟢');
    expect(qc6.score).toBe(4);
  });

  it('🔴 when more than half the frames errored (the pacman3 class)', () => {
    const results = [
      vqaResult({ testId: 't1', status: 'errored' }),
      vqaResult({ testId: 't2', status: 'errored' }),
      vqaResult({ testId: 't3', status: 'errored' }),
      vqaResult({ testId: 't4', status: 'pass' }),
    ];
    const ctx = makeCtx({ qaReport: makeQaReport({ results }) });
    const qc6 = byId(scoreQa(ctx), 'Q-C6');
    expect(qc6.verdict).toBe('🔴');
    expect(qc6.score).toBe(0);
    expect(qc6.ieIds).toContain('IE14');
    expect(qc6.fixIds.map((f) => f.id)).toContain('F12');
  });

  it('notes the un-evaluated byte-diversity half (sidecar not surfaced)', () => {
    const ctx = makeCtx({
      qaReport: makeQaReport({ results: [vqaResult({ testId: 't1', status: 'pass' })] }),
    });
    const qc6 = byId(scoreQa(ctx), 'Q-C6');
    expect(qc6.note).toContain('needs-instrumentation');
  });

  it('is ⚪ when no tests executed', () => {
    const ctx = makeCtx({ qaReport: makeQaReport({ results: [] }) });
    const qc6 = byId(scoreQa(ctx), 'Q-C6');
    expect(qc6.verdict).toBe('⚪');
  });

  // STUCK_CAPTURE wiring (2026-06-19) — the evidence-integrity sidecar path now
  // grades byte-diversity, closing the old [needs-instrumentation] gap.
  it('🔴 when stuckCapture (all-identical / wrong surface — the pacman2 class)', () => {
    const ctx = makeCtx({
      qaReport: makeQaReport({
        results: [vqaResult({ testId: 't1', status: 'pass' })],
        evidenceIntegrity: {
          captured: 6,
          authored: 6,
          ratio: 1.0,
          integrityFailed: false,
          stuckCapture: true,
          dominantRatio: 0.83,
          distinctHashes: 2,
        },
      }),
    });
    const qc6 = byId(scoreQa(ctx), 'Q-C6');
    expect(qc6.verdict).toBe('🔴');
    expect(qc6.score).toBe(0);
    expect(qc6.note).toContain('STUCK');
    expect(qc6.note).not.toContain('needs-instrumentation');
  });

  it('🟢 when frames are captured AND distinct (evidence-integrity path)', () => {
    const ctx = makeCtx({
      qaReport: makeQaReport({
        results: [vqaResult({ testId: 't1', status: 'pass' })],
        evidenceIntegrity: {
          captured: 6,
          authored: 6,
          ratio: 1.0,
          integrityFailed: false,
          stuckCapture: false,
          dominantRatio: 0.17,
          distinctHashes: 6,
        },
      }),
    });
    const qc6 = byId(scoreQa(ctx), 'Q-C6');
    expect(qc6.verdict).toBe('🟢');
    expect(qc6.score).toBe(4);
  });

  it('🔴 when the capture gate failed (missing frames)', () => {
    const ctx = makeCtx({
      qaReport: makeQaReport({
        results: [vqaResult({ testId: 't1', status: 'errored' })],
        evidenceIntegrity: {
          captured: 0,
          authored: 6,
          ratio: 0,
          integrityFailed: true,
          stuckCapture: false,
        },
      }),
    });
    const qc6 = byId(scoreQa(ctx), 'Q-C6');
    expect(qc6.verdict).toBe('🔴');
    expect(qc6.score).toBe(0);
  });
});

// ── Q-C7 ─────────────────────────────────────────────────────────────────────

describe('Q-C7 — honest verdict under broken evidence', () => {
  it('🟢 when broken evidence routes to errored (not a blocking fail)', () => {
    const results = [
      vqaResult({
        testId: 't1',
        status: 'errored',
        rationale: 'evidence missing — screenshot not captured',
      }),
      vqaResult({ testId: 't2', status: 'pass' }),
    ];
    const ctx = makeCtx({ qaReport: makeQaReport({ results }) });
    const qc7 = byId(scoreQa(ctx), 'Q-C7');
    expect(qc7.verdict).toBe('🟢');
    expect(qc7.score).toBe(4);
  });

  it('🔴 (IE15) when a missing frame was scored as a blocking FAIL', () => {
    const results = [
      vqaResult({ testId: 't1', status: 'fail', rationale: 'screenshot 404 — frame missing' }),
      vqaResult({ testId: 't2', status: 'pass' }),
    ];
    const ctx = makeCtx({ qaReport: makeQaReport({ results }) });
    const qc7 = byId(scoreQa(ctx), 'Q-C7');
    expect(qc7.verdict).toBe('🔴');
    expect(qc7.score).toBe(0);
    expect(qc7.value).toBe(1);
    expect(qc7.ieIds).toContain('IE15');
  });

  it('does not red a legitimate render fail (rationale not broken-evidence)', () => {
    const results = [
      vqaResult({ testId: 't1', status: 'fail', rationale: 'button is red but should be green' }),
    ];
    const ctx = makeCtx({ qaReport: makeQaReport({ results }) });
    const qc7 = byId(scoreQa(ctx), 'Q-C7');
    expect(qc7.verdict).toBe('🟢');
  });
});

// ── Q-C9 ─────────────────────────────────────────────────────────────────────

describe('Q-C9 — stage isolation (log-only → ⚪)', () => {
  it('is ⚪ needs-instrumentation (never a fabricated isolation pass)', () => {
    const qc9 = byId(scoreQa(makeCtx()), 'Q-C9');
    expect(qc9.verdict).toBe('⚪');
    expect(qc9.score).toBeNull();
    expect(qc9.note).toContain('needs-instrumentation');
    expect(qc9.ieIds).toContain('IE13');
    expect(qc9.fixIds.map((f) => f.id)).toContain('F11');
  });
});

// ── shape ────────────────────────────────────────────────────────────────────

describe('scoreQa — output shape', () => {
  it('emits exactly the four QA DET criteria, all deterministic', () => {
    const slices = scoreQa(makeCtx());
    expect(slices.map((s) => s.criterionId).sort()).toEqual(['Q-C5', 'Q-C6', 'Q-C7', 'Q-C9']);
    for (const s of slices) {
      expect(s.engine).toBe('deterministic');
      expect(s.stage).toBe('qa');
    }
  });
});
