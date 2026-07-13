import { describe, it, expect } from 'vitest';

import { derivePipelineStage } from '../pipeline-dispatch';
import { dispatchPipelineSchema } from '../../schemas/pipeline-dispatch-schema';
import type { Plan } from '../../types/plan';
import type { StoryNodeRow, StoryNodeState } from '../../types/plan-spec';

// ── factories ────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'p-1',
    name: 'demo-abc123',
    intent: 'build a thing',
    description: '',
    status: 'concept',
    epicIds: [],
    workingDir: '/home/ubuntu/projects/demo-abc123',
    executionMode: 'pipeline',
    rigor: 'mvp',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'external:test',
    ...overrides,
  };
}

let nodeSeq = 0;
function makeNode(state: StoryNodeState, cohortBatch: number): StoryNodeRow {
  nodeSeq += 1;
  return {
    storyId: `s-${nodeSeq}`,
    cohort: { epicId: 'e-1' },
    title: `story ${nodeSeq}`,
    acceptanceCriteria: [
      {
        id: `ac-${nodeSeq}`,
        text: 'does the thing',
        testBinding: { status: 'bound' },
        acClass: 'deterministic',
      },
    ],
    depends_on: [],
    touches: [`src/features/f${nodeSeq}.feature.tsx`],
    complexity: 'standard',
    planId: 'p-1',
    appId: 'demo-abc123',
    state,
    unblockedDepsCount: 0,
    cohortBatch,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

// ── derivePipelineStage — full external stage space ─────────────────────────

describe('derivePipelineStage', () => {
  it("failed — status 'abandoned' evaluated first", () => {
    // 'abandoned' is in the runtime schema enum but omitted from the narrow
    // PlanStatus type — the mapper accepts the 7-value runtime set.
    const view = derivePipelineStage(
      makePlan({ status: 'abandoned' as unknown as Plan['status'] }),
      [],
    );
    expect(view.stage).toBe('failed');
    expect(view.detail).toContain('abandoned');
  });

  it("failed — status 'archived'", () => {
    expect(derivePipelineStage(makePlan({ status: 'archived' }), []).stage).toBe('failed');
  });

  it("completed — status 'delivered'", () => {
    const view = derivePipelineStage(makePlan({ status: 'delivered' }), []);
    expect(view.stage).toBe('completed');
  });

  it('queued — concept plan with nothing produced yet', () => {
    const view = derivePipelineStage(makePlan({ status: 'concept' }), []);
    expect(view.stage).toBe('queued');
    expect(view.stories).toEqual({ done: 0, total: 0 });
    expect(view.currentWave).toBeNull();
    expect(view.totalWaves).toBeNull();
  });

  it('queued — planned but every node still ready/blocked (undispatched)', () => {
    const nodes = [makeNode('ready', 0), makeNode('blocked', 1)];
    const view = derivePipelineStage(makePlan({ status: 'concept' }), nodes);
    expect(view.stage).toBe('queued');
    expect(view.detail).toContain('awaiting first daemon claim');
  });

  it('concept — concept artifacts / PRD requirement ids present, no story nodes', () => {
    const view = derivePipelineStage(
      makePlan({ status: 'concept', prdRequirementIds: ['FR1', 'FR2'] }),
      [],
    );
    expect(view.stage).toBe('concept');
  });

  it('developing — partial story-nodes with correct done/total + currentWave', () => {
    const nodes = [
      makeNode('done', 0),
      makeNode('developing', 1),
      makeNode('ready', 1),
      makeNode('blocked', 2),
    ];
    const view = derivePipelineStage(makePlan({ status: 'developing' }), nodes);
    expect(view.stage).toBe('developing');
    expect(view.stories).toEqual({ done: 1, total: 4 });
    // lowest non-terminal batch is the active frontier
    expect(view.currentWave).toBe(1);
    expect(view.totalWaves).toBe(3);
  });

  it("developing — 'fixing' is truthfully development", () => {
    const nodes = [makeNode('done', 0), makeNode('developing', 1)];
    const view = derivePipelineStage(makePlan({ status: 'fixing' }), nodes);
    expect(view.stage).toBe('developing');
    expect(view.detail).toContain('fix-stories');
  });

  it('blocked(c) — graph deadlock: blocked nodes, empty frontier, nothing running', () => {
    const nodes = [makeNode('done', 0), makeNode('failed', 0), makeNode('blocked', 1)];
    const view = derivePipelineStage(makePlan({ status: 'developing' }), nodes);
    expect(view.stage).toBe('blocked');
    expect(view.detail).toContain('GRAPH-DEADLOCK');
  });

  it('blocked(a) — start-gate refused development', () => {
    const view = derivePipelineStage(
      makePlan({
        status: 'concept',
        checkoutGates: {
          blocks: true,
          bypassedByYolo: false,
          evaluatedAt: '2026-07-11T00:00:00.000Z',
        } as Plan['checkoutGates'],
      }),
      [],
    );
    expect(view.stage).toBe('blocked');
    expect(view.detail).toContain('START-GATE');
  });

  it('vqa — review, deployed-app QA not yet verified', () => {
    const view = derivePipelineStage(makePlan({ status: 'review', devUrl: 'https://dev.x' }), [
      makeNode('done', 0),
    ]);
    expect(view.stage).toBe('vqa');
    expect(view.devUrl).toBe('https://dev.x');
  });

  it('vqa — blocking verdict with autopilot still available stays vqa (eventual-consistency window)', () => {
    const view = derivePipelineStage(
      makePlan({
        status: 'review',
        qaAutopilot: true,
        p3QaVerdict: { blocking: true } as Plan['p3QaVerdict'],
      }),
      [makeNode('done', 0)],
    );
    expect(view.stage).toBe('vqa');
  });

  it('blocked(b) — QA exhausted: blocking verdict, autopilot off', () => {
    const view = derivePipelineStage(
      makePlan({
        status: 'review',
        qaAutopilot: false,
        p3QaVerdict: { blocking: true } as Plan['p3QaVerdict'],
      }),
      [makeNode('done', 0)],
    );
    expect(view.stage).toBe('blocked');
    expect(view.detail).toContain('QA-EXHAUSTED');
  });

  it('blocked(b) — QA exhausted with autopilot ON but automation spent (honesty boundary)', () => {
    // The critical branch: qaAutopilot is on, but both the integrator round and
    // the autofix rounds are used up → the cron can no longer auto-send-back, so
    // the undecided blocking verdict is genuinely wedged awaiting the operator.
    const view = derivePipelineStage(
      makePlan({
        status: 'review',
        qaAutopilot: true,
        qaIntegratorRounds: 1,
        qaAutoFixRounds: 2, // >= P3_QA_AUTOFIX_MAX default (2)
        p3QaVerdict: { blocking: true } as Plan['p3QaVerdict'],
      }),
      [makeNode('done', 0)],
    );
    expect(view.stage).toBe('blocked');
    expect(view.detail).toContain('QA-EXHAUSTED');
  });

  it('vqa — autopilot ON, autofix rounds still REMAINING → not yet blocked (cron will retry)', () => {
    // Same as above but one autofix round remains: automation is still pending,
    // so reporting 'blocked' would lie. Must stay 'vqa'.
    const view = derivePipelineStage(
      makePlan({
        status: 'review',
        qaAutopilot: true,
        qaIntegratorRounds: 1,
        qaAutoFixRounds: 1, // < P3_QA_AUTOFIX_MAX (2) → a retry is still owed
        p3QaVerdict: { blocking: true } as Plan['p3QaVerdict'],
      }),
      [makeNode('done', 0)],
    );
    expect(view.stage).toBe('vqa');
  });

  it('vqa — approved verdict pinned to a STALE sha must NOT report deployment (over-report guard)', () => {
    // Operator approved, but the approval is pinned to an old commit (approvedSha
    // !== current qaCommitSha) → isDeliverable is false → QA must re-verify, so
    // the honest stage is 'vqa', not 'deployment'.
    const view = derivePipelineStage(
      makePlan({
        status: 'review',
        qaCommitSha: 'newsha',
        p3QaVerdict: {
          decision: 'approved',
          approvedSha: 'oldsha',
        } as Plan['p3QaVerdict'],
        stagingUrl: 'https://stage.x',
      }),
      [makeNode('done', 0)],
    );
    expect(view.stage).toBe('vqa');
  });

  it('deployment — approved with NO qaCommitSha pinned yet is deliverable (awaiting production promote sub-state)', () => {
    // approved + no qaCommitSha → isDeliverable true; staging set but no deployUrl
    // exercises the middle promote sub-state.
    const view = derivePipelineStage(
      makePlan({
        status: 'review',
        p3QaVerdict: { decision: 'approved' } as Plan['p3QaVerdict'],
        stagingUrl: 'https://stage.x',
      }),
      [makeNode('done', 0)],
    );
    expect(view.stage).toBe('deployment');
    expect(view.detail).toContain('awaiting production promote');
  });

  it('default blocked — an unknown/unmapped status is surfaced, never faked as progress', () => {
    const view = derivePipelineStage(
      makePlan({ status: 'some-future-status' as unknown as Plan['status'] }),
      [],
    );
    expect(view.stage).toBe('blocked');
    expect(view.detail).toContain('unknown-status');
  });

  it('0-node rollup fallback — uses plan.doneStories/totalStories when the graph is empty', () => {
    const view = derivePipelineStage(
      makePlan({ status: 'developing', doneStories: 3, totalStories: 7 }),
      [],
    );
    expect(view.stories).toEqual({ done: 3, total: 7 });
    expect(view.currentWave).toBeNull();
  });

  it('deployment — QA verified (auto pass-mark), awaiting staging promote', () => {
    const view = derivePipelineStage(
      makePlan({ status: 'review', qaVerifiedAt: '2026-07-11T01:00:00.000Z' }),
      [makeNode('done', 0)],
    );
    expect(view.stage).toBe('deployment');
    expect(view.detail).toContain('awaiting staging promote');
  });

  it('deployment — operator-approved pinned SHA, production live', () => {
    const view = derivePipelineStage(
      makePlan({
        status: 'review',
        qaCommitSha: 'abc',
        p3QaVerdict: { decision: 'approved', approvedSha: 'abc' } as Plan['p3QaVerdict'],
        stagingUrl: 'https://stage.x',
        deployUrl: 'https://prod.x',
      }),
      [makeNode('done', 0)],
    );
    expect(view.stage).toBe('deployment');
    expect(view.detail).toContain('production live');
    expect(view.deployUrl).toBe('https://prod.x');
  });

  it('completed — all nodes done maps via delivered status, not story rollup', () => {
    // A review plan whose stories are all done but QA unverified is NOT completed —
    // completion is operator-marked 'delivered' only.
    const nodes = [makeNode('done', 0), makeNode('done', 1)];
    const notDone = derivePipelineStage(makePlan({ status: 'review' }), nodes);
    expect(notDone.stage).not.toBe('completed');
    const done = derivePipelineStage(makePlan({ status: 'delivered' }), nodes);
    expect(done.stage).toBe('completed');
    expect(done.stories).toEqual({ done: 2, total: 2 });
  });

  it('branch pointer is exposed, prUrl is never present', () => {
    const view = derivePipelineStage(makePlan({ name: 'foo-x' }), []);
    expect(view.branch).toBe('plan/foo-x');
    expect('prUrl' in view).toBe(false);
  });
});

// ── dispatchPipelineSchema ──────────────────────────────────────────────────

describe('dispatchPipelineSchema', () => {
  it('rejects a missing/empty source', () => {
    expect(dispatchPipelineSchema.safeParse({ intent: 'build a game' }).success).toBe(false);
    expect(dispatchPipelineSchema.safeParse({ source: '', intent: 'build a game' }).success).toBe(
      false,
    );
  });

  it('rejects a short intent', () => {
    expect(dispatchPipelineSchema.safeParse({ source: 'app', intent: 'hi' }).success).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(dispatchPipelineSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a valid body (name optional)', () => {
    expect(
      dispatchPipelineSchema.safeParse({ source: 'debatator', intent: 'build a snake game' })
        .success,
    ).toBe(true);
    const withName = dispatchPipelineSchema.safeParse({
      source: 'debatator',
      intent: 'build a snake game',
      name: 'Snake',
    });
    expect(withName.success).toBe(true);
    if (withName.success) expect(withName.data.name).toBe('Snake');
  });
});
