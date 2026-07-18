import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubtabRow, type SubtabRowTab } from '../developing-subtabs';
import { subtabDefs, stageDef } from '../constants';

/**
 * Regression coverage for the ambiguous-active-tab bug (operator screenshot,
 * 2026-07-13): the previous inline-style key order (`borderBottom` then
 * `border: 'none'`) reset the just-set border-bottom color/width, so every
 * tab — not just the active one — rendered a visible underline in its own text
 * color. These assertions read the resolved DOM style so a regression of the
 * key order (or a reintroduced `flexWrap: 'wrap'`) fails loudly.
 */
const DEV_TABS: SubtabRowTab[] = subtabDefs(stageDef('development').subtabs);

describe('SubtabRow — active tab indicator', () => {
  it('gives exactly one tab a real underline color; siblings resolve to transparent', () => {
    render(<SubtabRow tabs={DEV_TABS} active="stories" onChange={vi.fn()} />);

    for (const t of DEV_TABS) {
      const btn = screen.getByRole('tab', { name: t.label });
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
    render(<SubtabRow tabs={DEV_TABS} active="graph" onChange={vi.fn()} />);
    const tablist = screen.getByRole('tablist');
    expect(tablist.style.flexWrap).toBe('nowrap');
  });

  it('renders only the tabs it is handed, in the given order', () => {
    render(<SubtabRow tabs={DEV_TABS} active="stories" onChange={vi.fn()} />);
    const rendered = screen.getAllByRole('tab').map((el) => el.textContent);
    expect(rendered).toEqual(DEV_TABS.map((t) => t.label));
  });

  it('routes the exact clicked tab id through onChange', () => {
    const onChange = vi.fn();
    render(<SubtabRow tabs={DEV_TABS} active="stories" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Skills & Learnings' }));
    expect(onChange).toHaveBeenCalledWith('growth');
  });
});
