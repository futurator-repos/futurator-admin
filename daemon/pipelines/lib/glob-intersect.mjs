/**
 * Conservative glob intersection + wave reassignment (Touch-Point Inference §7).
 *
 * `globsIntersect` answers: "could a single file path match both globs?"
 * It deliberately leans toward false positives (extra wave serialization)
 * because false negatives cause runtime wave collisions.
 *
 * `detectCollisions` walks story pairs and returns intersecting pairs.
 *
 * `reassignWaves` bumps the lower-priority story of each colliding pair
 * to the next micro-wave while preserving existing `dependsOn` order.
 * Wave numbers are re-normalized (no gaps) on the way out.
 */

const COMPLEXITY_RANK = {
  trivial: 0,
  standard: 1,
  complex: 2,
  architectural: 3,
};

export function globsIntersect(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aNorm = normalize(a);
  const bNorm = normalize(b);
  if (aNorm.length === 0 || bNorm.length === 0) return false;
  if (aNorm === bNorm) return true;
  return segmentsIntersect(aNorm.split('/'), bNorm.split('/'));
}

function normalize(glob) {
  return glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function segmentsIntersect(a, b) {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0) return b.every((s) => s === '**');
  if (b.length === 0) return a.every((s) => s === '**');

  const a0 = a[0];
  const b0 = b[0];

  if (a0 === '**') {
    return segmentsIntersect(a.slice(1), b) || segmentsIntersect(a, b.slice(1));
  }
  if (b0 === '**') {
    return segmentsIntersect(a, b.slice(1)) || segmentsIntersect(a.slice(1), b);
  }

  if (segmentIntersect(a0, b0)) {
    return segmentsIntersect(a.slice(1), b.slice(1));
  }
  return false;
}

function segmentIntersect(a, b) {
  if (a === b) return true;
  if (a === '*' || b === '*') return true;

  const aWild = a.includes('*');
  const bWild = b.includes('*');

  // Neither has wildcards → literal comparison (already unequal above).
  if (!aWild && !bWild) return false;

  // One literal + one pattern → regex test resolves it exactly.
  if (!aWild) return segmentToRegex(b).test(a);
  if (!bWild) return segmentToRegex(a).test(b);

  // Both have wildcards: extension must not explicitly conflict.
  // Otherwise lean conservative — two wildcard patterns in the same segment
  // usually share at least one satisfying string.
  const aExt = extractExt(a);
  const bExt = extractExt(b);
  if (aExt && bExt && aExt !== bExt) return false;
  return true;
}

