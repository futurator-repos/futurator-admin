import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConceptRail } from '../concept-rail';
import type { ConceptPlan } from '@/types/plan';

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
