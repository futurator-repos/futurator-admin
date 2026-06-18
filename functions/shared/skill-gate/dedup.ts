/**
 * dedup.ts — Skills Institution, Story 2.4. The gate's dedup step.
 *
 * Flags near-duplicates at the gate so the registry doesn't accumulate 40 copies
 * of "write good tests." It does NOT auto-merge (Phase 1 — the operator decides);
 * it annotates a proposal with "possible duplicate of X" + a similarity score so
 * the inbox can offer merge-into-canonical.
 *
 * Similarity: cosine over `index.embeddings.json` vectors when the caller supplies
 * them (the precise path), else a dependency-free token-Jaccard heuristic over
 * name+description (always available). An exact name match is NOT a duplicate —
 * it's an update of the same skill — so same-name entries are excluded.
 *
 * Pure + dependency-free.
 */

export interface DedupCandidate {
  name: string;
  description: string;
}

export interface DedupTarget {
  name: string;
  description: string;
}

export interface DedupAnnotation {
  canonicalName: string;
  similarity: number;
}

export interface DedupOptions {
  /** Match threshold in [0,1]. Default 0.6. */
  threshold?: number;
  /** Optional embeddings: candidate vector + a name→vector map for cosine. */
  vectors?: { candidate: number[]; byName: Record<string, number[]> };
}

/** Lowercase word tokens (len ≥ 2), deduped. */
function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2));
}

/** Jaccard similarity of two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Find the closest existing skill to a candidate. Returns the best match at or
 * above `threshold` (excluding the same name), or null. The score is cosine when
 * vectors are supplied for both the candidate and the target, else token-Jaccard.
 */
export function findNearDuplicate(
  candidate: DedupCandidate,
  existing: DedupTarget[],
  options: DedupOptions = {},
): DedupAnnotation | null {
  const threshold = options.threshold ?? 0.6;
  const candTokens = tokens(`${candidate.name} ${candidate.description}`);

  let best: DedupAnnotation | null = null;
  for (const target of existing) {
    if (target.name === candidate.name) continue; // same skill → update, not dup

    let sim: number;
    const cv = options.vectors?.candidate;
    const tv = options.vectors?.byName?.[target.name];
    if (cv && tv) {
      sim = cosine(cv, tv);
    } else {
      sim = jaccard(candTokens, tokens(`${target.name} ${target.description}`));
    }

    if (sim >= threshold && (best === null || sim > best.similarity)) {
      best = { canonicalName: target.name, similarity: Number(sim.toFixed(4)) };
    }
  }
  return best;
}
