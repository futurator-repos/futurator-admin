import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LifecycleStrip } from '../lifecycle-strip';
import type { Plan } from '@/types/plan';

function makePlan(over: Partial<Plan> = {}): Plan {
  return { planId: 'p1', name: 'p1', status: 'developing', epicIds: [], ...over } as Plan;
}

function chipButton(label: string): HTMLButtonElement {
  return screen.getByText(label).closest('button') as HTMLButtonElement;
}

describe('LifecycleStrip — stage-first navigator', () => {
  it('renders all five stages as real buttons', () => {
    render(<LifecycleStrip plan={makePlan()} onSelectStage={vi.fn()} />);
    for (const label of ['Concept', 'Development', 'QA Review', 'Deployment', 'Publish']) {
      expect(chipButton(label).tagName).toBe('BUTTON');
    }
  });

  it('clicking a stage navigates by STAGE id (not subtab)', () => {
    const onSelectStage = vi.fn();
    render(<LifecycleStrip plan={makePlan()} onSelectStage={onSelectStage} />);
    fireEvent.click(screen.getByText('Concept'));
    expect(onSelectStage).toHaveBeenLastCalledWith('concept');
    fireEvent.click(screen.getByText('Development'));
    expect(onSelectStage).toHaveBeenLastCalledWith('development');
    fireEvent.click(screen.getByText('QA Review'));
    expect(onSelectStage).toHaveBeenLastCalledWith('qa');
    fireEvent.click(screen.getByText('Deployment'));
    expect(onSelectStage).toHaveBeenLastCalledWith('deployment');
    fireEvent.click(screen.getByText('Publish'));
    expect(onSelectStage).toHaveBeenLastCalledWith('publish');
  });

  it('every stage is clickable regardless of progress (selection ≠ progress)', () => {
    const onSelectStage = vi.fn();
    // A concept-stage plan: later stages are "pending" but must still fire.
    render(<LifecycleStrip plan={makePlan({ status: 'concept' })} onSelectStage={onSelectStage} />);
    fireEvent.click(screen.getByText('Publish'));
    expect(onSelectStage).toHaveBeenCalledWith('publish');
  });

  it('marks the selected stage with aria-current', () => {
    render(<LifecycleStrip plan={makePlan()} selectedStage="qa" onSelectStage={vi.fn()} />);
    expect(chipButton('QA Review').getAttribute('aria-current')).toBe('true');
    expect(chipButton('Concept').getAttribute('aria-current')).toBeNull();
  });

  it('clicking the "Open dev" link does NOT also trigger stage navigation', () => {
    const onSelectStage = vi.fn();
    render(
      <LifecycleStrip
        plan={makePlan({ status: 'review', devUrl: 'https://dev.futurator.ai/p1/' })}
        onSelectStage={onSelectStage}
      />,
    );
    fireEvent.click(screen.getByText('Open dev ↗'));
    expect(onSelectStage).not.toHaveBeenCalled();
  });

  it('disables the chips when no navigation handler is offered', () => {
    render(<LifecycleStrip plan={makePlan()} />);
    expect(chipButton('Concept').disabled).toBe(true);
  });
});
