import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConceptRail } from '../concept-rail';
import type { ConceptPlan, ConceptArtifact } from '@/types/plan';

const UI_BEARING: ConceptPlan = {
  uiBearing: true,
  complexity: 'medium',
  artifacts: [
    { kind: 'prd', depth: 'full' },
    { kind: 'ux', depth: 'light', dependsOn: ['prd'] },
    { kind: 'architecture', depth: 'full', dependsOn: ['prd', 'ux'] },
  ],
  gate: 'strict',
  rationale: 'Next.js + screens → UI-bearing; multi-subsystem → architecture.',
};

const NON_UI: ConceptPlan = {
  uiBearing: false,
  complexity: 'low',
  artifacts: [{ kind: 'prd', depth: 'lite' }],
  gate: 'noop',
  rationale: 'CLI tool — no UX, no gate.',
};

describe('ConceptRail (Concept v2 — E12.4)', () => {
  it('renders the full chain for a UI-bearing plan and shows the rationale', () => {
    render(<ConceptRail conceptPlan={UI_BEARING} />);
    for (const label of ['Route', 'PRD', 'UX', 'Architecture', 'Plan', 'Gate']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // UX + Architecture + Gate are active for this plan.
    expect(screen.getByTestId('concept-node-ux').dataset.active).toBe('true');
    expect(screen.getByTestId('concept-node-architecture').dataset.active).toBe('true');
    expect(screen.getByTestId('concept-node-gate').dataset.active).toBe('true');
    expect(screen.getByText(UI_BEARING.rationale)).toBeInTheDocument();
    expect(screen.getByText('UI-bearing')).toBeInTheDocument();
  });

  it('greys the UX node and the gate node for a non-UI, noop-gate plan', () => {
    render(<ConceptRail conceptPlan={NON_UI} />);
    // UX skipped (not uiBearing), Gate skipped (noop) — both inactive.
    expect(screen.getByTestId('concept-node-ux').dataset.active).toBe('false');
    expect(screen.getByTestId('concept-node-gate').dataset.active).toBe('false');
    // Architecture not in artifacts → inactive too.
    expect(screen.getByTestId('concept-node-architecture').dataset.active).toBe('false');
    // PRD + Route + Plan always active.
    expect(screen.getByTestId('concept-node-prd').dataset.active).toBe('true');
    expect(screen.getByTestId('concept-node-route').dataset.active).toBe('true');
    expect(screen.getByText('non-UI')).toBeInTheDocument();
    // Skipped nodes carry the "skipped" caption.
    expect(screen.getAllByText('skipped').length).toBeGreaterThanOrEqual(2);
  });
});

describe('ConceptRail — live status + Approve (Round 1)', () => {
  const artifacts = (over: Partial<Record<string, ConceptArtifact>> = {}): ConceptArtifact[] => [
    { kind: 'prd', rev: 1, contentHash: 'h1', status: 'draft', ...(over.prd ?? {}) },
    { kind: 'ux', rev: 0, contentHash: '', status: 'draft', ...(over.ux ?? {}) },
    {
      kind: 'architecture',
      rev: 0,
      contentHash: '',
      status: 'draft',
      ...(over.architecture ?? {}),
    },
  ];

  it('shows an Approve button on a drafted (rev>0) artifact and calls onApprove with its kind', () => {
    const onApprove = vi.fn();
    render(
      <ConceptRail conceptPlan={UI_BEARING} conceptArtifacts={artifacts()} onApprove={onApprove} />,
    );
    // PRD is draft rev1 → awaiting approval → Approve button present.
    const btn = screen.getByTestId('concept-approve-prd');
    expect(btn).toBeInTheDocument();
    expect(screen.getByTestId('concept-status-prd').textContent).toMatch(/awaiting approval/);
    fireEvent.click(btn);
    expect(onApprove).toHaveBeenCalledWith('prd');
    // UX is rev0 but sits BEHIND the awaiting PRD → queued (serial chain), not
    // generating, and no approve button yet.
    expect(screen.queryByTestId('concept-approve-ux')).toBeNull();
    expect(screen.getByTestId('concept-status-ux').textContent).toMatch(/queued/);
  });

  it('an approved artifact shows the approved caption and no Approve button', () => {
    render(
      <ConceptRail
        conceptPlan={UI_BEARING}
        conceptArtifacts={artifacts({
          prd: { kind: 'prd', rev: 2, contentHash: 'h2', status: 'approved' },
        })}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('concept-status-prd').textContent).toMatch(/approved/);
    expect(screen.queryByTestId('concept-approve-prd')).toBeNull();
  });

  it('without onApprove (back-compat) renders status captions but no buttons', () => {
    render(<ConceptRail conceptPlan={UI_BEARING} conceptArtifacts={artifacts()} />);
    expect(screen.getByTestId('concept-status-prd')).toBeInTheDocument();
    expect(screen.queryByTestId('concept-approve-prd')).toBeNull();
  });

  it('shows a live headline + spinner while a doc is generating', () => {
    // prd rev0 = generating.
    render(
      <ConceptRail
        conceptPlan={UI_BEARING}
        conceptArtifacts={artifacts({
          prd: { kind: 'prd', rev: 0, contentHash: '', status: 'draft' },
        })}
      />,
    );
    expect(screen.getByTestId('concept-headline').textContent).toMatch(/Drafting PRD/);
    // The working spinner is present (aria-label="working").
    expect(screen.getAllByLabelText('working').length).toBeGreaterThan(0);
  });

  it('headline reflects awaiting-review when a draft is ready', () => {
    render(
      <ConceptRail conceptPlan={UI_BEARING} conceptArtifacts={artifacts()} onApprove={vi.fn()} />,
    );
    // prd rev1 draft → ready for review.
    expect(screen.getByTestId('concept-headline').textContent).toMatch(/PRD ready for your review/);
  });

  it('offers a View button on a doc with content (rev>=1) and calls onView', () => {
    const onView = vi.fn();
    render(<ConceptRail conceptPlan={UI_BEARING} conceptArtifacts={artifacts()} onView={onView} />);
    // PRD has rev1 → has content → View available; UX is rev0 → no View.
    fireEvent.click(screen.getByTestId('concept-view-prd'));
    expect(onView).toHaveBeenCalledWith('prd');
    expect(screen.queryByTestId('concept-view-ux')).toBeNull();
  });

  it('offers Regenerate alongside Approve on a drafted doc and calls onRegenerate', () => {
    const onRegenerate = vi.fn();
    render(
      <ConceptRail
        conceptPlan={UI_BEARING}
        conceptArtifacts={artifacts()}
        onApprove={vi.fn()}
        onRegenerate={onRegenerate}
      />,
    );
    fireEvent.click(screen.getByTestId('concept-regen-prd'));
    expect(onRegenerate).toHaveBeenCalledWith('prd');
  });
});
