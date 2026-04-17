import { describe, it, expect } from 'vitest';
import { globsIntersect, detectCollisions, reassignWaves } from '../glob-intersect.mjs';

describe('globsIntersect', () => {
  it('identical globs intersect', () => {
    expect(globsIntersect('src/hooks/use-costs.ts', 'src/hooks/use-costs.ts')).toBe(true);
  });

  it('exact path vs same-dir wildcard intersects', () => {
    expect(globsIntersect('src/hooks/*.ts', 'src/hooks/use-costs.ts')).toBe(true);
    expect(globsIntersect('src/hooks/use-costs.ts', 'src/hooks/*.ts')).toBe(true);
  });

  it('recursive ** matches nested paths', () => {
    expect(globsIntersect('src/**/*.tsx', 'src/components/Widget.tsx')).toBe(true);
    expect(globsIntersect('functions/**/*.ts', 'functions/api/index.ts')).toBe(true);
    expect(globsIntersect('src/**', 'src/hooks/use-costs.ts')).toBe(true);
  });

  it('different directories do not intersect', () => {
    expect(globsIntersect('src/hooks/*.ts', 'src/stores/*.ts')).toBe(false);
    expect(globsIntersect('src/hooks/use-costs.ts', 'src/stores/auth-store.ts')).toBe(false);
  });

  it('different extensions do not intersect', () => {
    expect(globsIntersect('src/**/*.ts', 'src/**/*.tsx')).toBe(false);
    expect(globsIntersect('src/hooks/*.ts', 'src/hooks/*.tsx')).toBe(false);
  });

  it('overlapping wildcards within a segment intersect', () => {
    expect(globsIntersect('src/hooks/use-*.ts', 'src/hooks/use-costs.ts')).toBe(true);
    expect(globsIntersect('src/hooks/use-*.ts', 'src/hooks/*-costs.ts')).toBe(true);
  });

  it('rejects non-string inputs and empty strings', () => {
    expect(globsIntersect(null, 'a')).toBe(false);
    expect(globsIntersect('a', undefined)).toBe(false);
    expect(globsIntersect('', 'a')).toBe(false);
  });

  it('normalizes leading ./ and trailing /', () => {
    expect(globsIntersect('./src/hooks/', 'src/hooks')).toBe(true);
  });
});

describe('detectCollisions', () => {
  it('returns empty array when no stories overlap', () => {
    const stories = [
      { storyId: 'A', touchPoints: ['src/a.ts'] },
      { storyId: 'B', touchPoints: ['src/b.ts'] },
    ];
    expect(detectCollisions(stories)).toEqual([]);
  });

  it('reports a single pair for one overlapping touch-point', () => {
    const stories = [
      { storyId: 'A', touchPoints: ['src/hooks/*.ts'] },
      { storyId: 'B', touchPoints: ['src/hooks/use-costs.ts'] },
    ];
    const collisions = detectCollisions(stories);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].a).toBe('A');
    expect(collisions[0].b).toBe('B');
    expect(collisions[0].paths).toHaveLength(1);
  });

  it('finds all overlapping pairs in a 3-story epic', () => {
    const stories = [
      { storyId: 'A', touchPoints: ['src/hooks/*.ts'] },
      { storyId: 'B', touchPoints: ['src/hooks/use-costs.ts'] },
      { storyId: 'C', touchPoints: ['src/stores/auth-store.ts'] },
    ];
    const collisions = detectCollisions(stories);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ a: 'A', b: 'B' });
  });
});

