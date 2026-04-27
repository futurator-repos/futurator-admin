import { describe, it, expect } from 'vitest';
import { CostMeter } from '../cost-meter.mjs';

describe('CostMeter — decideAction', () => {
  const cm = new CostMeter({});

  it('returns continue when ceiling is unset', () => {
    expect(cm.decideAction(0.5, 0).action).toBe('continue');
    expect(cm.decideAction(0.5, NaN).action).toBe('continue');
  });

  it('returns continue while well under the ceiling', () => {
    expect(cm.decideAction(0.4, 5.0).action).toBe('continue');
  });

  it('warns at 80% by default', () => {
    expect(cm.decideAction(4.0, 5.0).action).toBe('warn');
  });

  it('terminates at exactly the ceiling', () => {
    const out = cm.decideAction(5.0, 5.0);
    expect(out.action).toBe('terminate');
    expect(out.reason).toBe('COST_CEILING');
  });

  it('respects custom warn threshold', () => {
    expect(cm.decideAction(0.5, 1.0, 0.5).action).toBe('warn');
    expect(cm.decideAction(0.4, 1.0, 0.5).action).toBe('continue');
  });
});
