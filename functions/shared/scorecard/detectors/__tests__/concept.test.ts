// Tests for detectors/concept.ts — Plan Retrospect CONCEPT-stage scorer.
//
// Asserts the §0.6 thresholds for the two computable concept criteria (C-R2
// route latency/discipline, C-D5 gen efficiency, C-P3 decomposition) and the
// honesty guard: every criterion whose evidence isn't in the DetectorContext
// (C-D4, C-P4, C-P5, C-G2, C-G3) is emitted as '⚪' needs-instrumentation with a
// null score so the rollup denominator excludes it.

import { describe, it, expect } from 'vitest';
import { scoreConcept } from '../concept';
import type { DetectorContext } from '../../types';
import type { Plan } from '../../../types/plan';
import type { EpicWorkflow } from '../../../types/epic-workflow';
import type { AgentEvent } from '../../../types/agent-orchestrator';

// ── synthetic context builder ──────────────────────────────────────────────

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan_test',
    name: 'test-plan',
    intent: 'x',
    description: 'x',
    status: 'review',
    epicIds: ['epic_1'],
    workingDir: '/tmp/test',
    executionMode: 'pipeline',
    totalCostUsd: 1,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
    createdBy: 'tester',
    ...over,
  } as Plan;
}

function evt(jobId: string, over: Partial<AgentEvent>): AgentEvent {
  return {
    jobId,
    eventSeq: '0',
    seq: 0,
    timestamp: '2026-06-18T00:00:00Z',
    stepId: 's',
    agentId: 'a',
    eventType: 'text_delta',
    expireAt: 0,
    ...over,
  } as AgentEvent;
}

function makeCtx(over: Partial<DetectorContext> = {}): DetectorContext {
  const plan = over.plan ?? makePlan();
  return {
    planId: plan.planId,
    plan,
    epics: [],
    events: [],
    slices: [],
    aggregate: { byCategory: {} as never, totalMs: 0 },
    skills: null,
    cohort: null,
    byCat: () => ({ totalMs: 0, count: 0 }),
    ...over,
  };
}

function byId(slices: ReturnType<typeof scoreConcept>) {
  return Object.fromEntries(slices.map((s) => [s.criterionId, s]));
}

// ── always-⚪ criteria (honesty guard) ─────────────────────────────────────

describe('concept honesty guard', () => {
  it('emits ⚪ needs-instrumentation for evidence not in DetectorContext', () => {
    const slices = byId(scoreConcept(makeCtx()));
    for (const id of ['C-D4', 'C-P4', 'C-P5', 'C-G2', 'C-G3']) {
      expect(slices[id].verdict).toBe('⚪');
      expect(slices[id].score).toBeNull();
      expect(slices[id].note).toMatch(/needs-instrumentation/);
      expect(slices[id].engine).toBe('deterministic');
    }
  });

  it('every slice carries the right stage + a non-data evidence ref', () => {
    const slices = scoreConcept(makeCtx());
    expect(slices).toHaveLength(9);
    for (const s of slices) {
      expect(s.stage).toBe('concept');
      expect(typeof s.evidence.ref).toBe('string');
    }
  });
});

// ── C-G1 — gate decision quality (v3 E3-S3, reads plan.checkoutGates) ─────────

describe('C-G1 gate decision quality', () => {
  const gate = (over: Partial<NonNullable<Plan['checkoutGates']>>): Plan['checkoutGates'] => ({
    verdict: 'ready',
    errors: [],
    conditions: [],
    blocks: false,
    report: '',
    bypassedByYolo: false,
    evaluatedAt: '2026-06-19T00:00:00Z',
    ...over,
  });

  it('⚪ when no checkout-gate verdict was persisted (prototype/legacy)', () => {
    const s = byId(scoreConcept(makeCtx({ plan: makePlan({ checkoutGates: undefined }) })))['C-G1'];
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
    expect(s.note).toMatch(/needs-instrumentation/);
  });

  it('🟢 / 4 on a clean ready (or auto-pass) verdict', () => {
    const ready = byId(
      scoreConcept(makeCtx({ plan: makePlan({ checkoutGates: gate({ verdict: 'ready' }) }) })),
    )['C-G1'];
    expect(ready.verdict).toBe('🟢');
    expect(ready.score).toBe(4);
    const auto = byId(
      scoreConcept(makeCtx({ plan: makePlan({ checkoutGates: gate({ verdict: 'auto-pass' }) }) })),
    )['C-G1'];
    expect(auto.score).toBe(4);
  });

  it('🟡 / 2 on ready-with-conditions, surfacing the conditions', () => {
    const s = byId(
      scoreConcept(
        makeCtx({
          plan: makePlan({
            checkoutGates: gate({ verdict: 'ready-with-conditions', conditions: ['2 manual ACs'] }),
          }),
        }),
      ),
    )['C-G1'];
    expect(s.verdict).toBe('🟡');
    expect(s.score).toBe(2);
    expect(s.note).toMatch(/2 manual ACs/);
  });

  it('🔴 / 0 when a BLOCKING verdict started anyway via a YOLO bypass', () => {
    const s = byId(
      scoreConcept(
        makeCtx({
          plan: makePlan({
            checkoutGates: gate({
              verdict: 'not-ready',
              blocks: true,
              bypassedByYolo: true,
              errors: ['PRD requirement FR-9 is not covered by any epic.'],
            }),
          }),
        }),
      ),
    )['C-G1'];
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
    expect(String(s.value)).toMatch(/YOLO-bypassed/);
    expect(s.note).toMatch(/FR-9/);
  });
});

