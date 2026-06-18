import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildQaExecutePipeline } from '../visual-qa-pipeline';
import type { Plan } from '../../types/plan';
import type { VisualTestDef } from '../../types/epic-workflow';

/**
 * VQA v3 — Stories E2.2 (interpreter dispatch), E2.3 (page.clock), E2.4
 * (un-staled judge prompt), E2.5 (grammar docs). The interpreter and judge
 * prompts are generated script strings inside the execute pipeline; we assert
 * their content (the behavioral ACs — "frame shows post-press state" — are e2e).
 */
const PLAN = {
  planId: 'plan-test',
  name: 'pong',
  workingDir: '/home/ubuntu/projects/pong',
  intent: 'test',
  rigor: 'mvp',
  status: 'review',
  epicIds: [],
  createdAt: '2026-06-16T00:00:00Z',
  updatedAt: '2026-06-16T00:00:00Z',
} as unknown as Plan;

const TESTS: Array<VisualTestDef & { storyId: string; storyTitle: string }> = [
  {
    id: 't1',
    criteriaRef: 'ac-1',
    description: 'plays after start',
    setup: 'visit /',
    expect: 'score increments',
    level: 'L2',
    storyId: 's1',
    storyTitle: 'Story 1',
  },
];

function stepCommand(stepId: string): string {
  const pipeline = buildQaExecutePipeline({
    plan: PLAN,
    allVisualTests: TESTS,
    snapshotPrefix: 'qa-snapshots/pong/job/',
    jobId: 'job-1',
  });
  const step = pipeline.steps.find((s) => s.id === stepId);
  if (!step || step.stepType !== 'shell' || !('command' in step)) {
    throw new Error(`${stepId} step not found or not a shell step`);
  }
  return String(step.command);
}

describe('probe interpreter dispatch (VQA v3 — E2.2/E2.3)', () => {
  const cmd = stepCommand('qa-prepare');

  it('E2.2 — dispatches press → keyboard.press', () => {
    expect(cmd).toContain("step.action === 'press'");
    expect(cmd).toContain('keyboard.press');
  });

  it('E2.2 — dispatches pointer/tap → mouse.click(x,y)', () => {
    expect(cmd).toContain("step.action === 'pointer'");
    expect(cmd).toContain('mouse.click');
  });

  it('E2.2 — dispatches select / drag / hold', () => {
    expect(cmd).toContain('selectOption');
    expect(cmd).toContain('dragAndDrop');
    expect(cmd).toContain('keyboard.down');
  });

  it('E2.3 — dispatches clock → page.clock (install/fastForward/runFor)', () => {
    expect(cmd).toContain('page.clock');
    expect(cmd).toContain('runFor');
    expect(cmd).toContain('fastForward');
  });

  it('E2.2 — dispatches H10 viewport + network actions', () => {
    expect(cmd).toContain('setViewportSize');
    expect(cmd).toContain('setOffline');
  });

  it('E5.3 — L2-state assert oracle reads window.__harness and compares deterministically', () => {
    expect(cmd).toContain("step.action === 'assert'");
    expect(cmd).toContain('window.__harness');
    expect(cmd).toContain('h.snapshot()');
    expect(cmd).toContain('ASSERT_FAILED');
    // the operator helper covers the full op set, no LLM call
    expect(cmd).toContain('function assertOp');
    expect(cmd).toContain("case 'contains'");
  });
});

describe('L2 judge prompt is un-staled (VQA v3 — E2.4)', () => {
  const cmd = stepCommand('qa-judge-l2');

  it('no longer claims interactions are NOT executed', () => {
    expect(cmd).not.toContain('flow interactions are NOT executed');
    expect(cmd).not.toContain('idle, no interaction');
  });

  it('tells the judge frames are POST-INTERACTION and it MAY FAIL a contradicted frame', () => {
    expect(cmd).toContain('POST-INTERACTION');
    expect(cmd).toContain('MAY FAIL');
  });

  it('verdict regex accepts the new not-observable tag and stays back-compat', () => {
    expect(cmd).toContain('not-idle-observable|not-observable');
  });
});

describe('grammar is documented to authors (VQA v3 — E2.5)', () => {
  const tpl = readFileSync(
    join(__dirname, '../../../../daemon/pipelines/templates/dev-subagent-prompt.md.tpl'),
    'utf-8',
  );

  it('the DEV template carries a worked multi-step flow example with a clock + assert step', () => {
    expect(tpl).toContain('<probe_grammar>');
    expect(tpl).toContain('press');
    expect(tpl).toContain('clock');
    expect(tpl).toContain('assert');
    expect(tpl).toContain('__harness');
  });
});
