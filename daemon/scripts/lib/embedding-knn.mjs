/**
 * embedding-knn.mjs — semantic-neighbour computation for the graph snapshot.
 *
 * Voyage embeds every knowledge article into a 1024-dim vector on `n.embedding`.
 * Those vectors power GraphRAG search but were never surfaced in the viz. Here we
 * precompute, per node, its top-k cosine-nearest neighbours and write a compact
 * `similarTo: [{id, score}]` into the snapshot — so the Graph tab can highlight
 * what's SEMANTICALLY close even when it isn't STRUCTURALLY linked, with no live
 * Memgraph access from the browser. The raw 1024-d vectors stay out of the
 * snapshot (kept small).
 *
 * Cost is bounded: O(N²·d) is fine for a per-project graph (hundreds of nodes);
 * above `maxNodes` we skip rather than blow up a compile.
 *
 * Pure + deterministic → unit-tested directly.
 */

export function cosineSimilarity(a, b) {
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
 * @param {Array<{id:string, embedding:number[]|null}>} items
 * @param {{k?:number, maxNodes?:number, minScore?:number}} [opts]
 * @returns {Map<string, Array<{id:string, score:number}>>}
 */
export function computeSimilarTo(items, opts = {}) {
  const k = opts.k ?? 5;
  const maxNodes = opts.maxNodes ?? 700;
  const minScore = opts.minScore ?? 0.55;

  const withEmb = (items ?? []).filter(
    (it) => Array.isArray(it.embedding) && it.embedding.length > 0,
  );
  const out = new Map();
  // Bounded cost guard — skip (empty map) rather than stall a large compile.
  if (withEmb.length < 2 || withEmb.length > maxNodes) return out;

  for (let i = 0; i < withEmb.length; i++) {
    const sims = [];
    for (let j = 0; j < withEmb.length; j++) {
      if (i === j) continue;
      const s = cosineSimilarity(withEmb[i].embedding, withEmb[j].embedding);
      if (s >= minScore) sims.push({ id: withEmb[j].id, score: Math.round(s * 1000) / 1000 });
    }
    sims.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    if (sims.length) out.set(withEmb[i].id, sims.slice(0, k));
  }
  return out;
}
