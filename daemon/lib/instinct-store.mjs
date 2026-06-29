// instinct-store — immutable scoring + scoped retrieval of instincts
// (development-plan §5.5, Pillar 3).
//
// Holds distilled instincts, merges new evidence immutably (support/confidence
// only ever accrete), and answers the one query the spawn needs:
// `activeInstinctsFor({role, touches})` — the instincts relevant to THIS story's
// role + touched paths, so the injector only adds what's pertinent (cheap, scoped
// context, not a dump of every learned rule).

import { globsIntersect } from '../pipelines/lib/glob-intersect.mjs';

const PROMOTE_CONFIDENCE = 0.6;

/** Merge a fresh distill pass into an existing instinct list. Immutable. */
export function mergeInstincts(existing = [], distilled = []) {
  const byId = new Map(existing.map((i) => [i.id, i]));
  for (const d of distilled) {
    const prev = byId.get(d.id);
    if (!prev) { byId.set(d.id, { ...d, status: d.status || 'candidate' }); continue; }
    const support = Math.max(prev.support, d.support);
    byId.set(d.id, {
      ...prev,
      support,
      confidence: Math.max(prev.confidence, d.confidence),
      text: d.text || prev.text,
      // enforcement only ever escalates (advisory < gate < test); promote sets it.
      enforcement: rank(prev.enforcement) >= rank(d.enforcement) ? prev.enforcement : d.enforcement,
    });
  }
  return [...byId.values()];
}

function rank(e) { return { advisory: 0, gate: 1, test: 2 }[e] ?? 0; }

/** True when an instinct is eligible to be enforced/promoted. */
export function isActive(instinct) {
  return instinct.status === 'active' || instinct.status === 'promoted' || instinct.confidence >= PROMOTE_CONFIDENCE;
}

/**
 * The instincts that apply to a story: role matches (or instinct is role-agnostic)
 * AND at least one of the story's `touches` globs overlaps the instinct's glob.
 * Returns active instincts sorted by confidence.
 */
export function activeInstinctsFor(instincts = [], { role, touches = [] } = {}) {
  const out = [];
  for (const inst of instincts) {
    if (!isActive(inst)) continue;
    if (inst.role && role && inst.role !== role) continue;
    const glob = inst.touchesGlob;
    const relevant = !glob || glob === '*' || (touches || []).some((t) => globsIntersect(t, glob));
    if (relevant) out.push(inst);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** Just the human-readable strings, for injection. */
export function activeInstinctTexts(instincts, scope) {
  return activeInstinctsFor(instincts, scope).map((i) => i.text);
}
