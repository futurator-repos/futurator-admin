/**
 * skill-scout-triggers.test.mjs — Pipeline v2 Phase 3 / Story 3-C-5 (PR-79).
 */

import { describe, it, expect } from 'vitest';
import {
  detectNewDependencies,
  createT5Debouncer,
  detectReviewerClusters,
  buildT7Args,
  T8_REFRESH_SCHEDULE,
  computeT8Deltas,
} from '../skill-scout-triggers.mjs';

describe('detectNewDependencies (T5)', () => {
  it('returns empty when nothing added', () => {
    const result = detectNewDependencies({
      beforePkgJson: { dependencies: { react: '^18.0.0' } },
      afterPkgJson: { dependencies: { react: '^18.0.0' } },
    });
    expect(result).toEqual([]);
  });

  it('detects new top-level dependency', () => {
    const result = detectNewDependencies({
      beforePkgJson: { dependencies: { react: '^18.0.0' } },
      afterPkgJson: {
        dependencies: { react: '^18.0.0', stripe: '^15.0.0' },
      },
    });
    expect(result).toEqual(['stripe']);
  });

  it('detects new devDependencies', () => {
    const result = detectNewDependencies({
      beforePkgJson: {},
      afterPkgJson: { devDependencies: { vitest: '^1.0.0' } },
    });
    expect(result).toEqual(['vitest']);
  });

  it('ignores transitive lockfile-only changes (no package.json change)', () => {
    // Both before/after are identical → empty
    const pkg = { dependencies: { react: '^18.0.0' } };
    expect(detectNewDependencies({ beforePkgJson: pkg, afterPkgJson: pkg })).toEqual([]);
  });

  it('handles null beforePkgJson (first commit)', () => {
    const result = detectNewDependencies({
      beforePkgJson: null,
      afterPkgJson: { dependencies: { react: '^18.0.0', next: '^15.0.0' } },
    });
    expect(result.sort()).toEqual(['next', 'react']);
  });

  it('ignores dep removals (those are out-of-band)', () => {
    const result = detectNewDependencies({
      beforePkgJson: { dependencies: { react: '^18.0.0', moment: '^2.0.0' } },
      afterPkgJson: { dependencies: { react: '^18.0.0' } },
    });
    expect(result).toEqual([]);
  });
});

describe('createT5Debouncer', () => {
  it('fires immediately on first event', () => {
    let now = 1000;
    const d = createT5Debouncer({ now: () => now });
    const result = d.record({ projectSlug: 'dino', deps: ['stripe'] });
    expect(result.fire).toBe(true);
    expect(result.deps).toEqual(['stripe']);
  });

  it('accumulates within window, defers fire', () => {
    let now = 1000;
    const d = createT5Debouncer({ now: () => now });
    d.record({ projectSlug: 'dino', deps: ['stripe'] }); // first fire

    now += 60_000; // 1 min later
    const second = d.record({ projectSlug: 'dino', deps: ['sentry'] });
    expect(second.fire).toBe(false);

    now += 60_000;
    const third = d.record({ projectSlug: 'dino', deps: ['moises'] });
    expect(third.fire).toBe(false);
  });

  it('fires with accumulated deps after window elapses', () => {
    let now = 1000;
    const d = createT5Debouncer({ now: () => now });
    d.record({ projectSlug: 'dino', deps: ['stripe'] });

    now += 60_000;
    d.record({ projectSlug: 'dino', deps: ['sentry'] });

    now += 6 * 60_000; // 6 min after first fire — past 5-min window
    const fourth = d.record({ projectSlug: 'dino', deps: ['moises'] });
    expect(fourth.fire).toBe(true);
    expect(fourth.deps.sort()).toEqual(['moises', 'sentry']);
  });

  it('isolates per-project state', () => {
    let now = 1000;
    const d = createT5Debouncer({ now: () => now });
    d.record({ projectSlug: 'dino', deps: ['stripe'] });
    const other = d.record({ projectSlug: 'songster', deps: ['moises'] });
    expect(other.fire).toBe(true); // different project, fresh fire
  });
});

