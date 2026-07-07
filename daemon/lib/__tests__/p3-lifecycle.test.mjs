import { describe, it, expect } from 'vitest';
import {
  isP3Plan,
  p3DevDeployIdentity,
  nextStatusOnDispatch,
  nextStatusOnAllDone,
  allStoriesResolved,
} from '../p3-lifecycle.mjs';

describe('isP3Plan', () => {
  it('true for a quick-flow plan (no epics, has appId)', () => {
    expect(isP3Plan({ epicIds: [], appId: 'pacman3-746c20' })).toBe(true);
    expect(isP3Plan({ appId: 'x' })).toBe(true); // epicIds absent
  });
  it('false for a legacy plan (has epics)', () => {
    expect(isP3Plan({ epicIds: ['E1'], appId: 'x' })).toBe(false);
  });
  it('false without an appId, or nullish', () => {
    expect(isP3Plan({ epicIds: [] })).toBe(false);
    expect(isP3Plan(null)).toBe(false);
    expect(isP3Plan(undefined)).toBe(false);
  });
});

describe('p3DevDeployIdentity', () => {
  it('keys on the clean app slug + the box worktree', () => {
    expect(p3DevDeployIdentity({ epicIds: [], appId: 'pacman3-746c20' })).toEqual({
      planSlug: 'pacman3-746c20',
      appId: 'pacman3-746c20',
      workingDir: '/home/ubuntu/projects/pacman3-746c20',
    });
  });
  it('honors a custom projectsRoot', () => {
    expect(p3DevDeployIdentity({ epicIds: [], appId: 'a' }, '/srv').workingDir).toBe('/srv/a');
  });
  it('null for a legacy plan', () => {
    expect(p3DevDeployIdentity({ epicIds: ['E1'], appId: 'a' })).toBeNull();
  });
});

describe('status machine', () => {
  it('dispatch: concept→developing, else no-op', () => {
    expect(nextStatusOnDispatch('concept')).toBe('developing');
    expect(nextStatusOnDispatch('developing')).toBeNull();
    expect(nextStatusOnDispatch('review')).toBeNull();
  });
  it('all-done: pre-review states → review, else no-op', () => {
    expect(nextStatusOnAllDone('concept')).toBe('review');
    expect(nextStatusOnAllDone('developing')).toBe('review');
    expect(nextStatusOnAllDone('fixing')).toBe('review');
    expect(nextStatusOnAllDone('review')).toBeNull();
    expect(nextStatusOnAllDone('delivered')).toBeNull();
  });
});

describe('allStoriesResolved (pacman4 wedge fix)', () => {
  it('true when every story is done', () => {
    expect(allStoriesResolved([{ state: 'done' }, { state: 'done' }])).toBe(true);
  });
  it('true when stories are a MIX of done and failed (was the wedge)', () => {
    expect(allStoriesResolved([{ state: 'done' }, { state: 'failed' }])).toBe(true);
  });
  it('false when any story is still active (ready/claimed/developing)', () => {
    expect(allStoriesResolved([{ state: 'done' }, { state: 'claimed' }])).toBe(false);
    expect(allStoriesResolved([{ state: 'ready' }])).toBe(false);
  });
  it('counts the just-resolved story as terminal despite GSI lag', () => {
    // The current story shows stale 'claimed' on the index but is the one that
    // just finished — it must not block the advance.
    expect(allStoriesResolved([{ state: 'done' }, { state: 'claimed', storyId: 's2' }], 's2')).toBe(true);
  });
  it('false for an empty/invalid node set', () => {
    expect(allStoriesResolved([])).toBe(false);
    expect(allStoriesResolved(null)).toBe(false);
  });
});
