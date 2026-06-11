import { describe, it, expect } from 'vitest';
import {
  aggregateEpic,
  aggregatePlan,
  aggregateWave,
  buildDashboardPlan,
  flattenStories,
  progressFor,
  DEFAULT_PLANNED_SEC,
  fmtCost,
  fmtSec,
  fmtTokens,
} from '../adapter';
import type { PlanWithEpics } from '@/hooks/use-plans';
import type { AgentJob } from '@/types/agent-orchestrator';
import type { EpicStory, EpicWorkflow } from '@/types/epic-workflow';

// ── Fixtures ─────────────────────────────────────────────────────────

function story(over: Partial<EpicStory> = {}): EpicStory {
  return {
    storyId: 'S1',
    order: 0,
    title: 'Scaffold project',
    description: 'Scaffold the thing.',
    status: 'pending',
    wave: 0,
    touchPoints: [],
    criteria: [],
    ...over,
  };
}

function epic(over: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: 'E-ABC',
    planId: 'P-1',
    title: 'Core',
    description: 'Build the core.',
    acceptanceCriteria: '',
    workingDir: '/tmp',
    status: 'in_progress',
    epicWave: 0,
    dependsOnEpics: [],
    stories: [story()],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'u',
    ...over,
  };
}

function plan(over: Partial<PlanWithEpics> = {}): PlanWithEpics {
  return {
    planId: 'P-1',
    name: 'pong',
    intent: 'Build pong',
    description: '',
    status: 'developing',
    epicIds: ['E-ABC'],
    workingDir: '/home/ubuntu/projects/pong',
    executionMode: 'pipeline',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'u',
    epics: [epic()],
    ...over,
  };
}

function job(over: Partial<AgentJob> = {}): AgentJob {
  return {
    jobId: 'J-1',
    status: 'COMPLETED',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:02:00Z', // 120s later
    createdBy: 'u',
    workingDir: '/tmp',
    pipeline: { agents: {}, steps: [] },
    totalCost: 0.42,
    stepResults: [
      { stepId: 'dev', agentId: 'dev', status: 'complete', inputTokens: 1_000, outputTokens: 500 },
    ],
    ...over,
  };
}

// ── progressFor ──────────────────────────────────────────────────────

describe('progressFor', () => {
  it('maps status to percentage', () => {
    expect(progressFor('pending')).toBe(0);
    expect(progressFor('running')).toBe(50);
    expect(progressFor('in_review')).toBe(92);
    expect(progressFor('done')).toBe(100);
    expect(progressFor('fixing')).toBe(40);
  });
});

// ── buildDashboardPlan ───────────────────────────────────────────────

describe('buildDashboardPlan', () => {
  it('synthesizes sp=1 and plannedSec default for every story', () => {
    const d = buildDashboardPlan(plan(), {});
    const s = d.epics[0].waves[0].stories[0];
    expect(s.sp).toBe(1);
    expect(s.plannedSec).toBe(DEFAULT_PLANNED_SEC);
  });

  it('groups stories into waves by EpicStory.wave', () => {
    const e = epic({
      stories: [
        story({ storyId: 'S1', wave: 0 }),
        story({ storyId: 'S2', wave: 0 }),
        story({ storyId: 'S3', wave: 1 }),
      ],
    });
    const d = buildDashboardPlan(plan({ epics: [e] }), {});
    expect(d.epics[0].waves).toHaveLength(2);
    expect(d.epics[0].waves[0].stories.map((s) => s.id)).toEqual(['S1', 'S2']);
    expect(d.epics[0].waves[1].stories.map((s) => s.id)).toEqual(['S3']);
  });

  it('produces 1-indexed epic labels and resolves dependsOn to labels', () => {
    const d = buildDashboardPlan(
      plan({
        epics: [
          epic({ epicId: 'E-A', stories: [] }),
          epic({ epicId: 'E-B', dependsOnEpics: ['E-A'], stories: [] }),
        ],
      }),
      {},
    );
    expect(d.epics[0].label).toBe('E1');
    expect(d.epics[1].label).toBe('E2');
    expect(d.epics[1].dependsOnLabels).toEqual(['E1']);
  });

  it('hydrates story metrics from linked job when COMPLETED', () => {
    const s = story({ storyId: 'S1', jobId: 'J-1', status: 'done' });
    const d = buildDashboardPlan(plan({ epics: [epic({ stories: [s] })] }), {
      'J-1': job(),
    });
    const out = d.epics[0].waves[0].stories[0];
    expect(out.actualSec).toBe(120);
    expect(out.cost).toBe(0.42);
    expect(out.tokens).toBe(1_500);
    expect(out.finishedAtIso).toBe('2026-01-01T00:02:00Z');
  });

  it('computes live elapsedSec for running stories using injected now', () => {
    const now = Date.parse('2026-01-01T00:00:45Z'); // 45s after job createdAt
    const s = story({ storyId: 'S1', jobId: 'J-1', status: 'running' });
    const d = buildDashboardPlan(
      plan({ epics: [epic({ stories: [s] })] }),
      { 'J-1': job({ status: 'RUNNING', updatedAt: '2026-01-01T00:00:05Z' }) },
      { now },
    );
    const out = d.epics[0].waves[0].stories[0];
    expect(out.actualSec).toBe(45);
    expect(out.finishedAtIso).toBeNull();
  });

  it('returns null metrics for stories without a job', () => {
    const s = story({ storyId: 'S1', status: 'pending' });
    const d = buildDashboardPlan(plan({ epics: [epic({ stories: [s] })] }), {});
    const out = d.epics[0].waves[0].stories[0];
    expect(out.actualSec).toBeNull();
    expect(out.cost).toBe(0);
    expect(out.tokens).toBe(0);
    expect(out.jobId).toBeNull();
  });

  it('handles missing epics array (concept plan)', () => {
    const d = buildDashboardPlan(plan({ epics: undefined }), {});
    expect(d.epics).toEqual([]);
  });
});

