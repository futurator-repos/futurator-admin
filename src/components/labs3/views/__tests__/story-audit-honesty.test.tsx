/**
 * story-audit-honesty.test.tsx — S4 failure honesty + named batches in the
 * Stories hierarchy (dossier A3, B4 stories-list half).
 *
 * Pins:
 * - A failed story's expanded Overview surfaces verdict.reasons prominently.
 * - The INVARIANTS section renders each invariant's id/description + status
 *   chip whenever the row carries invariants (a story can fail on an invariant
 *   while every visible AC is green).
 * - Batch headers render "Batch N — <phase>" when the batch's stories share a
 *   planner-emitted phase, and fall back to "Batch N" for mixed/absent phases.
 *
 * The three data hooks are mocked — this suite exercises rendering, not data.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/use-agent-job', () => ({
  useAgentJob: () => ({ data: undefined }),
}));
vi.mock('@/hooks/use-agent-events', () => ({
  useAgentEvents: () => ({ events: [] }),
}));
vi.mock('@/hooks/use-story-nodes', () => ({
  useRetryStory: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

import { HierarchyView } from '../hierarchy-view';
import type { StoryNodeRow, StoryNodeState, StoryVerdict } from '@/types/plan-spec';

type Extra = {
  phase?: string;
  invariants?: Array<{
    id: string;
    description?: string;
    validator?: { status?: string; ref?: string; detail?: string };
  }>;
};

function makeStory(over: Partial<StoryNodeRow> & Extra = {}): StoryNodeRow {
  const base = {
    storyId: 's-1',
    planId: 'plan-1',
    appId: 'app-1',
    cohort: { epicId: 'e1', epicTitle: 'Cohort One' },
    title: 'A story',
    acceptanceCriteria: [
      { id: 'ac1', text: 'renders', acClass: 'deterministic', testBinding: { status: 'passing' } },
    ],
    depends_on: [] as string[],
    touches: ['src/**'],
    complexity: 'standard',
    state: 'ready' as StoryNodeState,
    unblockedDepsCount: 0,
    cohortBatch: 0,
    version: 1,
    createdAt: '2026-07-03T10:00:00Z',
    updatedAt: '2026-07-03T10:00:00Z',
  };
  return { ...base, ...over } as unknown as StoryNodeRow;
}

const failedVerdict: StoryVerdict = {
  done: false,
  status: 'failing',
  failing: ['ac2'],
  blocking: [],
  attention: [],
  pending: [],
  reasons: ['invariant inv-1 has no authored validator (unbound)'],
};

describe('HierarchyView — failure honesty (A3)', () => {
  it('renders verdict.reasons on an expanded failed story', () => {
    const story = makeStory({ storyId: 's-fail', state: 'failed', verdict: failedVerdict });
    render(<HierarchyView planId="plan-1" appId="app-1" stories={[story]} />);
    fireEvent.click(screen.getByText('Cohort One')); // expand cohort
    fireEvent.click(screen.getByText('A story')); // expand story
    expect(screen.getByText('Why this story failed')).toBeTruthy();
    expect(screen.getByText(/no authored validator/)).toBeTruthy();
  });

  it('renders the INVARIANTS section with status chips', () => {
    const story = makeStory({
      storyId: 's-inv',
      state: 'failed',
      verdict: failedVerdict,
      invariants: [
        {
          id: 'inv-1',
          description: 'balance never goes negative',
          validator: { status: 'failing' },
        },
        { id: 'inv-2', description: 'ids are unique', validator: { status: 'declared' } },
      ],
    });
    render(<HierarchyView planId="plan-1" appId="app-1" stories={[story]} />);
    fireEvent.click(screen.getByText('Cohort One'));
    fireEvent.click(screen.getByText('A story'));
    expect(screen.getByText('balance never goes negative')).toBeTruthy();
    expect(screen.getByText('ids are unique')).toBeTruthy();
    // status chips
    expect(screen.getByText('failing')).toBeTruthy();
    expect(screen.getByText('declared')).toBeTruthy();
  });

  it('does not show a failure banner on a passing (done) story', () => {
    const story = makeStory({ storyId: 's-ok', state: 'done' });
    render(<HierarchyView planId="plan-1" appId="app-1" stories={[story]} />);
    fireEvent.click(screen.getByText('Cohort One'));
    fireEvent.click(screen.getByText('A story'));
    expect(screen.queryByText('Why this story failed')).toBeNull();
  });
});

describe('HierarchyView — named batches (B4)', () => {
  it('labels the batch with the shared phase name', () => {
    const stories = [
      makeStory({ storyId: 's-a', state: 'developing', cohortBatch: 0, phase: 'Foundation' }),
      makeStory({
        storyId: 's-b',
        state: 'developing',
        cohortBatch: 0,
        phase: 'Foundation',
        title: 'B story',
      }),
    ];
    render(<HierarchyView planId="plan-1" appId="app-1" stories={stories} />); // developing → cohort auto-expands
    expect(screen.getByText('Batch 0 — Foundation')).toBeTruthy();
  });

  it('falls back to anonymous "Batch N" when phases are mixed', () => {
    const stories = [
      makeStory({ storyId: 's-a', state: 'developing', cohortBatch: 0, phase: 'Foundation' }),
      makeStory({
        storyId: 's-b',
        state: 'developing',
        cohortBatch: 0,
        phase: 'Gameplay',
        title: 'B story',
      }),
    ];
    render(<HierarchyView planId="plan-1" appId="app-1" stories={stories} />);
    expect(screen.getByText('Batch 0')).toBeTruthy();
    expect(screen.queryByText(/Batch 0 —/)).toBeNull();
  });
});
