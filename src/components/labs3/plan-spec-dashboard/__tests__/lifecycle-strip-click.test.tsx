import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LifecycleStrip } from '../lifecycle-strip';
import type { Plan } from '@/types/plan';

function makePlan(over: Partial<Plan> = {}): Plan {
  return { planId: 'p1', name: 'p1', status: 'developing', epicIds: [], ...over } as Plan;
}

describe('LifecycleStrip — clickable stages (legacy pipeline parity)', () => {
  it('clicking a stage navigates to its subtab', () => {
    const onSelectStage = vi.fn();
    render(<LifecycleStrip plan={makePlan()} onSelectStage={onSelectStage} />);
    fireEvent.click(screen.getByText('Concept'));
    expect(onSelectStage).toHaveBeenCalledWith('graph');
    fireEvent.click(screen.getByText('QA Review'));
    expect(onSelectStage).toHaveBeenCalledWith('qa');
    fireEvent.click(screen.getByText('Deployed'));
    expect(onSelectStage).toHaveBeenCalledWith('qa');
    fireEvent.click(screen.getByText('Development'));
    expect(onSelectStage).toHaveBeenCalledWith('stories');
  });

  it('is keyboard-activatable (Enter/Space) for accessibility', () => {
    const onSelectStage = vi.fn();
    render(<LifecycleStrip plan={makePlan()} onSelectStage={onSelectStage} />);
    fireEvent.keyDown(screen.getByText('Concept').closest('[role="button"]')!, { key: 'Enter' });
    expect(onSelectStage).toHaveBeenCalledWith('graph');
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

  it('renders non-interactively (no role=button) when onSelectStage is omitted', () => {
    render(<LifecycleStrip plan={makePlan()} />);
    expect(screen.queryByRole('button', { name: /Concept/ })).toBeNull();
  });
});
