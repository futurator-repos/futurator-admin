/**
 * verdict-strip.test.tsx — the fallback strip must not read GREEN off the
 * unit-AC rollup while deployed-app QA is unverified/blocking.
 *
 * - all-done stories + qaReadiness 'pending'  → neutral "QA pending" (NOT green)
 * - all-done stories + qaReadiness 'blocking' → red "Blocking"
 * - all-done stories + qaReadiness 'verified' → green "Ready to deliver"
 * - all-done stories + no readiness signal    → legacy green "Ready to deliver"
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerdictStrip } from '../verdict-strip';
import type { StoryNodeRow, StoryNodeState } from '@/types/plan-spec';

function makeStory(state: StoryNodeState): StoryNodeRow {
  return {
    storyId: `s-${state}`,
    planId: 'plan-1',
    appId: 'app-1',
    cohort: { epicId: 'e1' },
    title: 't',
    acceptanceCriteria: [
      {
        id: 'ac1',
        text: 'ac',
        acClass: 'deterministic',
        testBinding: { status: 'passing' },
      },
    ],
    depends_on: [],
    touches: ['src/**'],
    complexity: 'standard',
    state,
    unblockedDepsCount: 0,
    cohortBatch: 0,
    version: 1,
    createdAt: '',
    updatedAt: '',
  };
}

describe('VerdictStrip — deployed-app QA readiness gate', () => {
  const allDone = [makeStory('done'), makeStory('done')];

  it('reads NEUTRAL "QA pending" (not green) when all stories done but QA pending', () => {
    render(<VerdictStrip stories={allDone} qaReadiness="pending" />);
    expect(screen.getByText(/QA pending/i)).toBeInTheDocument();
    expect(screen.queryByText('Ready to deliver')).toBeNull();
  });

  it('forces RED "Blocking" when QA readiness is blocking regardless of unit ACs', () => {
    render(<VerdictStrip stories={allDone} qaReadiness="blocking" />);
    expect(screen.getByText('Blocking')).toBeInTheDocument();
    expect(screen.queryByText('Ready to deliver')).toBeNull();
  });

  it('allows GREEN "Ready to deliver" only when QA readiness is verified', () => {
    render(<VerdictStrip stories={allDone} qaReadiness="verified" />);
    expect(screen.getByText('Ready to deliver')).toBeInTheDocument();
  });

  it('keeps legacy behavior (green when all done) when no readiness signal is passed', () => {
    render(<VerdictStrip stories={allDone} />);
    expect(screen.getByText('Ready to deliver')).toBeInTheDocument();
  });
});