function segmentToRegex(seg) {
  let re = '';
  for (const c of seg) {
    if (c === '*') re += '[^/]*';
    else if ('.+?^${}()|[]\\/'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function extractExt(seg) {
  const m = seg.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The collision surface of a story = its DECLARED touchPoints UNIONed with its
 * MEASURED actualTouchPoints (D3-2, 2026-06-22). The dev-scope gate records the
 * source files a story's DEV agent actually edited; unioning them here means two
 * siblings that both touched an undeclared shared file (the pacmanv3 pacman.ts
 * collision) are detected as colliding and serialized on the next wave
 * recompute — turning a merge-time conflict into a scheduler-time decision. The
 * union only ADDS collisions (genuine shared files); it never hides a declared
 * one. De-duplicated so a path declared AND measured isn't double-counted.
 *
 * @param {{ touchPoints?: string[], actualTouchPoints?: string[] }} story
 * @returns {string[]}
 */
function collisionSurface(story) {
  return [...new Set([...(story.touchPoints || []), ...(story.actualTouchPoints || [])])];
}

/**
 * Detect every pair of stories whose collision surfaces overlap.
 *
 * @param {Array<{ storyId: string, touchPoints?: string[], actualTouchPoints?: string[] }>} stories
 * @returns {Array<{ a: string, b: string, paths: string[] }>}
 */
export function detectCollisions(stories) {
  const out = [];
  for (let i = 0; i < stories.length; i++) {
    for (let j = i + 1; j < stories.length; j++) {
      const a = stories[i];
      const b = stories[j];
      const surfaceA = collisionSurface(a);
      const surfaceB = collisionSurface(b);
      const intersects = [];
      for (const pa of surfaceA) {
        for (const pb of surfaceB) {
          if (globsIntersect(pa, pb)) intersects.push(`${pa} ∩ ${pb}`);
        }
      }
      if (intersects.length > 0) {
        out.push({ a: a.storyId, b: b.storyId, paths: intersects });
      }
    }
  }
  return out;
}

/**
 * Re-assign wave numbers so no two stories share a wave if they collide,
 * while preserving explicit dependsOn order and Haiku-flagged collisions.
 *
 * @param {Array<Story>} stories   Each story: { storyId, wave?, dependsOn?, touchPoints?, complexity?, collisionsWith? }
 * @returns {{ stories: Array<Story>, reassignments: Array<{ storyId, from, to, reason }> }}
 *
 * Higher-complexity story stays in earlier wave; lower-complexity bumps forward.
 * If complexity equal, the later-indexed story bumps.
 */
export function reassignWaves(stories) {
  const byId = new Map(stories.map((s) => [s.storyId, { ...s }]));
  const orderIndex = new Map(stories.map((s, i) => [s.storyId, i]));
  const reassignments = [];

  const collisions = detectCollisions(stories);

  for (const { a, b } of collisions) {
    const sa = byId.get(a);
    const sb = byId.get(b);
    if (!sa || !sb) continue;

    // Respect explicit dependsOn graph: if one already depends on the other,
    // the DAG order dictates wave assignment — nothing to do here.
    if (dependsTransitively(sa, sb, byId) || dependsTransitively(sb, sa, byId)) {
      continue;
    }

    if ((sa.wave ?? 0) !== (sb.wave ?? 0)) continue; // already separated

    const bumpTarget = pickBumpTarget(sa, sb, orderIndex);
    const other = bumpTarget.storyId === sa.storyId ? sb : sa;
    const reason = haikuFlagged(bumpTarget, other.storyId) || haikuFlagged(other, bumpTarget.storyId)
      ? 'haiku_flagged'
      : 'wave_conflict_autosplit';

    const from = bumpTarget.wave ?? 0;
    const to = (other.wave ?? 0) + 1;
    bumpTarget.wave = to;
    reassignments.push({ storyId: bumpTarget.storyId, from, to, reason });
  }

  const out = Array.from(byId.values());
  normalizeWaves(out);

  return { stories: out, reassignments };
}

function pickBumpTarget(a, b, orderIndex) {
  const rankA = COMPLEXITY_RANK[a.complexity ?? 'standard'] ?? 1;
  const rankB = COMPLEXITY_RANK[b.complexity ?? 'standard'] ?? 1;
  if (rankA > rankB) return b; // keep a (higher-complexity) in earlier wave
  if (rankB > rankA) return a;
  // tie-break: later-indexed story gets bumped
  return (orderIndex.get(a.storyId) ?? 0) > (orderIndex.get(b.storyId) ?? 0) ? a : b;
}

function haikuFlagged(story, otherId) {
  return Array.isArray(story.collisionsWith) && story.collisionsWith.includes(otherId);
}

function dependsTransitively(from, to, byId) {
  const visited = new Set();
  const stack = [...(from.dependsOn || [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === to.storyId) return true;
    const next = byId.get(id);
    if (next?.dependsOn) stack.push(...next.dependsOn);
  }
  return false;
}

function normalizeWaves(stories) {
  const present = Array.from(new Set(stories.map((s) => s.wave ?? 0))).sort((x, y) => x - y);
  const rank = new Map(present.map((w, i) => [w, i + 1]));
  for (const s of stories) {
    s.wave = rank.get(s.wave ?? 0) ?? s.wave;
  }
}

/**
 * D3-2 (2026-06-22) — the mid-plan re-serialize CONSUMER. Recompute waves over
 * an epic's persisted stories (honoring declared + MEASURED `actualTouchPoints`
 * via `detectCollisions`'s union) and return ONLY the stories that are still
 * runnable AND whose wave changed — so a caller persists just those, never
 * disturbing a story already running or done.
 *
 * This is what makes the recorded actual edits actually change behavior: after
 * wave N's stories record what they really touched, calling this before wave
 * N+1 dispatches serializes a still-pending sibling that now collides on a
 * file neither declared. Idempotent: a second call with no new collisions
 * returns [].
 *
 * Stories with a terminal/active status (done, in_review, blocked, running,
 * queued) keep their wave — only `pending`/`draft` stories may be re-serialized
 * (moving a running/merged story's wave would be meaningless). Their fixed
 * waves still act as collision anchors for the pending ones.
 *
 * @param {Array<{ storyId, wave?, dependsOn?, touchPoints?, actualTouchPoints?, complexity?, collisionsWith?, status? }>} stories
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.reassignableStatuses] - statuses eligible to move (default: pending, draft, undefined)
 * @returns {{ changed: Array<{ storyId, fromWave: number, toWave: number }>, stories: Array<object> }}
 */
export function recomputePendingWaves(stories, opts = {}) {
  if (!Array.isArray(stories) || stories.length === 0) {
    return { changed: [], stories: stories ?? [] };
  }
  const reassignable = new Set(
    opts.reassignableStatuses
      ? Array.isArray(opts.reassignableStatuses)
        ? opts.reassignableStatuses
        : [...opts.reassignableStatuses]
      : ['pending', 'draft'],
  );
  const isReassignable = (s) => s.status === undefined || s.status === null || reassignable.has(s.status);

  const before = new Map(stories.map((s) => [s.storyId, s.wave ?? 0]));
  const { stories: recomputed } = reassignWaves(stories);

  const changed = [];
  for (const s of recomputed) {
    const original = stories.find((o) => o.storyId === s.storyId);
    if (!original || !isReassignable(original)) {
      // Pin non-reassignable stories back to their original wave (an anchor).
      s.wave = before.get(s.storyId);
      continue;
    }
    const fromWave = before.get(s.storyId) ?? 0;
    if ((s.wave ?? 0) !== fromWave) {
      changed.push({ storyId: s.storyId, fromWave, toWave: s.wave ?? 0 });
    }
  }
  return { changed, stories: recomputed };
}
