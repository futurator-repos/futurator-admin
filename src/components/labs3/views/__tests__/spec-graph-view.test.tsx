/**
 * spec-graph-view.test.tsx — Plan-tab in-place story panel + named phase columns
 * (dossier B4, plan-tab half).
 *
 * Pins:
 * - Clicking a story node opens the in-place detail panel WITHOUT navigating
 *   away (onSelectStory is NOT called on node click).
 * - The panel's "Open in Stories →" button is the ONLY path that fires
 *   onSelectStory (with the selected storyId).
 * - Batch column headers render "Batch N — <phase>" when the column's stories
 *   carry a planner-emitted phase, and fall back to "BATCH N" otherwise.
 * - A failed story surfaces verdict.reasons in the panel.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpecGraphView } from '../spec-graph-view';
import type { StoryNodeRow, StoryNodeState, StoryVerdict } from '@/types/plan-spec';
import type { Labs3ViewProps } from '@/components/labs3/plan-spec-dashboard/adapter';

function makeStory(over: Partial<StoryNodeRow> & { phase?: string } = {}): StoryNodeRow {
  const base = {
    storyId: 's-1',
    planId: 'plan-1',
    appId: 'app-1',
    cohort: { epicId: 'e1' },
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
    createdAt: '',
    updatedAt: '',
  };
  // `phase` is the S1 cross-slice field (not yet on the shared type); attach via cast.
  return { ...base, ...over } as StoryNodeRow;
}

function makeProps(over: Partial<Labs3ViewProps> = {}): Labs3ViewProps {
  return {
    planId: 'plan-1',
    appId: 'app-1',
    stories: [makeStory()],
    ...over,
  };
}

describe('SpecGraphView — in-place story detail panel', () => {
  it('opens the panel in place on node click WITHOUT calling onSelectStory', () => {
    const onSelectStory = vi.fn();
    render(
      <SpecGraphView
        {...makeProps({ stories: [makeStory({ title: 'Alpha story' })], onSelectStory })}
      />,
    );

    // Panel-only affordance not present before the click.
    expect(screen.queryByText('Open in Stories →')).toBeNull();

    fireEvent.click(screen.getByText('Alpha story'));

    // Panel opened in place …
    expect(screen.getByText('Open in Stories →')).toBeInTheDocument();
    // … and no navigation happened.
    expect(onSelectStory).not.toHaveBeenCalled();
  });

  it('fires onSelectStory only via the "Open in Stories →" button', () => {
    const onSelectStory = vi.fn();
    const story = makeStory({ storyId: 'story-xyz', title: 'Beta story' });
    render(<SpecGraphView {...makeProps({ stories: [story], onSelectStory })} />);

    fireEvent.click(screen.getByText('Beta story'));
    expect(onSelectStory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Open in Stories →'));
    expect(onSelectStory).toHaveBeenCalledTimes(1);
    expect(onSelectStory).toHaveBeenCalledWith('story-xyz');
  });

  it('surfaces verdict.reasons when the story failed', () => {
    const verdict: StoryVerdict = {
      done: false,
      status: 'failing',
      failing: ['ac1'],
      blocking: [],
      attention: [],
      pending: [],
      reasons: ['invariant boot-liveness has no authored validator'],
    };
    render(
      <SpecGraphView
        {...makeProps({ stories: [makeStory({ title: 'Gamma', state: 'failed', verdict })] })}
      />,
    );
    fireEvent.click(screen.getByText('Gamma'));
    expect(screen.getByText(/boot-liveness has no authored validator/)).toBeInTheDocument();
  });
});

describe('SpecGraphView — named phase column headers', () => {
  it('renders "Batch N — <phase>" when the column carries a phase', () => {
    render(
      <SpecGraphView
        {...makeProps({
          stories: [makeStory({ storyId: 's-a', cohortBatch: 0, phase: 'foundation' })],
        })}
      />,
    );
    expect(screen.getByText('Batch 0 — foundation')).toBeInTheDocument();
  });

  it('falls back to "BATCH N" when a column carries no phase', () => {
    render(
      <SpecGraphView
        {...makeProps({
          stories: [
            makeStory({ storyId: 's-a', cohortBatch: 0, phase: 'foundation' }),
            makeStory({ storyId: 's-b', cohortBatch: 1 }),
          ],
        })}
      />,
    );
    expect(screen.getByText('Batch 0 — foundation')).toBeInTheDocument();
    expect(screen.getByText('BATCH 1')).toBeInTheDocument();
  });
});
