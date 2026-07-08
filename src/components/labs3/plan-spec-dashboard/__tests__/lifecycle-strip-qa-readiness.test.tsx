/**
 * lifecycle-strip-qa-readiness.test.tsx — the QA REVIEW stage reflects the
 * deployed-app QA readiness (isDeliverable) once the plan has reached it, not
 * merely "assembled + tested".
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LifecycleStrip, qaStageOverride } from '../lifecycle-strip';
import type { Plan } from '@/types/plan';
import type { P3QaVerdict } from '@/types/qa-review-p3';

function makePlan(over: Partial<Plan> = {}): Plan {
  return { planId: 'p1', name: 'p1', status: 'review', epicIds: [], ...over } as Plan;
}

function blockingVerdict(): P3QaVerdict {
  return {
    status: 'fail',
    blocking: true,
    ranAtSha: 'sha',
    journeys: [],
    vqa: [],
    wiring: { orphanModules: [], blocking: false },
  };
}

describe('qaStageOverride (pure)', () => {
  it('returns null when the QA stage has not been reached', () => {
    expect(qaStageOverride(makePlan({ status: 'developing' }), false)).toBeNull();
  });

  it('reports verified when qaVerifiedAt is present', () => {
    const ov = qaStageOverride(makePlan({ qaVerifiedAt: '2026-07-08T00:00:00Z' }), true);
    expect(ov?.sub).toBe('QA verified');
    expect(ov?.color).toBe('var(--success)');
  });

  it('reports blocking when a blocking verdict exists and not deliverable', () => {
    const ov = qaStageOverride(makePlan({ p3QaVerdict: blockingVerdict() }), true);
    expect(ov?.sub).toBe('QA blocking');
    expect(ov?.color).toBe('var(--destructive)');
  });

  it('reports unverified when reached but no verdict/stamp yet', () => {
    const ov = qaStageOverride(makePlan(), true);
    expect(ov?.sub).toBe('QA unverified');
  });
});

describe('LifecycleStrip — QA stage label', () => {
  it('shows "QA unverified" at the review stage with no verdict (not "assembled + tested")', () => {
    render(<LifecycleStrip plan={makePlan({ status: 'review' })} />);
    expect(screen.getByText('QA unverified')).toBeInTheDocument();
    expect(screen.queryByText('assembled + tested')).toBeNull();
  });

  it('keeps "assembled + tested" while still developing (QA stage not reached)', () => {
    render(<LifecycleStrip plan={makePlan({ status: 'developing' })} />);
    expect(screen.getByText('assembled + tested')).toBeInTheDocument();
  });

  it('shows "QA verified" when qaVerifiedAt is stamped', () => {
    render(
      <LifecycleStrip
        plan={makePlan({ status: 'review', qaVerifiedAt: '2026-07-08T00:00:00Z' })}
      />,
    );
    expect(screen.getByText('QA verified')).toBeInTheDocument();
  });
});
