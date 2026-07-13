/**
 * story-stage-audit.test.tsx — S4 stage-audit tabs + verdict chip semantics
 * (dossier A4, B2) and the named-batch phase helper (B4).
 *
 * Pins:
 * - A stage pill is a clickable tab; clicking it opens the matching per-stage
 *   detail panel; clicking again closes it.
 * - The test-author panel renders RED sha, resumed badge, authored file
 *   previews, the AC→test binding table (mapping AC id → text), and the
 *   invariant manifest.
 * - A stage whose OUTCOME failed reads destructive even though the step exited
 *   (verdictFailed → Implementer failed; blockingReview → Reviewer failed).
 * - Missing stageSummaries → the panel states the run predates stage capture.
 * - batchPhaseLabel: shared phase → name; mixed/absent → null.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StoryStagePipeline, deriveStages } from '../story-stage-pipeline';
import { batchPhaseLabel } from '../adapter';
import type { AgentEvent } from '@/types/agent-orchestrator';
import type { BoundAcceptanceCriterion, StoryNodeRow } from '@/types/plan-spec';

const ev = (
  stepId: string,
  eventType: AgentEvent['eventType'],
  t: string,
  text?: string,
): AgentEvent =>
  ({
    jobId: 'j',
    eventSeq: t,
    seq: 0,
    timestamp: t,
    stepId,
    agentId: stepId,
    eventType,
    text,
  }) as AgentEvent;

const fullRun: AgentEvent[] = [
  ev('test-author', 'step_start', '2026-07-03T10:00:00Z'),
  ev('test-author', 'step_complete', '2026-07-03T10:01:30Z', 'RED confirmed'),
  ev('story-dev', 'step_start', '2026-07-03T10:01:31Z'),
  ev('story-dev', 'step_complete', '2026-07-03T10:05:00Z'),
  ev('reviewer', 'step_start', '2026-07-03T10:05:01Z'),
  ev('reviewer', 'step_complete', '2026-07-03T10:06:00Z'),
  ev('compile', 'step_start', '2026-07-03T10:06:01Z'),
  ev('compile', 'step_complete', '2026-07-03T10:07:00Z'),
];

const acs: BoundAcceptanceCriterion[] = [
  {
    id: 'ac1',
    text: 'the board renders',
    acClass: 'deterministic',
    testBinding: { status: 'passing' },
  },
  {
    id: 'ac2',
    text: 'score increments',
    acClass: 'deterministic',
    testBinding: { status: 'failing' },
  },
];

const stageSummaries = {
  testAuthor: {
    redSha: 'abcdef1234',
    resumed: true,
    files: [
      {
        path: 'src/foo.test.ts',
        lines: 42,
        preview: 'describe("foo", () => {\n  it("works", ok);\n});',
      },
    ],
    bindings: { ac1: { testRef: 'foo.test.ts::works', testKind: 'unit' } },
    invariantManifest: { 'inv-1': { ref: 'src/inv-1.invariant.test.ts', kind: 'test' } },
  },
  implementer: {
    attempts: [
      {
        attempt: 1,
        commitSha: 'deadbeef99',
        filesChanged: ['a.ts', 'b.ts'],
        durationMs: 66000,
        tokens: 16000,
      },
    ],
  },
  reviewer: {
    verdicts: { ac1: 'pass' as const, ac2: 'fail' as const },
    needsHuman: ['ac2'],
    ranAt: '2026-07-03T10:06:00Z',
  },
  compile: { status: 'ok', detail: 'graph grew by 3 nodes' },
};

describe('StoryStagePipeline — audit tabs (B2)', () => {
  it('clicking a pill opens the matching stage panel; clicking again closes it', () => {
    render(
      <StoryStagePipeline
        events={fullRun}
        stageSummaries={stageSummaries}
        acceptanceCriteria={acs}
      />,
    );
    // Overview default → no panel yet.
    expect(screen.queryByTestId('stage-panel-test-author')).toBeNull();
    fireEvent.click(screen.getByText('Test-Author'));
    expect(screen.getByTestId('stage-panel-test-author')).toBeTruthy();
    // Switch to a different pill.
    fireEvent.click(screen.getByText('Implementer'));
    expect(screen.queryByTestId('stage-panel-test-author')).toBeNull();
    expect(screen.getByTestId('stage-panel-story-dev')).toBeTruthy();
    // Toggle off.
    fireEvent.click(screen.getByText('Implementer'));
    expect(screen.queryByTestId('stage-panel-story-dev')).toBeNull();
  });

  it('test-author panel renders RED sha, resumed badge, file preview, bindings, invariants', () => {
    render(
      <StoryStagePipeline
        events={fullRun}
        stageSummaries={stageSummaries}
        acceptanceCriteria={acs}
      />,
    );
    fireEvent.click(screen.getByText('Test-Author'));
    const panel = screen.getByTestId('stage-panel-test-author');
    expect(panel.textContent).toContain('abcdef1'); // short RED sha
    expect(panel.textContent).toContain('resumed');
    expect(panel.textContent).toContain('src/foo.test.ts');
    // preview only after expanding the file row
    fireEvent.click(screen.getByText('src/foo.test.ts'));
    expect(screen.getByTestId('stage-panel-test-author').textContent).toContain('describe("foo"');
    // AC→test binding table maps the AC id back to its text + testRef
    expect(panel.textContent).toContain('the board renders');
    expect(panel.textContent).toContain('foo.test.ts::works');
    // invariant manifest
    expect(panel.textContent).toContain('inv-1');
    expect(panel.textContent).toContain('src/inv-1.invariant.test.ts');
  });

  it('implementer panel lists one row per attempt with commit/files/tokens', () => {
    render(
      <StoryStagePipeline
        events={fullRun}
        stageSummaries={stageSummaries}
        acceptanceCriteria={acs}
      />,
    );
    fireEvent.click(screen.getByText('Implementer'));
    const panel = screen.getByTestId('stage-panel-story-dev');
    expect(panel.textContent).toContain('deadbee'); // short commit
    expect(panel.textContent).toContain('2 files');
    expect(panel.textContent).toContain('16,000 tok');
  });

  it('reviewer panel renders per-AC verdict chips + needsHuman', () => {
    render(
      <StoryStagePipeline
        events={fullRun}
        stageSummaries={stageSummaries}
        acceptanceCriteria={acs}
      />,
    );
    fireEvent.click(screen.getByText('Reviewer'));
    const panel = screen.getByTestId('stage-panel-reviewer');
    expect(panel.textContent).toContain('the board renders'); // ac1 mapped
    expect(panel.textContent).toContain('score increments'); // ac2 mapped
    expect(panel.textContent).toContain('pass');
    expect(panel.textContent).toContain('fail');
  });

  it('missing stageSummaries → panel says the run predates stage capture', () => {
    render(<StoryStagePipeline events={fullRun} acceptanceCriteria={acs} />);
    fireEvent.click(screen.getByText('Test-Author'));
    expect(screen.getByTestId('stage-panel-test-author').textContent).toMatch(
      /predates stage capture/i,
    );
  });
});

describe('deriveStages — verdict chip semantics (A4)', () => {
  it('implementer reads failed when the final verdict failed (even though the step exited)', () => {
    const stages = deriveStages(fullRun, { verdictFailed: true });
    expect(stages.find((s) => s.id === 'story-dev')?.status).toBe('failed');
    // reviewer stays done unless a blocking review is flagged
    expect(stages.find((s) => s.id === 'reviewer')?.status).toBe('done');
  });

  it('reviewer reads failed when an advisory-security AC blocked', () => {
    const stages = deriveStages(fullRun, { blockingReview: true });
    expect(stages.find((s) => s.id === 'reviewer')?.status).toBe('failed');
  });

  it('a genuinely-running stage is never masked to failed by verdict hints', () => {
    const running = [ev('story-dev', 'step_start', '2026-07-03T10:00:00Z')];
    const stages = deriveStages(running, { verdictFailed: true });
    expect(stages.find((s) => s.id === 'story-dev')?.status).toBe('running');
  });
});

describe('batchPhaseLabel — named batches (B4)', () => {
  const mk = (phase?: string): StoryNodeRow => ({ storyId: 's', phase }) as unknown as StoryNodeRow;

  it('returns the shared phase when every story agrees', () => {
    expect(batchPhaseLabel([mk('Foundation'), mk('Foundation')])).toBe('Foundation');
  });

  it('returns null when phases are mixed', () => {
    expect(batchPhaseLabel([mk('Foundation'), mk('Gameplay')])).toBeNull();
  });

  it('returns null when any story lacks a phase', () => {
    expect(batchPhaseLabel([mk('Foundation'), mk(undefined)])).toBeNull();
  });
});
