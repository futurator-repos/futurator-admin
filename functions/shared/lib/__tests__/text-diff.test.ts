/**
 * text-diff.test.ts — Skills Institution, Story 3.2.
 */

import { describe, it, expect } from 'vitest';
import { lineDiff } from '../text-diff';

describe('lineDiff', () => {
  it('reports all-context when identical', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines.every((l) => l.type === 'ctx')).toBe(true);
  });

  it('detects a pure addition', () => {
    const d = lineDiff('a\nc', 'a\nb\nc');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.lines).toContainEqual({ type: 'add', text: 'b' });
  });

  it('detects a pure deletion', () => {
    const d = lineDiff('a\nb\nc', 'a\nc');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(1);
    expect(d.lines).toContainEqual({ type: 'del', text: 'b' });
  });

  it('detects a replacement as del + add and preserves order', () => {
    const d = lineDiff('a\nold\nc', 'a\nnew\nc');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    const types = d.lines.map((l) => `${l.type}:${l.text}`);
    expect(types).toEqual(['ctx:a', 'del:old', 'add:new', 'ctx:c']);
  });

  it('handles empty old (whole body is an addition)', () => {
    const d = lineDiff('', 'x\ny');
    // '' splits to [''] so one ctx-empty may align; assert additions present
    expect(d.added).toBeGreaterThanOrEqual(1);
    expect(d.lines.some((l) => l.type === 'add' && l.text === 'y')).toBe(true);
  });

  it('reconstructs the new text from ctx+add lines', () => {
    const a = 'one\ntwo\nthree';
    const b = 'one\ntwo-and-a-half\nthree\nfour';
    const d = lineDiff(a, b);
    const rebuilt = d.lines
      .filter((l) => l.type !== 'del')
      .map((l) => l.text)
      .join('\n');
    expect(rebuilt).toBe(b);
  });
});
