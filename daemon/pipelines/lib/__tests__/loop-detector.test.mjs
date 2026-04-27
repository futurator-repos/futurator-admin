import { describe, it, expect } from 'vitest';
import { LoopDetector, hashToolCall, LOOP_HINT_MESSAGE } from '../loop-detector.mjs';

describe('hashToolCall — canonicalization', () => {
  it('hashes identical calls to the same value', () => {
    expect(hashToolCall('Bash', { command: 'ls' })).toBe(hashToolCall('Bash', { command: 'ls' }));
  });

  it('hashes args in different key order to the same value (deep sort)', () => {
    const a = hashToolCall('Read', { path: '/a', limit: 100 });
    const b = hashToolCall('Read', { limit: 100, path: '/a' });
    expect(a).toBe(b);
  });

  it('hashes nested object keys in canonical order', () => {
    const a = hashToolCall('Tool', { opts: { z: 1, a: 2 } });
    const b = hashToolCall('Tool', { opts: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array order (order matters for tool args)', () => {
    const a = hashToolCall('Tool', { args: ['x', 'y'] });
    const b = hashToolCall('Tool', { args: ['y', 'x'] });
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different tool names', () => {
    expect(hashToolCall('Bash', {})).not.toBe(hashToolCall('Read', {}));
  });

  it('produces different hashes for different arg values', () => {
    expect(hashToolCall('Read', { path: '/a' })).not.toBe(hashToolCall('Read', { path: '/b' }));
  });

  it('handles null/undefined args without throwing', () => {
    expect(typeof hashToolCall('Bash')).toBe('string');
    expect(typeof hashToolCall('Bash', null)).toBe('string');
  });
});

describe('LoopDetector — thresholds', () => {
  it('returns continue while below hint threshold', () => {
    const det = new LoopDetector();
    for (let i = 0; i < 3; i++) {
      const out = det.observe('Bash', { command: 'pwd' });
      expect(out.action).toBe('continue');
    }
  });

  it('hints exactly once at hintAt occurrence', () => {
    const det = new LoopDetector({ hintAt: 4, forceAt: 6, windowSize: 10 });
    let hints = 0;
    for (let i = 0; i < 5; i++) {
      const out = det.observe('Bash', { command: 'pwd' });
      if (out.action === 'hint') hints++;
    }
    expect(hints).toBe(1);
  });

  it('hint payload includes the canonical message and repeatCount', () => {
    const det = new LoopDetector({ hintAt: 2, forceAt: 99, windowSize: 10 });
    det.observe('Read', { path: '/a' });
    const out = det.observe('Read', { path: '/a' });
    expect(out.action).toBe('hint');
    expect(out.repeatCount).toBe(2);
    expect(out.hintMessage).toBe(LOOP_HINT_MESSAGE);
  });

  it('force-escalates at forceAt occurrences and exposes repeatedToolCall', () => {
    const det = new LoopDetector({ hintAt: 4, forceAt: 6, windowSize: 10 });
    let forced;
    for (let i = 0; i < 6; i++) {
      const out = det.observe('Read', { path: '/a' });
      if (out.action === 'force-escalate') forced = out;
    }
    expect(forced).toBeTruthy();
    expect(forced.repeatCount).toBe(6);
    expect(forced.repeatedToolCall).toEqual({ toolName: 'Read', args: { path: '/a' } });
  });

  it('once forced, subsequent observes return continue and do not re-fire', () => {
    const det = new LoopDetector({ hintAt: 2, forceAt: 3, windowSize: 10 });
    det.observe('X', {});
    det.observe('X', {});
    const forced = det.observe('X', {});
    expect(forced.action).toBe('force-escalate');
    const after = det.observe('X', {});
    expect(after.action).toBe('continue');
  });
});

describe('LoopDetector — sliding window', () => {
  it('does not trigger when calls are spread thinly across the window', () => {
    const det = new LoopDetector({ hintAt: 4, forceAt: 6, windowSize: 10 });
    for (let i = 0; i < 10; i++) {
      const out = det.observe('Tool', { i });
      expect(out.action).toBe('continue');
    }
  });

  it('alternating two distinct calls does not escalate either', () => {
    const det = new LoopDetector({ hintAt: 4, forceAt: 6, windowSize: 10 });
    for (let i = 0; i < 5; i++) {
      const a = det.observe('A', {});
      const b = det.observe('B', {});
      expect(a.action).not.toBe('force-escalate');
      expect(b.action).not.toBe('force-escalate');
    }
  });

  it('drops old observations beyond windowSize', () => {
    const det = new LoopDetector({ hintAt: 4, forceAt: 6, windowSize: 5 });
    // 3 X's, then 5 unrelated Y's, then 3 more X's. Within window the first
    // batch of X's has rolled out — total visible X count never reaches 6.
    for (let i = 0; i < 3; i++) det.observe('X', {});
    for (let i = 0; i < 5; i++) det.observe('Y', { i });
    for (let i = 0; i < 3; i++) {
      const out = det.observe('X', {});
      expect(out.action).not.toBe('force-escalate');
    }
  });
});

describe('LoopDetector — per-step isolation (Story 1.3 AC#5)', () => {
  it('a new instance has fresh state', () => {
    const det1 = new LoopDetector({ hintAt: 2, forceAt: 3, windowSize: 10 });
    det1.observe('X', {});
    det1.observe('X', {});
    det1.observe('X', {}); // forced

    const det2 = new LoopDetector({ hintAt: 2, forceAt: 3, windowSize: 10 });
    expect(det2.observe('X', {}).action).toBe('continue');
  });
});