// ── C-R2 — routing latency & discipline ────────────────────────────────────

describe('C-R2 route latency', () => {
  it('⚪ when no conceptRouteJobId (prototype/legacy)', () => {
    const s = byId(scoreConcept(makeCtx()))['C-R2'];
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
  });

  it('🟢 when durationMs≤60s and tool_use≤8', () => {
    const plan = makePlan({ conceptRouteJobId: 'route_1' });
    const events: AgentEvent[] = [
      evt('route_1', { eventType: 'tool_use', toolName: 'Read' }),
      evt('route_1', { eventType: 'tool_use', toolName: 'Grep' }),
      evt('route_1', { eventType: 'result', durationMs: 45_000 }),
    ];
    const s = byId(scoreConcept(makeCtx({ plan, events })))['C-R2'];
    expect(s.verdict).toBe('🟢');
    expect(s.score).toBe(4);
    expect(s.value).toBe(45_000);
  });

  it('🟡 when 60s<durationMs≤180s', () => {
    const plan = makePlan({ conceptRouteJobId: 'route_1' });
    const events: AgentEvent[] = [evt('route_1', { eventType: 'result', durationMs: 120_000 })];
    const s = byId(scoreConcept(makeCtx({ plan, events })))['C-R2'];
    expect(s.verdict).toBe('🟡');
    expect(s.score).toBe(2);
  });

  it('🔴 when durationMs>180s', () => {
    const plan = makePlan({ conceptRouteJobId: 'route_1' });
    const events: AgentEvent[] = [evt('route_1', { eventType: 'result', durationMs: 200_000 })];
    const s = byId(scoreConcept(makeCtx({ plan, events })))['C-R2'];
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
  });

  it('🟡 when fast but tool_use>8 (discipline breach falls out of 🟢 band)', () => {
    const plan = makePlan({ conceptRouteJobId: 'route_1' });
    const events: AgentEvent[] = [
      ...Array.from({ length: 9 }, () =>
        evt('route_1', { eventType: 'tool_use', toolName: 'Read' }),
      ),
      evt('route_1', { eventType: 'result', durationMs: 30_000 }),
    ];
    const s = byId(scoreConcept(makeCtx({ plan, events })))['C-R2'];
    expect(s.verdict).toBe('🟡');
  });

  it('⚪ when route job has no collected events', () => {
    const plan = makePlan({ conceptRouteJobId: 'route_1' });
    const s = byId(scoreConcept(makeCtx({ plan, events: [] })))['C-R2'];
    expect(s.verdict).toBe('⚪');
  });
});

// ── C-D5 — generation efficiency ────────────────────────────────────────────

describe('C-D5 gen efficiency', () => {
  it('⚪ when no conceptArtifactJobIds', () => {
    const s = byId(scoreConcept(makeCtx()))['C-D5'];
    expect(s.verdict).toBe('⚪');
  });

  it('🟢 when worst gen-job within rigor budget (mvp)', () => {
    const plan = makePlan({
      rigor: 'mvp',
      conceptArtifactJobIds: { prd: 'g1', architecture: 'g2' },
    });
    const events: AgentEvent[] = [
      evt('g1', { eventType: 'result', durationMs: 100_000 }),
      evt('g2', { eventType: 'result', durationMs: 150_000 }),
    ];
    const s = byId(scoreConcept(makeCtx({ plan, events })))['C-D5'];
    expect(s.verdict).toBe('🟢');
    expect(s.value).toBe(150_000);
  });

  it('🔴 when worst gen-job >2× budget', () => {
    const plan = makePlan({ rigor: 'prototype', conceptArtifactJobIds: { prd: 'g1' } });
    // prototype budget = 120_000; 2× = 240_000
    const events: AgentEvent[] = [evt('g1', { eventType: 'result', durationMs: 300_000 })];
    const s = byId(scoreConcept(makeCtx({ plan, events })))['C-D5'];
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
  });
});

// ── C-P3 — decomposition sanity ─────────────────────────────────────────────

function makeEpic(stories: Array<{ wave?: number }>): EpicWorkflow {
  return {
    epicId: 'epic_1',
    stories: stories.map((s, i) => ({
      storyId: `st_${i}`,
      order: i,
      title: 't',
      description: 'd',
      status: 'done',
      wave: s.wave,
    })),
  } as EpicWorkflow;
}

describe('C-P3 decomposition', () => {
  it('🟢 when ≥1 wave has width≥2 (real parallelism)', () => {
    const epics = [makeEpic([{ wave: 0 }, { wave: 0 }, { wave: 1 }])];
    const s = byId(scoreConcept(makeCtx({ epics })))['C-P3'];
    expect(s.verdict).toBe('🟢');
    expect(s.value).toBe(2);
  });

  it('🟢 trivially for a single-story plan', () => {
    const epics = [makeEpic([{ wave: 0 }])];
    const s = byId(scoreConcept(makeCtx({ epics })))['C-P3'];
    expect(s.verdict).toBe('🟢');
  });

  it('🟡 when multiple stories but every wave is width==1 (serialized)', () => {
    const epics = [makeEpic([{ wave: 0 }, { wave: 1 }, { wave: 2 }])];
    const s = byId(scoreConcept(makeCtx({ epics })))['C-P3'];
    expect(s.verdict).toBe('🟡');
    expect(s.score).toBe(1);
  });

  it('⚪ when no stories at all', () => {
    const s = byId(scoreConcept(makeCtx({ epics: [makeEpic([])] })))['C-P3'];
    expect(s.verdict).toBe('⚪');
  });
});
