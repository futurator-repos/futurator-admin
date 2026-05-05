import { describe, it, expect } from 'vitest';
import { buildQaReport } from '../qa-report-aggregator';
import type { AgentJob } from '../../types/agent-orchestrator';
import type { AttentionItem } from '../../types/attention';
import type { EpicStory, EpicWorkflow, VisualTestDef } from '../../types/epic-workflow';
import type { Plan } from '../../types/plan';

// ── Fixture builders ────────────────────────────────────────────────

function plan(over: Partial<Plan> = {}): Plan {
  return {
    planId: 'P-1',
    name: 'test-plan',
    displayName: 'Test Plan',
    intent: 'Build something',
    description: '',
    status: 'review',
    epicIds: [],
    workingDir: '/tmp/test-plan',
    executionMode: 'pipeline',
    rigor: 'mvp',
    testingProfile: { hasBrowserTests: false },
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'u',
    ...over,
  };
}

function story(over: Partial<EpicStory> = {}): EpicStory {
  return {
    storyId: 'S1',
    order: 0,
    title: 'Something',
    description: '',
    status: 'done',
    wave: 0,
    touchPoints: [],
    criteria: [],
    visualTests: [],
    ...over,
  };
}

function epic(over: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: 'E-A',
    planId: 'P-1',
    title: 'Core',
    description: '',
    acceptanceCriteria: '',
    workingDir: '/tmp',
    status: 'completed',
    stories: [story()],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'u',
    ...over,
  };
}

function job(over: Partial<AgentJob> = {}): AgentJob {
  return {
    jobId: 'J-1',
    status: 'COMPLETED',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    createdBy: 'u',
    workingDir: '/tmp',
    pipeline: { agents: {}, steps: [] },
    ...over,
  };
}

function attention(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    planId: 'P-1',
    itemId: 'AI-1',
    createdAt: '2026-01-01T00:00:00Z',
    resolvedAt: null,
    severity: 'medium',
    category: 'test-gate-failed',
    title: 'Unit tests failing on wave 1',
    body: '',
    context: { storyId: 'S1' },
    suggestedActions: [],
    status: 'open',
    ...over,
  };
}

// ── Verdict math ────────────────────────────────────────────────────

