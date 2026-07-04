/**
 * journey-verdicts.test.tsx — QA-Review W2 Lane 1 (deterministic journeys).
 *
 * Pins:
 * - deriveJourneyVerdict: pass when all deterministic steps passed, fail
 *   when any failed, pass (vacuously) when there are no steps.
 * - Empty/idle state renders when journeys=[].
 * - A failing journey (the pacman3 "keyboard-no-move" row) shows the
 *   destructive (fail) pill collapsed, and expands to reveal the failing
 *   assertion + its detail + the acRefs it covers.
 * - A passing journey shows the pass pill and its assertion never renders
 *   until expanded.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JourneyVerdicts, deriveJourneyVerdict } from '../journey-verdicts';
import type { JourneyResult, JourneyStep } from '@/types/qa-review-p3';

function step(overrides: Partial<JourneyStep> = {}): JourneyStep {
  return {
    label: 'press ArrowUp',
    action: 'press ArrowUp',
    deterministic: {
      assertion: 'score increased after ArrowUp',
      passed: true,
      detail: 'score delta +10',
    },
    ...overrides,
  };
}

describe('deriveJourneyVerdict', () => {
  const cases: Array<[string, JourneyStep[], 'pass' | 'fail']> = [
    ['all steps passed', [step(), step()], 'pass'],
    [
      'one step failed',
      [
        step(),
        step({
          deterministic: {
            assertion: 'score increased after ArrowUp',
            passed: false,
            detail: 'no score change detected after ArrowUp press',
          },
        }),
      ],
      'fail',
    ],
    ['no steps', [], 'pass'],
  ];

  it.each(cases)('%s -> %s', (_desc, steps, expected) => {
    expect(deriveJourneyVerdict(steps)).toBe(expected);
  });
});

describe('JourneyVerdicts', () => {
  it('renders the empty/idle state when there are no journeys', () => {
    render(<JourneyVerdicts journeys={[]} />);
    expect(screen.getByText(/No delivery journeys run yet/)).toBeInTheDocument();
  });

  it('shows the destructive pill and expands to the failing assertion for a failing journey (pacman3 keyboard-no-move)', () => {
    const failingJourney: JourneyResult = {
      id: 'j-keyboard-no-move',
      title: 'Move the paddle with the keyboard',
      narrative: 'Player presses ArrowUp and the paddle should move.',
      acRefs: ['AC-3.1', 'AC-3.2'],
      verdict: 'fail',
      steps: [
        step(),
        step({
          label: 'press ArrowUp',
          action: 'press ArrowUp',
          deterministic: {
            assertion: 'paddle y-position changed after ArrowUp',
            passed: false,
            detail: 'no score change detected after ArrowUp press',
          },
        }),
      ],
    };

    render(<JourneyVerdicts journeys={[failingJourney]} />);

    // Collapsed: destructive/fail pill visible, failing assertion not yet shown.
    expect(screen.getByText('fail')).toBeInTheDocument();
    expect(screen.queryByText('paddle y-position changed after ArrowUp')).not.toBeInTheDocument();

    // Expand.
    fireEvent.click(screen.getByRole('button', { name: /Move the paddle with the keyboard/ }));

    expect(screen.getByText('paddle y-position changed after ArrowUp')).toBeInTheDocument();
    expect(screen.getByText('no score change detected after ArrowUp press')).toBeInTheDocument();
    expect(screen.getByText('AC-3.1')).toBeInTheDocument();
    expect(screen.getByText('AC-3.2')).toBeInTheDocument();
  });

  it('shows the pass pill for a passing journey and reveals its assertion only when expanded', () => {
    const passingJourney: JourneyResult = {
      id: 'j-score-up',
      title: 'Score increments on ArrowUp',
      acRefs: ['AC-1.1'],
      verdict: 'pass',
      steps: [step()],
    };

    render(<JourneyVerdicts journeys={[passingJourney]} />);

    expect(screen.getByText('pass')).toBeInTheDocument();
    expect(screen.queryByText('score increased after ArrowUp')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Score increments on ArrowUp/ }));

    expect(screen.getByText('score increased after ArrowUp')).toBeInTheDocument();
  });
});
