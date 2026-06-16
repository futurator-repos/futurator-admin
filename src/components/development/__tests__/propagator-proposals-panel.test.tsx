/**
 * propagator-proposals-panel.test.tsx — Story 6.5. The consent gate: an operator
 * can approve or reject a proposed sibling port-brief; nothing is auto-applied.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PropagatorProposalsPanel } from '../propagator-proposals-panel';
import type { PropagatorProposal } from '../../../../functions/shared/types/propagator';

const proposal = (over: Partial<PropagatorProposal> = {}): PropagatorProposal => ({
  proposalId: 'prop/labs->mobile/abc123',
  sourceProject: 'labs',
  sibling: 'mobile',
  trigger: 'wave-gate',
  status: 'proposed',
  requiresApproval: true,
  brief: 'PlanScreen.tsx needs a dependency picker + useValidatePlan hook',
  contractChanges: [{ node: 'infra/table/PlansTable', change: 'field +dependsOn:string[]' }],
  proposedStory: { title: 'Port plan-dependencies to Mobile', epic: 'labs-parity' },
  atCommit: 'abc123',
  createdAt: '2026-06-16T00:00:00Z',
  ...over,
});

describe('PropagatorProposalsPanel (Story 6.5)', () => {
  it('shows the empty state when nothing awaits approval', () => {
    render(<PropagatorProposalsPanel proposals={[]} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText(/No port-briefs awaiting approval/i)).toBeInTheDocument();
  });

  it('lists pending proposals with their brief and contract changes', () => {
    render(
      <PropagatorProposalsPanel proposals={[proposal()]} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    expect(screen.getByText('Port plan-dependencies to Mobile')).toBeInTheDocument();
    expect(screen.getByText(/labs → mobile/)).toBeInTheDocument();
    expect(screen.getByText('infra/table/PlansTable')).toBeInTheDocument();
    expect(screen.getByText(/1 awaiting approval/)).toBeInTheDocument();
  });

  it('hides already-decided proposals (only consent-pending shown)', () => {
    render(
      <PropagatorProposalsPanel
        proposals={[proposal({ status: 'approved' })]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText(/No port-briefs awaiting approval/i)).toBeInTheDocument();
  });

  it('approve fires onApprove with the proposal id', () => {
    const onApprove = vi.fn();
    render(
      <PropagatorProposalsPanel
        proposals={[proposal()]}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Approve'));
    expect(onApprove).toHaveBeenCalledWith('prop/labs->mobile/abc123');
  });

  it('reject requires a reason, then fires onReject (consent-gated, never auto-applied)', () => {
    const onReject = vi.fn();
    render(
      <PropagatorProposalsPanel proposals={[proposal()]} onApprove={vi.fn()} onReject={onReject} />,
    );
    fireEvent.click(screen.getByText('Reject'));
    // Confirm is disabled until a reason ≥3 chars is typed.
    const confirm = screen.getByText('Confirm reject');
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rejection reason'), {
      target: { value: 'not needed on mobile yet' },
    });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onReject).toHaveBeenCalledWith('prop/labs->mobile/abc123', 'not needed on mobile yet');
  });
});
