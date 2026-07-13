import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DevelopingSubtabs } from '../developing-subtabs';
import { LABS3_SUBTABS } from '../constants';

/**
 * Regression coverage for the ambiguous-active-tab bug (operator screenshot,
 * 2026-07-13): the previous inline-style key order (`borderBottom` then
 * `border: 'none'`) reset the just-set border-bottom color/width, so every
 * tab — not just the active one — rendered a visible underline in its own
 * text color. These assertions read the resolved DOM style so a regression
 * of the key order (or a reintroduced `flexWrap: 'wrap'`) fails loudly.
 */
describe('DevelopingSubtabs — active tab indicator', () => {
  it('gives exactly one tab a real underline color; siblings resolve to transparent', () => {
    const onChange = vi.fn();
    render(<DevelopingSubtabs active="stories" onChange={onChange} />);

    for (const t of LABS3_SUBTABS) {
      const btn = screen.getByRole('tab', { name: t.label });
      // Assert the resolved shorthand, not the individual longhand getters —
      // jsdom's CSSStyleDeclaration doesn't expand `var(...)` into
      // borderBottomColor, but it DOES preserve the shorthand string, and
      // this is exactly what the ordering bug corrupted: a later
      // `border: 'none'` wiped this out to plain `solid` with no explicit
      // color/width. An explicit "1px solid <value>" here proves the reset
      // now runs before the real value is set, for every tab.
      if (t.id === 'stories') {
        expect(btn.style.borderBottom).toBe('1px solid var(--foreground)');
        expect(btn.getAttribute('aria-selected')).toBe('true');
      } else {
        expect(btn.style.borderBottom).toBe('1px solid transparent');
        expect(btn.getAttribute('aria-selected')).toBe('false');
      }
    }
  });

  it('never wraps the tab row onto a second line (track/underline must share one line)', () => {
    render(<DevelopingSubtabs active="graph" onChange={vi.fn()} />);
    const tablist = screen.getByRole('tablist');
    expect(tablist.style.flexWrap).toBe('nowrap');
  });

  it('routes the exact clicked tab id through onChange, tab set unchanged', () => {
    const onChange = vi.fn();
    render(<DevelopingSubtabs active="graph" onChange={onChange} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Skills & Learnings' }));
    expect(onChange).toHaveBeenCalledWith('growth');

    expect(LABS3_SUBTABS.map((t) => t.id)).toEqual([
      'graph',
      'codegraph',
      'gitgraph',
      'stories',
      'qa',
      'growth',
      'stream',
    ]);
  });
});
