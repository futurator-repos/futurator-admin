import { describe, it, expect } from 'vitest';
import { canPromote } from '../deploy-gate';

describe('canPromote', () => {
  it('blocks when the plan has not loaded', () => {
    const gate = canPromote(undefined, 'verified');
    expect(gate.canPromote).toBe(false);
    expect(gate.reason).toMatch(/not loaded/i);
  });

  it('blocks when there is no dev deploy yet', () => {
    const gate = canPromote({ devUrl: undefined }, 'verified');
    expect(gate.canPromote).toBe(false);
    expect(gate.reason).toMatch(/no dev deploy/i);
  });

  it('blocks with a QA-blocking reason when readiness is blocking', () => {
    const gate = canPromote({ devUrl: 'https://dev.futurator.ai/app-1/' }, 'blocking');
    expect(gate.canPromote).toBe(false);
    expect(gate.reason).toMatch(/blocking/i);
  });

  it('blocks with a not-verified reason when readiness is pending', () => {
    const gate = canPromote({ devUrl: 'https://dev.futurator.ai/app-1/' }, 'pending');
    expect(gate.canPromote).toBe(false);
    expect(gate.reason).toMatch(/not verified/i);
  });

  it('allows promotion once dev is deployed and QA is verified', () => {
    const gate = canPromote({ devUrl: 'https://dev.futurator.ai/app-1/' }, 'verified');
    expect(gate.canPromote).toBe(true);
    expect(gate.reason).toBeUndefined();
  });
});
