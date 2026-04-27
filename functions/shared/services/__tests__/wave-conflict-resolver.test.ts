import { describe, it, expect } from 'vitest';
import {
  resolveWaves,
  assertWaveScopeNonOverlapping,
  collectIntraWaveConflicts,
  normalizeTouchPoints,
  TOUCH_POINTS_EPIC_WIDE,
  TOUCH_POINTS_UNKNOWN,
} from '../wave-conflict-resolver';

const story = (id: string, touchPoints: string[]) => ({ storyId: id, touchPoints });

describe('resolveWaves — greedy assignment', () => {
  it('places non-conflicting stories in wave 0', () => {
    const out = resolveWaves([
      story('S-1', ['src/main.js']),
      story('S-2', ['src/dino.js']),
      story('S-3', ['src/obstacle.js']),
    ]);
    expect(out.map((r) => r.wave)).toEqual([0, 0, 0]);
    expect(out.every((r) => r.reason === 'no-conflict')).toBe(true);
  });

  it('serialises stories that share a touchPoint into successive waves', () => {
    // dino3 e2w0: 4 stories all touching main.js → must run sequentially
    const out = resolveWaves([
      story('S-1', ['src/main.js']),
      story('S-2', ['src/main.js']),
      story('S-3', ['src/main.js']),
      story('S-4', ['src/main.js']),
    ]);
    expect(out.map((r) => r.wave)).toEqual([0, 1, 2, 3]);
    expect(out.slice(1).every((r) => r.reason === 'conflict-serialised')).toBe(true);
  });

  it('respects glob intersection (src/** vs src/components/foo.tsx)', () => {
    const out = resolveWaves([
      story('S-1', ['src/components/foo.tsx']),
      story('S-2', ['src/**/*.tsx']),
    ]);
    expect(out[0].wave).toBe(0);
    expect(out[1].wave).toBe(1);
    expect(out[1].reason).toBe('conflict-serialised');
  });

  it('<EPIC_WIDE> sentinel always grabs an exclusive wave', () => {
    const out = resolveWaves([
      story('S-1', ['src/foo.js']),
      story('S-2', [TOUCH_POINTS_EPIC_WIDE]),
      story('S-3', ['src/bar.js']),
    ]);
    expect(out[0].wave).toBe(0);
    expect(out[1].wave).toBe(1);
    expect(out[1].reason).toBe('epic-wide-isolated');
    // S-3 cannot share wave 1 (epic-wide is exclusive) but back-fills to wave 0
    // since src/bar.js doesn't collide with S-1's src/foo.js.
    expect(out[2].wave).toBe(0);
    expect(out[2].reason).toBe('no-conflict');
  });

  it('<EPIC_WIDE> blocks back-fill past it for stories that DO collide with wave 0', () => {
    const out = resolveWaves([
      story('S-1', ['src/main.js']),
      story('S-2', [TOUCH_POINTS_EPIC_WIDE]),
      story('S-3', ['src/main.js']), // collides with S-1; can't share wave 1 either
    ]);
    expect(out.map((r) => r.wave)).toEqual([0, 1, 2]);
  });

  it('<UNKNOWN> sentinel (legacy story) is wave-isolated', () => {
    const out = resolveWaves([
      story('S-1', ['src/foo.js']),
      { storyId: 'S-LEGACY', touchPoints: undefined },
      story('S-3', ['src/bar.js']),
    ]);
    expect(out[1].reason).toBe('unknown-isolated');
    expect(out[1].wave).not.toBe(out[0].wave); // legacy gets its own wave
    // S-3 back-fills to wave 0 (no collision with S-1's src/foo.js).
    expect(out[2].wave).toBe(0);
  });

  it('back-fills earlier waves when a later story has no conflict there', () => {
    // S-1 → main.js (wave 0)
    // S-2 → main.js (wave 1)
    // S-3 → dino.js (back-fills wave 0, since wave 0 only has main.js)
    const out = resolveWaves([
      story('S-1', ['src/main.js']),
      story('S-2', ['src/main.js']),
      story('S-3', ['src/dino.js']),
    ]);
    expect(out.map((r) => `${r.story.storyId}:${r.wave}`)).toEqual(['S-1:0', 'S-2:1', 'S-3:0']);
  });

  it('handles empty input', () => {
    expect(resolveWaves([])).toEqual([]);
  });

  it('handles missing / null touchPoints as <UNKNOWN>', () => {
    const out = resolveWaves([
      { storyId: 'S-A', touchPoints: null },
      { storyId: 'S-B', touchPoints: [] },
    ]);
    expect(out.every((r) => r.reason === 'unknown-isolated')).toBe(true);
  });
});

describe('collectIntraWaveConflicts — defensive runtime check', () => {
  it('returns [] when no stories share touchPoints', () => {
    const conflicts = collectIntraWaveConflicts([
      story('S-1', ['src/a.js']),
      story('S-2', ['src/b.js']),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('reports the exact storyId pair + colliding paths', () => {
    const conflicts = collectIntraWaveConflicts([
      story('S-1', ['src/main.js']),
      story('S-2', ['src/main.js', 'src/extra.js']),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].a).toBe('S-1');
    expect(conflicts[0].b).toBe('S-2');
    expect(conflicts[0].paths.some((p) => p.includes('main.js'))).toBe(true);
  });

  it('flags <EPIC_WIDE> against any sibling as a conflict', () => {
    const conflicts = collectIntraWaveConflicts([
      story('S-1', [TOUCH_POINTS_EPIC_WIDE]),
      story('S-2', ['src/anything.js']),
    ]);
    expect(conflicts).toHaveLength(1);
  });
});

describe('assertWaveScopeNonOverlapping', () => {
  it('does not throw for a clean wave', () => {
    expect(() =>
      assertWaveScopeNonOverlapping([story('S-1', ['a.js']), story('S-2', ['b.js'])]),
    ).not.toThrow();
  });

  it('throws a structured error with code=wave-conflict', () => {
    let caught: (Error & { code?: string; conflicts?: unknown }) | null = null;
    try {
      assertWaveScopeNonOverlapping([story('S-1', ['src/main.js']), story('S-2', ['src/main.js'])]);
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('wave-conflict');
    expect(caught?.message).toMatch(/Wave conflict/);
    expect(caught?.message).toContain('S-1');
    expect(caught?.message).toContain('S-2');
  });
});

describe('normalizeTouchPoints', () => {
  it('returns ["<UNKNOWN>"] for null / undefined / empty', () => {
    expect(normalizeTouchPoints(null)).toEqual([TOUCH_POINTS_UNKNOWN]);
    expect(normalizeTouchPoints(undefined)).toEqual([TOUCH_POINTS_UNKNOWN]);
    expect(normalizeTouchPoints([])).toEqual([TOUCH_POINTS_UNKNOWN]);
  });

  it('strips empty strings and falsy entries', () => {
    expect(normalizeTouchPoints(['', 'src/a.js', ''])).toEqual(['src/a.js']);
  });

  it('collapses to <UNKNOWN> when only empty strings provided', () => {
    expect(normalizeTouchPoints(['', ''])).toEqual([TOUCH_POINTS_UNKNOWN]);
  });
});
