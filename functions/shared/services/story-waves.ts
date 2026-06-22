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
 *
 * D3-2 (2026-06-22) — collision detection unions each story's DECLARED
 * `touchPoints` with its MEASURED `actualTouchPoints` (the files its DEV agent
 * actually edited on a prior run, recorded by the dev-scope gate). So two
 * siblings that BOTH edited an undeclared shared file (pacmanv3: `pacman.ts`)
 * are serialized on the NEXT wave computation — turning the merge-time collision
 * the PM under-declared into a scheduler-time serialization. The union only
 * adds constraints (more serialization of genuine collisions); it never lowers
 * parallelism of stories that don't actually share a file.
 */
export function computeStoryWavesWithTouchPoints(
  stories: Array<
    Pick<EpicStory, 'storyId' | 'dependsOn'> & {
      touchPoints?: string[];
      actualTouchPoints?: string[];
      order?: number;
    }
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
    // D3-2 — union DECLARED + MEASURED touch points for collision detection.
    const raw = [...(story.touchPoints ?? []), ...(story.actualTouchPoints ?? [])]
      .map(normalize)
      .filter(Boolean);
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

/**
 * D3-2 (2026-06-22) — the mid-plan re-serialize CONSUMER (TS side, called from
 * the wave launcher). Recompute the ideal wave assignment honoring DECLARED ∪
 * MEASURED touch points (`computeStoryWavesWithTouchPoints` unions
 * `actualTouchPoints`), then apply the new wave ONLY to a still-reassignable
 * story (pending/draft/unset status) and ONLY when it moves FORWARD. This:
 *   - serializes a still-pending sibling that now collides on a file neither
 *     declared (the recorded actual edits finally change behavior);
 *   - NEVER yanks a running/done story back, and never pulls a pending story
 *     into an already-dispatched earlier wave (forward-only guard).
 *
 * No-op on a fresh plan (no story has `actualTouchPoints` until the dev-scope
 * gate records one), so first-launch behavior is byte-identical. Only a
 * re-launch after a prior run's measurements can change anything.
 *
 * @returns the (possibly) re-waved stories + the list of stories that moved.
 */
export function recomputePendingStoryWaves<
  T extends Pick<EpicStory, 'storyId' | 'dependsOn'> & {
    wave?: number;
    status?: string;
    touchPoints?: string[];
    actualTouchPoints?: string[];
    order?: number;
  },
>(
  stories: T[],
): { stories: T[]; changed: { storyId: string; fromWave: number; toWave: number }[] } {
  if (!Array.isArray(stories) || stories.length === 0) {
    return { stories: stories ?? [], changed: [] };
  }
  // Gate on MEASURED data: only re-serialize when at least one story has a
  // recorded actualTouchPoints set. Without that, a from-scratch recompute would
  // re-litigate DECLARED-touch-point waves that plan-apply already decided
  // (e.g. intentionally co-scheduled stories), changing behavior for no reason.
  // The whole point of D3-2 is to act on NEW (measured) collision info only.
  const hasMeasured = stories.some(
    (s) => Array.isArray(s.actualTouchPoints) && s.actualTouchPoints.length > 0,
  );
  if (!hasMeasured) {
    return { stories, changed: [] };
  }
  const ideal = computeStoryWavesWithTouchPoints(
    stories.map((s, i) => ({
      storyId: s.storyId,
      dependsOn: s.dependsOn ?? [],
      touchPoints: s.touchPoints,
      actualTouchPoints: s.actualTouchPoints,
      order: s.order ?? i,
    })),
  );
  const reassignable = (s: T) =>
    s.status === undefined || s.status === null || s.status === 'pending' || s.status === 'draft';

  const changed: { storyId: string; fromWave: number; toWave: number }[] = [];
  const out = stories.map((s) => {
    const cur = s.wave ?? 0;
    const next = ideal.get(s.storyId) ?? cur;
    // Forward-only, reassignable-only: never pull a story earlier, never move a
    // running/done one.
    if (reassignable(s) && next > cur) {
      changed.push({ storyId: s.storyId, fromWave: cur, toWave: next });
      return { ...s, wave: next };
    }
    return s;
  });
  return { stories: out, changed };
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
