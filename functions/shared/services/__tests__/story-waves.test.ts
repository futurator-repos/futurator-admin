import { describe, it, expect } from 'vitest';
import { computeStoryWaves, assignStoryWaves, groupByWave } from '../story-waves';

function s(id: string, deps: string[] = []) {
  return { storyId: id, dependsOn: deps };
}

describe('computeStoryWaves', () => {
  it('assigns wave 0 to stories with no dependsOn', () => {
    const waves = computeStoryWaves([s('A'), s('B')]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(0);
  });

  it('stacks waves linearly: A → B → C', () => {
    const waves = computeStoryWaves([s('A'), s('B', ['A']), s('C', ['B'])]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(1);
    expect(waves.get('C')).toBe(2);
  });

  it('handles diamond: A → B, A → C, (B,C) → D', () => {
    const waves = computeStoryWaves([s('A'), s('B', ['A']), s('C', ['A']), s('D', ['B', 'C'])]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(1);
    expect(waves.get('C')).toBe(1);
    expect(waves.get('D')).toBe(2);
  });

  it('parallelism example: scaffold (wave 0) then 3 parallel features (wave 1) then assembly (wave 2)', () => {
    const stories = [
      s('scaffold'),
      s('physics', ['scaffold']),
      s('loop', ['scaffold']),
      s('input', ['scaffold']),
      s('assembly', ['physics', 'loop', 'input']),
    ];
    const waves = computeStoryWaves(stories);
    expect(waves.get('scaffold')).toBe(0);
    expect(waves.get('physics')).toBe(1);
    expect(waves.get('loop')).toBe(1);
    expect(waves.get('input')).toBe(1);
    expect(waves.get('assembly')).toBe(2);
  });

  it('ignores unknown dep references (defensive)', () => {
    const waves = computeStoryWaves([s('A', ['MISSING'])]);
    expect(waves.get('A')).toBe(0);
  });

  it('handles cycles without infinite loop', () => {
    const waves = computeStoryWaves([s('A', ['B']), s('B', ['A'])]);
    // Cycle detection returns 0 (we don't throw — stay resilient).
    expect(waves.get('A')).toBeDefined();
    expect(waves.get('B')).toBeDefined();
  });
});

describe('assignStoryWaves', () => {
  it('returns new stories array with wave set, without mutating input', () => {
    const input = [s('A'), s('B', ['A'])];
    const out = assignStoryWaves(input);
    expect(out[0].wave).toBe(0);
    expect(out[1].wave).toBe(1);
    // Original untouched
    expect((input[0] as unknown as { wave?: number }).wave).toBeUndefined();
  });
});

describe('groupByWave', () => {
  it('groups stories into a wave→list map', () => {
    const stories = [
      { storyId: 'A', wave: 0 },
      { storyId: 'B', wave: 1 },
      { storyId: 'C', wave: 1 },
      { storyId: 'D', wave: 2 },
    ];
    const groups = groupByWave(stories);
    expect(groups.get(0)).toHaveLength(1);
    expect(groups.get(1)).toHaveLength(2);
    expect(groups.get(2)).toHaveLength(1);
  });
});

// pacman1 disease (2026-06-11) — touch-point collision serialization.
import { computeStoryWavesWithTouchPoints } from '../story-waves';

describe('computeStoryWavesWithTouchPoints', () => {
  const st = (
    storyId: string,
    dependsOn: string[] = [],
    touchPoints: string[] = [],
    order = 0,
  ) => ({ storyId, dependsOn, touchPoints, order });

  it('keeps disjoint siblings parallel (pure dependsOn behavior preserved)', () => {
    const waves = computeStoryWavesWithTouchPoints([
      st('A', [], ['src/a.ts'], 0),
      st('B', [], ['src/b.ts'], 1),
      st('C', ['A'], ['src/c.ts'], 2),
    ]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(0);
    expect(waves.get('C')).toBe(1);
  });

  it('serializes siblings that declare the same file', () => {
    const waves = computeStoryWavesWithTouchPoints([
      st('A', [], ['src/game/types.ts', 'src/a.ts'], 0),
      st('B', [], ['src/game/types.ts', 'src/b.ts'], 1),
    ]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(1); // bumped — collides on types.ts
  });

  it('cascades: a bumped story still lands after its dependents are re-checked', () => {
    // B collides with A → wave 1. C depends on B → must be ≥ 2 even though
    // its topological wave (dependsOn only) would be 1.
    const waves = computeStoryWavesWithTouchPoints([
      st('A', [], ['src/shared.ts'], 0),
      st('B', [], ['src/shared.ts'], 1),
      st('C', ['B'], ['src/c.ts'], 2),
    ]);
    expect(waves.get('B')).toBe(1);
    expect(waves.get('C')).toBe(2);
  });

  it('<EPIC_WIDE> stories get a wave entirely to themselves', () => {
    const waves = computeStoryWavesWithTouchPoints([
      st('A', [], ['src/a.ts'], 0),
      st('WIDE', [], ['<EPIC_WIDE>'], 1),
      st('B', [], ['src/b.ts'], 2),
    ]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('WIDE')).toBe(1); // wave 0 occupied → alone in wave 1
    expect(waves.get('B')).toBe(0); // disjoint with A, fits wave 0
    // nothing shares the WIDE wave
    const inWideWave = ['A', 'B'].filter((id) => waves.get(id) === waves.get('WIDE'));
    expect(inWideWave).toHaveLength(0);
  });

  it('stories with empty touchPoints carry no collision info (legacy plans)', () => {
    const waves = computeStoryWavesWithTouchPoints([st('A', [], [], 0), st('B', [], [], 1)]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(0);
  });

  it('normalizes ./ prefixes when comparing paths', () => {
    const waves = computeStoryWavesWithTouchPoints([
      st('A', [], ['./src/x.ts'], 0),
      st('B', [], ['src/x.ts'], 1),
    ]);
    expect(waves.get('B')).toBe(1);
  });

  it('is deterministic by (dependency wave, declaration order)', () => {
    const run = () =>
      computeStoryWavesWithTouchPoints([
        st('B', [], ['src/x.ts'], 1),
        st('A', [], ['src/x.ts'], 0),
      ]);
    expect(run().get('A')).toBe(0);
    expect(run().get('B')).toBe(1);
  });

  // D3-2 (2026-06-22) — collision detection unions DECLARED touchPoints with
  // MEASURED actualTouchPoints, so two siblings that both edited an undeclared
  // shared file (the pacmanv3 pacman.ts collision) serialize on the next run.
  it('serializes siblings that collide only on actualTouchPoints (D3-2)', () => {
    const waves = computeStoryWavesWithTouchPoints([
      // Disjoint DECLARED scopes — would run parallel under declared-only.
      {
        storyId: 'A',
        dependsOn: [],
        touchPoints: ['src/a.ts'],
        actualTouchPoints: ['src/game/pacman.ts'],
        order: 0,
      },
      {
        storyId: 'B',
        dependsOn: [],
        touchPoints: ['src/b.ts'],
        actualTouchPoints: ['src/game/pacman.ts'],
        order: 1,
      },
    ]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(1); // bumped — they actually both touch pacman.ts
  });

  it('serializes when one declares the file and the other only measured it (D3-2)', () => {
    const waves = computeStoryWavesWithTouchPoints([
      { storyId: 'A', dependsOn: [], touchPoints: ['src/shared.ts'], order: 0 },
      {
        storyId: 'B',
        dependsOn: [],
        touchPoints: ['src/b.ts'],
        actualTouchPoints: ['src/shared.ts'],
        order: 1,
      },
    ]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(1);
  });

  it('does NOT lower parallelism when actual sets are disjoint (D3-2 safety)', () => {
    const waves = computeStoryWavesWithTouchPoints([
      {
        storyId: 'A',
        dependsOn: [],
        touchPoints: ['src/a.ts'],
        actualTouchPoints: ['src/a.ts', 'src/util.ts'],
        order: 0,
      },
      {
        storyId: 'B',
        dependsOn: [],
        touchPoints: ['src/b.ts'],
        actualTouchPoints: ['src/b.ts'],
        order: 1,
      },
    ]);
    expect(waves.get('A')).toBe(0);
    expect(waves.get('B')).toBe(0); // genuinely disjoint → stay parallel
  });
});

import { recomputePendingStoryWaves } from '../story-waves';

describe('recomputePendingStoryWaves — D3-2 mid-plan re-serialize consumer (TS)', () => {
  it('is a no-op on a fresh plan (no actualTouchPoints recorded yet)', () => {
    const stories = [
      { storyId: 'A', dependsOn: [], wave: 0, status: 'pending', touchPoints: ['src/a.ts'] },
      { storyId: 'B', dependsOn: [], wave: 0, status: 'pending', touchPoints: ['src/b.ts'] },
    ];
    const { changed } = recomputePendingStoryWaves(stories);
    expect(changed).toEqual([]);
  });

  it('bumps a still-pending sibling that now collides on a measured file', () => {
    const stories = [
      {
        storyId: 'A',
        dependsOn: [],
        wave: 0,
        status: 'pending',
        touchPoints: ['src/a.ts'],
        actualTouchPoints: ['src/game/pacman.ts'],
        order: 0,
      },
      {
        storyId: 'B',
        dependsOn: [],
        wave: 0,
        status: 'pending',
        touchPoints: ['src/b.ts'],
        actualTouchPoints: ['src/game/pacman.ts'],
        order: 1,
      },
    ];
    const { stories: out, changed } = recomputePendingStoryWaves(stories);
    expect(changed).toHaveLength(1);
    expect(changed[0].storyId).toBe('B'); // later-ordered sibling bumps
    expect(changed[0].toWave).toBeGreaterThan(changed[0].fromWave);
    const byId = Object.fromEntries(out.map((s) => [s.storyId, s]));
    expect(byId.A.wave).toBe(0);
    expect(byId.B.wave).toBe(1);
  });

  it('never moves a done/running story and never pulls a pending one earlier (forward-only)', () => {
    // A already ran on wave 0 (done). B is pending, parked on wave 1, and its
    // ideal recompute would be wave 0 (no real collision) — but it must NOT be
    // pulled back into the already-dispatched wave 0.
    const stories = [
      { storyId: 'A', dependsOn: [], wave: 0, status: 'done', touchPoints: ['src/a.ts'] },
      { storyId: 'B', dependsOn: [], wave: 1, status: 'pending', touchPoints: ['src/b.ts'] },
    ];
    const { stories: out, changed } = recomputePendingStoryWaves(stories);
    expect(changed).toEqual([]); // B stays at wave 1 (forward-only)
    const byId = Object.fromEntries(out.map((s) => [s.storyId, s]));
    expect(byId.A.wave).toBe(0);
    expect(byId.B.wave).toBe(1);
  });
});
