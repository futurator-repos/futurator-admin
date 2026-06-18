// Tests for the Development-stage deterministic detector (rubric §3 / §0.6).
//
// Asserts the precisely-computed criteria (D-TA2, D-CC1, D-CC3, D-MG4, D-VQ5,
// D-WS1) land on the right ratio + verdict band, and that every log-only /
// artifact-only / build-job-only criterion (D-PW*, D-TA3, D-CC2, D-MG1/2/3,
// D-VQ1/3/4, D-WS2) honestly emits ⚪ + [needs-instrumentation: …].

import { describe, it, expect } from 'vitest';
import { scoreDevelopment } from '../development';
import type { DetectorContext, ScorecardSlice } from '../../types';
import type { Plan } from '../../../types/plan';
import type { EpicWorkflow } from '../../../types/epic-workflow';
import type { AgentEvent } from '../../../types/agent-orchestrator';
import type { TimerSlice, TimerCategory } from '../../../timer/types';
import { aggregateByCategory } from '../../../timer/aggregator';

// ── fixture builders ─────────────────────────────────────────────────────────

function timerSlice(category: TimerCategory, durationMs: number, i: number): TimerSlice {
  return {
    jobId: 'job-1',
    eventSeq: String(i).padStart(6, '0'),
    category,
    startedAt: '2026-06-18T00:00:00.000Z',
    endedAt: '2026-06-18T00:00:01.000Z',
    durationMs,
    agentRole: 'dev',
    eventType: 'step_complete',
  };
}

function ev(timestamp: string, i: number): AgentEvent {
  return {
    jobId: 'job-1',
    eventSeq: String(i).padStart(6, '0'),
    seq: i,
    timestamp,
    stepId: 'dev',
    agentId: 'a',
    eventType: 'step_complete',
    expireAt: 0,
  };
}

function epic(over: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: 'epic-1',
    title: 't',
    description: 'd',
    acceptanceCriteria: '',
    workingDir: '/tmp',
    status: 'completed',
    stories: [],
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    createdBy: 'op',
    ...over,
  };
}

/**
 * Assemble a DetectorContext from synthetic timer slices + events. `byCat` is
 * built from the real `aggregateByCategory` so the detector reads exactly what
 * the production scorer would.
 */
function makeCtx(args: {
  slices: TimerSlice[];
  events?: AgentEvent[];
  epics?: EpicWorkflow[];
}): DetectorContext {
  const aggregate = aggregateByCategory(args.slices);
  const plan = { planId: 'plan-1', totalCostUsd: 0 } as unknown as Plan;
  return {
    planId: 'plan-1',
    plan,
    epics: args.epics ?? [],
    events: args.events ?? [],
    slices: args.slices,
    aggregate,
    skills: null,
    cohort: null,
    byCat: (cat: string) => aggregate.byCategory[cat as TimerCategory] ?? { totalMs: 0, count: 0 },
  };
}

function byId(slices: ScorecardSlice[], id: string): ScorecardSlice {
  const s = slices.find((x) => x.criterionId === id);
  if (!s) throw new Error(`missing slice ${id}`);
  return s;
}

// ── computed criteria ────────────────────────────────────────────────────────

