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
