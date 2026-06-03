import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSessionDraft } from '../use-session-draft';
import { loadDraft } from '@/lib/draft-store';

afterEach(() => {
  localStorage.clear();
});

describe('useSessionDraft', () => {
  it('restores a previously saved draft on mount', () => {
    localStorage.setItem('party:draft:s1', 'restored text');
    const { result } = renderHook(() => useSessionDraft('s1'));
    expect(result.current[0]).toBe('restored text');
  });

  it('persists draft changes to localStorage', () => {
    const { result } = renderHook(() => useSessionDraft('s1'));
    act(() => result.current[1]('typing…'));
    expect(result.current[0]).toBe('typing…');
    expect(loadDraft('s1')).toBe('typing…');
  });

  it('supports the functional updater form (DocTray insert path)', () => {
    const { result } = renderHook(() => useSessionDraft('s1'));
    act(() => result.current[1]('Read '));
    act(() => result.current[1]((d) => `${d}./docs/spec.md`));
    expect(result.current[0]).toBe('Read ./docs/spec.md');
    expect(loadDraft('s1')).toBe('Read ./docs/spec.md');
  });

  it('clears the persisted draft when set to empty (send path)', () => {
    const { result } = renderHook(() => useSessionDraft('s1'));
    act(() => result.current[1]('about to send'));
    act(() => result.current[1](''));
    expect(loadDraft('s1')).toBe('');
  });

  it('re-hydrates when the session id changes without a remount', () => {
    localStorage.setItem('party:draft:s2', 'session two draft');
    const { result, rerender } = renderHook(({ id }) => useSessionDraft(id), {
      initialProps: { id: 's1' },
    });
    act(() => result.current[1]('session one draft'));
    expect(result.current[0]).toBe('session one draft');

    rerender({ id: 's2' });
    expect(result.current[0]).toBe('session two draft');
    // The original session's draft is untouched.
    expect(loadDraft('s1')).toBe('session one draft');
  });
});