describe('scoreDevelopment — computed ratios', () => {
  it('D-TA2 authoring-cost ratio bands (test-author ÷ dev)', () => {
    // 🟢: 300/1000 = 0.3 ≤ 0.6
    const green = byId(
      scoreDevelopment(
        makeCtx({ slices: [timerSlice('dev', 1000, 0), timerSlice('test-author', 300, 1)] }),
      ),
      'D-TA2',
    );
    expect(green.verdict).toBe('🟢');
    expect(green.score).toBe(4);
    expect(green.value).toBe(0.3);

    // 🟡: 800/1000 = 0.8 in (0.6, 1.0]
    const yellow = byId(
      scoreDevelopment(
        makeCtx({ slices: [timerSlice('dev', 1000, 0), timerSlice('test-author', 800, 1)] }),
      ),
      'D-TA2',
    );
    expect(yellow.verdict).toBe('🟡');
    expect(yellow.score).toBe(2);

    // 🔴: 1500/1000 = 1.5 > 1.0
    const red = byId(
      scoreDevelopment(
        makeCtx({ slices: [timerSlice('dev', 1000, 0), timerSlice('test-author', 1500, 1)] }),
      ),
      'D-TA2',
    );
    expect(red.verdict).toBe('🔴');
    expect(red.score).toBe(0);
    // carries IE7 / F7 linkage (criteria-meta)
    expect(red.ieIds).toContain('IE7');
    expect(red.fixIds.map((f) => f.id)).toContain('F7');
  });

  it('D-TA2 ⚪ when dev time is 0', () => {
    const s = byId(
      scoreDevelopment(makeCtx({ slices: [timerSlice('test-author', 300, 0)] })),
      'D-TA2',
    );
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
  });

  it('D-CC1 compiles-per-story uses devJobCount from epic.orchestratorJobId', () => {
    // 10 compile slices ÷ 2 epic-dev jobs = 5 ≤ 15 → 🟢
    const slices = Array.from({ length: 10 }, (_, i) => timerSlice('compile', 50, i));
    const ctx = makeCtx({
      slices,
      epics: [
        epic({ epicId: 'e1', orchestratorJobId: 'oj-1' }),
        epic({ epicId: 'e2', orchestratorJobId: 'oj-2' }),
      ],
    });
    const s = byId(scoreDevelopment(ctx), 'D-CC1');
    expect(s.value).toBe(5);
    expect(s.verdict).toBe('🟢');
    expect(s.score).toBe(4);

    // 100 compiles ÷ 2 = 50 > 40 → 🔴 (reproduces IE1 compile thrash → F1)
    const manySlices = Array.from({ length: 100 }, (_, i) => timerSlice('compile', 50, i));
    const red = byId(
      scoreDevelopment(
        makeCtx({
          slices: manySlices,
          epics: [
            epic({ epicId: 'e1', orchestratorJobId: 'oj-1' }),
            epic({ epicId: 'e2', orchestratorJobId: 'oj-2' }),
          ],
        }),
      ),
      'D-CC1',
    );
    expect(red.value).toBe(50);
    expect(red.verdict).toBe('🔴');
    expect(red.ieIds).toContain('IE1');
    expect(red.fixIds.map((f) => f.id)).toContain('F1');
  });

  it('D-CC1 ⚪ when no epic-dev job is resolvable (devJobCount 0)', () => {
    const s = byId(
      scoreDevelopment(makeCtx({ slices: [timerSlice('compile', 50, 0)], epics: [epic()] })),
      'D-CC1',
    );
    expect(s.verdict).toBe('⚪');
    expect(s.note).toMatch(/needs-instrumentation/);
  });

  it('D-CC3 compile share of total time', () => {
    // compile 200 of total 1000 = 0.2 in (0.15, 0.25] → 🟡
    const s = byId(
      scoreDevelopment(
        makeCtx({ slices: [timerSlice('compile', 200, 0), timerSlice('dev', 800, 1)] }),
      ),
      'D-CC3',
    );
    expect(s.value).toBe(0.2);
    expect(s.verdict).toBe('🟡');
  });

  it('D-MG4 merge-gate latency per wave', () => {
    // merge-gate 200000ms ÷ 2 waves = 100000 in (60000, 120000] → 🟡
    const ctx = makeCtx({
      slices: [timerSlice('merge-gate', 200000, 0)],
      epics: [epic({ waveBuildJobs: { '0': 'b0', '1': 'b1' } })],
    });
    const s = byId(scoreDevelopment(ctx), 'D-MG4');
    expect(s.value).toBe(100000);
    expect(s.verdict).toBe('🟡');
  });

  it('D-MG4 ⚪ when there are no waves with build-check jobs', () => {
    const s = byId(
      scoreDevelopment(makeCtx({ slices: [timerSlice('merge-gate', 5000, 0)], epics: [epic()] })),
      'D-MG4',
    );
    expect(s.verdict).toBe('⚪');
  });

  it('D-VQ5 VQA share of total time', () => {
    // vqa-gate 50 of 1000 = 0.05 ≤ 0.15 → 🟢
    const s = byId(
      scoreDevelopment(
        makeCtx({ slices: [timerSlice('vqa-gate', 50, 0), timerSlice('dev', 950, 1)] }),
      ),
      'D-VQ5',
    );
    expect(s.value).toBe(0.05);
    expect(s.verdict).toBe('🟢');
  });

  it('D-WS1 parallelism factor over the event wall span (multi-story only)', () => {
    // totalMs 3000 over a 2000ms event span = 1.5 ≥ 1.5 → 🟢
    const ctx = makeCtx({
      slices: [timerSlice('dev', 3000, 0)],
      events: [ev('2026-06-18T00:00:00.000Z', 0), ev('2026-06-18T00:00:02.000Z', 1)],
      epics: [
        epic({
          stories: [
            { storyId: 's1', order: 0, title: 'a', description: '', status: 'done' },
            { storyId: 's2', order: 1, title: 'b', description: '', status: 'done' },
          ],
        }),
      ],
    });
    const s = byId(scoreDevelopment(ctx), 'D-WS1');
    expect(s.value).toBe(1.5);
    expect(s.verdict).toBe('🟢');
    expect(s.ieIds).toContain('IE11');
    expect(s.fixIds.map((f) => f.id)).toContain('F10');
  });

  it('D-WS1 ⚪ for single-story plans (no parallel opportunity)', () => {
    const ctx = makeCtx({
      slices: [timerSlice('dev', 3000, 0)],
      events: [ev('2026-06-18T00:00:00.000Z', 0), ev('2026-06-18T00:00:02.000Z', 1)],
      epics: [
        epic({
          stories: [{ storyId: 's1', order: 0, title: 'a', description: '', status: 'done' }],
        }),
      ],
    });
    const s = byId(scoreDevelopment(ctx), 'D-WS1');
    expect(s.verdict).toBe('⚪');
    expect(s.note).toMatch(/single-story/);
  });
});

// ── honesty guard ────────────────────────────────────────────────────────────

describe('scoreDevelopment — honesty guard', () => {
  it('emits ⚪ + [needs-instrumentation] for every log/artifact/build-job criterion', () => {
    const slices = scoreDevelopment(makeCtx({ slices: [] }));
    const mustBeWhite = [
      'D-PW1',
      'D-PW2',
      'D-TA3',
      'D-CC2',
      'D-MG1',
      'D-MG2',
      'D-MG3',
      'D-VQ1',
      'D-VQ3',
      'D-VQ4',
      'D-WS2',
    ];
    for (const id of mustBeWhite) {
      const s = byId(slices, id);
      expect(s.verdict, id).toBe('⚪');
      expect(s.score, id).toBeNull();
      expect(s.note, id).toMatch(/\[needs-instrumentation: .+\]/);
    }
  });

  it('every emitted slice is deterministic engine and carries the right stage', () => {
    const slices = scoreDevelopment(makeCtx({ slices: [] }));
    for (const s of slices) {
      expect(s.engine).toBe('deterministic');
      expect(s.stage).toBe('development');
    }
  });

  it('emits each owned criterion exactly once (no duplicates)', () => {
    const slices = scoreDevelopment(makeCtx({ slices: [] }));
    const ids = slices.map((s) => s.criterionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