describe('reassignWaves', () => {
  it('is a no-op when no collisions exist', () => {
    const stories = [
      { storyId: 'A', wave: 1, touchPoints: ['src/a.ts'] },
      { storyId: 'B', wave: 1, touchPoints: ['src/b.ts'] },
    ];
    const { stories: out, reassignments } = reassignWaves(stories);
    expect(reassignments).toEqual([]);
    expect(out.map((s) => s.wave)).toEqual([1, 1]);
  });

  it('bumps the lower-complexity story to next wave', () => {
    const stories = [
      { storyId: 'A', wave: 1, complexity: 'complex', touchPoints: ['src/hooks/*.ts'] },
      { storyId: 'B', wave: 1, complexity: 'standard', touchPoints: ['src/hooks/use-costs.ts'] },
    ];
    const { stories: out, reassignments } = reassignWaves(stories);
    expect(reassignments).toHaveLength(1);
    expect(reassignments[0].storyId).toBe('B');
    const byId = Object.fromEntries(out.map((s) => [s.storyId, s]));
    expect(byId.A.wave).toBe(1);
    expect(byId.B.wave).toBe(2);
  });

  it('preserves DAG order when dependsOn already separates the stories', () => {
    const stories = [
      { storyId: 'A', wave: 1, complexity: 'standard', touchPoints: ['src/hooks/*.ts'] },
      {
        storyId: 'B',
        wave: 2,
        complexity: 'standard',
        dependsOn: ['A'],
        touchPoints: ['src/hooks/use-costs.ts'],
      },
    ];
    const { stories: out, reassignments } = reassignWaves(stories);
    expect(reassignments).toEqual([]);
    expect(out.find((s) => s.storyId === 'B').wave).toBe(2);
  });

  it('re-normalizes wave numbers so there are no gaps', () => {
    const stories = [
      { storyId: 'A', wave: 1, complexity: 'complex', touchPoints: ['src/hooks/*.ts'] },
      { storyId: 'B', wave: 1, complexity: 'standard', touchPoints: ['src/hooks/use-costs.ts'] },
      { storyId: 'C', wave: 5, complexity: 'standard', touchPoints: ['src/stores/a.ts'] },
    ];
    const { stories: out } = reassignWaves(stories);
    const waves = out.map((s) => s.wave).sort();
    expect(new Set(waves).size).toBeLessThanOrEqual(3);
    expect(Math.min(...waves)).toBe(1);
    expect(Math.max(...waves)).toBeLessThanOrEqual(3);
  });

  it('flags Haiku-detected collisions with the haiku_flagged reason', () => {
    const stories = [
      {
        storyId: 'A',
        wave: 1,
        complexity: 'standard',
        collisionsWith: ['B'],
        touchPoints: ['src/hooks/*.ts'],
      },
      {
        storyId: 'B',
        wave: 1,
        complexity: 'standard',
        touchPoints: ['src/hooks/use-costs.ts'],
      },
    ];
    const { reassignments } = reassignWaves(stories);
    expect(reassignments).toHaveLength(1);
    expect(reassignments[0].reason).toBe('haiku_flagged');
  });

  it('is idempotent — running twice yields the same assignments', () => {
    const stories = [
      { storyId: 'A', wave: 1, complexity: 'complex', touchPoints: ['src/hooks/*.ts'] },
      { storyId: 'B', wave: 1, complexity: 'standard', touchPoints: ['src/hooks/use-costs.ts'] },
    ];
    const first = reassignWaves(stories).stories;
    const second = reassignWaves(first).stories;
    expect(second.map((s) => s.wave)).toEqual(first.map((s) => s.wave));
  });

  it('tie-breaks equal complexity by bumping the later-indexed story', () => {
    const stories = [
      { storyId: 'A', wave: 1, complexity: 'standard', touchPoints: ['src/hooks/*.ts'] },
      { storyId: 'B', wave: 1, complexity: 'standard', touchPoints: ['src/hooks/use-costs.ts'] },
    ];
    const { reassignments } = reassignWaves(stories);
    expect(reassignments).toHaveLength(1);
    expect(reassignments[0].storyId).toBe('B');
  });

  it('does not bump when stories are already on different waves', () => {
    const stories = [
      { storyId: 'A', wave: 1, complexity: 'standard', touchPoints: ['src/hooks/*.ts'] },
      { storyId: 'B', wave: 2, complexity: 'standard', touchPoints: ['src/hooks/use-costs.ts'] },
    ];
    const { reassignments } = reassignWaves(stories);
    expect(reassignments).toEqual([]);
  });
});