// ── aggregateWave / aggregateEpic / aggregatePlan ────────────────────

describe('aggregation', () => {
  it('wave time = max(story planned) and sums cost/tokens', () => {
    const e = epic({
      stories: [
        story({ storyId: 'S1', jobId: 'J-1', status: 'done' }),
        story({ storyId: 'S2', status: 'pending' }),
      ],
    });
    const d = buildDashboardPlan(plan({ epics: [e] }), { 'J-1': job({ totalCost: 1.0 }) });
    const wave = d.epics[0].waves[0];
    const agg = aggregateWave(wave);
    expect(agg.total).toBe(2);
    expect(agg.done).toBe(1);
    expect(agg.cost).toBe(1.0);
    expect(agg.planned).toBe(DEFAULT_PLANNED_SEC);
    expect(agg.progress).toBe(50);
  });

  it('epic time = sum(wave planned) (sequential waves)', () => {
    const e = epic({
      stories: [story({ storyId: 'S1', wave: 0 }), story({ storyId: 'S2', wave: 1 })],
    });
    const d = buildDashboardPlan(plan({ epics: [e] }), {});
    const agg = aggregateEpic(d.epics[0]);
    expect(agg.planned).toBe(DEFAULT_PLANNED_SEC * 2);
    expect(agg.total).toBe(2);
  });

  it('plan time = sum(epic planned); weighted progress', () => {
    const d = buildDashboardPlan(
      plan({
        epics: [
          epic({ epicId: 'E1', stories: [story({ storyId: 'A', status: 'done' })] }),
          epic({ epicId: 'E2', stories: [story({ storyId: 'B', status: 'pending' })] }),
        ],
      }),
      {},
    );
    const agg = aggregatePlan(d);
    expect(agg.planned).toBe(DEFAULT_PLANNED_SEC * 2);
    expect(agg.done).toBe(1);
    expect(agg.total).toBe(2);
    expect(agg.progress).toBe(50); // one done, one pending
  });

  it('empty wave aggregates safely', () => {
    const w = { id: 'W', label: 'W', waveIndex: 0, stories: [], gateJobId: null };
    const agg = aggregateWave(w);
    expect(agg.progress).toBe(0);
    expect(agg.planned).toBe(0);
  });
});

// ── flattenStories ───────────────────────────────────────────────────

describe('flattenStories', () => {
  it('flattens across epics and waves in order', () => {
    const d = buildDashboardPlan(
      plan({
        epics: [
          epic({
            epicId: 'E1',
            stories: [story({ storyId: 'A', wave: 0 }), story({ storyId: 'B', wave: 1 })],
          }),
          epic({ epicId: 'E2', stories: [story({ storyId: 'C' })] }),
        ],
      }),
      {},
    );
    expect(flattenStories(d).map((s) => s.id)).toEqual(['A', 'B', 'C']);
  });
});

// ── formatters ───────────────────────────────────────────────────────

describe('formatters', () => {
  it('fmtSec', () => {
    expect(fmtSec(null)).toBe('—');
    expect(fmtSec(45)).toBe('45s');
    expect(fmtSec(125)).toBe('2m 5s');
  });
  it('fmtCost', () => {
    expect(fmtCost(0)).toBe('$0.00');
    expect(fmtCost(1.234)).toBe('$1.23');
    expect(fmtCost(null)).toBe('$0.00');
  });
  it('fmtTokens', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(850)).toBe('850');
    expect(fmtTokens(1234)).toBe('1k');
    expect(fmtTokens(1_234_567)).toBe('1.2M');
  });
});
