import { describe, it, expect } from 'vitest';
import { normalizeVerdict, blocksGreen } from '../probe-verdict';

/**
 * VQA v3 — Stories E6.2 (one verdict vocab) + E6.3 (the (level×verdict)→block
 * rule, FR-21 + OQ3). The block rule is the single point both checkpoints use.
 */
describe('normalizeVerdict (VQA v3 — E6.2)', () => {
  it('maps both vocabularies + casings to the canonical set', () => {
    expect(normalizeVerdict('PASS')).toBe('pass');
    expect(normalizeVerdict('fail')).toBe('fail');
    expect(normalizeVerdict('UNREACHABLE')).toBe('unreachable');
    expect(normalizeVerdict('UNVERIFIABLE')).toBe('unreachable');
    expect(normalizeVerdict('UNCERTAIN')).toBe('uncertain');
    expect(normalizeVerdict(undefined)).toBe('uncertain');
    expect(normalizeVerdict('garbage')).toBe('uncertain');
  });
});

describe('blocksGreen — (level × verdict) → block (VQA v3 — E6.3/FR-21)', () => {
  it('only a fail can block; pass/uncertain/unreachable never do', () => {
    for (const v of ['pass', 'uncertain', 'unreachable'] as const) {
      expect(blocksGreen({ level: 'L2-state', verdict: v, checkpoint: 'qa-review' })).toBe(false);
    }
  });

  it('vision tiers (L1, L2-vision) NEVER block, even on a fail', () => {
    expect(blocksGreen({ level: 'L1', verdict: 'fail', checkpoint: 'qa-review' })).toBe(false);
    expect(blocksGreen({ level: 'L2-vision', verdict: 'fail', checkpoint: 'qa-review' })).toBe(
      false,
    );
  });

  it('L0 deterministic fail blocks at BOTH checkpoints', () => {
    expect(blocksGreen({ level: 'L0', verdict: 'fail', checkpoint: 'qa-review' })).toBe(true);
    expect(blocksGreen({ level: 'L0', verdict: 'fail', checkpoint: 'wave-gate' })).toBe(true);
  });

  it('OQ3 — L2-state fail blocks at QA Review but is non-blocking at the wave gate (until E13)', () => {
    expect(blocksGreen({ level: 'L2-state', verdict: 'fail', checkpoint: 'qa-review' })).toBe(true);
    expect(blocksGreen({ level: 'L2-state', verdict: 'fail', checkpoint: 'wave-gate' })).toBe(
      false,
    );
  });
});
