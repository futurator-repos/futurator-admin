import { describe, it, expect } from 'vitest';
import { deriveProjectId } from '../derive-project-id';

describe('deriveProjectId — worktree-aware projectId', () => {
  it('returns the app id from a per-story worktree path (the bug)', () => {
    // last segment is the storyId; appId is the segment after `worktrees`.
    expect(
      deriveProjectId(
        '/home/ubuntu/worktrees/dino1/dino1-initial/7901b4ff-04dc-4702-a8f6-cb7ea9faba6d',
      ),
    ).toBe('dino1');
    expect(deriveProjectId('/home/ubuntu/worktrees/dino1/dino1-initial/7901b4ff/')).toBe('dino1');
  });

  it('returns the app id from the legacy single-folder path', () => {
    expect(deriveProjectId('/home/ubuntu/projects/dino1')).toBe('dino1');
    expect(deriveProjectId('/home/ubuntu/projects/snake-4/')).toBe('snake-4');
  });

  it('handles the candidate worktree path (appId after worktrees)', () => {
    expect(deriveProjectId('/home/ubuntu/worktrees/dino1/dino1-initial/_cand/job-1')).toBe('dino1');
  });

  it('falls back to last segment for unknown shapes; unknown for empty', () => {
    expect(deriveProjectId('/some/other/path/myapp')).toBe('myapp');
    expect(deriveProjectId('')).toBe('unknown');
    expect(deriveProjectId(undefined)).toBe('unknown');
    expect(deriveProjectId(null)).toBe('unknown');
  });
});
