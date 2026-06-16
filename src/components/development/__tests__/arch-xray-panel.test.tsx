/**
 * arch-xray-panel.test.tsx — Story SG-3.4. The architectural overview:
 * god-nodes, community legend, surprising connections, overlay toggle, and the
 * graceful "MAGE unavailable" fallback.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArchXrayPanel } from '../arch-xray-panel';
import type { ArchInsights } from '@/lib/graph-insights';

const insights = (over: Partial<ArchInsights> = {}): ArchInsights => ({
  projectId: 'futurator-admin',
  generatedAt: '2026-06-16T00:00:00Z',
  mageAvailable: true,
  centralityAvailable: true,
  communityAvailable: true,
  threshold: 0,
  godNodes: [{ id: 'code/src--hub.ts', kind: 'file', title: 'hub.ts', centrality: 0.91 }],
  communities: [
    { community: 0, count: 12 },
    { community: 1, count: 5 },
  ],
  surprisingConnections: [
    {
      source: 'code/api.ts',
      sourceTitle: 'api.ts',
      type: 'READS',
      target: 'tbl/Orders',
      targetTitle: 'Orders',
      sourceCommunity: 0,
      targetCommunity: 1,
      score: 1.5,
    },
  ],
  nodeMetrics: {
    'code/src--hub.ts': { centrality: 0.91, community: 0 },
  },
  ...over,
});

const expand = () => fireEvent.click(screen.getByRole('button', { expanded: false }));

describe('ArchXrayPanel (SG-3.4)', () => {
  it('shows the MAGE-unavailable fallback when no analytics ran', () => {
    render(<ArchXrayPanel insights={null} overlayEnabled onToggleOverlay={vi.fn()} />);
    expand();
    expect(screen.getByText(/MAGE.*hasn't run|MAGE isn't installed/i)).toBeInTheDocument();
  });

  it('lists god-nodes with their centrality and inspects on click', () => {
    const onSelect = vi.fn();
    render(
      <ArchXrayPanel
        insights={insights()}
        overlayEnabled
        onToggleOverlay={vi.fn()}
        onSelect={onSelect}
      />,
    );
    expand();
    expect(screen.getByText('hub.ts')).toBeInTheDocument();
    expect(screen.getByText('0.910')).toBeInTheDocument();
    fireEvent.click(screen.getByText('hub.ts'));
    expect(onSelect).toHaveBeenCalledWith('code/src--hub.ts');
  });

  it('renders the community legend with counts', () => {
    render(<ArchXrayPanel insights={insights()} overlayEnabled onToggleOverlay={vi.fn()} />);
    expand();
    expect(screen.getByText('Communities')).toBeInTheDocument();
    expect(screen.getByText('(12)')).toBeInTheDocument();
  });

  it('lists surprising connections and inspects either endpoint', () => {
    const onSelect = vi.fn();
    render(
      <ArchXrayPanel
        insights={insights()}
        overlayEnabled
        onToggleOverlay={vi.fn()}
        onSelect={onSelect}
      />,
    );
    expand();
    expect(screen.getByText('api.ts')).toBeInTheDocument();
    expect(screen.getByText('Orders')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Orders'));
    expect(onSelect).toHaveBeenCalledWith('tbl/Orders');
  });

  it('toggles the overlay', () => {
    const onToggle = vi.fn();
    render(<ArchXrayPanel insights={insights()} overlayEnabled onToggleOverlay={onToggle} />);
    expand();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('shows the empty state when there are no surprising connections', () => {
    render(
      <ArchXrayPanel
        insights={insights({ surprisingConnections: [] })}
        overlayEnabled
        onToggleOverlay={vi.fn()}
      />,
    );
    expand();
    expect(screen.getByText(/no cross-community bridges/i)).toBeInTheDocument();
  });
});
