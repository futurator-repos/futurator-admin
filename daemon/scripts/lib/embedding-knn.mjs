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
 *
 * ── S1.5: embeddings sidecar ────────────────────────────────────────────────
 * With Memgraph excised (KD-1) the raw 1024-d Voyage vectors no longer live in a
 * graph DB. Step 5 of `graph-sync.mjs` writes them to a per-project sidecar
 * (`knowledge/_graph/embeddings.json`, shape `{nodeId: number[1024]}`) which rides
 * the existing S3 backup to `knowledge-live/<projectId>/_graph/` — PRIVATE, never
 * shipped to the browser (the Graph tab only reads `graph-snapshot.json`, which
 * carries the compact `similarTo` and no raw vectors). `graph-search.mjs` reads
 * this sidecar for query-time KNN. The read/merge/write helpers below are the
 * single owner of that file's shape so writer (graph-sync) and reader
 * (graph-search) can never disagree.
 */

import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

/** Sidecar path for a project's knowledge/ directory. */
export function embeddingsSidecarPath(knowledgeDir) {
  return join(knowledgeDir, '_graph', 'embeddings.json');
}

/**
 * Read the per-project embeddings sidecar. Missing/corrupt → `{}` (graceful:
 * KNN then returns nothing and Layer 1 degrades non-blockingly, same posture as
 * the old "Memgraph unavailable" branch).
 * @param {string} knowledgeDir
 * @returns {Promise<Record<string, number[]>>}
 */
export async function readEmbeddingsSidecar(knowledgeDir) {
  try {
    const raw = await readFile(embeddingsSidecarPath(knowledgeDir), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Atomically write the sidecar (tmp + rename, mirrors the snapshot writers in
 * graph-sync.mjs).
 * @param {string} knowledgeDir
 * @param {Record<string, number[]>} embeddingsById
 * @returns {Promise<string>} the path written
 */
export async function writeEmbeddingsSidecar(knowledgeDir, embeddingsById) {
  const p = embeddingsSidecarPath(knowledgeDir);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(embeddingsById ?? {}), 'utf-8');
  await rename(tmp, p);
  return p;
}

/**
 * Merge freshly-embedded vectors onto the existing sidecar and drop deleted
 * nodes. graph-sync only re-embeds NEW/CHANGED articles each run, so an
 * overwrite would wipe every unchanged node's vector — merge is mandatory.
 * @param {Record<string, number[]>} existing
 * @param {Record<string, number[]>} updates
 * @param {string[]} [deletedIds]
 * @returns {Record<string, number[]>}
 */
export function mergeEmbeddings(existing = {}, updates = {}, deletedIds = []) {
  const out = { ...existing, ...updates };
  for (const id of deletedIds ?? []) delete out[id];
  return out;
}

/**
 * Query-time cosine KNN over a sidecar map — the replacement for Memgraph's
 * `vector_search.search('node_embedding_index', …)`. Keeps the old strict
 * `similarity > minSimilarity` threshold and returns the top-K by descending
 * score (nodeId as the deterministic tie-breaker).
 * @param {number[]} queryVector
 * @param {Record<string, number[]>} embeddingsById
 * @param {{topK?:number, minSimilarity?:number}} [opts]
 * @returns {Array<{nodeId:string, score:number}>}
 */
export function knnSearch(queryVector, embeddingsById = {}, opts = {}) {
  const topK = opts.topK ?? 10;
  const minSimilarity = opts.minSimilarity ?? 0.6;
  if (!Array.isArray(queryVector) || queryVector.length === 0) return [];

  const scored = [];
  for (const [nodeId, vec] of Object.entries(embeddingsById ?? {})) {
    if (!Array.isArray(vec) || vec.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, vec);
    if (score > minSimilarity) scored.push({ nodeId, score });
  }
  scored.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  return scored.slice(0, topK);
}

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
