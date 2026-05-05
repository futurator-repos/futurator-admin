import type { EpicStory } from '../types/epic-workflow';

/**
 * Topologically sort stories by their `dependsOn` graph and assign a wave
 * number to each. Mirrors `computePlanWaves` (for epics) one level down.
 *
 * Wave 0 = stories with no `dependsOn` (or empty array).
 * Wave N = `1 + max(wave of each dep)`.
 *
 * Returns a Map keyed by `storyId`. Unknown/invalid deps are ignored so stale
 * dep references from legacy data don't crash wave assignment.
 *
 * Waves are the primary parallelization knob: all stories in a wave can run
 * concurrently, saving wall-clock time proportional to wave width. Aggressive
 * fan-out in wave 1 (many independent stories sharing a common scaffold in
 * wave 0) is usually the right shape.
 */
export function computeStoryWaves(stories: Pick<EpicStory, 'storyId' | 'dependsOn'>[]): Map<string, number> {
  const waveCache = new Map<string, number>();
  const storyById = new Map(stories.map((s) => [s.storyId, s]));

  function walk(id: string, visited = new Set<string>()): number {
    if (waveCache.has(id)) return waveCache.get(id)!;
    if (visited.has(id)) return 0; // cycle safety — cap at 0
    visited.add(id);
    const story = storyById.get(id);
    if (!story || !story.dependsOn || story.dependsOn.length === 0) {
      waveCache.set(id, 0);
      return 0;
    }
    const depWaves = story.dependsOn
      .filter((d) => storyById.has(d))
      .map((d) => walk(d, visited));
    const wave = depWaves.length === 0 ? 0 : Math.max(...depWaves) + 1;
    waveCache.set(id, wave);
    return wave;
  }

  for (const story of stories) walk(story.storyId);
  return waveCache;
}

/**
 * Return a new list of stories with `wave` set on each. Pure — doesn't mutate.
 */
export function assignStoryWaves<T extends Pick<EpicStory, 'storyId' | 'dependsOn'>>(
  stories: T[],
): (T & { wave: number })[] {
  const waves = computeStoryWaves(stories);
  return stories.map((s) => ({ ...s, wave: waves.get(s.storyId) ?? 0 }));
}

/** Group stories by their wave number. */
export function groupByWave<T extends { wave?: number }>(
  stories: T[],
): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const s of stories) {
    const w = s.wave ?? 0;
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w)!.push(s);
  }
  return groups;
}
