/**
 * bound-ac-table.test.tsx — advisory chip state mapping (Q1 observe-only
 * journey steps). ADV-class rows must read `ac.advisoryVqa`, never the old
 * testBinding.status pass/fail rollup (which was a permanent-FAILING lie
 * for advisory ACs that never ran through the per-story browser executor).
 */

import { describe, it, expect } from 'vitest';
import { advisoryChipState, type AdvisoryVqa } from '../bound-ac-table';

function vqa(status: AdvisoryVqa['status']): AdvisoryVqa {
  return { status, judgedAt: '2026-07-18T00:00:00.000Z' };
}

describe('advisoryChipState — pure helper', () => {
  it('maps absent advisoryVqa to never-run', () => {
    expect(advisoryChipState(undefined)).toBe('never-run');
    expect(advisoryChipState(null)).toBe('never-run');
  });

  it("maps status:'pass' to verified", () => {
    expect(advisoryChipState(vqa('pass'))).toBe('verified');
  });

  it("maps status:'attention' to attention", () => {
    expect(advisoryChipState(vqa('attention'))).toBe('attention');
  });

  it("maps status:'error' to error", () => {
    expect(advisoryChipState(vqa('error'))).toBe('error');
  });

  it('never returns a false-blocking-looking state for an unrun advisory AC', () => {
    // The regression this closes: an unbound/never-run advisory AC must NOT
    // resolve to the same visual class as a real 'error'/'attention' finding.
    const state = advisoryChipState(undefined);
    expect(state).not.toBe('error');
    expect(state).not.toBe('attention');
  });
});