describe('detectReviewerClusters (T6)', () => {
  it('returns empty when no rejections', () => {
    expect(detectReviewerClusters([])).toEqual([]);
  });

  it('returns empty when below 3-story threshold', () => {
    const rejections = [
      { storyId: 'S1', rejectedFiles: ['src/components/Foo.tsx'] },
      { storyId: 'S2', rejectedFiles: ['src/components/Bar.tsx'] },
    ];
    expect(detectReviewerClusters(rejections)).toEqual([]);
  });

  it('detects ≥ 3 distinct stories in same cluster', () => {
    const rejections = [
      { storyId: 'S1', rejectedFiles: ['src/components/Foo.tsx'] },
      { storyId: 'S2', rejectedFiles: ['src/components/Bar.tsx'] },
      { storyId: 'S3', rejectedFiles: ['src/components/Baz.tsx'] },
    ];
    const result = detectReviewerClusters(rejections);
    expect(result).toHaveLength(1);
    expect(result[0].cluster).toBe('components');
    expect(result[0].storyIds).toEqual(['S1', 'S2', 'S3']);
  });

  it('clusters across different source-root prefixes', () => {
    const rejections = [
      { storyId: 'S1', rejectedFiles: ['src/api/users.ts'] },
      { storyId: 'S2', rejectedFiles: ['functions/api/users.ts'] },
      { storyId: 'S3', rejectedFiles: ['lib/api/handler.ts'] },
    ];
    const result = detectReviewerClusters(rejections);
    // All three resolve to "api" bucket (segment after source-root)
    expect(result).toHaveLength(1);
    expect(result[0].cluster).toBe('api');
  });

  it('handles same story rejected on multiple files (single story counts once per cluster)', () => {
    const rejections = [
      {
        storyId: 'S1',
        rejectedFiles: ['src/hooks/useA.ts', 'src/hooks/useB.ts', 'src/hooks/useC.ts'],
      },
    ];
    const result = detectReviewerClusters(rejections);
    // S1 alone doesn't cross the 3-story threshold for `hooks`
    expect(result).toEqual([]);
  });
});

describe('buildT7Args (T7)', () => {
  it('shapes args with stream context', () => {
    const args = buildT7Args({
      streamName: 'live-perf-teleprompter',
      planId: 'songster-perf',
      projectSlug: 'songster',
      planIntent: 'extract teleprompter into a Plan',
    });
    expect(args.trigger).toBe('T7');
    expect(args.projectSlug).toBe('songster');
    expect(args.planIntent).toContain('live-perf-teleprompter');
    expect(args.planIntent).toContain('teleprompter into a Plan');
  });
});

describe('T8_REFRESH_SCHEDULE', () => {
  it('is Monday 06:00 UTC', () => {
    expect(T8_REFRESH_SCHEDULE.cronExpr).toBe('0 6 * * MON');
    expect(T8_REFRESH_SCHEDULE.utc).toBe(true);
  });

  it('is frozen', () => {
    expect(() => {
      T8_REFRESH_SCHEDULE.cronExpr = 'X';
    }).toThrow();
  });
});

describe('computeT8Deltas', () => {
  it('returns empty when snapshots match', () => {
    const snap = { 'src-1': new Set(['a', 'b']) };
    expect(computeT8Deltas({ priorSnapshot: snap, currentSnapshot: snap })).toEqual([]);
  });

  it('detects added skills', () => {
    const out = computeT8Deltas({
      priorSnapshot: { 'src-1': new Set(['a']) },
      currentSnapshot: { 'src-1': new Set(['a', 'b', 'c']) },
    });
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('src-1');
    expect(out[0].addedSkills).toEqual(['b', 'c']);
    expect(out[0].removedSkills).toEqual([]);
  });

  it('detects removed skills', () => {
    const out = computeT8Deltas({
      priorSnapshot: { 'src-1': new Set(['a', 'b']) },
      currentSnapshot: { 'src-1': new Set(['a']) },
    });
    expect(out[0].removedSkills).toEqual(['b']);
    expect(out[0].addedSkills).toEqual([]);
  });

  it('handles fresh source (no prior snapshot)', () => {
    const out = computeT8Deltas({
      priorSnapshot: null,
      currentSnapshot: { 'src-new': new Set(['x', 'y']) },
    });
    expect(out[0].addedSkills).toEqual(['x', 'y']);
  });
});
