/**
 * planner-narrative-panel.test.tsx — the "Planner narrative" block on the Plan
 * subtab (SpecGraphView).
 *
 * Pins (P3 phased-planner redesign, slice G):
 * - When plan.planNarrative is present, a collapsible "Planner narrative" block
 *   renders; the narrative body is hidden until expanded (collapsed by default).
 * - plan.planShape renders as a badge in the header, visible while collapsed.
 * - When planNarrative is absent, NO narrative block renders (legacy plans stay
 *   byte-identical).
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpecGraphView } from '../spec-graph-view';
import type { PlanWithEpics } from '@/hooks/use-plans';
import type { Labs3ViewProps } from '@/components/labs3/plan-spec-dashboard/adapter';

const NARRATIVE = 'CLASSIFICATION: greenfield UI app\nPHASES: foundation → capabilities → assemble';

function makePlan(over: Partial<PlanWithEpics> = {}): PlanWithEpics {
  return {
    planId: 'p1',
    name: 'p1',
    status: 'developing',
    epicIds: [],
    ...over,
  } as PlanWithEpics;
}

function makeProps(over: Partial<Labs3ViewProps> = {}): Labs3ViewProps {
  return {
    planId: 'p1',
    appId: 'app-1',
    stories: [],
    plan: makePlan(),
    ...over,
  };
}

describe('SpecGraphView — Planner narrative panel', () => {
  it('renders the collapsible "Planner narrative" block when planNarrative is present', () => {
    render(<SpecGraphView {...makeProps({ plan: makePlan({ planNarrative: NARRATIVE }) })} />);
    expect(screen.getByText('Planner narrative')).toBeInTheDocument();
  });

  it('hides the narrative body until the block is expanded', () => {
    render(<SpecGraphView {...makeProps({ plan: makePlan({ planNarrative: NARRATIVE }) })} />);
    // Collapsed by default — body text not in the DOM yet.
    expect(screen.queryByText(/PHASES: foundation/)).toBeNull();
    fireEvent.click(screen.getByText('Planner narrative'));
    expect(screen.getByText(/PHASES: foundation/)).toBeInTheDocument();
  });

  it('shows the planShape as a badge while collapsed', () => {
    render(
      <SpecGraphView
        {...makeProps({ plan: makePlan({ planNarrative: NARRATIVE, planShape: 'coherent' }) })}
      />,
    );
    expect(screen.getByText('coherent')).toBeInTheDocument();
  });

  it('renders NO narrative block when planNarrative is absent', () => {
    render(<SpecGraphView {...makeProps({ plan: makePlan() })} />);
    expect(screen.queryByText('Planner narrative')).toBeNull();
  });
});
