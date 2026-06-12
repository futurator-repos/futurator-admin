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
            {
              id: 'VT-1',
              criteriaRef: 'AC-1',
              description: 'd',
              setup: '',
              expect: 'ok',
            } as VisualTestDef,
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
      epics: [epic({ epicId: 'E-A', qaJobId: 'qa-a' }), epic({ epicId: 'E-B', qaJobId: 'qa-b' })],
      jobsById: { 'qa-a': qaA, 'qa-b': qaB },
      attentionItems: [],
    });
    expect(r.perEpic[0]).toMatchObject({ epicLabel: 'E1', qaVerdict: 'pass' });
    expect(r.perEpic[1]).toMatchObject({ epicLabel: 'E2', qaVerdict: 'fail' });
  });
});

// ── PR-8d — executeStatus + contract draft ───────────────────────────

/**
 * Build a realistic AGGREGATE_OUTPUT block matching what the qa-aggregate
 * step emits (functions/shared/pipelines/visual-qa-pipeline.ts:298-310).
 */
function aggregateOutput(opts: {
  total: number;
  byLevel: { L0: number; L1: number; L2: number };
  cost: number;
  wallclock: number;
  classifiedTests: Array<{ testId: string; level: 'L0' | 'L1' | 'L2'; reason?: string }>;
  coverageWarnings?: Array<{ acId?: string; message: string }>;
  specificityWarnings?: Array<{ testId?: string; reason?: string; message: string }>;
}): string {
  const lines: string[] = ['---QA_AGGREGATE_REPORT---'];
  lines.push('CONTRACT_STATUS: PENDING_APPROVAL');
  lines.push('OVERALL_VERDICT: PENDING_APPROVAL');
  lines.push(`TOTAL_TESTS: ${opts.total}`);
  lines.push(`L0_COUNT: ${opts.byLevel.L0}`);
  lines.push(`L1_COUNT: ${opts.byLevel.L1}`);
  lines.push(`L2_COUNT: ${opts.byLevel.L2}`);
  lines.push(`ESTIMATED_COST_USD: ${opts.cost.toFixed(4)}`);
  lines.push(`ESTIMATED_WALLCLOCK_SEC: ${opts.wallclock}`);
  lines.push(`COVERAGE_WARNINGS: ${JSON.stringify(opts.coverageWarnings ?? [])}`);
  lines.push(`SPECIFICITY_WARNINGS: ${JSON.stringify(opts.specificityWarnings ?? [])}`);
  lines.push(
    `CLASSIFIED_TESTS: ${JSON.stringify(
      opts.classifiedTests.map((t) => ({
        testId: t.testId,
        classification: { level: t.level, reason: t.reason ?? 'classified' },
      })),
    )}`,
  );
  lines.push('---END_QA_AGGREGATE_REPORT---');
  return lines.join('\n');
}

