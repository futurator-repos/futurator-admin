/**
 * capability-gap-panel.test.tsx — Story 5.3 (W8). The Graph-tab panel that
 * surfaces components touching a shared contract with no capability tag.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CapabilityGapPanel } from '../capability-gap-panel';
import type { CapabilityGapReport } from '@/lib/graph-insights';

const report = (over: Partial<CapabilityGapReport> = {}): CapabilityGapReport => ({
  projectId: 'futurator-admin',
  generatedAt: '2026-06-16T00:00:00Z',
  gapCount: 1,
  gaps: [{ nodeId: 'code/src--orders.ts', title: 'orders.ts', contractTouches: 2 }],
  ...over,
});

const expand = () => fireEvent.click(screen.getByRole('button', { expanded: false }));

describe('CapabilityGapPanel (Story 5.3)', () => {
  it('renders nothing when no report exists (no --global run yet)', () => {
    const { container } = render(<CapabilityGapPanel report={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists gaps with their contract-touch count and inspects on click', () => {
    const onSelect = vi.fn();
    render(<CapabilityGapPanel report={report()} onSelect={onSelect} />);
    expand();
    expect(screen.getByText('orders.ts')).toBeInTheDocument();
    expect(screen.getByText('2 contracts')).toBeInTheDocument();
    fireEvent.click(screen.getByText('orders.ts'));
    expect(onSelect).toHaveBeenCalledWith('code/src--orders.ts');
  });

  it('shows the all-clear empty state when there are no gaps', () => {
    render(<CapabilityGapPanel report={report({ gapCount: 0, gaps: [] })} />);
    expand();
    expect(screen.getByText(/No coverage gaps/i)).toBeInTheDocument();
  });
});
