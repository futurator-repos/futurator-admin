/**
 * Wave-conflict resolver — Epic D.3 (pipeline-v1 dev correction).
 *
 * Builds a wave assignment from a story list using a deterministic greedy
 * algorithm: each story is placed in the earliest wave where no already-
 * placed sibling shares a `touchPoint`. Two sentinel values:
 *
 *   • `'<EPIC_WIDE>'`  — cross-cutting refactor / integration story. Always
 *                        gets its own wave; nothing else may share it.
 *   • `'<UNKNOWN>'`    — legacy story without declared touchPoints. Treated
 *                        as wave-isolated (its own wave) to be safe — we
 *                        cannot prove it does not collide with siblings.
 *
 * Companion module to `daemon/pipelines/lib/glob-intersect.mjs`. That module
 * exists in the daemon's runtime where the touch-point inference pipeline
 * runs Haiku and bumps stories on the fly. This TS module exists so the API
 * Lambda + plan reducer can serialize conflicts at plan-build time without
 * crossing into the daemon. The two implementations share intent but live
 * at different layers:
 *
 *   inference-time (daemon)  ─→ `reassignWaves` (bumps in place)
 *   plan-build-time (lambda) ─→ `resolveWaves`  (assigns from scratch)
 *   launch-time (lambda)     ─→ `assertWaveScopeNonOverlapping` (defensive)
 */

/** Sentinel: story is cross-cutting and always serialised to its own wave. */
export const TOUCH_POINTS_EPIC_WIDE = '<EPIC_WIDE>';

/** Sentinel: legacy story without declared touchPoints. Treated as wave-isolated. */
export const TOUCH_POINTS_UNKNOWN = '<UNKNOWN>';

/** Public input shape — only the fields the resolver needs. */
export interface ResolverStory {
  storyId: string;
  /** Declared touchPoints. Empty / missing → treated as `['<UNKNOWN>']`. */
  touchPoints?: string[] | null;
  /**
   * Optional pre-existing wave (e.g. from the touch-point inference pipeline
   * or a prior `resolveWaves` call). Ignored — the resolver always assigns
   * waves from scratch. Carried forward in the output for back-references.
   */
  wave?: number;
}

export interface ResolvedStory<S extends ResolverStory> {
  story: S;
  wave: number;
  /** Why the story landed in this wave (debug aid + observability). */
  reason: 'no-conflict' | 'epic-wide-isolated' | 'unknown-isolated' | 'conflict-serialised';
  /** When `reason === 'conflict-serialised'`, the touchPoint(s) that forced the bump. */
  conflictPaths?: string[];
}

export interface WaveConflict {
  a: string;
  b: string;
  paths: string[];
}

/**
 * Greedy wave assignment. Same input → same output (deterministic order is
 * the input array order; ties resolve by storyId for stability).
 *
 * @param stories - ordered list of stories to place into waves
 * @returns one ResolvedStory per input story, in the same order
 */
export function resolveWaves<S extends ResolverStory>(stories: S[]): Array<ResolvedStory<S>> {
  if (!Array.isArray(stories) || stories.length === 0) return [];

  // Per-wave occupied touchPoint set. wave 0 = first slot.
  const waveTouchPoints: string[][] = [];
  const out: Array<ResolvedStory<S>> = [];

  for (const story of stories) {
    const tp = normalizeTouchPoints(story.touchPoints);

    // Sentinels always grab a fresh wave at the back of the line.
    if (tp.length === 1 && tp[0] === TOUCH_POINTS_EPIC_WIDE) {
      const wave = waveTouchPoints.length;
      waveTouchPoints.push(tp);
      out.push({ story, wave, reason: 'epic-wide-isolated' });
      continue;
    }
    if (tp.length === 1 && tp[0] === TOUCH_POINTS_UNKNOWN) {
      const wave = waveTouchPoints.length;
      waveTouchPoints.push(tp);
      out.push({ story, wave, reason: 'unknown-isolated' });
      continue;
    }

    // Find earliest wave where no occupied touchPoint intersects this story.
    let placed = false;
    for (let w = 0; w < waveTouchPoints.length; w++) {
      const occupied = waveTouchPoints[w];
      if (occupied.some((o) => o === TOUCH_POINTS_EPIC_WIDE || o === TOUCH_POINTS_UNKNOWN)) {
        continue; // sentinel waves are exclusive
      }
      const conflicts: string[] = [];
      for (const o of occupied) {
        for (const t of tp) {
          if (touchPointsCollide(o, t)) conflicts.push(`${o} ∩ ${t}`);
        }
      }
      if (conflicts.length === 0) {
        waveTouchPoints[w] = [...occupied, ...tp];
        out.push({ story, wave: w, reason: 'no-conflict' });
        placed = true;
        break;
      }
    }
    if (!placed) {
      const wave = waveTouchPoints.length;
      waveTouchPoints.push([...tp]);
      const reason: ResolvedStory<S>['reason'] = wave === 0 ? 'no-conflict' : 'conflict-serialised';
      out.push({
        story,
        wave,
        reason,
      });
    }
  }

  return out;
}

