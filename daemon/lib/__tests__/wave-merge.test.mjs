/**
 * wave-merge.test.mjs — Pipeline v2 Phase 2-B / Story 2-B-3-1 (PR-95).
 */

import { describe, it, expect } from 'vitest';
import {
  buildWaveMergeCommand,
  classifyWaveMergeOutcome,
  buildMergeConflictAttention,
  buildWaveBuildFailedAttention,
  waveBaseRef,
  postMergeCleanupBranches,
} from '../wave-merge.mjs';

describe('buildWaveMergeCommand', () => {
  it('builds canonical --no-ff merge with metadata', () => {
    const result = buildWaveMergeCommand({
      storyId: 'e3-s5',
      waveBaseRef: 'main',
      planId: 'pln-1',
      plan: 'songster-v2-storyboard',
      epicId: 'epic-3',
      wave: 2,
    });
    expect(result.command).toContain('git merge --no-ff wip/e3-s5');
    expect(result.command).toContain("'merge story e3-s5 into wave'");
    expect(result.command).toContain('Agent: WAVE-MERGE');
    expect(result.command).toContain('Plan-Id: pln-1');
    expect(result.command).toContain('Story: e3-s5');
    expect(result.command).toContain('Wave: 2');
  });

  it('respects custom storyBranch override', () => {
    const result = buildWaveMergeCommand({
      storyId: 's1',
      waveBaseRef: 'main',
      storyBranch: 'wip/custom-name',
    });
    expect(result.command).toContain('git merge --no-ff wip/custom-name');
  });

  it('throws on missing storyId', () => {
    expect(() => buildWaveMergeCommand({ waveBaseRef: 'main' })).toThrow(/storyId/);
  });

  it('flagBodies always includes the Agent line', () => {
    const result = buildWaveMergeCommand({ storyId: 's1', waveBaseRef: 'main' });
    expect(result.flagBodies).toContain('Agent: WAVE-MERGE');
  });
});

describe('classifyWaveMergeOutcome', () => {
  it('flags merge-conflict on non-zero merge exit', () => {
    const r = classifyWaveMergeOutcome({ mergeExit: 1 });
    expect(r.outcome).toBe('merge-conflict');
    expect(r.attentionCategory).toBe('merge-conflict');
  });

  it('flags wave-build-failed when merge clean but tests red', () => {
    const r = classifyWaveMergeOutcome({ mergeExit: 0, testExit: 1 });
    expect(r.outcome).toBe('wave-build-failed');
    expect(r.attentionCategory).toBe('wave-build-failed');
  });

  it('success on clean merge + green tests', () => {
    const r = classifyWaveMergeOutcome({ mergeExit: 0, testExit: 0 });
    expect(r.outcome).toBe('success');
    expect(r.attentionCategory).toBeUndefined();
  });

  it('success when no testExit provided (merge-only path)', () => {
    const r = classifyWaveMergeOutcome({ mergeExit: 0 });
    expect(r.outcome).toBe('success');
  });
});

describe('buildMergeConflictAttention', () => {
  it('shapes a high-severity attention item with file list', () => {
    const item = buildMergeConflictAttention({
      planId: 'pln-1',
      storyIds: ['s1', 's2', 's3'],
      conflictedFiles: ['src/foo.ts', 'src/bar.ts'],
    });
    expect(item.severity).toBe('high');
    expect(item.category).toBe('merge-conflict');
    expect(item.body).toContain('src/foo.ts');
    expect(item.body).toContain('src/bar.ts');
    expect(item.body).toContain('s1');
    expect(item.actions).toContain('resolve-manually');
  });
});

describe('buildWaveBuildFailedAttention', () => {
  it('shapes a high-severity item with failing-test sample', () => {
    const item = buildWaveBuildFailedAttention({
      planId: 'pln-1',
      storyIds: ['s1', 's2'],
      testExit: 1,
      failingTests: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    expect(item.severity).toBe('high');
    expect(item.body).toContain('a');
    expect(item.body).toContain('e');
    // Top-5 + "…and N more"
    expect(item.body).toContain('and 2 more');
  });

  it('handles empty failingTests list gracefully', () => {
    const item = buildWaveBuildFailedAttention({
      planId: 'pln-1',
      storyIds: ['s1'],
      testExit: 1,
    });
    expect(item.body).toContain('No failing test list');
  });
});

describe('waveBaseRef', () => {
  it('wave 0 → main', () => {
    expect(waveBaseRef({ waveIndex: 0 })).toBe('main');
  });

  it('wave 1+ → previousWaveSha', () => {
    expect(waveBaseRef({ waveIndex: 1, previousWaveSha: 'abc123' })).toBe('abc123');
  });

  it('throws when wave 1+ has no previous SHA', () => {
    expect(() => waveBaseRef({ waveIndex: 1 })).toThrow(/previousWaveSha/);
  });
});

describe('postMergeCleanupBranches', () => {
  it('maps story ids to wip/ branch names', () => {
    expect(postMergeCleanupBranches(['s1', 's2', 'e3-s5'])).toEqual([
      'wip/s1',
      'wip/s2',
      'wip/e3-s5',
    ]);
  });

  it('empty input → empty output', () => {
    expect(postMergeCleanupBranches([])).toEqual([]);
  });
});
