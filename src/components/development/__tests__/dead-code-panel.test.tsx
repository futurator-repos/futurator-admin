/**
 * dead-code-panel.test.tsx — Story SG-2.4.
 *
 * The "no alone dots" guarantee made visible: dead-code candidates + the
 * orphan-invariant status badge, with an empty state.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeadCodePanel } from '../dead-code-panel';
import { integrityHeadline, type DeadCodeReport } from '@/lib/graph-insights';

const report = (candidates: DeadCodeReport['candidates']): DeadCodeReport => ({
  projectId: 'futurator-admin',
  generatedAt: '2026-06-16T00:00:00Z',
  count: candidates.length,
  candidates,
});

describe('DeadCodePanel (SG-2.4)', () => {
  it('shows the empty state when there is no dead code', () => {
    render(<DeadCodePanel deadCode={report([])} integrity={integrityHeadline(null)} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/no dead code detected/i)).toBeInTheDocument();
  });

  it('lists candidates with their last-updated timestamp and inspects on click', () => {
    const onSelect = vi.fn();
    render(
      <DeadCodePanel
        deadCode={report([{ id: 'code/src--dead.ts', title: 'dead.ts', updated: '2026-06-01' }])}
        integrity={integrityHeadline(null)}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('dead.ts')).toBeInTheDocument();
    expect(screen.getByText(/updated 2026-06-01/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('dead.ts'));
    expect(onSelect).toHaveBeenCalledWith('code/src--dead.ts');
  });

  it('renders the orphan-invariant pass badge', () => {
    render(
      <DeadCodePanel
        deadCode={report([])}
        integrity={integrityHeadline({
          projectId: 'p',
          generatedAt: '2026-06-16T00:00:00Z',
          status: 'pass',
          orphanCount: 0,
          hardFailCount: 0,
          byKind: {},
          orphans: [],
          hardFail: [],
        })}
      />,
    );
    expect(screen.getByText(/orphan invariant: pass/i)).toBeInTheDocument();
  });

  it('renders the orphan-invariant FAIL badge when an extractor dropped an edge', () => {
    render(
      <DeadCodePanel
        deadCode={report([])}
        integrity={integrityHeadline({
          projectId: 'p',
          generatedAt: '2026-06-16T00:00:00Z',
          status: 'fail',
          orphanCount: 1,
          hardFailCount: 1,
          byKind: { lambda: ['infra/lambda/Api'] },
          orphans: [{ id: 'infra/lambda/Api', kind: 'lambda' }],
          hardFail: [{ id: 'infra/lambda/Api', kind: 'lambda' }],
        })}
      />,
    );
    expect(screen.getByText(/orphan invariant: fail/i)).toBeInTheDocument();
  });
});
