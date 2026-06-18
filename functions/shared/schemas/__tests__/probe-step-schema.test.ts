import { describe, it, expect } from 'vitest';
import {
  probeStepSchema,
  probeFlowSchema,
  probeStepActionSchema,
  assertOpSchema,
} from '../probe-step-schema';

/**
 * VQA v3 — Story E2.1: the probe action grammar (types + parser). The five
 * legacy actions must still validate; the new interaction/assert/coverage
 * actions are accepted; unknown actions are rejected.
 */
describe('probeStepSchema (VQA v3 — E2.1)', () => {
  it('AC1 — accepts a press step with a key', () => {
    const result = probeStepSchema.safeParse({ action: 'press', key: 'Space' });
    expect(result.success).toBe(true);
  });

  it('AC1 — accepts an assert step (L2-state oracle)', () => {
    const result = probeStepSchema.safeParse({
      action: 'assert',
      expr: 'snapshot.gameState',
      op: 'eq',
      expected: 'playing',
    });
    expect(result.success).toBe(true);
  });

  it('AC1 — accepts a clock step', () => {
    expect(
      probeStepSchema.safeParse({ action: 'clock', clockMode: 'runFor', ms: 5000 }).success,
    ).toBe(true);
  });

  it('AC1 — accepts pointer/tap with coordinates and a stroke path', () => {
    expect(probeStepSchema.safeParse({ action: 'pointer', x: 100, y: 200 }).success).toBe(true);
    expect(
      probeStepSchema.safeParse({
        action: 'stroke',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      }).success,
    ).toBe(true);
  });

  it('AC1 — accepts H10 coverage-class actions (viewport, upload, network)', () => {
    expect(probeStepSchema.safeParse({ action: 'viewport', w: 375, h: 812 }).success).toBe(true);
    expect(
      probeStepSchema.safeParse({ action: 'upload', selector: '#file', value: '/tmp/x.png' })
        .success,
    ).toBe(true);
    expect(probeStepSchema.safeParse({ action: 'network', network: 'offline' }).success).toBe(true);
  });

  it('AC2 — back-compat: the five legacy actions still validate', () => {
    const legacy = [
      { action: 'navigate', url: '/' },
      { action: 'click', selector: '#start' },
      { action: 'fill', selector: '#name', value: 'Ada' },
      { action: 'wait', ms: 500 },
      { action: 'screenshot', label: 'after-start' },
    ];
    expect(probeFlowSchema.safeParse(legacy).success).toBe(true);
  });

  it('rejects an unknown action', () => {
    expect(probeStepSchema.safeParse({ action: 'teleport' }).success).toBe(false);
  });

  it('grammar surface — action enum has the full set; assert ops are the operator set', () => {
    expect(probeStepActionSchema.options).toContain('press');
    expect(probeStepActionSchema.options).toContain('assert');
    expect(probeStepActionSchema.options).toContain('clock');
    expect(assertOpSchema.options).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'contains',
      'truthy',
      'falsy',
    ]);
  });
});
