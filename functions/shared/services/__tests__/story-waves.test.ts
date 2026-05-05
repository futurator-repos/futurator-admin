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
    const waves = computeStoryWaves([
      s('A'),
      s('B', ['A']),
      s('C', ['A']),
      s('D', ['B', 'C']),
    ]);
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
