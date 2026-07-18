import { describe, it, expect } from 'vitest';
import { stageForStatus, stageIndex } from '../constants';
import type { Plan } from '@/types/plan';

function plan(over: Partial<Plan> = {}): Plan {
  return { planId: 'p1', name: 'p1', status: 'developing', epicIds: [], ...over } as Plan;
}

/**
 * The lifecycle strip's PROGRESS marker is `stageIndex(stageForStatus(plan))`.
 * This asserts the composed active-index the component paints done/active/
 * pending from (selection is orthogonal and tested in the click spec).
 */
describe('lifecycle progress index (stageForStatus → stageIndex)', () => {
  const active = (p: Plan) => stageIndex(stageForStatus(p.status, p));

  it('advances concept → development → qa across statuses', () => {
    expect(active(plan({ status: 'concept' }))).toBe(0);
    expect(active(plan({ status: 'developing' }))).toBe(1);
    expect(active(plan({ status: 'fixing' }))).toBe(1);
    expect(active(plan({ status: 'review' }))).toBe(2);
  });

  it('delivered rests at deployment (3) until a deploy URL bumps it to publish (4)', () => {
    expect(active(plan({ status: 'delivered' }))).toBe(3);
    expect(active(plan({ status: 'delivered', deployUrl: 'https://x/' }))).toBe(4);
  });

  it('archived/unknown falls back to concept', () => {
    expect(active(plan({ status: 'archived' as never }))).toBe(0);
  });
});
