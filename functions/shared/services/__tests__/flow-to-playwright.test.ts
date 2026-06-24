import { describe, it, expect } from 'vitest';
import { flowToPlaywright } from '../flow-to-playwright';
import type { VisualTestFlowStep } from '../../types/epic-workflow';

describe('flowToPlaywright — Stage A.4 visible scripts', () => {
  it('returns empty for a flow-less (idle) test', () => {
    expect(flowToPlaywright(undefined)).toBe('');
    expect(flowToPlaywright([])).toBe('');
  });

  it('translates a press/wait/screenshot flow into readable Playwright', () => {
    const flow: VisualTestFlowStep[] = [
      { action: 'press', key: 'Enter' },
      { action: 'wait', ms: 600 },
      { action: 'press', key: 'ArrowRight' },
      { action: 'screenshot', label: 'after' },
    ];
    const script = flowToPlaywright(flow);
    expect(script).toContain('await page.goto(BASE');
    expect(script).toContain('await page.keyboard.press("Enter")');
    expect(script).toContain('await page.waitForTimeout(600)');
    expect(script).toContain('await page.keyboard.press("ArrowRight")');
    expect(script).toContain("page.screenshot({ path: 'after.png' })");
  });

  it('adds the seam-ready wait + force/assert lines for a seam flow', () => {
    const flow: VisualTestFlowStep[] = [
      { action: 'force', status: 'over' },
      {
        action: 'waitForEvent',
        expr: 'snapshot.status',
        op: 'eq',
        expected: 'over',
        timeoutMs: 5000,
      },
      { action: 'screenshot', label: 'after' },
      { action: 'assert', expr: 'snapshot.status', op: 'eq', expected: 'over' },
    ];
    const script = flowToPlaywright(flow);
    expect(script).toContain('window.__harness?.ready === true'); // seam ready gate
    expect(script).toContain('window.__harness?.forceStatus?.');
    expect(script).toContain('ASSERT');
    expect(script).toContain('snapshot.status');
  });
});
