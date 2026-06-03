import { afterEach, describe, expect, it } from 'vitest';
import { clearDraft, loadDraft, saveDraft } from '../draft-store';

afterEach(() => {
  localStorage.clear();
});

describe('draft-store', () => {
  it('returns empty string when nothing is saved', () => {
    expect(loadDraft('s1')).toBe('');
  });

  it('round-trips a draft per session id', () => {
    saveDraft('s1', 'hello world');
    saveDraft('s2', 'other');
    expect(loadDraft('s1')).toBe('hello world');
    expect(loadDraft('s2')).toBe('other');
  });

  it('removes the key when saving an empty draft (no stale rows)', () => {
    saveDraft('s1', 'typed something');
    expect(localStorage.getItem('party:draft:s1')).toBe('typed something');
    saveDraft('s1', '');
    expect(localStorage.getItem('party:draft:s1')).toBeNull();
    expect(loadDraft('s1')).toBe('');
  });

  it('clearDraft removes the persisted draft', () => {
    saveDraft('s1', 'keep then drop');
    clearDraft('s1');
    expect(loadDraft('s1')).toBe('');
  });

  it('is a no-op for an empty session id', () => {
    saveDraft('', 'no key');
    expect(loadDraft('')).toBe('');
    expect(localStorage.getItem('party:draft:')).toBeNull();
  });
});
