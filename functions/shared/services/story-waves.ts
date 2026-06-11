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
export function computeStoryWaves(
  stories: Pick<EpicStory, 'storyId' | 'dependsOn'>[],
): Map<string, number> {
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
    const depWaves = story.dependsOn.filter((d) => storyById.has(d)).map((d) => walk(d, visited));
    const wave = depWaves.length === 0 ? 0 : Math.max(...depWaves) + 1;
    waveCache.set(id, wave);
    return wave;
  }

  for (const story of stories) walk(story.storyId);
  return waveCache;
}

/**
 * pacman1 disease (2026-06-11) — touch-point collision serialization.
 *
 * `computeStoryWaves` parallelizes purely on `dependsOn`, so two siblings
 * that both declared the same file landed in the same wave and collided at
 * the merge gate (the BMAD create-epics-and-stories contract promised this
 * serialization existed; it never did). This pass assigns each story the
 * EARLIEST wave that satisfies BOTH constraints:
 *
 *   1. dependency order — strictly after every effective dep wave;
 *   2. touch-point disjointness — no two stories in one wave share a
 *      declared file path, and a `<EPIC_WIDE>` story (cross-cutting, no
 *      precise file set) gets a wave entirely to itself.
 *
 * Stories with EMPTY touchPoints carry no collision information and only
 * obey constraint 1 (legacy plans / hand-written imports stay valid).
 * Deterministic: stories are placed in (dependency-wave, declaration-order)
 * order, so the same plan always serializes the same way.
 */
export function computeStoryWavesWithTouchPoints(
  stories: Array<
    Pick<EpicStory, 'storyId' | 'dependsOn'> & { touchPoints?: string[]; order?: number }
  >,
  opts: { epicWideSentinel?: string } = {},
): Map<string, number> {
  const sentinel = opts.epicWideSentinel ?? '<EPIC_WIDE>';
  const depWaves = computeStoryWaves(stories);

  const normalize = (p: string) => p.trim().replace(/^\.\//, '');
  const placed = new Map<string, number>();
  const claims = new Map<number, { paths: Set<string>; epicWide: boolean; count: number }>();

  const claimFor = (w: number) => {
    if (!claims.has(w)) claims.set(w, { paths: new Set(), epicWide: false, count: 0 });
    return claims.get(w)!;
  };

  const sorted = [...stories].sort((a, b) => {
    const dw = (depWaves.get(a.storyId) ?? 0) - (depWaves.get(b.storyId) ?? 0);
    if (dw !== 0) return dw;
    return (a.order ?? 0) - (b.order ?? 0);
  });

  for (const story of sorted) {
    const raw = (story.touchPoints ?? []).map(normalize).filter(Boolean);
    const isEpicWide = raw.includes(sentinel);
    const paths = raw.filter((p) => p !== sentinel);

    // Constraint 1 — strictly after every dep's EFFECTIVE (post-bump) wave.
    let w = 0;
    for (const dep of story.dependsOn ?? []) {
      const depWave = placed.get(dep);
      if (depWave !== undefined) w = Math.max(w, depWave + 1);
    }

    // Constraint 2 — earliest non-colliding wave from there.
    const collides = (wave: number): boolean => {
      const c = claims.get(wave);
      if (!c) return false;
      if (c.epicWide) return true;
      if (isEpicWide) return c.count > 0;
      for (const p of paths) if (c.paths.has(p)) return true;
      return false;
    };
    while (collides(w)) w += 1;

    placed.set(story.storyId, w);
    const c = claimFor(w);
    c.count += 1;
    if (isEpicWide) c.epicWide = true;
    for (const p of paths) c.paths.add(p);
  }

  return placed;
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
export function groupByWave<T extends { wave?: number }>(stories: T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const s of stories) {
    const w = s.wave ?? 0;
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w)!.push(s);
  }
  return groups;
}
