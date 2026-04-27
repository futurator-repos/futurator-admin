import { describe, it, expect, vi } from 'vitest';
import { injectSystemMessage, formatSystemMessage } from '../inject-system-message.mjs';

describe('formatSystemMessage', () => {
  it('prefixes [SYSTEM] and tags the category', () => {
    const text = formatSystemMessage('COST_WARN', '$4.00 of $5.00');
    expect(text).toMatch(/^\[SYSTEM\] \[COST_WARN\] /);
  });

  it('caps the message at 500 chars to match event-payload bounds', () => {
    const big = 'x'.repeat(2000);
    expect(formatSystemMessage('LOOP_HINT', big).length).toBeLessThanOrEqual(500);
  });
});

describe('injectSystemMessage', () => {
  it('calls pushEvent with the formatted text', () => {
    const pushEvent = vi.fn();
    injectSystemMessage({ pushEvent }, 'j1', 's1', 'a1', 'LOOP_HINT', 'try a different approach');
    expect(pushEvent).toHaveBeenCalledWith(
      'j1',
      's1',
      'a1',
      'status',
      expect.objectContaining({ text: expect.stringContaining('LOOP_HINT') }),
    );
  });

  it('swallows pushEvent failures (informational only)', () => {
    const pushEvent = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() =>
      injectSystemMessage({ pushEvent }, 'j', 's', 'a', 'TIME_WARN', 'x'),
    ).not.toThrow();
  });
});