describe('buildQaReport — VQA executeStatus + contract draft', () => {
  it('never-run when plan has no aggregate and no execute job', () => {
    const r = buildQaReport({
      plan: plan(),
      epics: [epic()],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.vqa.executeStatus).toBe('never-run');
    expect(r.vqa.contract).toBeUndefined();
  });

  it('queued-contract when aggregate is COMPLETED and contract pending', () => {
    const aggregateJob = job({
      jobId: 'agg-1',
      variables: {
        AGGREGATE_OUTPUT: aggregateOutput({
          total: 2,
          byLevel: { L0: 0, L1: 2, L2: 0 },
          cost: 0.01,
          wallclock: 10,
          classifiedTests: [
            { testId: 'VT-1', level: 'L1', reason: 'level set in source' },
            { testId: 'VT-2', level: 'L1', reason: 'level set in source' },
          ],
        }),
      },
    });
    const ep = epic({
      stories: [
        story({
          criteria: [{ id: 'AC-1', text: 'something', needsBrowser: true }],
          visualTests: [
            {
              id: 'VT-1',
              criteriaRef: 'AC-1',
              description: 'test 1',
              setup: '',
              expect: 'pass',
            } as VisualTestDef,
            {
              id: 'VT-2',
              criteriaRef: 'AC-1',
              description: 'test 2',
              setup: '',
              expect: 'pass',
            } as VisualTestDef,
          ],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan({
        qaAggregateJobId: 'agg-1',
        qaContractStatus: 'pending',
      }),
      epics: [ep],
      jobsById: { 'agg-1': aggregateJob },
      attentionItems: [],
    });
    expect(r.vqa.executeStatus).toBe('queued-contract');
    expect(r.vqa.contract).toBeDefined();
    expect(r.vqa.contract).toMatchObject({
      aggregateJobId: 'agg-1',
      status: 'pending',
      totalTests: 2,
      byLevel: { L0: 0, L1: 2, L2: 0 },
      estimatedCostUsd: 0.01,
      estimatedWallclockSec: 10,
    });
    expect(r.vqa.contract!.classifiedTests).toHaveLength(2);
    expect(r.vqa.contract!.classifiedTests[0]).toMatchObject({
      testId: 'VT-1',
      level: 'L1',
      criteriaRef: 'AC-1',
      expect: 'pass',
      estimatedCostUsd: 0.005,
      estimatedWallclockSec: 5,
      epicLabel: 'E1',
    });
  });

  it('contract carries coverage + specificity warnings', () => {
    const aggregateJob = job({
      jobId: 'agg-2',
      variables: {
        AGGREGATE_OUTPUT: aggregateOutput({
          total: 1,
          byLevel: { L0: 0, L1: 1, L2: 0 },
          cost: 0.005,
          wallclock: 5,
          classifiedTests: [{ testId: 'VT-1', level: 'L1' }],
          coverageWarnings: [
            { acId: 'AC-2', message: 'AC-2 has needsBrowser=true but no visual test' },
          ],
          specificityWarnings: [
            { testId: 'VT-1', reason: 'vague-expect', message: 'VT-1 expect is vague' },
          ],
        }),
      },
    });
    const ep = epic({
      stories: [
        story({
          visualTests: [
            {
              id: 'VT-1',
              criteriaRef: 'AC-1',
              description: 'test',
              setup: '',
              expect: 'vague',
            } as VisualTestDef,
          ],
        }),
      ],
    });
    const r = buildQaReport({
      plan: plan({ qaAggregateJobId: 'agg-2', qaContractStatus: 'pending' }),
      epics: [ep],
      jobsById: { 'agg-2': aggregateJob },
      attentionItems: [],
    });
    expect(r.vqa.contract!.coverageWarnings).toHaveLength(1);
    expect(r.vqa.contract!.coverageWarnings[0]).toMatchObject({
      refId: 'AC-2',
      message: 'AC-2 has needsBrowser=true but no visual test',
    });
    expect(r.vqa.contract!.specificityWarnings).toHaveLength(1);
    expect(r.vqa.contract!.specificityWarnings[0]).toMatchObject({
      refId: 'VT-1',
      reason: 'vague-expect',
    });
  });

  it('queued-execute when execute job exists but is PENDING', () => {
    const execJob = job({ jobId: 'exec-1', status: 'PENDING' });
    const r = buildQaReport({
      plan: plan({
        qaAggregateJobId: 'agg-1',
        qaJobId: 'exec-1',
        qaContractStatus: 'approved',
      }),
      epics: [epic()],
      jobsById: { 'exec-1': execJob },
      attentionItems: [],
    });
    expect(r.vqa.executeStatus).toBe('queued-execute');
  });

  it('running when execute job is RUNNING', () => {
    const execJob = job({ jobId: 'exec-1', status: 'RUNNING' });
    const r = buildQaReport({
      plan: plan({
        qaAggregateJobId: 'agg-1',
        qaJobId: 'exec-1',
        qaContractStatus: 'approved',
      }),
      epics: [epic()],
      jobsById: { 'exec-1': execJob },
      attentionItems: [],
    });
    expect(r.vqa.executeStatus).toBe('running');
  });

  it('done when execute job is COMPLETED — contract stays populated for history', () => {
    const aggregateJob = job({
      jobId: 'agg-1',
      variables: {
        AGGREGATE_OUTPUT: aggregateOutput({
          total: 1,
          byLevel: { L0: 0, L1: 1, L2: 0 },
          cost: 0.005,
          wallclock: 5,
          classifiedTests: [{ testId: 'VT-1', level: 'L1' }],
        }),
      },
    });
    const execJob = job({
      jobId: 'exec-1',
      status: 'COMPLETED',
      variables: { OVERALL_VERDICT: 'PASS', FAILED_TESTS: 'none' },
    });
    const r = buildQaReport({
      plan: plan({
        qaAggregateJobId: 'agg-1',
        qaJobId: 'exec-1',
        qaContractStatus: 'approved',
        qaContractDecidedBy: 'op@x.com',
        qaContractDecidedAt: '2026-05-18T16:00:00Z',
      }),
      epics: [
        epic({
          stories: [
            story({
              visualTests: [
                {
                  id: 'VT-1',
                  criteriaRef: 'AC-1',
                  description: 'd',
                  setup: '',
                  expect: 'ok',
                } as VisualTestDef,
              ],
            }),
          ],
        }),
      ],
      jobsById: { 'agg-1': aggregateJob, 'exec-1': execJob },
      attentionItems: [],
    });
    expect(r.vqa.executeStatus).toBe('done');
    expect(r.vqa.contract).toBeDefined();
    expect(r.vqa.contract!.status).toBe('approved');
    expect(r.vqa.contract!.decidedBy).toBe('op@x.com');
  });

  it('rejected when operator declined the contract', () => {
    const aggregateJob = job({
      jobId: 'agg-1',
      variables: {
        AGGREGATE_OUTPUT: aggregateOutput({
          total: 1,
          byLevel: { L0: 0, L1: 1, L2: 0 },
          cost: 0.005,
          wallclock: 5,
          classifiedTests: [{ testId: 'VT-1', level: 'L1' }],
        }),
      },
    });
    const r = buildQaReport({
      plan: plan({
        qaAggregateJobId: 'agg-1',
        qaContractStatus: 'rejected',
        qaContractDecidedBy: 'op@x.com',
      }),
      epics: [
        epic({
          stories: [
            story({
              visualTests: [
                {
                  id: 'VT-1',
                  criteriaRef: 'AC-1',
                  description: 'd',
                  setup: '',
                  expect: 'ok',
                } as VisualTestDef,
              ],
            }),
          ],
        }),
      ],
      jobsById: { 'agg-1': aggregateJob },
      attentionItems: [],
    });
    expect(r.vqa.executeStatus).toBe('rejected');
    expect(r.vqa.contract!.status).toBe('rejected');
    expect(r.vqa.contract!.decidedBy).toBe('op@x.com');
  });

  it('prototype rigor short-circuits to never-run with skipped verdict', () => {
    const r = buildQaReport({
      plan: plan({ rigor: 'prototype' }),
      epics: [
        epic({
          stories: [
            story({
              visualTests: [
                {
                  id: 'VT-1',
                  criteriaRef: 'AC-1',
                  description: 'd',
                  setup: '',
                  expect: 'ok',
                } as VisualTestDef,
              ],
            }),
          ],
        }),
      ],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.vqa.verdict).toBe('skipped');
    expect(r.vqa.executeStatus).toBe('never-run');
    expect(r.vqa.contract).toBeUndefined();
  });

  it('aggregate output with no classified-test source row skips that row gracefully', () => {
    // Operator removed VT-2 from the story after aggregate ran; aggregator
    // joins by id and silently drops orphans rather than crashing.
    const aggregateJob = job({
      jobId: 'agg-1',
      variables: {
        AGGREGATE_OUTPUT: aggregateOutput({
          total: 2,
          byLevel: { L0: 0, L1: 2, L2: 0 },
          cost: 0.01,
          wallclock: 10,
          classifiedTests: [
            { testId: 'VT-1', level: 'L1' },
            { testId: 'VT-orphan', level: 'L1' },
          ],
        }),
      },
    });
    const r = buildQaReport({
      plan: plan({ qaAggregateJobId: 'agg-1', qaContractStatus: 'pending' }),
      epics: [
        epic({
          stories: [
            story({
              visualTests: [
                {
                  id: 'VT-1',
                  criteriaRef: 'AC-1',
                  description: 'd',
                  setup: '',
                  expect: 'ok',
                } as VisualTestDef,
              ],
            }),
          ],
        }),
      ],
      jobsById: { 'agg-1': aggregateJob },
      attentionItems: [],
    });
    expect(r.vqa.contract!.totalTests).toBe(2); // header still shows the original
    expect(r.vqa.contract!.classifiedTests).toHaveLength(1); // orphan dropped
    expect(r.vqa.contract!.classifiedTests[0].testId).toBe('VT-1');
  });
});

// ── QA-A (pong1 2026-06-12) — single-count plan-scoped rollup ───────
//
// pong1 forensic: with plan-scoped QA (plan.qaJobId), the old per-epic loop
// resolved the SAME job for every epic and ingested its app-wide
// TEST_RESULTS once per epic — 2 epics × 4 tests rendered as "VQA 8/8",
// 8 thumbnails, doubled runCostUsd, and results stamped with the wrong
// epicId. These tests pin: N unique tests → N results regardless of epic
// count, cost counted once, attribution from the plan-wide join.

function vt(id: string, over: Partial<VisualTestDef> = {}): VisualTestDef {
  return {
    id,
    criteriaRef: `AC-${id}`,
    description: `desc ${id}`,
    setup: '',
    expect: `expect ${id}`,
    ...over,
  } as VisualTestDef;
}

function planScopedFixture() {
  const testResults = JSON.stringify([
    {
      testId: 'VT-1',
      level: 'L1',
      verdict: 'pass',
      screenshotUrl: 'https://s/1.png',
      costUsd: 0.01,
    },
    { testId: 'VT-2', level: 'L1', verdict: 'pass', costUsd: 0.01 },
    { testId: 'VT-3', level: 'L1', verdict: 'fail', rationale: 'paddle missing', costUsd: 0.01 },
    { testId: 'VT-4', level: 'L0', verdict: 'pass', costUsd: 0 },
  ]);
  const qaJob = job({
    jobId: 'qa-plan-1',
    variables: { TEST_RESULTS: testResults, COST_USD: '0.04', WALLCLOCK_SEC: '120' },
  });
  const e1 = epic({
    epicId: 'E-A',
    stories: [
      story({ storyId: 'S1', title: 'Court story', visualTests: [vt('VT-1'), vt('VT-2')] }),
    ],
  });
  const e2 = epic({
    epicId: 'E-B',
    stories: [
      story({
        storyId: 'S2',
        title: 'Paddle story',
        visualTests: [vt('VT-3', { level: 'L1' }), vt('VT-4')],
      }),
    ],
  });
  return { qaJob, e1, e2 };
}

describe('QA-A — plan-scoped VQA rollup is single-counted', () => {
  it('4 unique tests across 2 epics → total 4 (NOT 8), cost counted once', () => {
    const { qaJob, e1, e2 } = planScopedFixture();
    const r = buildQaReport({
      plan: plan({ qaJobId: 'qa-plan-1' }),
      epics: [e1, e2],
      jobsById: { 'qa-plan-1': qaJob },
      attentionItems: [],
    });
    expect(r.vqa.total).toBe(4);
    expect(r.vqa.pass).toBe(3);
    expect(r.vqa.fail).toBe(1);
    expect(r.vqa.results).toHaveLength(4);
    expect(r.vqa.costUsd).toBeCloseTo(0.04);
    expect(r.vqa.wallclockSec).toBe(120);
  });

  it('results are attributed to the OWNING epic/story via the plan-wide join', () => {
    const { qaJob, e1, e2 } = planScopedFixture();
    const r = buildQaReport({
      plan: plan({ qaJobId: 'qa-plan-1' }),
      epics: [e1, e2],
      jobsById: { 'qa-plan-1': qaJob },
      attentionItems: [],
    });
    const byId = new Map(r.vqa.results!.map((t) => [t.testId, t]));
    expect(byId.get('VT-1')!.epicId).toBe('E-A');
    expect(byId.get('VT-1')!.storyId).toBe('S1');
    expect(byId.get('VT-1')!.storyTitle).toBe('Court story');
    expect(byId.get('VT-1')!.epicLabel).toBe('E1');
    expect(byId.get('VT-3')!.epicId).toBe('E-B');
    expect(byId.get('VT-3')!.epicLabel).toBe('E2');
  });

  it('exposes level + criteriaRef + description on every result', () => {
    const { qaJob, e1, e2 } = planScopedFixture();
    const r = buildQaReport({
      plan: plan({ qaJobId: 'qa-plan-1' }),
      epics: [e1, e2],
      jobsById: { 'qa-plan-1': qaJob },
      attentionItems: [],
    });
    for (const t of r.vqa.results!) {
      expect(t.criteriaRef).toBe(`AC-${t.testId}`);
      expect(t.description).toBe(`desc ${t.testId}`);
    }
    expect(r.vqa.results!.find((t) => t.testId === 'VT-4')!.level).toBe('L0');
  });

  it('an authored test missing from the run results is PENDING (not silently dropped)', () => {
    const { qaJob, e1, e2 } = planScopedFixture();
    const e3 = epic({
      epicId: 'E-C',
      stories: [story({ storyId: 'S3', title: 'Late story', visualTests: [vt('VT-9')] })],
    });
    const r = buildQaReport({
      plan: plan({ qaJobId: 'qa-plan-1' }),
      epics: [e1, e2, e3],
      jobsById: { 'qa-plan-1': qaJob },
      attentionItems: [],
    });
    expect(r.vqa.total).toBe(5);
    const late = r.vqa.results!.find((t) => t.testId === 'VT-9')!;
    expect(late.status).toBe('pending');
    expect(late.epicLabel).toBe('E3');
  });
});

describe('QA-A — qaRuns panels deduplicate plan-scoped runs', () => {
  it('plan-scoped: ONE panel covering both epics (was: one identical panel per epic)', () => {
    const { qaJob, e1, e2 } = planScopedFixture();
    const r = buildQaReport({
      plan: plan({ qaJobId: 'qa-plan-1' }),
      epics: [e1, e2],
      jobsById: { 'qa-plan-1': qaJob },
      attentionItems: [],
    });
    expect(r.qaRuns).toHaveLength(1);
    expect(r.qaRuns[0].scope).toBe('plan');
    expect(r.qaRuns[0].epicLabels).toEqual(['E1', 'E2']);
    expect(r.qaRuns[0].title).toContain('plan-scoped');
  });

  it('legacy per-epic jobs: one panel each', () => {
    const { e1, e2 } = planScopedFixture();
    const r = buildQaReport({
      plan: plan(),
      epics: [
        { ...e1, qaJobId: 'qa-e1' },
        { ...e2, qaJobId: 'qa-e2' },
      ],
      jobsById: {},
      attentionItems: [],
    });
    expect(r.qaRuns).toHaveLength(2);
    expect(r.qaRuns.map((p) => p.scope)).toEqual(['epic', 'epic']);
  });
});

// ── QA-B (pong1 2026-06-12) — wave-gate VQA ingestion ───────────────

describe('QA-B — gateVqa claims from waveMergeResult.vqa', () => {
  function gateJob(jobId: string, vqa: Record<string, unknown>) {
    return {
      ...job({ jobId }),
      waveMergeResult: { outcome: 'success', vqa },
    } as AgentJob;
  }

  it('builds the full fix-forward arc: wave-2 FAIL → fix story → wave-3 PASS = fixed-by-story', () => {
    const owner = story({
      storyId: 'S5',
      title: 'Ball physics',
      wave: 2,
      criteria: [{ id: 'AC-S5-1', text: 'Ball bounces off paddle', needsBrowser: true }],
    });
    const fixStory = {
      ...story({
        storyId: 'S6',
        title: 'Fix visual regression: AC-S5-1',
        wave: 3,
        criteria: [{ id: 'AC-S5-1', text: 'Ball bounces off paddle', needsBrowser: true }],
      }),
      origin: 'wave-vqa-fix',
      dependsOn: ['S5'],
    } as EpicStory;
    const ep = epic({
      epicId: 'E-A',
      stories: [owner, fixStory],
      waveBuildJobs: { '2': 'gate-w2', '3': 'gate-w3' },
    });
    const w2 = gateJob('gate-w2', {
      outcome: 'fix-forward',
      pass: 0,
      fixed: 0,
      unverifiable: 0,
      verdicts: [
        {
          acId: 'AC-S5-1',
          storyId: 'S5',
          result: 'FAIL',
          observation: 'ball passes through paddle',
          screenshotUrl: 'https://s/w2.png',
        },
      ],
      fixForward: [
        {
          storyId: 'S5',
          acId: 'AC-S5-1',
          observed: 'ball passes through',
          screenshotUrl: 'https://s/w2.png',
        },
      ],
    });
    const w3 = gateJob('gate-w3', {
      outcome: 'pass',
      pass: 1,
      fixed: 0,
      unverifiable: 0,
      verdicts: [
        // pacman1 keying fix — the wave-3 gate judges the FIX story's
        // criteria, so its verdicts carry the FIX story id (S6). The
        // aggregator remaps fix-story verdicts to the OWNER (S5) so the
        // whole arc is ONE claim.
        { acId: 'AC-S5-1', storyId: 'S6', result: 'PASS', screenshotUrl: 'https://s/w3.png' },
      ],
      fixForward: [],
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [ep],
      jobsById: { 'gate-w2': w2, 'gate-w3': w3 },
      attentionItems: [],
    });
    expect(r.gateVqa).toBeDefined();
    const claim = r.gateVqa!.claims.find((c) => c.acId === 'AC-S5-1')!;
    expect(claim.attempts.map((a) => [a.waveNumber, a.result])).toEqual([
      [2, 'FAIL'],
      [3, 'PASS'],
    ]);
    expect(claim.final).toBe('fixed-by-story');
    expect(claim.fixStoryId).toBe('S6');
    expect(claim.acText).toBe('Ball bounces off paddle');
    expect(r.gateVqa!.fixedByStory).toBe(1);
    expect(r.gateVqa!.fixForwarded).toBe(0);
  });

  it('first-gate PASS = verified; FIXED_IN_GATE from fixedAcIds; UNVERIFIABLE honest', () => {
    const ep = epic({
      epicId: 'E-A',
      stories: [
        story({
          storyId: 'S1',
          criteria: [
            { id: 'AC-1', text: 'a', needsBrowser: true },
            { id: 'AC-2', text: 'b', needsBrowser: true },
            { id: 'AC-3', text: 'c', needsBrowser: true },
          ],
        }),
      ],
      waveBuildJobs: { '0': 'gate-w0' },
    });
    const w0 = gateJob('gate-w0', {
      outcome: 'fixed',
      verdicts: [
        { acId: 'AC-1', storyId: 'S1', result: 'PASS' },
        { acId: 'AC-2', storyId: 'S1', result: 'FAIL' },
        { acId: 'AC-3', storyId: 'S1', result: 'UNVERIFIABLE' },
      ],
      fixedAcIds: ['AC-2'],
      fixForward: [],
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [ep],
      jobsById: { 'gate-w0': w0 },
      attentionItems: [],
    });
    const finals = Object.fromEntries(r.gateVqa!.claims.map((c) => [c.acId, c.final]));
    expect(finals['AC-1']).toBe('verified');
    expect(finals['AC-2']).toBe('fixed-in-gate');
    expect(finals['AC-3']).toBe('unverifiable');
    expect(r.gateVqa!.verified).toBe(1);
    expect(r.gateVqa!.fixedInGate).toBe(1);
    expect(r.gateVqa!.unverifiable).toBe(1);
  });

  it('undefined when no wave-merge job carries vqa (pre-v2.6 plans)', () => {
    const r = buildQaReport({
      plan: plan(),
      epics: [epic({ waveBuildJobs: { '0': 'b-1' } })],
      jobsById: { 'b-1': job({ jobId: 'b-1' }) },
      attentionItems: [],
    });
    expect(r.gateVqa).toBeUndefined();
  });
});

// ── QA-D (pong1 2026-06-12) — truthful gate matrix ──────────────────

describe('QA-D — gate rows prefer real stage outcomes over inferred cells', () => {
  it('stages from waveMergeResult render truthfully; legacy rows are flagged inferred', () => {
    const stagedJob = {
      ...job({ jobId: 'gate-staged' }),
      waveMergeResult: {
        outcome: 'success',
        stages: [
          { key: 'build', cmd: 'npm run build', status: 'pass', durationMs: 40000 },
          { key: 'test', cmd: 'npm run test --if-present', status: 'pass', durationMs: 9000 },
          { key: 'lint', cmd: 'npx eslint . --max-warnings 200', status: 'pass' },
        ],
        vqa: { outcome: 'pass', pass: 3, fixed: 0, fixForward: [], unverifiable: 0 },
      },
    } as AgentJob;
    const legacyJob = job({ jobId: 'gate-legacy' }); // COMPLETED, no stage data
    const ep = epic({
      stories: [story({ storyId: 'S1', wave: 0 }), story({ storyId: 'S2', wave: 1 })],
      waveBuildJobs: { '0': 'gate-staged', '1': 'gate-legacy' },
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [ep],
      jobsById: { 'gate-staged': stagedJob, 'gate-legacy': legacyJob },
      attentionItems: [],
    });
    expect(r.gate.hasStageData).toBe(true);
    const w0 = r.gate.waveRows.find((row) => row.waveIndex === 0)!;
    expect(w0.stages).toHaveLength(3);
    expect(w0.stages![0]).toMatchObject({ key: 'build', status: 'pass' });
    expect(w0.vqa).toMatchObject({ outcome: 'pass', pass: 3 });
    expect(w0.inferred).toBeUndefined();
    const w1 = r.gate.waveRows.find((row) => row.waveIndex === 1)!;
    expect(w1.stages).toBeUndefined();
    expect(w1.inferred).toBe(true); // one COMPLETED bit, honestly labeled
  });

  it('a failing stage marks later stages skipped and fails the pillar', () => {
    const failedJob = {
      ...job({ jobId: 'gate-fail', status: 'FAILED' }),
      waveMergeResult: {
        outcome: 'wave-build-failed',
        stages: [
          { key: 'build', cmd: 'npm run build', status: 'pass' },
          { key: 'test', cmd: 'npm run test --if-present', status: 'fail' },
          { key: 'lint', cmd: 'npx eslint .', status: 'skipped' },
        ],
      },
    } as AgentJob;
    const ep = epic({
      stories: [story({ storyId: 'S1', wave: 0 })],
      waveBuildJobs: { '0': 'gate-fail' },
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [ep],
      jobsById: { 'gate-fail': failedJob },
      attentionItems: [],
    });
    const row = r.gate.waveRows[0];
    expect(row.stages!.map((s) => s.status)).toEqual(['pass', 'fail', 'skipped']);
    expect(r.gate.verdict).toBe('fail');
  });
});

// pacman1 keying fix (2026-06-12) — the PM numbers criteria PER STORY, so
// "AC-S1-1" exists in many epics. Claims must key by (storyId, acId);
// acId-only keying merged unrelated claims (pacman1: E4/E5/E7 all wore one
// polluted four-attempt arc).
describe('QA-B — acId collision across stories stays separate claims', () => {
  function gateJob(jobId: string, vqa: Record<string, unknown>) {
    return { ...job({ jobId }), waveMergeResult: { outcome: 'success', vqa } } as AgentJob;
  }

  it('same acId in two epics → two claims with independent histories', () => {
    const epA = epic({
      epicId: 'E-GHOSTS',
      stories: [
        story({
          storyId: 'S-ghosts',
          criteria: [{ id: 'AC-S1-1', text: 'Four ghosts in a row', needsBrowser: true }],
        }),
      ],
      waveBuildJobs: { '0': 'gate-a' },
    });
    const epB = epic({
      epicId: 'E-OVERLAY',
      stories: [
        story({
          storyId: 'S-overlay',
          criteria: [{ id: 'AC-S1-1', text: 'Dark overlay covers canvas', needsBrowser: true }],
        }),
      ],
      waveBuildJobs: { '0': 'gate-b' },
    });
    const gateA = gateJob('gate-a', {
      outcome: 'pass',
      verdicts: [{ acId: 'AC-S1-1', storyId: 'S-ghosts', result: 'PASS' }],
      fixForward: [],
    });
    const gateB = gateJob('gate-b', {
      outcome: 'pass',
      verdicts: [{ acId: 'AC-S1-1', storyId: 'S-overlay', result: 'UNVERIFIABLE' }],
      fixForward: [],
    });
    const r = buildQaReport({
      plan: plan(),
      epics: [epA, epB],
      jobsById: { 'gate-a': gateA, 'gate-b': gateB },
      attentionItems: [],
    });
    expect(r.gateVqa!.claims).toHaveLength(2);
    const ghosts = r.gateVqa!.claims.find((c) => c.storyId === 'S-ghosts')!;
    const overlay = r.gateVqa!.claims.find((c) => c.storyId === 'S-overlay')!;
    // Independent histories — no cross-pollution.
    expect(ghosts.attempts).toHaveLength(1);
    expect(ghosts.final).toBe('verified');
    expect(ghosts.acText).toBe('Four ghosts in a row');
    expect(overlay.attempts).toHaveLength(1);
    expect(overlay.final).toBe('unverifiable');
    expect(overlay.acText).toBe('Dark overlay covers canvas');
    expect(r.gateVqa!.verified).toBe(1);
    expect(r.gateVqa!.unverifiable).toBe(1);
  });
});