/**
 * Defensive runtime check used by `launchPipelineWave`: assert no two of the
 * stories about to launch share a touchPoint. Throws a structured error so
 * the launcher can surface it as an attention item.
 *
 * @param waveStories - stories the launcher is about to dispatch in this wave
 * @throws Error with `code: 'wave-conflict'` on overlap
 */
export function assertWaveScopeNonOverlapping(waveStories: ResolverStory[]): void {
  const conflicts = collectIntraWaveConflicts(waveStories);
  if (conflicts.length === 0) return;
  const first = conflicts[0];
  const e = new Error(
    `Wave conflict: stories ${first.a} and ${first.b} both touch ${first.paths.join(', ')}. They must be in different waves.`,
  ) as Error & { code: string; conflicts: WaveConflict[] };
  e.code = 'wave-conflict';
  e.conflicts = conflicts;
  throw e;
}

/**
 * Pure helper — useful for tests and the launcher's defensive check.
 * @returns every pair of stories whose touchPoints intersect.
 */
export function collectIntraWaveConflicts(stories: ResolverStory[]): WaveConflict[] {
  const out: WaveConflict[] = [];
  for (let i = 0; i < stories.length; i++) {
    for (let j = i + 1; j < stories.length; j++) {
      const a = normalizeTouchPoints(stories[i].touchPoints);
      const b = normalizeTouchPoints(stories[j].touchPoints);
      // Sentinel-bearing stories should never be in the same wave; if they are
      // (caller bug), surface it rather than silently letting it through.
      const paths: string[] = [];
      for (const pa of a) {
        for (const pb of b) {
          if (
            pa === TOUCH_POINTS_EPIC_WIDE ||
            pb === TOUCH_POINTS_EPIC_WIDE ||
            pa === TOUCH_POINTS_UNKNOWN ||
            pb === TOUCH_POINTS_UNKNOWN ||
            touchPointsCollide(pa, pb)
          ) {
            paths.push(`${pa} ∩ ${pb}`);
          }
        }
      }
      if (paths.length > 0) {
        out.push({ a: stories[i].storyId, b: stories[j].storyId, paths });
      }
    }
  }
  return out;
}

/**
 * Backwards-compat normalisation: missing / empty touchPoints → ['<UNKNOWN>'].
 * Public so callers (planner, plan-reducer) can use the same rule.
 */
export function normalizeTouchPoints(input: string[] | null | undefined): string[] {
  if (!Array.isArray(input) || input.length === 0) return [TOUCH_POINTS_UNKNOWN];
  const filtered = input.filter((s) => typeof s === 'string' && s.length > 0);
  if (filtered.length === 0) return [TOUCH_POINTS_UNKNOWN];
  return filtered;
}

// ─── Internals ───

/**
 * Conservative literal+wildcard collision test. Mirrors the daemon's
 * `globsIntersect` semantics without importing across the daemon boundary —
 * keeps the API Lambda free of `.mjs` runtime deps.
 *
 * Rules:
 *   - Identical literals collide.
 *   - `<EPIC_WIDE>` and `<UNKNOWN>` collide with everything (handled by caller).
 *   - `*` wildcards collide with anything in the same path segment.
 *   - `**` collides with any path on either side of it.
 *   - Different file extensions on otherwise-wildcard segments do NOT collide.
 */
function touchPointsCollide(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === b) return true;
  return segmentsCollide(normalize(a).split('/'), normalize(b).split('/'));
}

function normalize(glob: string): string {
  return glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function segmentsCollide(a: string[], b: string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0) return b.every((s) => s === '**');
  if (b.length === 0) return a.every((s) => s === '**');

  const a0 = a[0];
  const b0 = b[0];

  if (a0 === '**') return segmentsCollide(a.slice(1), b) || segmentsCollide(a, b.slice(1));
  if (b0 === '**') return segmentsCollide(a, b.slice(1)) || segmentsCollide(a.slice(1), b);

  if (segmentCollide(a0, b0)) return segmentsCollide(a.slice(1), b.slice(1));
  return false;
}

function segmentCollide(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '*' || b === '*') return true;

  const aWild = a.includes('*');
  const bWild = b.includes('*');
  if (!aWild && !bWild) return false;
  if (!aWild) return segmentToRegex(b).test(a);
  if (!bWild) return segmentToRegex(a).test(b);

  // Both wildcard: extension must not explicitly conflict.
  const aExt = extractExt(a);
  const bExt = extractExt(b);
  if (aExt && bExt && aExt !== bExt) return false;
  return true;
}

function segmentToRegex(seg: string): RegExp {
  let re = '';
  for (const c of seg) {
    if (c === '*') re += '[^/]*';
    else if ('.+?^${}()|[]\\/'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function extractExt(seg: string): string | null {
  const m = seg.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : null;
}