describe('buildQaReport — plan verdict', () => {
  it('not-run when no pillars have data', () => {
    const r = buildQaReport({
      plan: plan(),
      epics: [epic({ stories: [story({ criteria: [], visualTests: [] })] })],
      jobsById: {},
      attentionItems: [],
    });
    // With no criteria, no visual tests, and rigor=mvp (gate active but no
    // wave-build jobs), all pillars return 'pending' → plan verdict is
    // 'not-run' per our state machine.
    expect(r.verdict).toBe('not-run');
  });

  it('ready when all pillars pass', () => {
    const poJob = job({
      jobId: 'po-1',
      variables: { VERDICT: 'PASS', FAILED_CRITERIA: '' },
    });
    const qaJob = job({
      jobId: 'qa-1',
      variables: { OVERALL_VERDICT: 'PASS', SCREENSHOTS: '', FAILED_TESTS: 'none' },
    });
    const buildJob = job({
      jobId: 'b-1',
      variables: {
        COMPILE_VERDICT: 'PASS',
        TYPECHECK_VERDICT: 'PASS',
        LINT_VERDICT: 'PASS',
        UNIT_TESTS_VERDICT: 'PASS',
      },
    });
    const ep = epic({
      poJobId: 'po-1',
      qaJobId: 'qa-1',
      waveBuildJobs: { '0': 'b-1' },
      stories: [
        story({
          criteria: [{ id: 'AC-1', text: 'Does a thing', needsBrowser: false }],
          visualTests: [
            { id: 'VT-1', criteriaRef: 'AC-1', description: 'd', setup: '', expect: 'ok' } as VisualTestDef,
          ],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [ep],
      jobsById: { 'po-1': poJob, 'qa-1': qaJob, 'b-1': buildJob },
      attentionItems: [],
    });
    expect(r.ac.verdict).toBe('pass');
    expect(r.vqa.verdict).toBe('pass');
    expect(r.gate.verdict).toBe('pass');
    expect(r.verdict).toBe('ready');
    expect(r.blockingReason).toBeUndefined();
  });

  it('blocking when AC has a failure', () => {
    const poJob = job({
      jobId: 'po-1',
      variables: { VERDICT: 'FAIL', FAILED_CRITERIA: 'AC-1' },
    });
    const ep = epic({
      poJobId: 'po-1',
      stories: [
        story({
          criteria: [{ id: 'AC-1', text: 'Does a thing', needsBrowser: false }],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [ep],
      jobsById: { 'po-1': poJob },
      attentionItems: [],
    });
    expect(r.ac.verdict).toBe('fail');
    expect(r.ac.failures).toHaveLength(1);
    expect(r.ac.failures[0].criterionId).toBe('AC-1');
    expect(r.verdict).toBe('blocking');
    expect(r.blockingReason).toMatch(/acceptance criteria/i);
  });
});

// ── Rigor-aware gate ────────────────────────────────────────────────

describe('buildQaReport — rigor-aware gate', () => {
  it('prototype skips the gate pillar', () => {
    const r = buildQaReport({
      plan: plan({ rigor: 'prototype' }),
      epics: [epic()],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.gate.verdict).toBe('skipped');
    expect(r.gate.waveRows).toHaveLength(0);
  });

  it('mvp includes unit but not browser (without toggle)', () => {
    const r = buildQaReport({
      plan: plan({ rigor: 'mvp', testingProfile: { hasBrowserTests: false } }),
      epics: [epic()],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.gate.activeChecks).toContain('unit');
    expect(r.gate.activeChecks).not.toContain('browser');
    expect(r.gate.activeChecks).not.toContain('tamper');
  });

  it('production includes tamper + browser (with toggle)', () => {
    const r = buildQaReport({
      plan: plan({ rigor: 'production', testingProfile: { hasBrowserTests: true } }),
      epics: [epic()],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.gate.activeChecks).toContain('tamper');
    expect(r.gate.activeChecks).toContain('browser');
  });
});

// ── Attention items ─────────────────────────────────────────────────

describe('buildQaReport — attention items', () => {
  it('filters to QA-relevant categories only', () => {
    const budget = attention({ itemId: 'B-1', category: 'budget-warning' });
    const tamper = attention({ itemId: 'T-1', category: 'tamper-reverted' });
    const r = buildQaReport({
      plan: plan(),
      epics: [epic()],
      jobsById: {},
      attentionItems: [budget, tamper],
    });
    const ids = r.attentionItems.map((i) => i.itemId);
    expect(ids).toContain('T-1');
    expect(ids).not.toContain('B-1');
  });

  it('excludes resolved items', () => {
    const resolved = attention({
      itemId: 'T-1',
      category: 'test-gate-failed',
      status: 'resolved',
      resolvedAt: '2026-01-02T00:00:00Z',
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [epic()],
      jobsById: {},
      attentionItems: [resolved],
    });
    expect(r.attentionItems).toHaveLength(0);
  });

  it('tallies tamper counts per story', () => {
    const t1 = attention({
      itemId: 'T-1',
      category: 'tamper-reverted',
      context: { storyId: 'S1' },
    });
    const t2 = attention({
      itemId: 'T-2',
      category: 'tamper-reverted',
      context: { storyId: 'S1' },
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [epic()],
      jobsById: {},
      attentionItems: [t1, t2],
    });
    expect(r.gate.tamperCountsByStory.S1).toBe(2);
  });
});

// ── AC verdict cascade ──────────────────────────────────────────────

describe('buildQaReport — AC verdict cascade', () => {
  it('implicit-pass: done story with no PO job → AC pass (mvp)', () => {
    const ep = epic({
      stories: [
        story({
          status: 'done',
          criteria: [{ id: 'AC-1', text: 'Works', needsBrowser: false }],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan({ rigor: 'mvp' }),
      epics: [ep],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.ac.pass).toBe(1);
    expect(r.ac.verdict).toBe('pass');
    expect(r.ac.canManuallyApprove).toBe(false);
  });

  it('production rigor keeps done stories pending without sign-off', () => {
    const ep = epic({
      stories: [
        story({
          status: 'done',
          criteria: [{ id: 'AC-1', text: 'Works', needsBrowser: false }],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan({ rigor: 'production' }),
      epics: [ep],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.ac.pending).toBe(1);
    expect(r.ac.verdict).toBe('pending');
    expect(r.ac.canManuallyApprove).toBe(true);
  });

  it('manual approval flips everything to pass (even production)', () => {
    const ep = epic({
      stories: [
        story({
          status: 'done',
          criteria: [{ id: 'AC-1', text: 'Works', needsBrowser: false }],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan({
        rigor: 'production',
        acApproval: { approvedAt: '2026-04-23T10:00:00Z', approvedBy: 'u1' },
      }),
      epics: [ep],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.ac.pass).toBe(1);
    expect(r.ac.verdict).toBe('pass');
    expect(r.ac.manualApproval?.approvedBy).toBe('u1');
    expect(r.ac.canManuallyApprove).toBe(false);
  });

  it('pending story with no PO job stays pending even on mvp', () => {
    const ep = epic({
      stories: [
        story({
          status: 'pending',
          criteria: [{ id: 'AC-1', text: 'Works', needsBrowser: false }],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan({ rigor: 'mvp' }),
      epics: [ep],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.ac.pending).toBe(1);
    expect(r.ac.pass).toBe(0);
  });

  it('PO job FAIL still overrides manual approval', () => {
    // If the PO explicitly says a criterion fails, operator override via
    // acApproval is NOT honored for that criterion — the PO verdict wins.
    const poJob = job({
      jobId: 'po-1',
      variables: { VERDICT: 'FAIL', FAILED_CRITERIA: 'AC-1' },
    });
    const ep = epic({
      poJobId: 'po-1',
      stories: [
        story({
          status: 'done',
          criteria: [{ id: 'AC-1', text: 'Works', needsBrowser: false }],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan({
        rigor: 'mvp',
        acApproval: { approvedAt: '2026-04-23T10:00:00Z', approvedBy: 'u1' },
      }),
      epics: [ep],
      jobsById: { 'po-1': poJob },
      attentionItems: [],
    });
    expect(r.ac.fail).toBe(1);
    expect(r.ac.verdict).toBe('fail');
  });
});

// ── Per-epic breakdown ──────────────────────────────────────────────

describe('buildQaReport — per-epic breakdown', () => {
  it('1-indexes epic labels and surfaces per-epic verdicts', () => {
    const qaA = job({
      jobId: 'qa-a',
      variables: { OVERALL_VERDICT: 'PASS', SCREENSHOTS: '', FAILED_TESTS: 'none' },
    });
    const qaB = job({
      jobId: 'qa-b',
      variables: { OVERALL_VERDICT: 'FAIL', SCREENSHOTS: '', FAILED_TESTS: 'VT-1' },
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [
        epic({ epicId: 'E-A', qaJobId: 'qa-a' }),
        epic({ epicId: 'E-B', qaJobId: 'qa-b' }),
      ],
      jobsById: { 'qa-a': qaA, 'qa-b': qaB },
      attentionItems: [],
    });
    expect(r.perEpic[0]).toMatchObject({ epicLabel: 'E1', qaVerdict: 'pass' });
    expect(r.perEpic[1]).toMatchObject({ epicLabel: 'E2', qaVerdict: 'fail' });
  });
});
